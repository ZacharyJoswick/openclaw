import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { Readable } from "node:stream";
import { ChannelType, type Client, ReadyListener } from "@buape/carbon";
import type { VoicePlugin } from "@buape/carbon/voice";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { agentCommandFromIngress } from "openclaw/plugin-sdk/agent-runtime";
import { resolveTtsConfig, type ResolvedTtsConfig } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { DiscordAccountConfig, TtsConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { parseTtsDirectives } from "openclaw/plugin-sdk/speech";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { formatMention } from "../mentions.js";
import { normalizeDiscordSlug, resolveDiscordOwnerAccess } from "../monitor/allow-list.js";
import { formatDiscordUserTag } from "../monitor/format.js";
import { getDiscordRuntime } from "../runtime.js";
import { authorizeDiscordVoiceIngress } from "./access.js";
import { loadDiscordVoiceSdk } from "./sdk-runtime.js";

const require = createRequire(import.meta.url);

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BIT_DEPTH = 16;
const MIN_SEGMENT_SECONDS = 1.5;
const SILENCE_DURATION_MS = 1_000;
const VOICE_CONNECT_READY_TIMEOUT_MS = 15_000;
const PLAYBACK_READY_TIMEOUT_MS = 60_000;
const SPEAKING_READY_TIMEOUT_MS = 60_000;
const DECRYPT_FAILURE_WINDOW_MS = 30_000;
const DECRYPT_FAILURE_RECONNECT_THRESHOLD = 3;
const DECRYPT_FAILURE_PATTERN = /DecryptionFailed\(/;
const SPEAKER_CONTEXT_CACHE_TTL_MS = 60_000;

const logger = createSubsystemLogger("discord/voice");

const logVoiceVerbose = (message: string) => {
  logVerbose(`discord voice: ${message}`);
};

type VoiceOperationResult = {
  ok: boolean;
  message: string;
  channelId?: string;
  guildId?: string;
};

type VoiceSessionEntry = {
  guildId: string;
  guildName?: string;
  channelId: string;
  channelName?: string;
  sessionChannelId: string;
  textChannelId?: string;
  route: ReturnType<typeof resolveAgentRoute>;
  connection: import("@discordjs/voice").VoiceConnection;
  player: import("@discordjs/voice").AudioPlayer;
  playbackQueue: Promise<void>;
  processingQueue: Promise<void>;
  activeSpeakers: Set<string>;
  decryptFailureCount: number;
  lastDecryptFailureAt: number;
  decryptRecoveryInFlight: boolean;
  stop: () => void;
};

function mergeTtsConfig(base: TtsConfig, override?: TtsConfig): TtsConfig {
  if (!override) {
    return base;
  }
  const baseProviders = base.providers ?? {};
  const overrideProviders = override.providers ?? {};
  const mergedProviders = Object.fromEntries(
    [...new Set([...Object.keys(baseProviders), ...Object.keys(overrideProviders)])].map(
      (providerId) => {
        const baseProvider = baseProviders[providerId] ?? {};
        const overrideProvider = overrideProviders[providerId] ?? {};
        return [
          providerId,
          {
            ...baseProvider,
            ...overrideProvider,
          },
        ];
      },
    ),
  );
  return {
    ...base,
    ...override,
    modelOverrides: {
      ...base.modelOverrides,
      ...override.modelOverrides,
    },
    ...(Object.keys(mergedProviders).length === 0 ? {} : { providers: mergedProviders }),
  };
}

function resolveVoiceTtsConfig(params: { cfg: OpenClawConfig; override?: TtsConfig }): {
  cfg: OpenClawConfig;
  resolved: ResolvedTtsConfig;
} {
  if (!params.override) {
    return { cfg: params.cfg, resolved: resolveTtsConfig(params.cfg) };
  }
  const base = params.cfg.messages?.tts ?? {};
  const merged = mergeTtsConfig(base, params.override);
  const messages = params.cfg.messages ?? {};
  const cfg = {
    ...params.cfg,
    messages: {
      ...messages,
      tts: merged,
    },
  };
  return { cfg, resolved: resolveTtsConfig(cfg) };
}

function buildWavBuffer(pcm: Buffer): Buffer {
  const blockAlign = (CHANNELS * BIT_DEPTH) / 8;
  const byteRate = SAMPLE_RATE * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BIT_DEPTH, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

type OpusDecoder = {
  decode: (buffer: Buffer) => Buffer;
};

let warnedOpusMissing = false;

function createOpusDecoder(): { decoder: OpusDecoder; name: string } | null {
  try {
    const OpusScript = require("opusscript") as {
      new (sampleRate: number, channels: number, application: number): OpusDecoder;
      Application: { AUDIO: number };
    };
    const decoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
    return { decoder, name: "opusscript" };
  } catch (err) {
    if (!warnedOpusMissing) {
      warnedOpusMissing = true;
      logger.warn(
        `discord voice: opusscript unavailable (${formatErrorMessage(err)}); cannot decode voice audio`,
      );
    }
  }
  return null;
}

async function decodeOpusStream(stream: Readable): Promise<Buffer> {
  const selected = createOpusDecoder();
  if (!selected) {
    return Buffer.alloc(0);
  }
  logVoiceVerbose(`opus decoder: ${selected.name}`);
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of stream) {
      if (!chunk || !(chunk instanceof Buffer) || chunk.length === 0) {
        continue;
      }
      const decoded = selected.decoder.decode(chunk);
      if (decoded && decoded.length > 0) {
        chunks.push(Buffer.from(decoded));
      }
    }
  } catch (err) {
    if (shouldLogVerbose()) {
      logVerbose(`discord voice: opus decode failed: ${formatErrorMessage(err)}`);
    }
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
}

function estimateDurationSeconds(pcm: Buffer): number {
  const bytesPerSample = (BIT_DEPTH / 8) * CHANNELS;
  if (bytesPerSample <= 0) {
    return 0;
  }
  return pcm.length / (bytesPerSample * SAMPLE_RATE);
}

async function writeWavFile(pcm: Buffer): Promise<{ path: string; durationSeconds: number }> {
  const tempDir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "discord-voice-"));
  const filePath = path.join(tempDir, `segment-${randomUUID()}.wav`);
  const wav = buildWavBuffer(pcm);
  await fs.writeFile(filePath, wav);
  scheduleTempCleanup(tempDir);
  return { path: filePath, durationSeconds: estimateDurationSeconds(pcm) };
}

