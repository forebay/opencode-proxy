import type { DescribedEnums, PluginContext } from "@weivel/typescript/context";
import { Catalog } from "./catalog.js";
import type { Proxy } from "./fetch.js";
import { hooksOf, type Hooks } from "./hooks.js";
import type { Anthropic, Config, Enums, Log, LogLine, Provider, Routing } from "./services.js";
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

/** The enums a description carries, read as the names this plugin reads of them. */
function described<Read>(enums: DescribedEnums | undefined, of: string): Read {
  if (enums === undefined) throw new Error(`opencode-proxy reads the enums of ${of}, and no description carries them`);
  return enums as unknown as Read;
}

function logWriter(log: Log, enums: Enums): (lines: readonly LogLine[]) => void {
  const { FOREBAY_LOG_WARN } = enums.routing.forebay_log_level;
  const { WEIVEL_STANDARD_LOG_INFO, WEIVEL_STANDARD_LOG_WARN } = enums.log.weivel_standard_log_level;
  return (lines) => {
    for (const line of lines) {
      void log.write({ level: line.level === FOREBAY_LOG_WARN ? WEIVEL_STANDARD_LOG_WARN : WEIVEL_STANDARD_LOG_INFO, message: line.message }).catch(() => undefined);
    }
  };
}

async function started(context: PluginContext): Promise<Running> {
  const routing = required<Routing>(context, "routing");
  const anthropic = required<Anthropic>(context, "anthropic");
  const settings = await readSettings(required<Config>(context, "weivel.config"));
  const log = required<Log>(context, "weivel.log");
  const providerType = context.capability<Provider>(PROVIDER_CAPABILITY);
  const enums: Enums = {
    routing: described(context.services.enumsOf(routing), "routing"),
    anthropic: described(context.services.enumsOf(anthropic), "anthropic"),
    provider: described(context.capabilities.enumsOf(providerType), PROVIDER_CAPABILITY),
    log: described(context.services.enumsOf(log), "weivel.log"),
  };
  const writeLog = logWriter(log, enums);
  const limits = await routing.limits({});
  const providers = (): Provider[] => context.capabilities.all(providerType);
  const catalog = await Catalog.opened({ providers, routing, enums: enums.routing, profile: settings.profile, settings: settings.record, writeLog, now: Date.now });
  const proxy: Proxy = { routing, anthropic, enums, settings, limits, catalog, writeLog };
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
