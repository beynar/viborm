#!/usr/bin/env node

/**
 * Bundle-size and production-LOC baseline.
 *
 * `pnpm size` (size-limit with the @size-limit/file preset) weighs ONE FILE on
 * disk. tsdown emits a per-entry stub plus shared chunks, so `dist/index.mjs`
 * is 1.99 kB while the code it pulls in is two orders of magnitude larger. That
 * number cannot answer "what does importing viborm cost an application", which
 * is the only question a dependency swap is judged on. This script answers it:
 * it bundles fixed fixtures against the BUILT `dist/`, exactly as a consumer's
 * bundler would, and reports raw / gzip / brotli for each.
 *
 * Requires `pnpm package:build` to have run first.
 *
 * Determinism: the output JSON carries no timestamps and no machine-specific
 * paths. Two runs at the same commit with the same `dist/` must be byte-equal.
 *
 * Usage:
 *   node scripts/measure-bundle.mjs [--out <path>] [--print]
 *
 * Environment:
 *   VIBORM_BIGJS_DIR  Directory holding an unpacked big.js (the directory that
 *                     contains its package.json). big.js is NOT a dependency of
 *                     this package; when the variable is unset or the directory
 *                     is missing, the big.js row records `available: false`
 *                     instead of failing.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  brotliCompressSync,
  gzipSync,
  constants as zlibConstants,
} from "node:zlib";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const fixtureDir = join(scriptDir, "bundle-fixtures");

// ---------------------------------------------------------------------------
// esbuild resolution
// ---------------------------------------------------------------------------

/**
 * esbuild is not a direct dependency of this package; it arrives under pnpm's
 * virtual store through size-limit's esbuild presets. Resolve it normally
 * first, then fall back to the highest version in the virtual store, and record
 * which one was used so a number can be reproduced.
 */
const ESBUILD_STORE_DIRECTORY = /^esbuild@\d/;
const VERSION_SEPARATOR = /[.-]/;
const HASHED_CHUNK = /^dist\/(.*)-[A-Za-z0-9_-]{8}(\.mjs)$/;
const PNPM_VIRTUAL_STORE = /^node_modules\/\.pnpm\/[^/]+\/node_modules\//;

const loadEsbuild = async () => {
  const require_ = createRequire(join(repoRoot, "package.json"));
  try {
    const direct = require_.resolve("esbuild");
    const mod = await import(`file://${direct}`);
    return { module: mod.default ?? mod, source: "node_modules/esbuild" };
  } catch {
    // fall through to the virtual store
  }
  const storeDir = join(repoRoot, "node_modules", ".pnpm");
  if (!existsSync(storeDir)) {
    throw new Error(
      "esbuild is not installed and node_modules/.pnpm is absent; run `pnpm install`"
    );
  }
  const candidates = readdirSync(storeDir)
    .filter((name) => ESBUILD_STORE_DIRECTORY.test(name))
    .map((name) => ({
      name,
      version: name.slice("esbuild@".length),
      entry: join(storeDir, name, "node_modules", "esbuild", "lib", "main.js"),
    }))
    .filter((candidate) => existsSync(candidate.entry))
    .sort((a, b) => compareVersions(a.version, b.version));
  const chosen = candidates.at(-1);
  if (!chosen) {
    throw new Error("no esbuild found in node_modules/.pnpm");
  }
  const mod = await import(`file://${chosen.entry}`);
  return {
    module: mod.default ?? mod,
    source: `node_modules/.pnpm/${chosen.name}`,
  };
};

const compareVersions = (a, b) => {
  const pa = a.split(VERSION_SEPARATOR).map((part) => Number(part) || 0);
  const pb = b.split(VERSION_SEPARATOR).map((part) => Number(part) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

// ---------------------------------------------------------------------------
// Bundle options — one object, used for every fixture, so the rows compare
// ---------------------------------------------------------------------------

/**
 * Every package a consumer installs separately (drivers, peer deps, runtime
 * built-ins). Anything NOT listed here is counted, which is the point: the
 * id/decimal libraries are real `dependencies` and must land inside the number.
 */
const EXTERNAL = [
  "pg",
  "postgres",
  "mysql2",
  "better-sqlite3",
  "@libsql/client",
  "@neondatabase/serverless",
  "@planetscale/database",
  "@electric-sql/pglite",
  "@cloudflare/workers-types",
  "@opentelemetry/api",
  "commander",
  "@clack/prompts",
  "bun",
  "bun:sqlite",
  "bun:sql",
];

const BUNDLE_OPTIONS = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  minify: true,
  treeShaking: true,
  external: EXTERNAL,
  write: false,
  legalComments: "none",
  logLevel: "silent",
};

const measureBytes = (bytes) => ({
  raw: bytes.byteLength,
  gzip: gzipSync(bytes, { level: 9 }).byteLength,
  brotli: brotliCompressSync(bytes, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY,
    },
  }).byteLength,
});

