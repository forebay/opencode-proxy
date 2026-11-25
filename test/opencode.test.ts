import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { scratchHome, type ScratchHome } from "@weivel/typescript/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bundled, homeWith, HOST_ID, processRecords, REPOSITORY, type Home, type Install } from "./fixtures/home.js";
import { bundledHost, entrySource, installedOpencode, isolatedEnvironment, opencodeVersion, pinnedKoffi, ranOpencode, realOpencodeFiles, withVariables, type Ran } from "./fixtures/opencode.js";

const MODEL = "claude-sonnet-4-5";
const PROVIDER_ID = "forebay";
const SERVICE = "opencode-proxy:opencode-plugin";
const SETUP_BOUND = 600_000;
const RUN_BOUND = 300_000;
const OPENCODE_BOUND = 180_000;
const TEARDOWN_BOUND = 120_000;

/** One OpenCode home: the runtime home the host runs over, and OpenCode's own folders under it. */
interface Scratch {
  readonly home: Home;
  readonly opencode: string;
  readonly project: string;
  readonly listens: string;
  readonly koffi: string;
  readonly env: NodeJS.ProcessEnv;
}

/** The real home by its real path, read before any home of the test moves `HOME` and `USERPROFILE`. */
const REAL_HOME = realpathSync(homedir());
const realBefore = realOpencodeFiles(REAL_HOME);
let root: ScratchHome | undefined;
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
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/_API_KEY$|_AUTH_TOKEN$/i.test(name)));
}

function opencodeFolder(base: string): string {
  return join(base, "opencode");
}

function configDirectoryOf(base: string): string {
  return join(opencodeFolder(base), "config-dir");
}

/** A runtime home with the proxy and one test provider installed, and OpenCode's folders isolated under it. */
async function scratch(): Promise<Scratch> {
  const home = await homeWith([proxyInstall(), providerInstall("alpha")], (base) => isolatedEnvironment(opencodeFolder(base), configDirectoryOf(base)));
  const opencode = opencodeFolder(home.base);
  const configDirectory = configDirectoryOf(home.base);
  const project = join(opencode, "project");
  const { TEMP, APPDATA, LOCALAPPDATA } = home.environment;
  for (const directory of [project, join(configDirectory, "plugins"), TEMP!, APPDATA!, LOCALAPPDATA!]) mkdirSync(directory, { recursive: true });
  const listens = join(opencode, "listens.log");
  const koffi = join(opencode, "koffi.json");
  writeFileSync(join(configDirectory, "plugins", "weivel-host.ts"), entrySource({ bundle: hostBundle, runtime: home.runtime, hostId: HOST_ID, plugin: "opencode-proxy", service: SERVICE, listens, koffi }));
  const env = withVariables(withoutCredentials(process.env), home.environment);
  const created = { home, opencode, project, listens, koffi, env };
  scratches.push(created);
  return created;
}

function opencode(within: Scratch, parameters: readonly string[]): Promise<Ran> {
  return ranOpencode(binary, parameters, within.project, within.env, OPENCODE_BOUND);
}

/**
 * OpenCode run in `within` with its own session store, every other variable and the runtime home shared.
 * @implNote OpenCode keeps its sessions in one sqlite database under `XDG_DATA_HOME`, which two runs writing at once
 * can find locked; that store is OpenCode's own and not under test.
 */
function opencodeWithSessionStore(within: Scratch, store: string, parameters: readonly string[]): Promise<Ran> {
  const env = withVariables(within.env, { XDG_DATA_HOME: join(within.opencode, "xdg", store) });
  return ranOpencode(binary, parameters, within.project, env, OPENCODE_BOUND);
}

/** Every file under `directory` whose name is `name`. */
function filesNamed(directory: string, name: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" }).filter((file) => file.split(/[\\/]/).at(-1) === name);
}

function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((name) => before.get(name) !== after.get(name));
}

/**
 * The scratch holds no credential, no OpenCode config file and no processes record, nothing changed under the real
 * home's OpenCode, Bun and npm folders, no JavaScript listen was made after the entry loaded, and the bundle loaded the
 * pinned koffi.
 */
function expectIsolated(within: Scratch): void {
  expect(processRecords(within.home)).toEqual([]);
  expect(filesNamed(within.opencode, "auth.json")).toEqual([]);
  for (const name of ["opencode.json", "opencode.jsonc", "config.json"]) expect(filesNamed(within.opencode, name)).toEqual([]);
  expect(changedFiles(realBefore, realOpencodeFiles(REAL_HOME))).toEqual([]);
  expect(existsSync(within.listens) ? readFileSync(within.listens, "utf8") : "").toBe("");
  expect(JSON.parse(readFileSync(within.koffi, "utf8"))).toEqual({ path: join(root!.base, "weivel", "node_modules", "koffi"), version: pinnedKoffi() });
}

function expectServed(run: Ran): void {
  expect(run.code, run.stderr).toBe(0);
  expect(run.stdout).toContain("served by alpha");
}

function expectListed(listed: Ran): void {
  expect(listed.code, listed.stderr).toBe(0);
  expect(listed.stdout.split(/\r?\n/)).toContain(`${PROVIDER_ID}/${MODEL}`);
}

beforeAll(async () => {
  root = scratchHome({ prefix: "ocp-opencode-", libraries: {}, environment: () => ({}), files: () => [] });
  binary = installedOpencode(join(root.base, "opencode"), opencodeVersion());
  hostBundle = await bundledHost(join(root.base, "weivel"));
  proxyBundle = await bundled(join(REPOSITORY, "src", "plugin.ts"), join(root.base, "bundles", "proxy"));
  providerBundle = await bundled(join(REPOSITORY, "test", "fixtures", "provider", "index.ts"), join(root.base, "bundles", "provider"));
}, SETUP_BOUND);

afterEach(() => {
  for (const finished of scratches.splice(0)) finished.home.remove();
}, TEARDOWN_BOUND);

afterAll(() => root?.remove());

describe(`opencode-proxy inside OpenCode ${opencodeVersion().version}, whose own process hosts it`, () => {
  it("lists the provider's models, answers two runs in one home through it, and leaves no socket, credential or real-home file behind", async () => {
    const within = await scratch();

    const listed = await opencode(within, ["models", PROVIDER_ID]);
    const first = await opencode(within, ["run", "-m", `${PROVIDER_ID}/${MODEL}`, "say hi"]);
    const second = await opencode(within, ["run", "-m", `${PROVIDER_ID}/${MODEL}`, "say hi"]);

    expectIsolated(within);
    expectListed(listed);
    expectServed(first);
    expectServed(second);
  }, RUN_BOUND);

  it("serves two OpenCode processes started together in one home OpenCode already set up", async () => {
    const within = await scratch();

    const warmed = await opencode(within, ["models", PROVIDER_ID]);
    const asked = ["run", "-m", `${PROVIDER_ID}/${MODEL}`, "say hi"];
    const both = await Promise.all([opencodeWithSessionStore(within, "data-first", asked), opencodeWithSessionStore(within, "data-second", asked)]);

    expectIsolated(within);
    expectListed(warmed);
    both.forEach(expectServed);
  }, RUN_BOUND);
});
