import { execSync, spawn } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bundleProgram } from "@weivel/typescript/bundle";
import { REPOSITORY } from "./home.js";

const TYPESCRIPT = join(REPOSITORY, "siblings", "typescript");
const PLATFORM_NAMES: Readonly<Record<string, string>> = { win32: "windows", darwin: "darwin", linux: "linux" };

/** The OpenCode the test runs, as `test/opencode-version.json` names it. */
export interface OpencodeVersion {
  readonly package: string;
  readonly version: string;
}

export function opencodeVersion(): OpencodeVersion {
  return JSON.parse(readFileSync(join(REPOSITORY, "test", "opencode-version.json"), "utf8"));
}

/** The koffi weivel/typescript pins, which the in-process bundle must load. */
export function pinnedKoffi(): string {
  return JSON.parse(readFileSync(join(TYPESCRIPT, "package.json"), "utf8")).dependencies.koffi;
}

/**
 * `base` with each of `overrides` set, any variable of the same name in another case removed first.
 * @implNote Windows names variables case-insensitively, and a forked worker inherits them upper-cased, so a lower-case
 * `npm_config_cache` beside an inherited `NPM_CONFIG_CACHE` would lose to it.
 */
export function withVariables(base: NodeJS.ProcessEnv, overrides: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const replaced = new Set(Object.keys(overrides).map((name) => name.toLowerCase()));
  const kept = Object.entries(base).filter(([name]) => !replaced.has(name.toLowerCase()));
  return { ...Object.fromEntries(kept), ...overrides };
}

/**
 * Installs OpenCode into `directory` and answers its binary, the platform package's own, since npm may refuse the
 * wrapper's postinstall that copies it.
 * @implNote npm's cache is moved under `directory`, so the install writes nothing in the real home.
 */
export function installedOpencode(directory: string, version: OpencodeVersion): string {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true }));
  const env = withVariables(process.env, { npm_config_cache: join(directory, "npm-cache"), npm_config_update_notifier: "false" });
  execSync(`npm install --ignore-scripts --no-audit --no-fund ${JSON.stringify(`${version.package}@${version.version}`)}`, { cwd: directory, env, stdio: "ignore" });
  const platform = PLATFORM_NAMES[process.platform] ?? process.platform;
  const binary = join(directory, "node_modules", `opencode-${platform}-${process.arch}`, "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
  if (!existsSync(binary)) throw new Error(`the install of ${version.package}@${version.version} left no ${binary}`);
  return binary;
}

/**
 * Bundles weivel/typescript's program into `directory` with what it loads beside it: the core's and the standard's
 * shared libraries, and the pinned koffi under `node_modules`, so nothing is fetched when OpenCode's Bun imports it.
 */
export async function bundledHost(directory: string): Promise<string> {
  const { inProcess } = await bundleProgram(directory);
  const native = join(TYPESCRIPT, "native");
  for (const file of readdirSync(native)) {
    if (statSync(join(native, file)).isFile()) copyFileSync(join(native, file), join(directory, file));
  }
  cpSync(join(TYPESCRIPT, "node_modules", "koffi"), join(directory, "node_modules", "koffi"), { recursive: true });
  return inProcess;
}

/** What the entry the test writes for OpenCode reads: the bundle, the host to start and the files it reports to. */
export interface Entry {
  readonly bundle: string;
  readonly runtime: string;
  readonly hostId: string;
  readonly plugin: string;
  readonly service: string;
  /**
   * Where each listen through Node's or Bun's JavaScript API after the entry loaded is recorded, with its stack; a
   * socket opened from C is not seen.
   */
  readonly listens: string;
  /** Where the koffi the bundle resolves is recorded: its folder and the loaded module's own version. */
  readonly koffi: string;
}

/**
 * The in-process entry an OpenCode loader writes, as the test writes it: it records each JavaScript listen after it
 * loads and the koffi the bundle resolves, starts the loader's in-process run once per process and answers the hooks
 * of the service it names. It names a service id, never proxy code.
 */