/**
 * tsdown hashes its shared chunk names (`dist/v-WdGCC0Lz.mjs`), so a rebuild
 * with no source change still renames them. Erase the hash so the composition
 * table survives a rebuild.
 */
const stableInputName = (name) =>
  name
    .replace(HASHED_CHUNK, "dist/$1-*$2")
    .replace(PNPM_VIRTUAL_STORE, "node_modules/");

/**
 * Which npm package a bundled input came from, or null for first-party code.
 * `node_modules/.pnpm/@noble+hashes@2.0.1/node_modules/@noble/hashes/sha3.js`
 * is attributed to `@noble/hashes`.
 */
const inputPackage = (name) => {
  const marker = "/node_modules/";
  const index = name.lastIndexOf(marker);
  if (index === -1) return null;
  const rest = name.slice(index + marker.length);
  const segments = rest.split("/");
  return segments[0].startsWith("@")
    ? `${segments[0]}/${segments[1]}`
    : segments[0];
};

const TOP_INPUT_COUNT = 12;

const bundleFile = async (esbuild, entryPath, extra = {}) => {
  const result = await esbuild.build({
    ...BUNDLE_OPTIONS,
    absWorkingDir: repoRoot,
    entryPoints: [entryPath],
    metafile: true,
    ...extra,
  });
  const output = result.outputFiles[0];
  const measurement = measureBytes(output.contents);
  const outputKey = Object.keys(result.metafile.outputs)[0];
  const inputs = Object.entries(result.metafile.outputs[outputKey].inputs);
  const byPackage = {};
  let firstPartyBytes = 0;
  for (const [name, info] of inputs) {
    const pkg = inputPackage(name);
    if (pkg === null) firstPartyBytes += info.bytesInOutput;
    else byPackage[pkg] = (byPackage[pkg] ?? 0) + info.bytesInOutput;
  }
  const sortedPackages = {};
  for (const key of Object.keys(byPackage).sort()) {
    sortedPackages[key] = byPackage[key];
  }
  return {
    ...measurement,
    // Pre-minification input bytes, not output bytes: esbuild attributes each
    // input's contribution to the output, so these sum to roughly `raw`.
    composition: {
      firstPartyBytes,
      dependencyBytes: sortedPackages,
      topInputs: inputs
        .map(([name, info]) => [stableInputName(name), info.bytesInOutput])
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, TOP_INPUT_COUNT)
        .map(([name, bytes]) => ({ name, bytes })),
    },
  };
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PACKAGE_FIXTURES = [
  ["ids-only", "ids-only.mjs"],
  ["decimal-only", "decimal-only.mjs"],
  ["pg-representative", "pg-representative.mjs"],
  ["full", "full.mjs"],
];

const LIBRARY_FIXTURES = [
  ["@paralleldrive/cuid2", "lib/cuid2.mjs"],
  ["nanoid", "lib/nanoid.mjs"],
  ["ulidx", "lib/ulidx.mjs"],
  ["decimal.js", "lib/decimal.mjs"],
];

const installedVersion = (name) => {
  const manifest = join(repoRoot, "node_modules", name, "package.json");
  if (!existsSync(manifest)) return null;
  return JSON.parse(readFileSync(manifest, "utf8")).version ?? null;
};

/**
 * big.js is deliberately NOT in package.json. Point VIBORM_BIGJS_DIR at an
 * unpacked tarball (`npm pack big.js@latest` then `tar xzf`) to price it.
 */
