import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { bundlePlugin } from "@weivel/typescript/bundle";
import { scratchHome, type PlacedLibrary, type ScratchFile } from "@weivel/typescript/testing";

export const REPOSITORY = resolve(import.meta.dirname, "..", "..");
export const HOST_ID = "test-host";

const NATIVE = join(REPOSITORY, "native");
const FOLDERS = ["user", "portable", "secrets", "koffi"];

/** One plugin to install: its manifest, the bundled entry to place where the manifest names it, and its stored settings. */
export interface Install {
  readonly manifest: { readonly id: string; readonly version: string; readonly entry: string } & Record<string, unknown>;
  readonly bundle: string;
  readonly settings: Record<string, unknown>;
}

/** Further variables a test sets while the home lives, given its base; one of the same name as a place wins. */
export type Variables = (base: string) => Readonly<Record<string, string>>;

export interface Home {
  readonly base: string;
  readonly runtime: string;
  /** Every variable the home set in the process while it lives. */
  readonly environment: Readonly<Record<string, string>>;
  /** Puts the process's variables back as they were and deletes the home. */
  remove(): void;
}

function placesOf(base: string): Record<string, string> {
  return {
    SPISOR_HOME: join(base, "portable"),
    SPISOR_STATE: join(base, "state"),
    SPISOR_CACHE: join(base, "cache"),
    SPISOR_SECRETS: join(base, "secrets"),
    HOME: join(base, "user"),
    USERPROFILE: join(base, "user"),
  };
}

function installedFiles(base: string, install: Install): ScratchFile[] {
  const { id, version, entry } = install.manifest;
  const bundle = join(base, "cache", "bundles", id, version);
  return [
    { path: join(bundle, "plugin.json"), content: install.manifest },
    { path: join(bundle, entry), copyFrom: install.bundle },
    { path: join(bundle, ".installed.json"), content: { files: {} } },
    { path: join(base, "application", "config", `${id}.json`), content: install.settings },
  ];
}

/** The files an install leaves: the registered loader, the javascript-host's hint naming the libraries, every install enabled. */
function homeFiles(base: string, libraries: Readonly<Record<string, PlacedLibrary>>, installs: readonly Install[]): ScratchFile[] {
  const catalog = join(base, "catalog", "index.json");
  const enabled = Object.fromEntries(installs.map((install) => [install.manifest.id, { enabled: true }]));
  const hint = {
    host: "2.0.0",
    libraries: {
      runtime: { version: "0.2.0", ...libraries.runtime },
      koffi: { version: "2.0.0", directory: join(base, "koffi") },
      "forebay-library": { version: "0.2.0", ...libraries.forebay_library },
    },
  };
  return [
    { path: catalog, content: { format: 1, items: {} } },
    { path: join(base, "state", "hosts", `${HOST_ID}.json`), content: { id: HOST_ID, kind: "host", version: "1.0.0", home: join(base, "application") } },
    { path: join(base, "cache", "hosts", "javascript-host.json"), content: hint },
    ...installs.flatMap((install) => installedFiles(base, install)),
    { path: join(base, "application", "config", "settings.json"), content: { plugins: enabled, catalog: { sources: [{ kind: "local", path: catalog }] } } },
  ];
}

/**
 * Lays out a fresh home under the temporary directory, as an install leaves one, with runtime and forebay-library out
 * of `native/` and spisor's places, then `variables`, set until `remove`. No processes record is written: a run
 * started `in-process` neither claims nor checks one.
 */
export function homeWith(installs: readonly Install[], variables: Variables = () => ({})): Home {
  let environment: Readonly<Record<string, string>> = {};
  const scratch = scratchHome({
    prefix: "ocp-home-",
    libraries: { runtime: join(NATIVE, "runtime"), forebay_library: join(NATIVE, "forebay_library") },
    environment: (base) => (environment = { ...placesOf(base), ...variables(base) }),
    files: (base, libraries) => homeFiles(base, libraries, installs),
  });
  for (const folder of FOLDERS) mkdirSync(join(scratch.base, folder), { recursive: true });
  return { base: scratch.base, runtime: scratch.libraries.runtime!.binary, environment, remove: scratch.remove };
}

/** The files of the home's processes folder, where a run that claimed the loader would have written its record. */
export function processRecords(home: Home): string[] {
  const folder = join(home.base, "state", "processes");
  return existsSync(folder) ? readdirSync(folder) : [];
}

/** Bundles a plugin entry into one module, as a plugin's build does, under `directory`. */
export function bundled(entry: string, directory: string): Promise<string> {
  return bundlePlugin(entry, directory);
}