function scheduleTempCleanup(tempDir: string, delayMs: number = 30 * 60 * 1000): void {
  const timer = setTimeout(() => {
    fs.rm(tempDir, { recursive: true, force: true }).catch((err) => {
      if (shouldLogVerbose()) {
        logVerbose(`discord voice: temp cleanup failed for ${tempDir}: ${formatErrorMessage(err)}`);
      }
    });
  }, delayMs);
  timer.unref();
}

const WHISPER_HALLUCINATIONS = new Set([
  "you're welcome",
  "thank you",
  "thanks for watching",
  "bye",
  "goodbye",
  "thank you for watching",
  "thanks",
  "you",
]);

async function convertToMono16k(inputPath: string): Promise<string> {
  const { execFileSync } = await import("node:child_process");
  const outputPath = inputPath.replace(/\.wav$/, "-16k.wav");
  execFileSync(
    "ffmpeg",
    ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-f", "wav", outputPath],
    {
      timeout: 10_000,
    },
  );
  return outputPath;
}

// Whisper vocabulary biasing via two mechanisms:
// 1. initial_prompt — style prompt that biases toward expected words
// 2. hotwords — faster-whisper's beam search biasing (more reliable for proper nouns)
const WHISPER_INITIAL_PROMPT =
  "Claw, OpenClaw, Joswick, MakerHarness, Tiny, " +
  "Qwen, vLLM, Whisper, Hindsight, " +
  "Tailscale, Discord, Gemini, Sonnet, Anthropic, OpenRouter";

const WHISPER_HOTWORDS =
  "Claw OpenClaw Joswick MakerHarness Tiny " +
  "Qwen vLLM Whisper Hindsight " +
  "Tailscale Discord Gemini Sonnet Anthropic OpenRouter";

async function transcribeAudio(params: {
  cfg: OpenClawConfig;
  agentId: string;
  filePath: string;
}): Promise<string | undefined> {
  let transcribeFilePath = params.filePath;
  try {
    transcribeFilePath = await convertToMono16k(params.filePath);
  } catch (err) {
    logger.warn(
      `discord voice: ffmpeg conversion failed, using original: ${formatErrorMessage(err)}`,
    );
  }

  // Call Whisper API directly to pass initial_prompt for vocabulary biasing
  const sttBaseUrl =
    params.cfg.channels?.discord?.voice?.stt?.baseUrl ?? "http://192.168.5.100:8097/v1";
  const sttModel =
    params.cfg.channels?.discord?.voice?.stt?.model ?? "Systran/faster-whisper-large-v3";

  try {
    const formData = new FormData();
    const fileBuffer = await fs.readFile(transcribeFilePath);
    formData.append(
      "file",
      new Blob([fileBuffer], { type: "audio/wav" }),
      path.basename(transcribeFilePath),
    );
    formData.append("model", sttModel);
    formData.append("language", "en");
    formData.append("initial_prompt", WHISPER_INITIAL_PROMPT);
    formData.append("hotwords", WHISPER_HOTWORDS);

    const response = await fetch(`${sttBaseUrl}/audio/transcriptions`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      logger.warn(`discord voice: whisper API returned ${response.status}`);
      return undefined;
    }

    const result = (await response.json()) as { text?: string };
    const text = result.text?.trim() || undefined;
    if (text && WHISPER_HALLUCINATIONS.has(text.toLowerCase().replace(/[.!?,]/g, ""))) {
      logVoiceVerbose(`filtered whisper hallucination: "${text}"`);
      return undefined;
    }
    return text;
  } catch (err) {
    logger.warn(`discord voice: transcription failed: ${formatErrorMessage(err)}`);
    // Fallback to the standard media understanding pipeline
    const result = await getDiscordRuntime().mediaUnderstanding.transcribeAudioFile({
      filePath: transcribeFilePath,
      cfg: params.cfg,
      agentDir: resolveAgentDir(params.cfg, params.agentId),
      mime: "audio/wav",
    });
    const text = result.text?.trim() || undefined;
    if (text && WHISPER_HALLUCINATIONS.has(text.toLowerCase().replace(/[.!?,]/g, ""))) {
      logVoiceVerbose(`filtered whisper hallucination: "${text}"`);
      return undefined;
    }
    return text;
  }
}

