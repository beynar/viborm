#!/usr/bin/env node

/**
 * What each extension fixture adds to the pg application, by source folder.
 *
 * `scripts/measure-bundle.mjs` weighs fixtures against the BUILT `dist/`,
 * whose shared chunks hide which source file a byte came from. This script
 * builds the same fixtures from `src` instead (each `../../dist/<entry>.mjs`
 * import is pointed at the source file `tsdown.config.ts` builds that entry
 * from), so esbuild's metafile attributes every output byte to a source file,
 * and subtracts the pg application (`pg-representative.mjs`) from each.
 *
 * The fixtures are every `pg-*.mjs` of `scripts/bundle-fixtures/` except the
 * base. The table gives, per fixture, the minified and gzip bytes it adds,
 * the bytes `src/extensions` adds, and the bytes its own folders add: the
 * folders of the entries it imports beyond the base's, the root entry and
 * `viborm/validation` (which name no one extension).
 *
 * Built from `src`, `src/version.ts` would inline the whole `package.json`;
 * the built package keeps only its `version`. The build does the same, so
 * the figures leave that file out, and the output says so.
 *
 * Usage:
 *   node scripts/extension-bytes.mjs [--root <checkout>] [--detail <fixture>|all] [fixture...]
 *
 * `--root` measures another checkout (default: the one holding this script),
 * with that checkout's own fixtures and esbuild. `--detail` adds the bytes
 * per file for one fixture, or for all of them. Names after the options
 * restrict the table to those fixtures.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const BASE = "pg-representative";
const FIXTURE_FILE = /^(pg-.+)\.mjs$/;
const ESBUILD_STORE_DIRECTORY = /^esbuild@\d/;
const VERSION_SEPARATOR = /[.-]/;
const DIST_IMPORT = /\.\.\/\.\.\/dist\/([A-Za-z0-9/-]+)\.mjs/g;
const TSDOWN_ENTRY =
  /^\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*)):\s*"\.\/(src\/[^"]+)"/gm;
const PACKAGE_JSON = /(^|\/)package\.json$/;
// Entries every application or every extension imports: their folders are
// nobody's own.
const SHARED_ENTRIES = new Set(["index", "pg", "schema", "validation"]);

const parseArguments = (argv) => {
  const options = {
    root: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    detail: null,
    only: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") {
      options.root = resolve(argv[index + 1] ?? "");
      index += 1;
    } else if (argument === "--detail") {
      options.detail = argv[index + 1] ?? "all";
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new Error(`unknown option: ${argument}`);
    } else {
      options.only.push(argument);
    }
  }
  return options;
};

const compareVersions = (a, b) => {
  const pa = a.split(VERSION_SEPARATOR).map((part) => Number(part) || 0);
  const pb = b.split(VERSION_SEPARATOR).map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const difference = (pa[index] ?? 0) - (pb[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

/**
 * esbuild comes to the checkout through size-limit's presets, not as a direct
 * dependency: resolve it normally, else take the newest in pnpm's store.
 */
const loadEsbuild = async (root) => {
  try {
    const direct = createRequire(join(root, "package.json")).resolve("esbuild");
    const loaded = await import(`file://${direct}`);
    return loaded.default ?? loaded;
  } catch {
    // Not hoisted: look in the virtual store below.
  }
  const store = join(root, "node_modules", ".pnpm");
  const newest = existsSync(store)
    ? readdirSync(store)
        .filter((name) => ESBUILD_STORE_DIRECTORY.test(name))
        .sort((a, b) =>
          compareVersions(
            a.slice("esbuild@".length),
            b.slice("esbuild@".length)
          )
        )
        .at(-1)
    : undefined;
  if (newest === undefined) {
    throw new Error(`no esbuild under ${root}/node_modules; run pnpm install`);
  }
  const loaded = await import(
    `file://${join(store, newest, "node_modules/esbuild/lib/main.js")}`
  );
  return loaded.default ?? loaded;
};

/** Each public entry's source file, as `tsdown.config.ts` builds it. */
const readEntries = (root) => {
  const entries = new Map();
  const config = readFileSync(join(root, "tsdown.config.ts"), "utf8");
  for (const match of config.matchAll(TSDOWN_ENTRY)) {
    entries.set(match[1] ?? match[2], match[3]);
  }
  return entries;
};

const entryFolder = (source) => {
  const parts = source.split("/");
  return parts.length > 2 ? `${parts[0]}/${parts[1]}` : source;
};

/** The source folders a fixture's own entries live in. */
const ownFolders = (fixture, entries) => {
  const folders = new Set();
  for (const match of fixture.matchAll(DIST_IMPORT)) {
    const source = entries.get(match[1]);
    if (source !== undefined && !SHARED_ENTRIES.has(match[1])) {
      folders.add(entryFolder(source));
    }
  }
  return [...folders].sort();
};

