import type { Config, RoutingProfile } from "./services.js";

/**
 * What the `config` hook names the provider it adds to OpenCode, the base its model requests are addressed to, and the
 * placeholder token the model client sends as `Authorization: Bearer`, which `placeholderAuthorization` names whole.
 */
export interface OpencodeSettings {
  readonly providerId: unknown;
  readonly providerName: unknown;
  readonly baseURL: unknown;
  readonly authToken: unknown;
}

export interface ProxySettings {
  readonly upstream: unknown;
  readonly placeholderAuthorization: unknown;
  readonly profile: RoutingProfile;
  readonly loginCommand: unknown;
  readonly settingsFile: unknown;
  /** The settings record `model_map` reads the stored map from, `routing` as the config holds it. */
  readonly record: { readonly routing: unknown };
  readonly opencode: OpencodeSettings;
}

type Tree = Readonly<Record<string, unknown>>;

/** A setting whole as the config holds it, undefined when it is neither stored nor defaulted. */
async function settingOf(config: Config, key: string): Promise<unknown> {
  const answer = await config.get_tree({ key });
  return typeof answer === "symbol" ? undefined : answer;
}

function member(record: unknown, name: string): unknown {
  return typeof record === "object" && record !== null && !Array.isArray(record) ? (record as Tree)[name] : undefined;
}

function profileOf(routing: unknown): RoutingProfile {
  return {
    tier_source_provider: member(routing, "tierSourceProvider"),
    tier_order: member(routing, "tierOrder"),
    tier_fallback: member(routing, "tierFallback"),
    tier_regex: member(routing, "tierRegex"),
    native_model_pattern: member(routing, "nativeModelPattern"),
    default_context: member(routing, "defaultContext"),
    default_output: member(routing, "defaultOutput"),
  };
}

/** The file the config writes, which C names to the user; undefined when the config keeps its settings in none. */
async function settingsFileOf(config: Config): Promise<unknown> {
  const answer = await config.settings_file({});
  return typeof answer === "symbol" ? undefined : answer.path;
}

export async function readSettings(config: Config): Promise<ProxySettings> {
  const routing = await settingOf(config, "routing");
  const opencode = await settingOf(config, "opencode");
  return {
    upstream: await settingOf(config, "upstream"),
    placeholderAuthorization: await settingOf(config, "proxy.placeholderAuthorization"),
    profile: profileOf(routing),
    loginCommand: member(routing, "loginCommand"),
    settingsFile: await settingsFileOf(config),
    record: { routing },
    opencode: {
      providerId: member(opencode, "providerId"),
      providerName: member(opencode, "providerName"),
      baseURL: member(opencode, "baseURL"),
      authToken: member(opencode, "authToken"),
    },
  };
}
