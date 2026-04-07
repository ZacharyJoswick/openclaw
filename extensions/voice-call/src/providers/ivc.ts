/**
 * IVC (Intelligent Voice Controller) provider for OpenClaw voice-call extension.
 *
 * Maps physical mic/speaker hardware to the voice-call provider interface:
 *   - Unmute (DESK_MIC/AMBIENT_MIC) = call in progress
 *   - Mute = call ended / hangup
 *   - Transcription from Whisper = call.speech event
 *   - Agent response = playTts() → ElevenLabs → pw-play → speakers
 *
 * All communication is via HTTP to the master-controller on the LAN.
 */
import crypto from "node:crypto";
import type {
  EndReason,
  GetCallStatusInput,
  GetCallStatusResult,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  NormalizedEvent,
  PlayTtsInput,
  WebhookParseOptions,
  ProviderWebhookParseResult,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookVerificationResult,
} from "../types.js";
import type { VoiceCallProvider } from "./base.js";

export interface IvcProviderConfig {
  /** Base URL for the master-controller API (e.g. "http://192.168.5.81:54321") */
  masterControllerUrl?: string;
  /** Shared secret for /api/tts_play authentication (Bearer token) */
  ttsSecret?: string;
}

/**
 * IVC voice-call provider for local mic/speaker hardware.
 *
 * Webhooks arrive from the master-controller as normalized voice-call events.
 * TTS is played back through the master-controller's ElevenLabs + pw-play pipeline.
 */
export class IvcProvider implements VoiceCallProvider {
  readonly name = "ivc" as const;
  private readonly masterControllerUrl: string;
  private readonly ttsSecret: string;

  constructor(config?: IvcProviderConfig) {
    this.masterControllerUrl = config?.masterControllerUrl ?? "http://192.168.5.81:54321";
    this.ttsSecret = config?.ttsSecret ?? "";
  }

  /**
   * LAN-only provider — no webhook signature verification needed.
   */
  verifyWebhook(_ctx: WebhookContext): WebhookVerificationResult {
    return { ok: true, verifiedRequestKey: "ivc-local" };
  }

  /**
   * Parse webhook events from the master-controller.
   *
   * The master-controller forwards transcriptions as normalized events:
   *   { events: [{ type: "call.speech", transcript, isFinal, callId, ... }] }
   *
   * Also handles call lifecycle events (call.initiated, call.active, call.ended).
   */
  parseWebhookEvent(
    ctx: WebhookContext,
    _options?: WebhookParseOptions,
  ): ProviderWebhookParseResult {
    try {
      const payload = JSON.parse(ctx.rawBody);
      const events: NormalizedEvent[] = [];

      if (Array.isArray(payload.events)) {
        for (const evt of payload.events) {
          const normalized = this.normalizeEvent(evt);
          if (normalized) {
            events.push(normalized);
          }
        }
      } else if (payload.event) {
        const normalized = this.normalizeEvent(payload.event);
        if (normalized) {
          events.push(normalized);
        }
      }

      return { events, statusCode: 200 };
    } catch {
      return { events: [], statusCode: 400 };
    }
  }

  private normalizeEvent(evt: Partial<NormalizedEvent>): NormalizedEvent | null {
    if (!evt.type || !evt.callId) {
      return null;
    }

    const base = {
      id: evt.id ?? crypto.randomUUID(),
      callId: evt.callId,
      providerCallId: evt.providerCallId,
      direction: (evt as Record<string, unknown>).direction as string ?? "inbound",
      from: (evt as Record<string, unknown>).from as string ?? "+15550000000",
      to: (evt as Record<string, unknown>).to as string ?? "+15550000000",
      timestamp: evt.timestamp ?? Date.now(),
    };

    switch (evt.type) {
      case "call.initiated":
      case "call.ringing":
      case "call.answered":
      case "call.active":
        return { ...base, type: evt.type };

      case "call.speech": {
        const payload = evt as Partial<
          NormalizedEvent & {
            transcript?: string;
            isFinal?: boolean;
            confidence?: number;
          }
        >;
        return {
          ...base,
          type: evt.type,
          transcript: payload.transcript ?? "",
          isFinal: payload.isFinal ?? true,
          confidence: payload.confidence,
        };
      }

      case "call.speaking": {
        const payload = evt as Partial<NormalizedEvent & { text?: string }>;
        return {
          ...base,
          type: evt.type,
          text: payload.text ?? "",
        };
      }

      case "call.silence": {
        const payload = evt as Partial<NormalizedEvent & { durationMs?: number }>;
        return {
          ...base,
          type: evt.type,
          durationMs: payload.durationMs ?? 0,
        };
      }

      case "call.ended": {
        const payload = evt as Partial<NormalizedEvent & { reason?: EndReason }>;
        return {
          ...base,
          type: evt.type,
          reason: payload.reason ?? "completed",
        };
      }

      case "call.error": {
        const payload = evt as Partial<NormalizedEvent & { error?: string; retryable?: boolean }>;
        return {
          ...base,
          type: evt.type,
          error: payload.error ?? "unknown error",
          retryable: payload.retryable,
        };
      }

      default:
        return null;
    }
  }