export class DiscordVoiceManager {
  private sessions = new Map<string, VoiceSessionEntry>();
  private botUserId?: string;
  private readonly voiceEnabled: boolean;
  private autoJoinTask: Promise<void> | null = null;
  private readonly ownerAllowFrom: string[];
  private readonly speakerContextCache = new Map<
    string,
    {
      id: string;
      label: string;
      name?: string;
      tag?: string;
      senderIsOwner: boolean;
      expiresAt: number;
    }
  >();

  constructor(
    private params: {
      client: Client;
      cfg: OpenClawConfig;
      discordConfig: DiscordAccountConfig;
      accountId: string;
      runtime: RuntimeEnv;
      botUserId?: string;
    },
  ) {
    this.botUserId = params.botUserId;
    this.voiceEnabled = params.discordConfig.voice?.enabled !== false;
    this.ownerAllowFrom =
      params.discordConfig.allowFrom ?? params.discordConfig.dm?.allowFrom ?? [];
  }

  setBotUserId(id?: string) {
    if (id) {
      this.botUserId = id;
    }
  }

  private async postToTextChannel(entry: VoiceSessionEntry, content: string): Promise<void> {
    const channelId = entry.textChannelId;
    if (!channelId) return;
    try {
      const token = this.params.client.options.token;
      const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content }),
      });
      if (!response.ok) {
        logger.warn(`discord voice: post to text channel ${channelId} failed: ${response.status}`);
      }
    } catch (err) {
      logger.warn(
        `discord voice: failed to post to text channel ${channelId}: ${formatErrorMessage(err)}`,
      );
    }
  }

  private async sendTypingToTextChannel(entry: VoiceSessionEntry): Promise<void> {
    const channelId = entry.textChannelId;
    if (!channelId) return;
    try {
      const token = this.params.client.options.token;
      await fetch(`https://discord.com/api/v10/channels/${channelId}/typing`, {
        method: "POST",
        headers: { Authorization: `Bot ${token}` },
      });
    } catch {
      // typing indicator failures are non-critical
    }
  }

  /**
   * Check if a guild has an active voice session.
   */
  getActiveSession(guildId: string): VoiceSessionEntry | undefined {
    return this.sessions.get(guildId);
  }

  /**
   * Find a voice session by channel ID. Used to detect if a message
   * was sent in a channel with an active voice session.
   */
  findSessionByChannelId(
    channelId: string,
  ): { guildId: string; session: VoiceSessionEntry } | undefined {
    for (const [guildId, session] of this.sessions) {
      if (session.channelId === channelId) {
        return { guildId, session };
      }
    }
    return undefined;
  }

  /**
   * Play TTS for a text message that was sent in a channel with an active voice session.
   * Called by the Discord message handler when it detects the message is in a voice channel.
   */
  async playTtsForTextReply(guildId: string, text: string): Promise<void> {
    const entry = this.sessions.get(guildId);
    if (!entry) return;

    const { cfg: ttsCfg, resolved: ttsConfig } = resolveVoiceTtsConfig({
      cfg: this.params.cfg,
      override: this.params.discordConfig.voice?.tts,
    });
    const directive = parseTtsDirectives(text, ttsConfig.modelOverrides, {
      cfg: ttsCfg,
      providerConfigs: ttsConfig.providerConfigs,
    });
    const speakText = directive.overrides.ttsText ?? directive.cleanedText.trim();
    if (!speakText) return;

    logger.warn(`[voice-pipe] TTS for text reply: "${speakText.slice(0, 60)}"`);
    const ttsResult = await getDiscordRuntime().tts.textToSpeech({
      text: speakText,
      cfg: ttsCfg,
      channel: "discord",
      overrides: directive.overrides,
    });
    if (!ttsResult.success || !ttsResult.audioPath) {
      logger.warn(`[voice-pipe] TTS for text reply FAILED: ${ttsResult.error ?? "unknown"}`);
      return;
    }

    const audioPath = ttsResult.audioPath;
    this.enqueuePlayback(entry, async () => {
      const voiceSdk = loadDiscordVoiceSdk();
      const resource = voiceSdk.createAudioResource(audioPath);
      entry.player.play(resource);
      await voiceSdk
        .entersState(entry.player, voiceSdk.AudioPlayerStatus.Playing, PLAYBACK_READY_TIMEOUT_MS)
        .catch(() => undefined);
      await voiceSdk
        .entersState(entry.player, voiceSdk.AudioPlayerStatus.Idle, SPEAKING_READY_TIMEOUT_MS)
        .catch(() => undefined);
    });
  }

  private resolveTextChannelForVoice(voiceChannelId: string): string {
    // Discord voice channels have built-in text chat — post directly to the voice channel ID
    return voiceChannelId;
  }

  isEnabled() {
    return this.voiceEnabled;
  }

  async autoJoin(): Promise<void> {
    if (!this.voiceEnabled) {
      return;
    }
    if (this.autoJoinTask) {
      return this.autoJoinTask;
    }
    this.autoJoinTask = (async () => {
      const entries = this.params.discordConfig.voice?.autoJoin ?? [];
      logVoiceVerbose(`autoJoin: ${entries.length} entries`);
      const seenGuilds = new Set<string>();
      for (const entry of entries) {
        const guildId = entry.guildId.trim();
        if (!guildId) {
          continue;
        }
        if (seenGuilds.has(guildId)) {
          logger.warn(
            `discord voice: autoJoin has multiple entries for guild ${guildId}; skipping`,
          );
          continue;
        }
        seenGuilds.add(guildId);
        logVoiceVerbose(`autoJoin: joining guild ${guildId} channel ${entry.channelId}`);
        await this.join({
          guildId: entry.guildId,
          channelId: entry.channelId,
        });
      }
    })().finally(() => {
      this.autoJoinTask = null;
    });
    return this.autoJoinTask;
  }

  status(): VoiceOperationResult[] {
    return Array.from(this.sessions.values()).map((session) => ({
      ok: true,
      message: `connected: guild ${session.guildId} channel ${session.channelId}`,
      guildId: session.guildId,
      channelId: session.channelId,
    }));
  }

  async join(params: { guildId: string; channelId: string }): Promise<VoiceOperationResult> {
    if (!this.voiceEnabled) {
      return {
        ok: false,
        message: "Discord voice is disabled (channels.discord.voice.enabled).",
      };
    }
    const guildId = params.guildId.trim();
    const channelId = params.channelId.trim();
    if (!guildId || !channelId) {
      return { ok: false, message: "Missing guildId or channelId." };
    }
    logVoiceVerbose(`join requested: guild ${guildId} channel ${channelId}`);

    const existing = this.sessions.get(guildId);
    if (existing && existing.channelId === channelId) {
      logVoiceVerbose(`join: already connected to guild ${guildId} channel ${channelId}`);
      return {
        ok: true,
        message: `Already connected to ${formatMention({ channelId })}.`,
        guildId,
        channelId,
      };
    }
    if (existing) {
      logVoiceVerbose(`join: replacing existing session for guild ${guildId}`);
      await this.leave({ guildId });
    }

    const channelInfo = await this.params.client.fetchChannel(channelId).catch(() => null);
    if (!channelInfo || ("type" in channelInfo && !isVoiceChannel(channelInfo.type))) {
      return { ok: false, message: `Channel ${channelId} is not a voice channel.` };
    }
    const channelGuildId = "guildId" in channelInfo ? channelInfo.guildId : undefined;
    if (channelGuildId && channelGuildId !== guildId) {
      return { ok: false, message: "Voice channel is not in this guild." };
    }

    const voicePlugin = this.params.client.getPlugin<VoicePlugin>("voice");
    if (!voicePlugin) {
      return { ok: false, message: "Discord voice plugin is not available." };
    }

    const adapterCreator = voicePlugin.getGatewayAdapterCreator(guildId);
    const daveEncryption = this.params.discordConfig.voice?.daveEncryption;
    const decryptionFailureTolerance = this.params.discordConfig.voice?.decryptionFailureTolerance;
    logVoiceVerbose(
      `join: DAVE settings encryption=${daveEncryption === false ? "off" : "on"} tolerance=${
        decryptionFailureTolerance ?? "default"
      }`,
    );
    const voiceSdk = loadDiscordVoiceSdk();
    const connection = voiceSdk.joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator,
      selfDeaf: false,
      selfMute: false,
      daveEncryption,
      decryptionFailureTolerance,
    });

    // --- Set up entry, handlers, and event listeners BEFORE awaiting Ready ---
    // Discord may send Speaking opcodes during the DAVE/encryption handshake
    // (before Ready fires), especially when the user is already in the voice
    // channel. If we bind the speaking handler after Ready, SpeakingMap
    // consumes the event and transitions to "speaking" state before our handler
    // exists, so "start" never re-emits and audio capture never triggers.
    const sessionChannelId = channelInfo?.id ?? channelId;
    const textChannelId = this.resolveTextChannelForVoice(channelId);
    const route = resolveAgentRoute({
      cfg: this.params.cfg,
      channel: "discord",
      accountId: this.params.accountId,
      guildId,
      peer: { kind: "channel", id: sessionChannelId },
    });

    const player = voiceSdk.createAudioPlayer();

    let speakingHandler: ((userId: string) => void) | undefined;
    let disconnectedHandler: (() => Promise<void>) | undefined;
    let destroyedHandler: (() => void) | undefined;
    let playerErrorHandler: ((err: Error) => void) | undefined;
    const clearSessionIfCurrent = () => {
      const active = this.sessions.get(guildId);
      if (active?.connection === connection) {
        this.sessions.delete(guildId);
      }
    };

    const entry: VoiceSessionEntry = {
      guildId,
      guildName:
        channelInfo &&
        "guild" in channelInfo &&
        channelInfo.guild &&
        typeof channelInfo.guild.name === "string"
          ? channelInfo.guild.name
          : undefined,
      channelId,
      channelName:
        channelInfo && "name" in channelInfo && typeof channelInfo.name === "string"
          ? channelInfo.name
          : undefined,
      sessionChannelId,
      textChannelId,
      route,
      connection,
      player,
      playbackQueue: Promise.resolve(),
      processingQueue: Promise.resolve(),
      activeSpeakers: new Set(),
      decryptFailureCount: 0,
      lastDecryptFailureAt: 0,
      decryptRecoveryInFlight: false,
      stop: () => {
        if (speakingHandler) {
          connection.receiver.speaking.off("start", speakingHandler);
        }
        if (disconnectedHandler) {
          connection.off(voiceSdk.VoiceConnectionStatus.Disconnected, disconnectedHandler);
        }
        if (destroyedHandler) {
          connection.off(voiceSdk.VoiceConnectionStatus.Destroyed, destroyedHandler);
        }
        if (playerErrorHandler) {
          player.off("error", playerErrorHandler);
        }
        player.stop();
        connection.destroy();
      },
    };

    speakingHandler = (userId: string) => {
      void this.handleSpeakingStart(entry, userId).catch((err) => {
        logger.warn(`discord voice: capture failed: ${formatErrorMessage(err)}`);
      });
    };

    disconnectedHandler = async () => {
      try {
        await Promise.race([
          voiceSdk.entersState(connection, voiceSdk.VoiceConnectionStatus.Signalling, 5_000),
          voiceSdk.entersState(connection, voiceSdk.VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        clearSessionIfCurrent();
        connection.destroy();
      }
    };
    destroyedHandler = () => {
      clearSessionIfCurrent();
    };
    playerErrorHandler = (err: Error) => {
      logger.warn(`discord voice: playback error: ${formatErrorMessage(err)}`);
    };

    // Bind event listeners early so we don't miss Speaking events during handshake
    connection.receiver.speaking.on("start", speakingHandler);
    connection.on(voiceSdk.VoiceConnectionStatus.Disconnected, disconnectedHandler);
    connection.on(voiceSdk.VoiceConnectionStatus.Destroyed, destroyedHandler);
    player.on("error", playerErrorHandler);

    // Now wait for Ready — handlers are already bound
    try {
      await voiceSdk.entersState(
        connection,
        voiceSdk.VoiceConnectionStatus.Ready,
        VOICE_CONNECT_READY_TIMEOUT_MS,
      );
      logVoiceVerbose(`join: connected to guild ${guildId} channel ${channelId}`);
    } catch (err) {
      // Clean up handlers on failure
      entry.stop();
      return { ok: false, message: `Failed to join voice channel: ${formatErrorMessage(err)}` };
    }

    if (sessionChannelId !== channelId) {
      logVoiceVerbose(
        `join: using session channel ${sessionChannelId} for voice channel ${channelId}`,
      );
    }

    connection.subscribe(player);
    this.sessions.set(guildId, entry);
    return {
      ok: true,
      message: `Joined ${formatMention({ channelId })}.`,
      guildId,
      channelId,
    };
  }

  async leave(params: { guildId: string; channelId?: string }): Promise<VoiceOperationResult> {
    const guildId = params.guildId.trim();
    logVoiceVerbose(`leave requested: guild ${guildId} channel ${params.channelId ?? "current"}`);
    const entry = this.sessions.get(guildId);
    if (!entry) {
      return { ok: false, message: "Not connected to a voice channel." };
    }
    if (params.channelId && params.channelId !== entry.channelId) {
      return { ok: false, message: "Not connected to that voice channel." };
    }
    entry.stop();
    this.sessions.delete(guildId);
    logVoiceVerbose(`leave: disconnected from guild ${guildId} channel ${entry.channelId}`);
    return {
      ok: true,
      message: `Left ${formatMention({ channelId: entry.channelId })}.`,
      guildId,
      channelId: entry.channelId,
    };
  }

  async destroy(): Promise<void> {
    for (const entry of this.sessions.values()) {
      entry.stop();
    }
    this.sessions.clear();
  }

  private enqueueProcessing(entry: VoiceSessionEntry, task: () => Promise<void>) {
    entry.processingQueue = entry.processingQueue
      .then(task)
      .catch((err) => logger.warn(`discord voice: processing failed: ${formatErrorMessage(err)}`));
  }

  private resumePausedPlayback(entry: VoiceSessionEntry, reason: string) {
    const voiceSdk = loadDiscordVoiceSdk();
    if (entry.player.state.status === voiceSdk.AudioPlayerStatus.Paused) {
      entry.player.unpause();
      logVoiceVerbose(`resumed TTS (${reason}): guild ${entry.guildId}`);
    }
  }

  private enqueuePlayback(entry: VoiceSessionEntry, task: () => Promise<void>) {
    entry.playbackQueue = entry.playbackQueue
      .then(task)
      .catch((err) => logger.warn(`discord voice: playback failed: ${formatErrorMessage(err)}`));
  }

  private async handleSpeakingStart(entry: VoiceSessionEntry, userId: string) {
    if (!userId || entry.activeSpeakers.has(userId)) {
      return;
    }
    if (this.botUserId && userId === this.botUserId) {
      return;
    }

    const voiceSdk = loadDiscordVoiceSdk();

    entry.activeSpeakers.add(userId);
    logVoiceVerbose(
      `capture start: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
    );

    const stream = entry.connection.receiver.subscribe(userId, {
      end: {
        behavior: voiceSdk.EndBehaviorType.AfterSilence,
        duration: SILENCE_DURATION_MS,
      },
    });
    stream.on("error", (err) => {
      this.handleReceiveError(entry, err);
    });

    try {
      const pcm = await decodeOpusStream(stream);
      if (pcm.length === 0) {
        logVoiceVerbose(
          `capture empty: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
        );
        return;
      }
      this.resetDecryptFailureState(entry);
      const { path: wavPath, durationSeconds } = await writeWavFile(pcm);
      if (durationSeconds < MIN_SEGMENT_SECONDS) {
        logVoiceVerbose(
          `capture too short (${durationSeconds.toFixed(2)}s): guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
        );
        return;
      }

      // Segment is long enough — pause TTS while we run Whisper to check content
      const wasPlaying = entry.player.state.status === voiceSdk.AudioPlayerStatus.Playing;
      if (wasPlaying) {
        entry.player.pause(true);
        logVoiceVerbose(`paused TTS for whisper check: guild ${entry.guildId} user ${userId}`);
      }
      logVoiceVerbose(
        `capture ready (${durationSeconds.toFixed(2)}s): guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
      );
      this.enqueueProcessing(entry, async () => {
        await this.processSegment({ entry, wavPath, userId, durationSeconds });
      });
    } finally {
      entry.activeSpeakers.delete(userId);
    }
  }

  private async processSegment(params: {
    entry: VoiceSessionEntry;
    wavPath: string;
    userId: string;
    durationSeconds: number;
  }) {
    const { entry, wavPath, userId, durationSeconds } = params;
    logVoiceVerbose(
      `segment processing (${durationSeconds.toFixed(2)}s): guild ${entry.guildId} channel ${entry.channelId}`,
    );
    if (!entry.guildName) {
      const guild = await this.params.client.fetchGuild(entry.guildId).catch(() => null);
      if (guild && typeof guild.name === "string" && guild.name.trim()) {
        entry.guildName = guild.name;
      }
    }
    const speaker = await this.resolveSpeakerContext(entry.guildId, userId);
    const speakerIdentity = await this.resolveSpeakerIdentity(entry.guildId, userId);
    const access = await authorizeDiscordVoiceIngress({
      cfg: this.params.cfg,
      discordConfig: this.params.discordConfig,
      guildName: entry.guildName,
      guildId: entry.guildId,
      channelId: entry.channelId,
      channelName: entry.channelName,
      channelSlug: entry.channelName ? normalizeDiscordSlug(entry.channelName) : "",
      channelLabel: formatMention({ channelId: entry.channelId }),
      memberRoleIds: speakerIdentity.memberRoleIds,
      sender: {
        id: speakerIdentity.id,
        name: speakerIdentity.name,
        tag: speakerIdentity.tag,
      },
    });
    if (!access.ok) {
      logVoiceVerbose(
        `segment unauthorized: guild ${entry.guildId} channel ${entry.channelId} user ${userId} reason=${access.message}`,
      );
      return;
    }
    // Step 1: Transcribe (post immediately, independent of LLM)
    void this.sendTypingToTextChannel(entry);

    logger.warn(`[voice-pipe] transcribing: ${wavPath} user=${userId}`);

    const transcript = await transcribeAudio({
      cfg: this.params.cfg,
      agentId: entry.route.agentId,
      filePath: wavPath,
    });

    if (!transcript) {
      logger.warn(`[voice-pipe] transcription empty: guild ${entry.guildId} user ${userId}`);
      // Resume TTS if we paused it — Whisper found nothing useful
      this.resumePausedPlayback(entry, "empty transcription");
      return;
    }
    logger.warn(
      `[voice-pipe] transcription: "${transcript.slice(0, 100)}" (${transcript.length} chars)`,
    );

    // Real speech confirmed by Whisper — fully stop TTS
    const voiceSdk2 = loadDiscordVoiceSdk();
    if (
      entry.player.state.status === voiceSdk2.AudioPlayerStatus.Playing ||
      entry.player.state.status === voiceSdk2.AudioPlayerStatus.Paused
    ) {
      logVoiceVerbose(`interrupting TTS for real speech from user ${userId}`);
      entry.player.stop(true);
    }

    // Always post transcription immediately
    void this.postToTextChannel(entry, `🎙️ <@${userId}>: ${transcript}`);

    // Step 2: Start a typing loop that continues until we explicitly stop it
    let typingActive = true;
    const typingLoop = (async () => {
      while (typingActive) {
        await this.sendTypingToTextChannel(entry);
        await new Promise((r) => setTimeout(r, 8_000));
      }
    })();

    try {
      // Step 3: Call the agent
      const prompt = speaker.label ? `${speaker.label}: ${transcript}` : transcript;

      const result = await agentCommandFromIngress(
        {
          message: prompt,
          sessionKey: entry.route.sessionKey,
          agentId: entry.route.agentId,
          messageChannel: "discord",
          senderIsOwner: speaker.senderIsOwner,
          allowModelOverride: false,
          deliver: false,
          extraSystemPrompt:
            "This is a VOICE conversation. Keep responses concise — 1-3 short sentences max. " +
            "The user is listening, not reading. Be direct and conversational. " +
            "Do NOT use markdown, bullet points, code blocks, or long explanations. " +
            "Do NOT use <think> tags or thinking blocks. " +
            "If a task will take time, briefly acknowledge and do it — don't narrate every step.",
        },
        this.params.runtime,
      );

      // Extract reply text from payloads, falling back to raw result text.
      // Some models (Gemini) output <think> blocks without closing tags,
      // which causes empty payloads. Handle this by stripping think blocks ourselves.
      let replyText = (result.payloads ?? [])
        .map((payload) => payload.text)
        .filter((text) => typeof text === "string" && text.trim())
        .join("\n")
        .trim();

      if (!replyText) {
        // Fallback: check if payloads have text buried in think blocks
        const rawTexts = (result.payloads ?? []).map((payload) => payload.text ?? "").join("\n");
        if (rawTexts.includes("<think>")) {
          replyText = rawTexts
            .replace(/<think>[\s\S]*?<\/think>/g, "")
            .replace(/<think>[\s\S]*/g, "")
            .trim();
          if (replyText) {
            logger.warn(`[voice-pipe] recovered reply by stripping think blocks`);
          }
        }
      }

      if (!replyText) {
        logger.warn(`[voice-pipe] agent returned no reply: guild ${entry.guildId} user ${userId}`);
        return;
      }
      logger.warn(
        `[voice-pipe] agent reply: "${replyText.slice(0, 100)}" (${replyText.length} chars)`,
      );

      // Post agent's reply to text channel immediately
      void this.postToTextChannel(entry, `🔊 **Claw:** ${replyText}`);

      // Step 4: Synthesize TTS
      const { cfg: ttsCfg, resolved: ttsConfig } = resolveVoiceTtsConfig({
        cfg: this.params.cfg,
        override: this.params.discordConfig.voice?.tts,
      });
      const directive = parseTtsDirectives(replyText, ttsConfig.modelOverrides, {
        cfg: ttsCfg,
        providerConfigs: ttsConfig.providerConfigs,
      });
      const speakText = directive.overrides.ttsText ?? directive.cleanedText.trim();
      if (!speakText) {
        return;
      }

      logger.warn(
        `[voice-pipe] TTS synthesizing: provider=${ttsConfig.provider ?? "default"} text="${speakText.slice(0, 60)}"`,
      );
      const ttsResult = await getDiscordRuntime().tts.textToSpeech({
        text: speakText,
        cfg: ttsCfg,
        channel: "discord",
        overrides: directive.overrides,
      });
      if (!ttsResult.success || !ttsResult.audioPath) {
        logger.warn(`[voice-pipe] TTS FAILED: ${ttsResult.error ?? "unknown error"}`);
        return;
      }
      const audioPath = ttsResult.audioPath;

      // Step 5: Play back — typing continues during playback
      await new Promise<void>((resolve) => {
        this.enqueuePlayback(entry, async () => {
          const voiceSdk = loadDiscordVoiceSdk();
          const resource = voiceSdk.createAudioResource(audioPath);
          entry.player.play(resource);
          await voiceSdk
            .entersState(
              entry.player,
              voiceSdk.AudioPlayerStatus.Playing,
              PLAYBACK_READY_TIMEOUT_MS,
            )
            .catch(() => undefined);
          await voiceSdk
            .entersState(entry.player, voiceSdk.AudioPlayerStatus.Idle, SPEAKING_READY_TIMEOUT_MS)
            .catch(() => undefined);
          resolve();
        });
      });
    } finally {
      // Stop typing loop after everything completes (including TTS playback)
      typingActive = false;
      await typingLoop.catch(() => undefined);
    }
  }

  private handleReceiveError(entry: VoiceSessionEntry, err: unknown) {
    const message = formatErrorMessage(err);
    logger.warn(`discord voice: receive error: ${message}`);
    if (!DECRYPT_FAILURE_PATTERN.test(message)) {
      return;
    }
    const now = Date.now();
    if (now - entry.lastDecryptFailureAt > DECRYPT_FAILURE_WINDOW_MS) {
      entry.decryptFailureCount = 0;
    }
    entry.lastDecryptFailureAt = now;
    entry.decryptFailureCount += 1;
    if (entry.decryptFailureCount === 1) {
      logger.warn(
        "discord voice: DAVE decrypt failures detected; voice receive may be unstable (upstream: discordjs/discord.js#11419)",
      );
    }
    if (
      entry.decryptFailureCount < DECRYPT_FAILURE_RECONNECT_THRESHOLD ||
      entry.decryptRecoveryInFlight
    ) {
      return;
    }
    entry.decryptRecoveryInFlight = true;
    this.resetDecryptFailureState(entry);
    void this.recoverFromDecryptFailures(entry)
      .catch((recoverErr) =>
        logger.warn(`discord voice: decrypt recovery failed: ${formatErrorMessage(recoverErr)}`),
      )
      .finally(() => {
        entry.decryptRecoveryInFlight = false;
      });
  }

  private resetDecryptFailureState(entry: VoiceSessionEntry) {
    entry.decryptFailureCount = 0;
    entry.lastDecryptFailureAt = 0;
  }

  private async recoverFromDecryptFailures(entry: VoiceSessionEntry) {
    const active = this.sessions.get(entry.guildId);
    if (!active || active.connection !== entry.connection) {
      return;
    }
    logger.warn(
      `discord voice: repeated decrypt failures; attempting rejoin for guild ${entry.guildId} channel ${entry.channelId}`,
    );
    const leaveResult = await this.leave({ guildId: entry.guildId });
    if (!leaveResult.ok) {
      logger.warn(`discord voice: decrypt recovery leave failed: ${leaveResult.message}`);
      return;
    }
    const result = await this.join({ guildId: entry.guildId, channelId: entry.channelId });
    if (!result.ok) {
      logger.warn(`discord voice: rejoin after decrypt failures failed: ${result.message}`);
    }
  }

  private resolveSpeakerIsOwner(params: { id: string; name?: string; tag?: string }): boolean {
    return resolveDiscordOwnerAccess({
      allowFrom: this.ownerAllowFrom,
      sender: {
        id: params.id,
        name: params.name,
        tag: params.tag,
      },
      allowNameMatching: false,
    }).ownerAllowed;
  }

  private resolveSpeakerContextCacheKey(guildId: string, userId: string): string {
    return `${guildId}:${userId}`;
  }

  private getCachedSpeakerContext(
    guildId: string,
    userId: string,
  ):
    | {
        id: string;
        label: string;
        name?: string;
        tag?: string;
        senderIsOwner: boolean;
      }
    | undefined {
    const key = this.resolveSpeakerContextCacheKey(guildId, userId);
    const cached = this.speakerContextCache.get(key);
    if (!cached) {
      return undefined;
    }
    if (cached.expiresAt <= Date.now()) {
      this.speakerContextCache.delete(key);
      return undefined;
    }
    return {
      id: cached.id,
      label: cached.label,
      name: cached.name,
      tag: cached.tag,
      senderIsOwner: cached.senderIsOwner,
    };
  }

  private setCachedSpeakerContext(
    guildId: string,
    userId: string,
    context: {
      id: string;
      label: string;
      name?: string;
      tag?: string;
      senderIsOwner: boolean;
    },
  ): void {
    const key = this.resolveSpeakerContextCacheKey(guildId, userId);
    this.speakerContextCache.set(key, {
      id: context.id,
      label: context.label,
      name: context.name,
      tag: context.tag,
      senderIsOwner: context.senderIsOwner,
      expiresAt: Date.now() + SPEAKER_CONTEXT_CACHE_TTL_MS,
    });
  }

  private async resolveSpeakerContext(
    guildId: string,
    userId: string,
  ): Promise<{
    id: string;
    label: string;
    name?: string;
    tag?: string;
    senderIsOwner: boolean;
  }> {
    const cached = this.getCachedSpeakerContext(guildId, userId);
    if (cached) {
      return cached;
    }
    const identity = await this.resolveSpeakerIdentity(guildId, userId);
    const context = {
      id: identity.id,
      label: identity.label,
      name: identity.name,
      tag: identity.tag,
      senderIsOwner: this.resolveSpeakerIsOwner({
        id: identity.id,
        name: identity.name,
        tag: identity.tag,
      }),
    };
    this.setCachedSpeakerContext(guildId, userId, context);
    return context;
  }

  private async resolveSpeakerIdentity(
    guildId: string,
    userId: string,
  ): Promise<{
    id: string;
    label: string;
    name?: string;
    tag?: string;
    memberRoleIds: string[];
  }> {
    try {
      const member = await this.params.client.fetchMember(guildId, userId);
      const username = member.user?.username ?? undefined;
      return {
        id: userId,
        label: member.nickname ?? member.user?.globalName ?? username ?? userId,
        name: username,
        tag: member.user ? formatDiscordUserTag(member.user) : undefined,
        memberRoleIds: Array.isArray(member.roles)
          ? member.roles
              .map((role) =>
                typeof role === "string" ? role : typeof role?.id === "string" ? role.id : "",
              )
              .filter(Boolean)
          : [],
      };
    } catch {
      try {
        const user = await this.params.client.fetchUser(userId);
        const username = user.username ?? undefined;
        return {
          id: userId,
          label: user.globalName ?? username ?? userId,
          name: username,
          tag: formatDiscordUserTag(user),
          memberRoleIds: [],
        };
      } catch {
        return { id: userId, label: userId, memberRoleIds: [] };
      }
    }
  }
}

export class DiscordVoiceReadyListener extends ReadyListener {
  constructor(private manager: DiscordVoiceManager) {
    super();
  }

  async handle(_data: unknown, _client: Client): Promise<void> {
    void this.manager
      .autoJoin()
      .catch((err) => logger.warn(`discord voice: autoJoin failed: ${formatErrorMessage(err)}`));
  }
}

function isVoiceChannel(type: ChannelType) {
  return type === ChannelType.GuildVoice || type === ChannelType.GuildStageVoice;
}