const versionOnly = (root) => ({
  name: "package-json-version-only",
  setup(build) {
    build.onLoad({ filter: PACKAGE_JSON }, (args) => {
      if (args.path !== join(root, "package.json")) return;
      const { version } = JSON.parse(readFileSync(args.path, "utf8"));
      return { contents: JSON.stringify({ version }), loader: "json" };
    });
  },
});

const zoneOf = (file) => {
  const parts = file.split("/");
  if (parts[0] !== "src") return parts[0];
  if (parts[1] === "query-engine") return `src/query-engine/${parts[2]}`;
  return `src/${parts[1]}`;
};

const inFolder = (file, folder) =>
  file === folder || file.startsWith(`${folder}/`);

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  const { root } = options;
  const esbuild = await loadEsbuild(root);
  const entries = readEntries(root);
  const fixtureDirectory = join(root, "scripts", "bundle-fixtures");
  const cache = join(root, "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });

  const build = async (name) => {
    const fixture = readFileSync(join(fixtureDirectory, `${name}.mjs`), "utf8");
    const pointed = fixture.replace(DIST_IMPORT, (whole, entry) => {
      const source = entries.get(entry);
      if (source === undefined) {
        throw new Error(`${name}: no tsdown entry for ${whole}`);
      }
      return join(root, source);
    });
    const entry = join(cache, `ext-bytes-${name}.mjs`);
    writeFileSync(entry, pointed);
    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      minify: true,
      write: false,
      metafile: true,
      format: "esm",
      platform: "node",
      tsconfig: join(root, "tsconfig.json"),
      packages: "external",
      logLevel: "error",
      absWorkingDir: root,
      plugins: [versionOnly(root)],
    });
    const code = result.outputFiles[0].contents;
    const files = {};
    const output = Object.values(result.metafile.outputs)[0];
    for (const [file, info] of Object.entries(output.inputs)) {
      files[file] = info.bytesInOutput;
    }
    return {
      min: code.length,
      gzip: gzipSync(code).length,
      files,
      own: ownFolders(fixture, entries),
    };
  };

  const names = readdirSync(fixtureDirectory)
    .map((file) => FIXTURE_FILE.exec(file)?.[1])
    .filter((name) => name !== undefined && name !== BASE)
    .filter((name) => options.only.length === 0 || options.only.includes(name))
    .sort();

  const base = await build(BASE);
  const rows = [];
  for (const name of names) {
    const measured = await build(name);
    const changes = [];
    for (const [file, bytes] of Object.entries(measured.files)) {
      const difference = bytes - (base.files[file] ?? 0);
      if (difference !== 0) changes.push([difference, file]);
    }
    for (const [file, bytes] of Object.entries(base.files)) {
      if (!(file in measured.files)) changes.push([-bytes, file]);
    }
    const sum = (keep) =>
      changes.reduce(
        (total, [bytes, file]) => total + (keep(file) ? bytes : 0),
        0
      );
    rows.push({
      name,
      min: measured.min - base.min,
      gzip: measured.gzip - base.gzip,
      extensions: sum((file) => inFolder(file, "src/extensions")),
      own:
        measured.own.length === 0
          ? null
          : sum((file) =>
              measured.own.some((folder) => inFolder(file, folder))
            ),
      folders: measured.own,
      changes,
    });
  }

  const out = (line = "") => process.stdout.write(`${line}\n`);
  out(`${BASE} (base): ${base.min} B minified, ${base.gzip} B gzip`);
  out(
    "package.json, which src/version.ts inlines whole when built from src, is reduced to its version field, as in the built package."
  );
  out();
  const width = Math.max(...rows.map((row) => row.name.length), 7);
  const cell = (value) => String(value ?? "—").padStart(9);
  out(
    `${"fixture".padEnd(width)}  ${"+min".padStart(9)}  ${"+gzip".padStart(9)}  ${"src/ext".padStart(9)}  ${"own".padStart(9)}  own folders`
  );
  for (const row of rows) {
    out(
      `${row.name.padEnd(width)}  ${cell(row.min)}  ${cell(row.gzip)}  ${cell(row.extensions)}  ${cell(row.own)}  ${row.folders.join(", ")}`
    );
  }
  out();
  out(
    "Bytes are what the fixture adds to the base. src/ext: src/extensions. own: the folders of the entries it imports beyond pg, schema, validation and the root."
  );

  for (const row of rows) {
    if (options.detail !== "all" && options.detail !== row.name) continue;
    out();
    out(`${row.name}: by folder, then by file`);
    const zones = {};
    for (const [bytes, file] of row.changes) {
      zones[zoneOf(file)] = (zones[zoneOf(file)] ?? 0) + bytes;
    }
    for (const [zone, bytes] of Object.entries(zones).sort(
      (a, b) => b[1] - a[1]
    )) {
      out(`  ${String(bytes).padStart(7)}  ${zone}`);
    }
    for (const [bytes, file] of [...row.changes].sort((a, b) => b[0] - a[0])) {
      out(`      ${String(bytes).padStart(7)}  ${file}`);
    }
  }
};

await main();
