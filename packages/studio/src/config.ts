/**
 * Which config the studio opens, how it loads it, and when it loads it again.
 *
 * The studio finds the project's `defineConfig` file by itself: a
 * `viborm.config.*` in the working directory or one of its parents (up to the
 * repository root), else the files below the working directory, by name first
 * and then by their `viborm/config` import. Loading goes through VibORM's own
 * config loader with a fresh jiti each time, which records every project file
 * it compiles: those are the files the studio watches.
 */

import { existsSync, readdirSync, readFileSync, watch } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { type LoadedConfig, loadConfig } from "@src/cli/utils";
import { createJiti } from "jiti";

export const CONFIG_FILES = [
  "viborm.config.ts",
  "viborm.config.mts",
  "viborm.config.js",
  "viborm.config.mjs",
];

/** Directories no config lives in: dependencies, builds, caches. */
const SKIPPED = new Set(["node_modules", "dist", "build", "out", "coverage"]);
const SOURCE = /\.(?:[cm]?ts|[cm]?js)$/;
const DEFINES_CONFIG = /from\s*["']viborm\/config["']/;
const DEFINE_CALL = /\bdefineConfig\s*\(/;
/** How deep below the working directory the scan looks. */
const SCAN_DEPTH = 6;

export interface FoundConfig {
  readonly path: string;
  /** Other candidates the scan found, nearest first; `--config` picks one. */
  readonly others: readonly string[];
}

/** The project's config, or undefined when there is none to find. */
export function findConfig(cwd: string): FoundConfig | undefined {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const named = CONFIG_FILES.map((file) => join(dir, file)).find((path) =>
      existsSync(path)
    );
    if (named) return { path: named, others: [] };
    const parent = dirname(dir);
    if (existsSync(join(dir, ".git")) || parent === dir) break;
  }
  const found = scan(resolve(cwd));
  const [path, ...others] = [
    ...found.filter((file) =>
      CONFIG_FILES.some((name) => file.endsWith(`/${name}`))
    ),
    ...found.filter(
      (file) => !CONFIG_FILES.some((name) => file.endsWith(`/${name}`))
    ),
  ];
  return path ? { path, others } : undefined;
}

/** Every file below `root` that is, or defines, a VibORM config; shallowest first. */
function scan(root: string): string[] {
  const found: { path: string; depth: number }[] = [];
  const visit = (dir: string, depth: number) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < SCAN_DEPTH && !SKIPPED.has(entry.name))
          visit(path, depth + 1);
      } else if (
        entry.isFile() &&
        SOURCE.test(entry.name) &&
        !entry.name.endsWith(".d.ts") &&
        (CONFIG_FILES.includes(entry.name) || definesConfig(path))
      ) {
        found.push({ path, depth });
      }
    }
  };
  visit(root, 0);
  return found
    .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path))
    .map(({ path }) => path);
}

function definesConfig(path: string): boolean {
  const source = readFileSync(path, "utf8");
  return DEFINES_CONFIG.test(source) && DEFINE_CALL.test(source);
}

export interface LoadedProject {
  readonly config: LoadedConfig;
  /** The project files the config compiled: itself, its schema, their imports. */
  readonly files: readonly string[];
}

/** How a runtime imports the config module (Bun imports TypeScript itself). */
export type Importer = (path: string) => Promise<unknown>;

/**
 * Load the config through VibORM's loader. Without an importer, a fresh jiti
 * evaluates the project's files again, so an edited schema is read anew, and
 * records which ones it compiled outside `node_modules`.
 */
export async function loadProject(
  path: string,
  importer?: Importer
): Promise<LoadedProject> {
  const files = new Set<string>([path]);
  const fresh: Importer = (file) => {
    const compiler = createJiti(file);
    return createJiti(file, {
      moduleCache: false,
      fsCache: false,
      tsconfigPaths: true,
      interopDefault: true,
      transform: (options) => {
        if (options.filename && !options.filename.includes("/node_modules/")) {
          files.add(options.filename);
        }
        return { code: compiler.transform(options) };
      },
    }).import(file);
  };
  const config = await loadConfig({
    config: path,
    importer: importer ?? fresh,
  });
  return { config, files: [...files] };
}

/**
 * Call `changed` once a burst of edits to these files settles. Each file's
 * directory is watched rather than the file, so an editor's save-by-rename is
 * seen too. Returns the function that stops watching.
 */
export function watchFiles(
  files: readonly string[],
  changed: () => void,
  settle = 150
): () => void {
  const byDirectory = new Map<string, Set<string>>();
  for (const file of files) {
    const names = byDirectory.get(dirname(file)) ?? new Set<string>();
    names.add(relative(dirname(file), file));
    byDirectory.set(dirname(file), names);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchers = [...byDirectory].map(([directory, names]) =>
    watch(directory, (_event, name) => {
      if (name !== null && !names.has(String(name))) return;
      clearTimeout(timer);
      timer = setTimeout(changed, settle);
    })
  );
  return () => {
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}
