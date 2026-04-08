import { z } from "zod";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";

export const IvcConfigSchema = z
  .object({
    /** Whether the IVC channel is enabled. */
    enabled: z.boolean().optional(),
    /** Target session key to inject transcriptions into (e.g. "discord:channel:123"). */
    targetSession: z.string().optional(),
    /** Port for the HTTP listener that receives transcriptions from master-controller. */
    listenPort: z.number().int().min(1).max(65535).optional(),
    /** Bind address for the HTTP listener. */
    listenHost: z.string().optional(),
    /** Whether TTS playback is enabled for responses. */
    ttsEnabled: z.boolean().optional(),
    /** Base URL of the IVC master-controller (e.g. "http://192.168.5.81:54321"). */
    masterControllerUrl: z.string().url().optional(),
    /** Shared secret for /api/tts_play authentication (Bearer token). */
    ttsSecret: z.string().optional(),
  })
  .strict();

export type IvcConfig = z.infer<typeof IvcConfigSchema>;

export const DEFAULT_LISTEN_PORT = 54322;
export const DEFAULT_LISTEN_HOST = "127.0.0.1";
export const DEFAULT_MASTER_CONTROLLER_URL = "http://192.168.5.81:54321";

export interface ResolvedIvcAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: IvcConfig;
  targetSession: string;
  listenPort: number;
  listenHost: string;
  ttsEnabled: boolean;
  masterControllerUrl: string;
}

export function resolveIvcAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedIvcAccount {
  const ivcSection = (params.cfg as Record<string, unknown>).channels?.ivc ?? {};
  const parsed = IvcConfigSchema.safeParse(ivcSection);
  if (!parsed.success) {
    throw new Error(
      `Invalid channels.ivc config: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
    );
  }
  const config = parsed.data;
  const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;

  return {
    accountId,
    enabled: config.enabled !== false,
    config,
    targetSession: config.targetSession ?? "",
    listenPort: config.listenPort ?? DEFAULT_LISTEN_PORT,
    listenHost: config.listenHost ?? DEFAULT_LISTEN_HOST,
    ttsEnabled: config.ttsEnabled ?? true,
    masterControllerUrl:
      config.masterControllerUrl ?? DEFAULT_MASTER_CONTROLLER_URL,
  };
}

/** Read the ivc config section from the OpenClaw config. */
export function getIvcConfig(cfg: OpenClawConfig): IvcConfig {
  const channels = (cfg as Record<string, unknown>).channels as
    | Record<string, unknown>
    | undefined;
  return (channels?.ivc ?? {}) as IvcConfig;
}
