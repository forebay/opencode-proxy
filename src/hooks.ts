import { proxyFetch, type Proxy } from "./fetch.js";
import type { CatalogModel } from "./services.js";

/** The AI SDK package OpenCode builds the provider's model client from, the one speaking the wire `anthropic` decodes. */
const ANTHROPIC_SDK = "@ai-sdk/anthropic";

/** One model as OpenCode's config lists it. */
export interface OpencodeModel {
  readonly name: string;
  readonly limit?: { readonly context: number; readonly output: number };
}

/** The part of OpenCode's config the `config` hook writes. */
export interface OpencodeConfig {
  provider?: Record<string, unknown>;
}

export interface Hooks {
  config(config: OpencodeConfig): Promise<void>;
}

function limitOf(entry: CatalogModel): OpencodeModel["limit"] {
  return entry.has_context === 1 && entry.has_output === 1 ? { context: entry.context!, output: entry.output! } : undefined;
}

/** C's entries as OpenCode's config lists models, keyed by id. */
function modelsOf(entries: readonly CatalogModel[]): Record<string, OpencodeModel> {
  return Object.fromEntries(
    entries.map((entry) => {
      const limit = limitOf(entry);
      return [entry.id, { name: entry.name!, ...(limit === undefined ? {} : { limit }) }];
    }),
  );
}

/**
 * The hooks OpenCode's plugin API takes: `config` adds the provider whose models are the catalog's entries and whose
 * every model request goes through this process's `fetch`. The only token it hands OpenCode's model client is the
 * configured placeholder, which the model client requires and the pass-through drops; no credential is stored and no
 * file is written.
 */
export function hooksOf(proxy: Proxy): Hooks {
  const fetch = proxyFetch(proxy);
  return {
    async config(config) {
      const { entries } = await proxy.catalog.current();
      const { providerId, providerName, baseURL, authToken } = proxy.settings.opencode;
      config.provider ??= {};
      config.provider[String(providerId)] = { name: providerName, npm: ANTHROPIC_SDK, options: { baseURL, authToken, fetch }, models: modelsOf(entries) };
    },
  };
}
