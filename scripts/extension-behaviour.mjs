#!/usr/bin/env node

/**
 * The behaviour net of the extension rewrite: the same calls, the same
 * answers, before and after each step.
 *
 * `scripts/extension-behaviour/scenario.mjs` makes its calls through the
 * public entries (`viborm`, `viborm/sqlite3`, `viborm/soft-delete`, …) on
 * in-memory SQLite. This script bundles it against the checkout's `src` (each
 * `viborm/<entry>` resolved to the file `tsdown.config.ts` builds that entry
 * from), runs it, and compares every answer with the recorded file
 * `scripts/extension-behaviour/answers.jsonl`: a result, or an error's class
 * and code, and the SQL and parameters where a call captures them. An
 * error's message is recorded too, but a changed message alone is printed as
 * a note and does not fail, since error texts may change.
 *
 * Usage:
 *   node scripts/extension-behaviour.mjs [--record] [section...]
 *
 * `--record` rewrites the answers file instead of comparing. Section letters
 * (A to N, see `SECTIONS` in the scenario) run and compare only those.
 * Exit code 1 on any difference.
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const here = join(root, "scripts", "extension-behaviour");
const answersFile = join(here, "answers.jsonl");
const bundleFile = join(
  root,
  "node_modules",
  ".cache",
  "extension-behaviour.mjs"
);

const ESBUILD_STORE_DIRECTORY = /^esbuild@\d/;
const VERSION_SEPARATOR = /[.-]/;
const TSDOWN_ENTRY =
  /^\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*)):\s*"\.\/(src\/[^"]+)"/gm;
const PUBLIC_SPECIFIER = /^viborm(?:\/(.+))?$/;
const SECTION = /^[A-Z]$/;

const compareVersions = (a, b) => {
  const pa = a.split(VERSION_SEPARATOR).map((part) => Number(part) || 0);
  const pb = b.split(VERSION_SEPARATOR).map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const difference = (pa[index] ?? 0) - (pb[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

/** esbuild from the checkout's own node_modules (see extension-bytes.mjs). */
const loadEsbuild = async () => {
  try {
    const direct = createRequire(join(root, "package.json")).resolve("esbuild");
    const loaded = await import(pathToFileURL(direct).href);
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
    pathToFileURL(join(store, newest, "node_modules/esbuild/lib/main.js")).href
  );
  return loaded.default ?? loaded;
};

const publicEntries = () => {
  const entries = new Map();
  const config = readFileSync(join(root, "tsdown.config.ts"), "utf8");
  for (const match of config.matchAll(TSDOWN_ENTRY)) {
    entries.set(match[1] ?? match[2], join(root, match[3]));
  }
  return entries;
};

const bundleScenario = async () => {
  const esbuild = await loadEsbuild();
  const entries = publicEntries();
  const publicImports = {
    name: "viborm-public-entries",
    setup(build) {
      build.onResolve({ filter: PUBLIC_SPECIFIER }, (args) => {
        const entry = PUBLIC_SPECIFIER.exec(args.path)?.[1] ?? "index";
        const path = entries.get(entry);
        if (path === undefined) {
          return { errors: [{ text: `no public entry "${args.path}"` }] };
        }
        return { path };
      });
    },
  };
  mkdirSync(dirname(bundleFile), { recursive: true });
  await esbuild.build({
    entryPoints: [join(here, "scenario.mjs")],
    bundle: true,
    outfile: bundleFile,
    format: "esm",
    platform: "node",
    tsconfig: join(root, "tsconfig.json"),
    packages: "external",
    logLevel: "error",
    absWorkingDir: root,
    plugins: [publicImports],
  });
};

const readAnswers = () =>
  existsSync(answersFile)
    ? readFileSync(answersFile, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line))
    : [];

const labelsOf = (answers) => {
  const byLabel = new Map();
  for (const answer of answers) {
    if (byLabel.has(answer[0])) {
      throw new Error(`label "${answer[0]}" is answered twice`);
    }
    byLabel.set(answer[0], answer);
  }
  return byLabel;
};

// What fails: a result, or an error's class and code. The message is a note.
const compared = ([, status, value]) =>
  status === "err" ? [status, value.error, value.code] : [status, value];

const show = (answer) => JSON.stringify(answer.slice(1)).slice(0, 600);

const main = async () => {
  const argv = process.argv.slice(2);
  const record = argv.includes("--record");
  const only = argv.filter((argument) => SECTION.test(argument));
  const unknown = argv.filter(
    (argument) => argument !== "--record" && !SECTION.test(argument)
  );
  if (unknown.length > 0)
    throw new Error(`unknown arguments: ${unknown.join(" ")}`);

  await bundleScenario();
  const scenario = await import(pathToFileURL(bundleFile).href);
  const answers = await scenario.run(only);
  const current = labelsOf(answers);

  if (record) {
    const kept = only.length === 0 ? [] : readAnswers();
    const merged = labelsOf(kept);
    for (const [label, answer] of current) merged.set(label, answer);
    const lines = [...merged.values()].map((answer) => JSON.stringify(answer));
    writeFileSync(answersFile, `${lines.join("\n")}\n`);
    process.stdout.write(
      `recorded ${current.size} answers in ${answersFile}\n`
    );
    return 0;
  }

  const recorded = labelsOf(readAnswers());
  let differences = 0;
  let notes = 0;
  for (const [label, answer] of current) {
    const before = recorded.get(label);
    if (before === undefined) {
      differences += 1;
      process.stdout.write(`NEW      ${label}\n  now     ${show(answer)}\n`);
    } else if (!isDeepStrictEqual(compared(before), compared(answer))) {
      differences += 1;
      process.stdout.write(
        `CHANGED  ${label}\n  before  ${show(before)}\n  now     ${show(answer)}\n`
      );
    } else if (answer[1] === "err" && before[2].message !== answer[2].message) {
      notes += 1;
      process.stdout.write(
        `note     ${label}: message\n  before  ${before[2].message}\n  now     ${answer[2].message}\n`
      );
    }
  }
  if (only.length === 0) {
    for (const label of recorded.keys()) {
      if (!current.has(label)) {
        differences += 1;
        process.stdout.write(`MISSING  ${label}\n`);
      }
    }
  }
  process.stdout.write(
    `${current.size} answers compared: ${differences} different, ${notes} message notes\n`
  );
  return differences === 0 ? 0 : 1;
};

process.exit(await main());
