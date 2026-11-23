import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bundled, homeWith, HOST_ID, placesOf, REPOSITORY, type Home, type Install } from "./fixtures/home.js";
import { bundledHost, entrySource, installedOpencode, isolatedEnvironment, opencodeVersion, pinnedKoffi, ranOpencode, realOpencodeFiles, type Ran } from "./fixtures/opencode.js";

const MODEL = "claude-sonnet-4-5";
const PROVIDER_ID = "forebay";
const SERVICE = "opencode-proxy:opencode-plugin";
const SETUP_BOUND = 600_000;
const RUN_BOUND = 300_000;
const OPENCODE_BOUND = 180_000;

/** One OpenCode home: the runtime home the host runs over, and OpenCode's own folders under it. */
interface Scratch {
  readonly home: Home;
  readonly opencode: string;
  readonly project: string;
  readonly listens: string;
  readonly koffi: string;
  readonly env: NodeJS.ProcessEnv;
}

/** The real home, read before any home of the test moves `HOME` and `USERPROFILE`. */
const REAL_HOME = homedir();
const realBefore = realOpencodeFiles(REAL_HOME);
let root: string;
let binary: string;
let hostBundle: string;
let proxyBundle: string;
let providerBundle: string;
const scratches: Scratch[] = [];

function proxyInstall(): Install {
  const manifest = JSON.parse(readFileSync(join(REPOSITORY, "plugin.json"), "utf8"));
  return { manifest, bundle: proxyBundle, settings: {} };
}

function providerInstall(id: string): Install {
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
  return { manifest, bundle: providerBundle, settings: { mode: "as-asked", name: id, model: MODEL } };
}

/** Variables naming a credential OpenCode would read on its own, which the run must not have. */
function withoutCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/_API_KEY$|_AUTH_TOKEN$/.test(name)));
}

/** A runtime home with the proxy and one test provider installed, and OpenCode's folders isolated under it. */
function scratch(): Scratch {
  const home = homeWith([proxyInstall(), providerInstall("alpha")]);
  const opencode = join(home.base, "opencode");
  const configDirectory = join(opencode, "config-dir");
  const project = join(opencode, "project");
  const isolated = isolatedEnvironment(opencode, configDirectory);
  for (const directory of [project, join(configDirectory, "plugins"), isolated.TEMP!, isolated.APPDATA!, isolated.LOCALAPPDATA!]) mkdirSync(directory, { recursive: true });
  const listens = join(opencode, "listens.log");
  const koffi = join(opencode, "koffi.json");
  writeFileSync(join(configDirectory, "plugins", "weivel-host.ts"), entrySource({ bundle: hostBundle, runtime: home.runtime, hostId: HOST_ID, holders: join(home.base, "state", "processes", `${HOST_ID}.json`), plugin: "opencode-proxy", service: SERVICE, listens, koffi }));
  const env = { ...withoutCredentials(process.env), ...placesOf(home.base), ...isolated };
  const created = { home, opencode, project, listens, koffi, env };
  scratches.push(created);
  return created;
}

function opencode(within: Scratch, parameters: readonly string[]): Promise<Ran> {
  return ranOpencode(binary, parameters, within.project, within.env, OPENCODE_BOUND);
}

/** Every file under `directory` whose name is `name`. */
function filesNamed(directory: string, name: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" }).filter((file) => file.split(/[\\/]/).at(-1) === name);
}

function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((name) => before.get(name) !== after.get(name));
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "ocp-opencode-"));
  binary = installedOpencode(join(root, "opencode"), opencodeVersion());
  hostBundle = await bundledHost(join(root, "weivel"));
  proxyBundle = await bundled(join(REPOSITORY, "src", "plugin.ts"), join(root, "bundles", "proxy"));
  providerBundle = await bundled(join(REPOSITORY, "test", "fixtures", "provider", "index.ts"), join(root, "bundles", "provider"));
}, SETUP_BOUND);

afterEach(() => {
  for (const finished of scratches.splice(0)) finished.home.remove();
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

describe(`opencode-proxy inside OpenCode ${opencodeVersion().version}, whose own process hosts it`, () => {
  it("lists the provider's models, answers two runs in one home through it, and leaves no socket, credential or real-home file behind", async () => {
    const within = scratch();

    const listed = await opencode(within, ["models", PROVIDER_ID]);
    const first = await opencode(within, ["run", "-m", `${PROVIDER_ID}/${MODEL}`, "say hi"]);
    const second = await opencode(within, ["run", "-m", `${PROVIDER_ID}/${MODEL}`, "say hi"]);

    expect(filesNamed(within.opencode, "auth.json")).toEqual([]);
    for (const name of ["opencode.json", "opencode.jsonc", "config.json"]) expect(filesNamed(within.opencode, name)).toEqual([]);
    expect(changedFiles(realBefore, realOpencodeFiles(REAL_HOME))).toEqual([]);
    expect(existsSync(within.listens) ? readFileSync(within.listens, "utf8") : "").toBe("");
    expect(JSON.parse(readFileSync(within.koffi, "utf8"))).toEqual({ path: join(root, "weivel", "node_modules", "koffi"), version: pinnedKoffi() });
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout.split(/\r?\n/)).toContain(`${PROVIDER_ID}/${MODEL}`);
    for (const run of [first, second]) {
      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout).toContain("served by alpha");
    }
  }, RUN_BOUND);

  it("lists the models in two OpenCode processes started together in one home OpenCode already set up", async () => {
    const within = scratch();

    const warmed = await opencode(within, ["models", PROVIDER_ID]);
    const both = await Promise.all([opencode(within, ["models", PROVIDER_ID]), opencode(within, ["models", PROVIDER_ID])]);

    expect(warmed.code, warmed.stderr).toBe(0);
    for (const listed of both) {
      expect(listed.code, listed.stderr).toBe(0);
      expect(listed.stdout.split(/\r?\n/)).toContain(`${PROVIDER_ID}/${MODEL}`);
    }
    expect(changedFiles(realBefore, realOpencodeFiles(REAL_HOME))).toEqual([]);
  }, RUN_BOUND);
});
