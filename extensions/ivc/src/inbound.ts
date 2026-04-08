/**
 * Inbound message handler for IVC transcriptions.
 *
 * Processes voice transcriptions through OpenClaw's trusted auto-reply
 * pipeline — the same path that Discord text messages use. This avoids
 * the EXTERNAL_UNTRUSTED_CONTENT security wrapper that /hooks/agent applies.
 *
 * The key design choice: IVC injects into the Discord channel session
 * (e.g. "discord:channel:123") so voice and text share conversation
 * history, memories, and agent context.
 */
import {
  dispatchInboundReplyWithBase,
  formatTextWithAttachmentLinks,
  resolveOutboundMediaUrls,
  type OutboundReplyPayload,
  type OpenClawConfig,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import type { ResolvedIvcAccount } from "./config.js";
import { getIvcRuntime } from "./runtime.js";

const CHANNEL_ID = "ivc" as const;

export interface IvcInboundMessage {
  /** Transcription text from Whisper. */
  text: string;
  /** Sender display name (e.g. "Zachary (Voice)"). */
  senderName: string;
  /** Sender ID for session tracking. */
  senderId?: string;
  /** Unix timestamp in milliseconds. */
  timestamp: number;
  /** Unique message ID for deduplication. */
  messageId?: string;
}

async function deliverIvcReply(params: {
  payload: OutboundReplyPayload;
  account: ResolvedIvcAccount;
  onDeliver?: (text: string) => Promise<void>;
}) {
  const combined = formatTextWithAttachmentLinks(
    params.payload.text,
    resolveOutboundMediaUrls(params.payload),
  );
  if (!combined) {
    return;
  }

  // Deliver through /api/tts_play which handles everything:
  // mention sanitization, Discord posting, LED/typing stop, and TTS audio
  if (params.onDeliver) {
    try {
      await params.onDeliver(combined);
    } catch (err) {
      console.error("[ivc] delivery failed:", err);
    }
  }
}

export async function handleIvcInbound(params: {
  message: IvcInboundMessage;
  account: ResolvedIvcAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  onDeliver?: (text: string) => Promise<void>;
  statusSink?: (patch: {
    lastInboundAt?: number;
    lastOutboundAt?: number;
  }) => void;
}): Promise<void> {
  const { message, account, config, runtime, statusSink } = params;
  const core = getIvcRuntime();

  const rawBody = message.text?.trim() ?? "";
  if (!rawBody) {
    return;
  }

  statusSink?.({ lastInboundAt: message.timestamp });

  // The target session is the Discord channel session — voice and text share it
  const sessionKey = account.targetSession;
  if (!sessionKey) {
    runtime.error?.(
      "ivc: no targetSession configured — cannot inject transcription",
    );
    return;
  }

  // Resolve route for the target session
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: "group",
      id: sessionKey,
    },
  });

  // Override route session key to use the Discord channel session directly
  const routeSessionKey = sessionKey;

  const storePath = core.channel.session.resolveStorePath(
    (config as Record<string, unknown>).session?.store,
    { agentId: route.agentId },
  );

  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(
    config,
  );
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: routeSessionKey,
  });

  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Voice",
    from: message.senderName,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `ivc:voice:${message.senderId ?? "user"}`,
    To: sessionKey,
    SessionKey: routeSessionKey,
    AccountId: route.accountId,
    ChatType: "group",
    ConversationLabel: message.senderName,
    SenderName: message.senderName,
    SenderId: message.senderId ?? "voice-user",
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: message.messageId,
    Timestamp: message.timestamp,
    // Delivery routes back through IVC (for TTS) but session is shared with Discord
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: sessionKey,
    // Voice messages are always authorized (physical mic access = authentication)
    CommandAuthorized: true,
  });

  await dispatchInboundReplyWithBase({
    cfg: config,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    route: { ...route, sessionKey: routeSessionKey },
    storePath,
    ctxPayload,
    core,
    deliver: async (payload) => {
      await deliverIvcReply({
        payload,
        account,
        onDeliver: params.onDeliver,
      });
      statusSink?.({ lastOutboundAt: Date.now() });
    },
    onRecordError: (err) => {
      runtime.error?.(
        `ivc: failed updating session meta: ${String(err)}`,
      );
    },
    onDispatchError: (err, info) => {
      runtime.error?.(
        `ivc: ${info.kind} reply failed: ${String(err)}`,
      );
    },
  });
}
