import type { PluginContext } from "@weivel/typescript/context";
import { Catalog } from "./catalog.js";
import type { Proxy } from "./fetch.js";
import { hooksOf, type Hooks } from "./hooks.js";
import { LOG_LEVEL, WEIVEL_LOG } from "./kinds.js";
import type { Anthropic, Config, Log, LogLine, Provider, Routing } from "./services.js";
import { readSettings } from "./settings.js";

const PROVIDER_CAPABILITY = "forebay.provider";

/** The service OpenCode's in-process entry asks for: a function from OpenCode's plugin input to its hooks. */
const OPENCODE_PLUGIN_SERVICE = "opencode-proxy:opencode-plugin";

export type OpencodePlugin = (input: unknown) => Promise<Hooks>;

interface Running {
  readonly catalog: Catalog;
  readonly unregister: () => void;
}

function required<Service>(context: PluginContext, id: string): Service {
  const service = context.services.get(context.service<Service>(id));
  if (service === undefined) throw new Error(`opencode-proxy reaches no ${id} service`);
  return service;
}

function logWriter(log: Log): (lines: readonly LogLine[]) => void {
  return (lines) => {
    for (const line of lines) {
      void log.write({ level: line.level === LOG_LEVEL.WARN ? WEIVEL_LOG.WARN : WEIVEL_LOG.INFO, message: line.message }).catch(() => undefined);
    }
  };
}

async function started(context: PluginContext): Promise<Running> {
  const routing = required<Routing>(context, "routing");
  const anthropic = required<Anthropic>(context, "anthropic");
  const settings = await readSettings(required<Config>(context, "weivel.config"));
  const writeLog = logWriter(required<Log>(context, "weivel.log"));
  const limits = await routing.limits({});
  const providers = (): Provider[] => context.capabilities.all(context.capability<Provider>(PROVIDER_CAPABILITY));
  const catalog = await Catalog.opened({ providers, routing, profile: settings.profile, settings: settings.record, writeLog, now: Date.now });
  const proxy: Proxy = { routing, anthropic, settings, limits, catalog, writeLog };
  const plugin: OpencodePlugin = async () => hooksOf(proxy);
  const unregister = context.services.register(context.service<OpencodePlugin>(OPENCODE_PLUGIN_SERVICE), plugin);
  return { catalog, unregister };
}

function proxyPlugin(): { activate(context: PluginContext): Promise<void>; deactivate(): Promise<void> } {
  let running: Running | undefined;
  return {
    async activate(context) {
      running = await started(context);
    },
    async deactivate() {
      const stopping = running;
      running = undefined;
      if (stopping === undefined) return;
      stopping.unregister();
      stopping.catalog.release();
    },
  };
}

export default proxyPlugin();
