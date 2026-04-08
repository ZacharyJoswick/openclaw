/**
 * IVC gateway — HTTP server that receives transcriptions from the
 * master-controller and feeds them through the trusted inbound pipeline.
 *
 * Outbound delivery routes through the master-controller's /api/tts_play
 * endpoint, which handles Discord posting, mention sanitization, LED/typing
 * indicator cleanup, and TTS audio playback (when enabled).
 */
import http from "node:http";
import crypto from "node:crypto";
import {
  createAccountStatusSink,
  type ChannelGatewayContext,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import type { ResolvedIvcAccount } from "./config.js";
import { handleIvcInbound, type IvcInboundMessage } from "./inbound.js";

/** Payload sent by the master-controller for each transcription. */
interface TranscriptionPayload {
  text: string;
  sender_name?: string;
  sender_id?: string;
  timestamp?: number;
  message_id?: string;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY = 64 * 1024; // 64 KB limit
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * Deliver response text through the master-controller's /api/tts_play
 * endpoint. This single endpoint handles everything:
 * - Mention sanitization (@everyone, @here)
 * - Discord posting (text record)
 * - LED/typing indicator cleanup
 * - TTS audio playback (when enabled)
 */
async function deliverViaTtsPlay(
  masterControllerUrl: string,
  text: string,
  ttsSecret?: string,
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (ttsSecret) {
    headers["Authorization"] = `Bearer ${ttsSecret}`;
  }
  const resp = await fetch(`${masterControllerUrl}/api/tts_play`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`tts_play delivery failed: ${resp.status} ${body}`);
  }
}

export async function startIvcGateway(
  ctx: ChannelGatewayContext<ResolvedIvcAccount>,
): Promise<void> {
  const { account, cfg, runtime, abortSignal, log } = ctx;
  const statusSink = createAccountStatusSink({
    accountId: ctx.accountId,
    setStatus: ctx.setStatus,
  });

  if (!account.targetSession) {
    throw new Error(
      'IVC channel is not configured: set channels.ivc.targetSession (e.g. "discord:channel:123")',
    );
  }

  log?.info(
    `[${account.accountId}] starting IVC gateway on ${account.listenHost}:${account.listenPort}`,
  );
  log?.info(
    `[${account.accountId}] target session: ${account.targetSession}`,
  );

  const server = http.createServer(async (req, res) => {
    // Health check
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", channel: "ivc" }));
      return;
    }

    // Transcription inbound endpoint
    if (req.method === "POST" && req.url === "/inbound") {
      // Loopback guard: only accept requests from localhost.
      // CommandAuthorized is set to true in inbound.ts because physical
      // mic access constitutes authentication — this guard ensures that
      // trust boundary by rejecting non-local connections.
      const remoteAddr = req.socket.remoteAddress ?? "";
      const isLoopback =
        remoteAddr === "127.0.0.1" ||
        remoteAddr === "::1" ||
        remoteAddr === "::ffff:127.0.0.1";
      if (!isLoopback) {
        log?.warn(
          `[${account.accountId}] rejected non-loopback request from ${remoteAddr}`,
        );
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden: loopback only" }));
        return;
      }

      try {
        const rawBody = await readBody(req);
        const payload: TranscriptionPayload = JSON.parse(rawBody);

        if (!payload.text?.trim()) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "missing text" }));
          return;
        }

        const message: IvcInboundMessage = {
          text: payload.text,
          senderName: payload.sender_name ?? "Zachary (Voice)",
          senderId: payload.sender_id,
          timestamp: payload.timestamp ?? Date.now(),
          messageId:
            payload.message_id ?? `ivc-${crypto.randomUUID()}`,
        };

        log?.info(
          `[${account.accountId}] transcription received: ${message.text.slice(0, 80)}...`,
        );

        // Respond immediately — dispatch happens async
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "accepted" }));

        // Process through trusted inbound pipeline.
        // All delivery goes through /api/tts_play which handles
        // Discord posting, mention sanitization, indicators, and TTS.
        handleIvcInbound({
          message,
          account,
          config: cfg as OpenClawConfig,
          runtime,
          onDeliver: (text) =>
            deliverViaTtsPlay(
              account.masterControllerUrl,
              text,
              account.config.ttsSecret,
            ),
          statusSink: (patch) => {
            if (patch.lastInboundAt) {
              statusSink({ lastInboundAt: patch.lastInboundAt });
            }
            if (patch.lastOutboundAt) {
              statusSink({ lastOutboundAt: patch.lastOutboundAt });
            }
          },
        }).catch((err) => {
          log?.error(
            `[${account.accountId}] inbound dispatch failed: ${String(err)}`,
          );
        });
      } catch (err) {
        log?.error(
          `[${account.accountId}] request error: ${String(err)}`,
        );
        if (!res.headersSent) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "bad request" }));
        }
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  // Graceful shutdown on abort
  abortSignal.addEventListener(
    "abort",
    () => {
      log?.info(`[${account.accountId}] shutting down IVC gateway`);
      server.close();
    },
    { once: true },
  );

  await new Promise<void>((resolve, reject) => {
    server.on("error", (err) => {
      log?.error(
        `[${account.accountId}] gateway server error: ${String(err)}`,
      );
      reject(err);
    });

    server.listen(account.listenPort, account.listenHost, () => {
      log?.info(
        `[${account.accountId}] IVC gateway listening on ${account.listenHost}:${account.listenPort}`,
      );
      statusSink({
        running: true,
        connected: true,
        lastStartAt: Date.now(),
      });
      resolve();
    });
  });

  // Keep alive until abort
  await new Promise<void>((resolve) => {
    if (abortSignal.aborted) {
      resolve();
      return;
    }
    abortSignal.addEventListener("abort", () => resolve(), {
      once: true,
    });
  });
}
