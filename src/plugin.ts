import type { PluginContext } from "@weivel/typescript/context";
import { Catalog } from "./catalog.js";
import type { Proxy } from "./fetch.js";
import { hooksOf, type Hooks } from "./hooks.js";
import { ANTHROPIC_ENUM_NAMES, LOG_ENUM_NAMES, PROVIDER_ENUM_NAMES, ROUTING_ENUM_NAMES, type Anthropic, type Config, type Enums, type Log, type LogLine, type Provider, type Routing } from "./services.js";
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

/**
 * Every enum entry this plugin reads, from the descriptions of what it reaches, refusing the activation when one lacks a
 * name it reads.
 *
 * @implNote They are read once, at the activation, which holds because a header's enums are append-only: an entry never
 * changes its number while the plugin runs.
 */
function enumsOf(context: PluginContext, reached: { routing: Routing; anthropic: Anthropic; log: Log }): Enums {
  const { services, capabilities } = context;
  return {
    routing: context.requireEnums(services.enumsOf(reached.routing), ROUTING_ENUM_NAMES, "routing"),
    anthropic: context.requireEnums(services.enumsOf(reached.anthropic), ANTHROPIC_ENUM_NAMES, "anthropic"),
    provider: context.requireEnums(capabilities.enumsOf(context.capability(PROVIDER_CAPABILITY)), PROVIDER_ENUM_NAMES, PROVIDER_CAPABILITY),
    log: context.requireEnums(services.enumsOf(reached.log), LOG_ENUM_NAMES, "weivel.log"),
  };
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
  const log = required<Log>(context, "weivel.log");
  const enums = enumsOf(context, { routing, anthropic, log });
  const settings = await readSettings(required<Config>(context, "weivel.config"));
  const providerType = context.capability<Provider>(PROVIDER_CAPABILITY);
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
