/**
 * IVC channel plugin definition.
 *
 * Registers "ivc" as a channel that receives voice transcriptions from the
 * master-controller via HTTP and processes them through OpenClaw's trusted
 * inbound pipeline, sharing the Discord channel session.
 */
import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  getChatChannelMeta,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import {
  IvcConfigSchema,
  resolveIvcAccount,
  type ResolvedIvcAccount,
} from "./config.js";
import { startIvcGateway } from "./gateway.js";

const meta = getChatChannelMeta("ivc");

export const ivcPlugin: ChannelPlugin<ResolvedIvcAccount> = {
  id: "ivc",
  meta: {
    // getChatChannelMeta may not have ivc registered — provide fallback
    id: meta?.id ?? "ivc",
    label: meta?.label ?? "IVC",
    selectionLabel: meta?.selectionLabel ?? "Intelligent Voice Controller",
    docsPath: meta?.docsPath ?? "plugins/ivc",
    blurb:
      meta?.blurb ??
      "Voice transcription channel for the Intelligent Voice Controller",
    order: meta?.order ?? 999,
  },
  capabilities: {
    // Voice transcriptions inject into group (channel) sessions
    chatTypes: ["channel"],
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.ivc"] },
  configSchema: buildChannelConfigSchema(IvcConfigSchema),
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg, accountId) =>
      resolveIvcAccount({ cfg, accountId }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account) => Boolean(account.targetSession?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: Boolean(account.targetSession?.trim()),
      port: account.listenPort,
    }),
  },
  outbound: {
    // Delivery is handled inline in the gateway (TTS + Discord post)
    // The outbound adapter is a no-op fallback for any framework-level delivery
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async ({ to, text }) => {
      // Outbound delivery is handled by the inbound dispatch deliver callback.
      // This is a fallback in case the framework routes a message here directly.
      console.warn(
        `[ivc] unexpected outbound sendText to=${to}, text length=${text.length}`,
      );
      return { channel: "ivc" };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ account, snapshot }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: Boolean(account.targetSession),
      targetSession: account.targetSession,
      listenPort: account.listenPort,
      ttsEnabled: account.ttsEnabled,
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: Boolean(account.targetSession?.trim()),
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
      port: account.listenPort,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.targetSession) {
        throw new Error(
          `IVC is not configured for account "${account.accountId}" — set channels.ivc.targetSession`,
        );
      }
      ctx.log?.info(
        `[${account.accountId}] starting IVC channel (target: ${account.targetSession})`,
      );
      await startIvcGateway(ctx);
    },
  },
};