const measureBigJs = async (esbuild) => {
  const dir = process.env.VIBORM_BIGJS_DIR;
  if (!(dir && existsSync(join(dir, "package.json")))) {
    return { available: false, reason: "VIBORM_BIGJS_DIR unset or empty" };
  }
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const measurement = await bundleFile(
    esbuild,
    join(fixtureDir, "lib", "big.mjs"),
    // The fixture imports "big.js" by name; resolve it to the unpacked copy.
    { alias: { "big.js": join(dir, manifest.module ?? "big.mjs") } }
  );
  return {
    available: true,
    version: manifest.version ?? null,
    raw: measurement.raw,
    gzip: measurement.gzip,
    brotli: measurement.brotli,
  };
};

// ---------------------------------------------------------------------------
// dist inventory
// ---------------------------------------------------------------------------

const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
};

const measureDist = () => {
  const distDir = join(repoRoot, "dist");
  if (!existsSync(distDir)) {
    throw new Error("dist/ is absent; run `pnpm package:build` first");
  }
  const files = walk(distDir).sort();
  const byExtension = {};
  let totalBytes = 0;
  for (const file of files) {
    const size = statSync(file).size;
    totalBytes += size;
    const name = file.slice(distDir.length + 1);
    const extension = name.endsWith(".mjs.map")
      ? "mjs.map"
      : name.endsWith(".d.mts")
        ? "d.mts"
        : name.slice(name.lastIndexOf(".") + 1);
    const bucket = (byExtension[extension] ??= { files: 0, bytes: 0 });
    bucket.files += 1;
    bucket.bytes += size;
  }
  // What actually ships as executable code, ignoring maps and declarations.
  const runtimeBytes = byExtension.mjs?.bytes ?? 0;
  return {
    files: files.length,
    totalBytes,
    runtimeMjsBytes: runtimeBytes,
    byExtension,
  };
};

// ---------------------------------------------------------------------------
// Production LOC
// ---------------------------------------------------------------------------

/**
 * Non-blank, non-comment-only lines of `src/**\/*.ts`. A line inside a block
 * comment counts as a comment; a line with code before a trailing `//` counts
 * as code. Declaration files (`*.d.ts`) are excluded — they are types the build
 * regenerates, not maintained production code.
 */
const countFileLoc = (source) => {
  let code = 0;
  let comment = 0;
  let blank = 0;
  let inBlock = false;
  // A file ending in a newline splits to a trailing "" that is not a line.
  const lines = source.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") {
      blank += 1;
      continue;
    }
    if (inBlock) {
      comment += 1;
      const end = line.indexOf("*/");
      if (end !== -1) {
        inBlock = false;
        // Code after the close on the same line makes it a code line.
        if (line.slice(end + 2).trim() !== "") {
          comment -= 1;
          code += 1;
        }
      }
      continue;
    }
    if (line.startsWith("//")) {
      comment += 1;
      continue;
    }
    if (line.startsWith("/*")) {
      const end = line.indexOf("*/");
      if (end === -1) {
        inBlock = true;
        comment += 1;
        continue;
      }
      if (line.slice(end + 2).trim() === "") {
        comment += 1;
        continue;
      }
      code += 1;
      continue;
    }
    // A code line may still open a block comment that runs past it.
    const openIndex = line.lastIndexOf("/*");
    if (openIndex !== -1 && line.indexOf("*/", openIndex) === -1)
      inBlock = true;
    code += 1;
  }
  return { code, comment, blank };
};

const countLoc = () => {
  const srcDir = join(repoRoot, "src");
  const files = walk(srcDir)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
    .sort();
  const perDirectory = {};
  const total = { files: 0, code: 0, comment: 0, blank: 0 };
  for (const file of files) {
    const relativePath = relative(srcDir, file);
    const segments = relativePath.split(sep);
    const bucketName = segments.length === 1 ? "(root)" : segments[0];
    const counts = countFileLoc(readFileSync(file, "utf8"));
    const bucket = (perDirectory[bucketName] ??= {
      files: 0,
      code: 0,
      comment: 0,
      blank: 0,
    });
    bucket.files += 1;
    bucket.code += counts.code;
    bucket.comment += counts.comment;
    bucket.blank += counts.blank;
    total.files += 1;
    total.code += counts.code;
    total.comment += counts.comment;
    total.blank += counts.blank;
  }
  const sorted = {};
  for (const key of Object.keys(perDirectory).sort()) {
    sorted[key] = perDirectory[key];
  }
  return { total, perDirectory: sorted };
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const gitCommit = () => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
};

