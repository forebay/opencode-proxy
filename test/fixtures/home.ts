import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { bundlePlugin } from "@weivel/typescript/bundle";
import type { BoundDefinition } from "@weivel/typescript/host";
import { describedLibrary, scratchHome, setVariables, type DescribedLibrary, type PlacedLibrary } from "@weivel/typescript/testing";

export const REPOSITORY = resolve(import.meta.dirname, "..", "..");
export const HOST_ID = "test-host";

const NATIVE = join(REPOSITORY, "native");

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
  /** The folder a run that claimed the loader writes its record in. */
  readonly processes: string;
  /** Every variable the home set in the process while it lives. */
  readonly environment: Readonly<Record<string, string>>;
  /** Puts the process's variables back as they were and deletes the home. */
  remove(): void;
}

interface LaidOutHome {
  readonly variables: readonly { readonly name: string; readonly value: string }[];
  readonly processes: string;
}

let runtimeTesting: DescribedLibrary | undefined;

/** runtime-testing's service, the test-only C library that lays a home out through runtime's own writers, loaded once. */
function testingService(): BoundDefinition {
  runtimeTesting ??= describedLibrary(join(NATIVE, "runtime_testing"));
  return runtimeTesting.described.get("runtime.testing")!;
}

function hintedLibrary(id: string, placed: PlacedLibrary): Record<string, unknown> {
  return { id, version: null, directory: placed.directory, binary: placed.binary };
}

/** Lays the home out with no processes record: a run started `in-process` neither claims nor checks one. */
function layOutHome(base: string, libraries: Readonly<Record<string, PlacedLibrary>>, installs: readonly Install[]): Promise<LaidOutHome> {
  const argument = {
    base,
    host_id: HOST_ID,
    installs: installs.map((install) => ({ manifest: install.manifest, entry_source: install.bundle, settings: install.settings })),
    libraries: [hintedLibrary("runtime", libraries.runtime!), hintedLibrary("forebay-library", libraries.forebay_library!)],
    holder: 0,
  };
  return testingService().lay_out_home!({ argument }) as Promise<LaidOutHome>;
}

/**
 * Lays out a fresh home under the temporary directory through runtime-testing, as an install leaves one, with runtime
 * and forebay-library out of `native/`, and sets spisor's places, then `variables`, until `remove`.
 */
export async function homeWith(installs: readonly Install[], variables: Variables = () => ({})): Promise<Home> {
  const scratch = scratchHome({
    prefix: "ocp-home-",
    libraries: { runtime: join(NATIVE, "runtime"), forebay_library: join(NATIVE, "forebay_library") },
    environment: () => ({}),
    files: () => [],
  });
  try {
    const base = join(scratch.base, "home");
    mkdirSync(base);
    const laidOut = await layOutHome(base, scratch.libraries, installs);
    const places = Object.fromEntries(laidOut.variables.map((variable) => [variable.name, variable.value]));
    const environment = { ...places, ...variables(base) };
    const restore = setVariables(environment);
    const remove = (): void => {
      restore();
      scratch.remove();
    };
    return { base, runtime: scratch.libraries.runtime!.binary, processes: laidOut.processes, environment, remove };
  } catch (error) {
    scratch.remove();
    throw error;
  }
}

/** The files of the home's processes folder, where a run that claimed the loader would have written its record. */
export function processRecords(home: Home): string[] {
  return existsSync(home.processes) ? readdirSync(home.processes) : [];
}

/** Bundles a plugin entry into one module, as a plugin's build does, under `directory`. */
export function bundled(entry: string, directory: string): Promise<string> {
  return bundlePlugin(entry, directory);
}
