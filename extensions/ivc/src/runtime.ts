import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
import type { PluginRuntime } from "openclaw/plugin-sdk";

const { setRuntime: setIvcRuntime, getRuntime: getIvcRuntime } =
  createPluginRuntimeStore<PluginRuntime>("IVC runtime not initialized");
export { getIvcRuntime, setIvcRuntime };
