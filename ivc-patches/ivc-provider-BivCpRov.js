import crypto from "node:crypto";
//#region extensions/voice-call/src/providers/ivc.ts
/**
 * IVC (Intelligent Voice Controller) provider for OpenClaw voice-call extension.
 */
var IvcProvider = class {
	constructor(config) {
		this.name = "ivc";
		this.masterControllerUrl = config?.masterControllerUrl ?? "http://192.168.5.81:54321";
		this.ttsSecret = config?.ttsSecret ?? "";
	}
	verifyWebhook(_ctx) {
		return { ok: true, verifiedRequestKey: "ivc-local" };
	}
	parseWebhookEvent(ctx, _options) {
		try {
			const payload = JSON.parse(ctx.rawBody);
			const events = [];
			if (Array.isArray(payload.events)) {
				for (const evt of payload.events) {
					const normalized = this.normalizeEvent(evt);
					if (normalized) events.push(normalized);
				}
			} else if (payload.event) {
				const normalized = this.normalizeEvent(payload.event);
				if (normalized) events.push(normalized);
			}
			return { events, statusCode: 200 };
		} catch {
			return { events: [], statusCode: 400 };
		}
	}
	normalizeEvent(evt) {
		if (!evt.type || !evt.callId) return null;
		const base = {
			id: evt.id ?? crypto.randomUUID(),
			callId: evt.callId,
			providerCallId: evt.providerCallId,
			timestamp: evt.timestamp ?? Date.now()
		};
		switch (evt.type) {
			case "call.initiated":
			case "call.ringing":
			case "call.answered":
			case "call.active":
				return { ...base, type: evt.type };
			case "call.speech":
				return {
					...base,
					type: evt.type,
					transcript: evt.transcript ?? "",
					isFinal: evt.isFinal ?? true,
					confidence: evt.confidence
				};
			case "call.speaking":
				return { ...base, type: evt.type, text: evt.text ?? "" };
			case "call.silence":
				return { ...base, type: evt.type, durationMs: evt.durationMs ?? 0 };
			case "call.ended":
				return { ...base, type: evt.type, reason: evt.reason ?? "completed" };
			case "call.error":
				return { ...base, type: evt.type, error: evt.error ?? "unknown error", retryable: evt.retryable };
			default:
				return null;
		}
	}
	async initiateCall(input) {
		let mode = "DESK_MIC";
		try {
			const statusResp = await fetch(`${this.masterControllerUrl}/status`);
			if (statusResp.ok) {
				const data = await statusResp.json();
				const current = data.mode ?? "MUTED";
				if (current === "DESK_MIC" || current === "AMBIENT_MIC") mode = current;
			}
		} catch {}
		try {
			const resp = await fetch(`${this.masterControllerUrl}/set_mode/${mode}`, { method: "POST" });
			if (!resp.ok) console.error(`[ivc] Failed to set mode ${mode}: ${resp.status}`);
		} catch (err) {
			console.error(`[ivc] Failed to reach master-controller:`, err);
		}
		return { providerCallId: `ivc-${input.callId}`, status: "initiated" };
	}
	async hangupCall(_input) {
		try {
			const resp = await fetch(`${this.masterControllerUrl}/set_mode/MUTED`, { method: "POST" });
			if (!resp.ok) console.error(`[ivc] Failed to mute: ${resp.status}`);
		} catch (err) {
			console.error(`[ivc] Failed to reach master-controller for hangup:`, err);
		}
	}
	async playTts(input) {
		try {
			const headers = { "Content-Type": "application/json" };
			if (this.ttsSecret) headers["Authorization"] = `Bearer ${this.ttsSecret}`;
			const resp = await fetch(`${this.masterControllerUrl}/api/tts_play`, {
				method: "POST",
				headers,
				body: JSON.stringify({ text: input.text, voice_id: input.voice })
			});
			if (!resp.ok) {
				const body = await resp.text();
				console.error(`[ivc] TTS playback failed: ${resp.status} ${body}`);
			}
		} catch (err) {
			console.error(`[ivc] Failed to reach master-controller for TTS:`, err);
		}
	}
	async startListening(_input) {}
	async stopListening(_input) {}
	async getCallStatus(input) {
		try {
			const resp = await fetch(`${this.masterControllerUrl}/status`);
			if (resp.ok) {
				const data = await resp.json();
				const mode = data.mode ?? "MUTED";
				if (mode === "DESK_MIC" || mode === "AMBIENT_MIC") return { status: "in-progress", isTerminal: false };
				return { status: "completed", isTerminal: true };
			}
		} catch {
			return { status: "unknown", isTerminal: false, isUnknown: true };
		}
		return { status: "completed", isTerminal: true };
	}
};
//#endregion
export { IvcProvider };
