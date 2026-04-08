import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { ivcPlugin } from "./src/channel.js";
import { setIvcRuntime } from "./src/runtime.js";

const plugin = {
  id: "ivc",
  name: "IVC",
  description: "Intelligent Voice Controller channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setIvcRuntime(api.runtime);
    api.registerChannel({ plugin: ivcPlugin as ChannelPlugin });
  },
};

export default plugin;
