import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHost, type RunningHost } from "@weivel/typescript/program";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bundled, homeWith, HOST_ID, processRecords, REPOSITORY, type Home, type Install } from "./fixtures/home.js";
import { fakeUpstream, type Upstream } from "./fixtures/upstream.js";

const MODEL = "claude-sonnet-4-5";
const MESSAGES = JSON.stringify({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
const STREAMED_MESSAGES = JSON.stringify({ model: MODEL, max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] });
const RUN_BOUND = 60_000;
const SERVICE = "opencode-proxy:opencode-plugin";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface ProviderConfig {
  readonly name: string;
  readonly npm: string;
  readonly options: { readonly baseURL: string; readonly fetch: Fetch } & Record<string, unknown>;
  readonly models: Record<string, { readonly name: string; readonly limit?: { readonly context: number; readonly output: number } }>;
}

interface Hooks {
  config(config: { provider?: Record<string, ProviderConfig> }): Promise<void>;
}

/** OpenCode's plugin input as far as a credential goes: a client whose `auth.set` would store one. */
interface PluginInput {
  readonly client: { readonly auth: { set(input: unknown): Promise<unknown> } };
}

interface Running {
  readonly home: Home;
  readonly host: RunningHost;
}

let bundles: string;
let proxyBundle: string;
let providerBundle: string;
let upstream: Upstream;
const running: Running[] = [];

function proxyInstall(settings: Record<string, unknown> = {}): Install {
  const manifest = JSON.parse(readFileSync(join(REPOSITORY, "plugin.json"), "utf8"));
  return { manifest, bundle: proxyBundle, settings: { upstream: upstream.url, ...settings } };
}

/** The user's stored model map, a chain of the two providers for the one model. */
function chainOfBoth(): Record<string, unknown> {
  const chain = [
    { provider: "alpha", model: MODEL },
    { provider: "beta", model: MODEL },
  ];
  return { routing: { modelMap: { default: chain } } };
}

function providerInstall(id: string, mode: string, settings: Record<string, unknown> = {}): Install {
  const manifest = {
    api: 1,
    importName: id,
    id,
    version: "1.0.0",
    entry: "index.js",
    capabilities: { provides: ["forebay.provider"] },
    services: { consumes: ["weivel.config"], provides: [`${id}:probe`] },
    config: { defaults: {} },
  };
  return { manifest, bundle: providerBundle, settings: { mode, name: id, model: MODEL, ...settings } };
}

async function started(installs: readonly Install[]): Promise<Running> {
  const home = homeWith(installs);
  const quiet = (): void => undefined;
  const host = await startHost({ hostLibraryPath: home.runtime, arguments: [HOST_ID, "in-process"], log: { debug: quiet, info: quiet, warn: quiet, error: quiet } });
  const run = { home, host };
  running.push(run);
  return run;
}

/** The provider entry the `config` hook adds, and how often the plugin asked OpenCode's client to store a credential. */
async function configured(run: Running): Promise<{ provider: ProviderConfig; credentialsStored: number }> {
  let credentialsStored = 0;
  const input: PluginInput = { client: { auth: { set: async () => (credentialsStored += 1) } } };
  const plugin = run.host.service<(input: PluginInput) => Promise<Hooks>>("opencode-proxy", SERVICE);
  if (plugin === undefined) throw new Error(`opencode-proxy registered no ${SERVICE}`);
  const hooks = await plugin(input);
  const config: { provider?: Record<string, ProviderConfig> } = {};
  await hooks.config(config);
  return { provider: config.provider!.forebay!, credentialsStored };
}

/** The placeholder the manifest names, which the model client sends as its key. */
function placeholderAuthorization(): string {
  return JSON.parse(readFileSync(join(REPOSITORY, "plugin.json"), "utf8")).config.defaults.proxy.placeholderAuthorization;
}

/** A messages request as OpenCode's model client sends it: the placeholder as its `x-api-key`. */
function messages(provider: ProviderConfig, body: string, signal?: AbortSignal): Promise<Response> {
  const headers = { "content-type": "application/json", "x-api-key": String(provider.options.apiKey) };
  return provider.options.fetch(`${provider.options.baseURL}/messages`, { method: "POST", headers, body, signal });
}

beforeAll(async () => {
  bundles = mkdtempSync(join(tmpdir(), "ocp-bundles-"));
  proxyBundle = await bundled(join(REPOSITORY, "src", "plugin.ts"), join(bundles, "proxy"));
  providerBundle = await bundled(join(REPOSITORY, "test", "fixtures", "provider", "index.ts"), join(bundles, "provider"));
}, RUN_BOUND);

beforeEach(async () => {
  upstream = await fakeUpstream();
});

afterAll(() => rmSync(bundles, { recursive: true, force: true }));

afterEach(async () => {
  const records: string[] = [];
  for (const run of running.splice(0)) {
    try {
      await run.host.stop();
      records.push(...processRecords(run.home));
    } finally {
      run.home.remove();
    }
  }
  await upstream.close();
  expect(records).toEqual([]);
});

describe("opencode-proxy's hooks under the host program, over runtime in a temporary home", () => {
  it("adds the catalog's models with their limits through the config hook and sets no credential, only the placeholder", async () => {
    const run = await started([proxyInstall(), providerInstall("alpha", "plain")]);

    const { provider, credentialsStored } = await configured(run);

    expect(provider.npm).toBe("@ai-sdk/anthropic");
    expect(provider.models).toEqual({ [MODEL]: { name: MODEL, limit: { context: 200000, output: 64000 } } });
    expect(Object.keys(provider.options).sort()).toEqual(["apiKey", "baseURL", "fetch"]);
    expect(provider.options.apiKey).toBe(placeholderAuthorization());
    expect(credentialsStored).toBe(0);
  }, RUN_BOUND);

  it("answers a plain request through the provider", async () => {
    const run = await started([proxyInstall(), providerInstall("alpha", "plain")]);
    const { provider } = await configured(run);

    const answer = await messages(provider, MESSAGES);

    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ type: "message", model: MODEL, content: [{ type: "text", text: "served by alpha" }] });
  }, RUN_BOUND);

  it("answers a streamed request as Anthropic events", async () => {
    const run = await started([proxyInstall(), providerInstall("alpha", "stream")]);
    const { provider } = await configured(run);

    const answer = await messages(provider, STREAMED_MESSAGES);
    const body = await answer.text();

    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("text/event-stream");
    expect(body).toContain("event: message_start");
    expect(body).toContain("streamed by alpha");
    expect(body).toContain("event: message_stop");
  }, RUN_BOUND);

  it("answers exhaustion with C's rate-limit reply, never the upstream's 429", async () => {
    const zone = process.env.TZ;
    process.env.TZ = "UTC";
    try {
      const run = await started([proxyInstall(chainOfBoth()), providerInstall("alpha", "rate-limited"), providerInstall("beta", "rate-limited")]);
      const { provider } = await configured(run);

      const answer = await messages(provider, MESSAGES);
      const body = await answer.text();

      expect(answer.status, body).toBe(429);
      expect(body).not.toContain("limited");
      expect(JSON.parse(body)).toMatchObject({ type: "error", error: { type: "rate_limit_error" } });
      expect(JSON.parse(body).error.message).toMatch(/^You've hit your usage limit · resets at \d{1,2}:\d{2} (AM|PM) UTC$/);
      expect(Number(answer.headers.get("retry-after"))).toBeGreaterThan(100);
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  }, RUN_BOUND);

  it("ends a stream that fails after bytes went out with an Anthropic error event", async () => {
    const run = await started([proxyInstall(), providerInstall("alpha", "stream-fails"), providerInstall("beta", "plain")]);
    const { provider } = await configured(run);

    const answer = await messages(provider, STREAMED_MESSAGES);
    const body = await answer.text();

    expect(answer.status).toBe(200);
    expect(body).toContain("partial");
    expect(body).not.toContain("served by beta");
    expect(body.trimEnd().split("\n\n").at(-1)).toMatch(/^event: error\ndata: .*"alpha broke mid stream"/s);
  }, RUN_BOUND);

  it("releases the provider's stream once OpenCode cancels the request mid stream", async () => {
    const run = await started([proxyInstall(), providerInstall("alpha", "hang")]);
    const { provider } = await configured(run);
    const caller = new AbortController();

    const answer = await messages(provider, STREAMED_MESSAGES, caller.signal);
    const reader = answer.body!.getReader();
    await reader.read();
    caller.abort();

    await expect(reader.read()).rejects.toBeDefined();

    const probe = (): { released: number; releasedWhileReading: number } | undefined => run.host.service("alpha", "alpha:probe");
    await expect.poll(() => probe()?.released, { timeout: 5_000 }).toBe(1);
    expect(probe()?.releasedWhileReading).toBe(0);
  }, RUN_BOUND);

  it("refuses a body over C's limit with 413 and one that is no JSON object with 400", async () => {
    const run = await started([proxyInstall(), providerInstall("alpha", "plain")]);
    const { provider } = await configured(run);

    const tooLarge = await messages(provider, "x".repeat(64 * 1024 * 1024 + 1));
    const notAnObject = await messages(provider, "[1, 2]");

    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ type: "error", error: { type: "loader_proxy_error", message: expect.stringContaining("67108864") } });
    expect(notAnObject.status).toBe(400);
    expect(await notAnObject.json()).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
  }, RUN_BOUND);

  it("with no provider installed, sends a messages request upstream as C's step answers, without the placeholder", async () => {
    const run = await started([proxyInstall()]);
    const { provider } = await configured(run);

    const answer = await messages(provider, MESSAGES);

    expect(answer.status).toBe(200);
    expect(answer.headers.get("x-upstream")).toBe("fake");
    expect(upstream.received).toHaveLength(1);
    expect(upstream.received[0]).toMatchObject({ method: "POST", url: "/v1/messages", body: MESSAGES });
    expect(upstream.received[0]?.headers["x-api-key"]).not.toBe(placeholderAuthorization());
    expect(upstream.received[0]?.headers.authorization).not.toBe(placeholderAuthorization());
    expect(provider.models).toEqual({});
  }, RUN_BOUND);

  it.each([
    ["the whole placeholder", (placeholder: string) => placeholder],
    ["the bare key", (placeholder: string) => placeholder.replace(/^Bearer /, "")],
  ])("passes a request no route serves through without an x-api-key carrying %s", async (_form, keyOf) => {
    const run = await started([proxyInstall(), providerInstall("alpha", "plain")]);
    const { provider } = await configured(run);
    const headers = { "content-type": "application/json", "x-api-key": keyOf(placeholderAuthorization()) };

    const answer = await provider.options.fetch(`${provider.options.baseURL}/messages/count_tokens`, { method: "POST", headers, body: MESSAGES });

    expect(answer.status).toBe(200);
    expect(upstream.received).toHaveLength(1);
    expect(upstream.received[0]?.url).toBe("/v1/messages/count_tokens");
    expect(upstream.received[0]?.headers["x-api-key"]).toBeUndefined();
  }, RUN_BOUND);

  it("answers a compressed upstream reply plain, with neither its content-encoding nor its content-length", async () => {
    const compressing = await fakeUpstream(true);
    try {
      const run = await started([proxyInstall({ upstream: compressing.url })]);
      const { provider } = await configured(run);

      const answer = await messages(provider, MESSAGES);

      expect(answer.status).toBe(200);
      expect(answer.headers.get("x-upstream")).toBe("fake");
      expect(answer.headers.get("content-encoding")).toBeNull();
      expect(answer.headers.get("content-length")).toBeNull();
      expect(await answer.text()).toBe(JSON.stringify({ upstream: "/v1/messages" }));
    } finally {
      await compressing.close();
    }
  }, RUN_BOUND);
});