const parseArguments = (argv) => {
  const options = {
    out: join(repoRoot, "docs/architecture/native-ids-evidence/baseline.json"),
    print: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") {
      options.out = resolve(repoRoot, argv[i + 1] ?? "");
      i += 1;
    } else if (argv[i] === "--print") {
      options.print = true;
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return options;
};

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  const { module: esbuild, source: esbuildSource } = await loadEsbuild();

  const fixtures = {};
  for (const [name, file] of PACKAGE_FIXTURES) {
    fixtures[name] = await bundleFile(esbuild, join(fixtureDir, file));
  }

  const libraries = {};
  for (const [name, file] of LIBRARY_FIXTURES) {
    // A library this package has REMOVED can no longer be priced: its fixture
    // has nothing to resolve. The row stays, saying so, rather than
    // disappearing — the before/after comparison is the whole point of the
    // measurement, and a missing row would read as a measurement that was
    // never taken.
    const version = installedVersion(name);
    if (version === null) {
      libraries[name] = { available: false, reason: "not installed" };
      continue;
    }
    const measurement = await bundleFile(esbuild, join(fixtureDir, file));
    libraries[name] = {
      version,
      raw: measurement.raw,
      gzip: measurement.gzip,
      brotli: measurement.brotli,
      // A library's own transitive cost: cuid2 v3 drags bignumber.js and
      // @noble/hashes behind it.
      dependencyBytes: measurement.composition.dependencyBytes,
    };
  }
  libraries["big.js"] = await measureBigJs(esbuild);

  const report = {
    schemaVersion: 1,
    commit: gitCommit(),
    tool: {
      esbuild: esbuild.version,
      esbuildSource,
      bundleOptions: {
        bundle: BUNDLE_OPTIONS.bundle,
        format: BUNDLE_OPTIONS.format,
        platform: BUNDLE_OPTIONS.platform,
        target: BUNDLE_OPTIONS.target,
        minify: BUNDLE_OPTIONS.minify,
        treeShaking: BUNDLE_OPTIONS.treeShaking,
        external: EXTERNAL,
      },
      gzipLevel: 9,
      brotliQuality: zlibConstants.BROTLI_MAX_QUALITY,
    },
    dist: measureDist(),
    fixtures,
    libraries,
    loc: countLoc(),
  };

  const json = `${JSON.stringify(report, null, 2)}\n`;
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, json);

  const kb = (bytes) => (bytes / 1024).toFixed(2).padStart(9);
  process.stdout.write(`esbuild ${esbuild.version} (${esbuildSource})\n`);
  process.stdout.write(
    `dist: ${report.dist.files} files, ${(report.dist.totalBytes / 1024).toFixed(1)} KiB total, ${(report.dist.runtimeMjsBytes / 1024).toFixed(1)} KiB of .mjs\n\n`
  );
  process.stdout.write(
    "fixture                    raw KiB  gzip KiB    br KiB\n"
  );
  for (const [name, row] of Object.entries(fixtures)) {
    process.stdout.write(
      `${name.padEnd(24)}${kb(row.raw)}${kb(row.gzip)}${kb(row.brotli)}\n`
    );
  }
  process.stdout.write(
    "\nlibrary alone              raw KiB  gzip KiB    br KiB\n"
  );
  for (const [name, row] of Object.entries(libraries)) {
    if (row.available === false) {
      process.stdout.write(
        `${name.padEnd(24)}  (not measured: ${row.reason})\n`
      );
      continue;
    }
    process.stdout.write(
      `${name.padEnd(24)}${kb(row.raw)}${kb(row.gzip)}${kb(row.brotli)}\n`
    );
  }
  process.stdout.write(
    `\nsrc LOC: ${report.loc.total.code} code, ${report.loc.total.comment} comment, ${report.loc.total.blank} blank across ${report.loc.total.files} files\n`
  );
  for (const [name, row] of Object.entries(report.loc.perDirectory)) {
    process.stdout.write(
      `  ${name.padEnd(18)}${String(row.code).padStart(7)} code  ${String(row.files).padStart(4)} files\n`
    );
  }
  if (options.print) process.stdout.write(`\n${json}`);
  process.stdout.write(`\nwrote ${relative(repoRoot, options.out)}\n`);
};

await main();