export function entrySource(entry: Entry): string {
  const text = (value: string): string => JSON.stringify(value);
  return `import { appendFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import http from "node:http";
import net from "node:net";
import { startHost } from ${text(pathToFileURL(entry.bundle).href)};

const recordListen = (what) => appendFileSync(${text(entry.listens)}, what + "\\n" + new Error().stack + "\\n\\n");
for (const prototype of [net.Server.prototype, http.Server.prototype]) {
  const listen = prototype.listen;
  prototype.listen = function (...parameters) {
    recordListen("listen");
    return listen.apply(this, parameters);
  };
}
if (globalThis.Bun !== undefined) {
  for (const name of ["serve", "listen"]) {
    const original = Bun[name];
    Bun[name] = (...parameters) => {
      recordListen("Bun." + name);
      return original(...parameters);
    };
  }
}

const requireBesideTheBundle = createRequire(${text(entry.bundle)});
writeFileSync(${text(entry.koffi)}, JSON.stringify({ path: dirname(requireBesideTheBundle.resolve("koffi/package.json")), version: requireBesideTheBundle("koffi").version }));

let started;
export const WeivelHost = async (input) => {
  started ??= startHost({ hostLibraryPath: ${text(entry.runtime)}, arguments: [${text(entry.hostId)}, "in-process"] });
  const host = await started;
  const plugin = host.service(${text(entry.plugin)}, ${text(entry.service)});
  if (plugin === undefined) throw new Error(${text(`${entry.plugin} registered no ${entry.service}`)});
  return plugin(input);
};
`;
}

export interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs OpenCode's `binary` with `parameters` in `directory` under `env`, killed after `bound` milliseconds. */
export function ranOpencode(binary: string, parameters: readonly string[], directory: string, env: NodeJS.ProcessEnv, bound: number): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, parameters, { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => child.kill(), bound);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

/** The folders OpenCode, its Bun and npm keep in a home, wherever each system puts them. */
const REAL_OPENCODE_FOLDERS = [
  ".opencode",
  ".config/opencode",
  ".local/share/opencode",
  ".cache/opencode",
  ".local/state/opencode",
  "AppData/Roaming/opencode",
  "AppData/Local/opencode",
  ".bun",
  ".cache/bun",
  "Library/Caches/bun",
  "AppData/Local/bun",
  ".npm",
  "AppData/Local/npm-cache",
];

/**
 * The npm debug-log folders, which the npm or npx that launches the suite writes and rotates while it runs; a leaking
 * install still shows in the cache's own entries.
 */
const LAUNCHER_LOGS = [".npm/_logs", "AppData/Local/npm-cache/_logs"];

/** Every file under the OpenCode, Bun and npm folders of `home` with its size and modification time. */
export function realOpencodeFiles(home: string): Map<string, string> {
  const files = new Map<string, string>();
  const skipped = new Set(LAUNCHER_LOGS.map((folder) => join(home, folder)));
  const walked = (path: string): void => {
    if (skipped.has(path)) return;
    let entries: string[];
    try {
      entries = readdirSync(path);
    } catch {
      return;
    }
    files.set(path, "folder");
    for (const name of entries) {
      const child = join(path, name);
      const stat = statSync(child, { throwIfNoEntry: false });
      if (stat === undefined) continue;
      if (stat.isDirectory()) walked(child);
      else files.set(child, `${stat.size}:${stat.mtimeMs}`);
    }
  };
  for (const folder of REAL_OPENCODE_FOLDERS) walked(join(home, folder));
  return files;
}

/** The variables that keep OpenCode, Bun and npm inside `base`, and out of the real home. */
export function isolatedEnvironment(base: string, configDirectory: string): Record<string, string> {
  const home = join(base, "user");
  return {
    HOME: home,
    USERPROFILE: home,
    OPENCODE_TEST_HOME: home,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_CONFIG_DIR: configDirectory,
    XDG_CONFIG_HOME: join(base, "xdg", "config"),
    XDG_DATA_HOME: join(base, "xdg", "data"),
    XDG_CACHE_HOME: join(base, "xdg", "cache"),
    XDG_STATE_HOME: join(base, "xdg", "state"),
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    TEMP: join(base, "tmp"),
    TMP: join(base, "tmp"),
    TMPDIR: join(base, "tmp"),
    npm_config_cache: join(base, "npm-cache"),
  };
}