  /**
   * Initiate a "call" by activating a mic mode on the master-controller.
   * Queries current mode first -- only switches to DESK_MIC if currently muted.
   */
  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    let mode = "DESK_MIC";

    // Query current mode -- if already on a mic, keep it
    try {
      const statusResp = await fetch(`${this.masterControllerUrl}/status`);
      if (statusResp.ok) {
        const data = (await statusResp.json()) as { mode?: string };
        const current = data.mode ?? "MUTED";
        if (current === "DESK_MIC" || current === "AMBIENT_MIC") {
          mode = current;
        }
      }
    } catch {
      // Fall through to default DESK_MIC
    }

    try {
      const resp = await fetch(`${this.masterControllerUrl}/set_mode/${mode}`, {
        method: "POST",
      });
      if (!resp.ok) {
        console.error(`[ivc] Failed to set mode ${mode}: ${resp.status}`);
      }
    } catch (err) {
      console.error(`[ivc] Failed to reach master-controller:`, err);
    }

    return {
      providerCallId: `ivc-${input.callId}`,
      status: "initiated",
    };
  }

  /**
   * Hang up by muting the controller.
   */
  async hangupCall(_input: HangupCallInput): Promise<void> {
    try {
      const resp = await fetch(`${this.masterControllerUrl}/set_mode/MUTED`, {
        method: "POST",
      });
      if (!resp.ok) {
        console.error(`[ivc] Failed to mute: ${resp.status}`);
      }
    } catch (err) {
      console.error(`[ivc] Failed to reach master-controller for hangup:`, err);
    }
  }

  /**
   * Play TTS by sending text to the master-controller's TTS endpoint.
   * The master-controller calls ElevenLabs streaming API and plays via pw-play.
   */
  async playTts(input: PlayTtsInput): Promise<void> {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.ttsSecret) {
        headers["Authorization"] = `Bearer ${this.ttsSecret}`;
      }
      const resp = await fetch(`${this.masterControllerUrl}/api/tts_play`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          text: input.text,
          voice_id: input.voice,
        }),
      });
      if (!resp.ok) {
        const body = await resp.text();
        console.error(`[ivc] TTS playback failed: ${resp.status} ${body}`);
      }
    } catch (err) {
      console.error(`[ivc] Failed to reach master-controller for TTS:`, err);
    }
  }

  /**
   * No-op -- VAD on the whisper-processor handles speech detection.
   */
  async startListening(_input: StartListeningInput): Promise<void> {
    // Always listening when mic is active — VAD handles silence detection
  }

  /**
   * No-op -- VAD on the whisper-processor handles speech detection.
   */
  async stopListening(_input: StopListeningInput): Promise<void> {
    // VAD handles silence detection
  }

  /**
   * Check call status by querying the master-controller mode.
   * Active mic mode = in-progress, MUTED = completed.
   */
  async getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult> {
    try {
      const resp = await fetch(`${this.masterControllerUrl}/status`);
      if (resp.ok) {
        const data = (await resp.json()) as { mode?: string };
        const mode = data.mode ?? "MUTED";
        if (mode === "DESK_MIC" || mode === "AMBIENT_MIC") {
          return { status: "in-progress", isTerminal: false };
        }
        return { status: "completed", isTerminal: true };
      }
    } catch {
      // Transient error — report unknown so the call isn't reaped
      return { status: "unknown", isTerminal: false, isUnknown: true };
    }

    return { status: "completed", isTerminal: true };
  }
}
