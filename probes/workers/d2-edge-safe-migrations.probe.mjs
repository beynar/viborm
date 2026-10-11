// D2: `viborm/migrations` is edge-safe. Loading it reaches no Node builtin
// (so workerd needs no nodejs_compat and no compatibility-date floor), its
// code never touches the `Buffer` global, and `createFsStorageWriter` lives only at
// `viborm/migrations/storage/fs`.
//
// Two checks, both against the INSTALLED package:
// 1. static: resolve the export map, walk the static import graph of the built
//    files and list every Node builtin and every `Buffer.x` use it reaches;
// 2. runtime emulation: a child Node process with every builtin import refused
//    and `globalThis.Buffer`/`process` deleted imports `viborm/migrations` and runs the
//    exported conformance suite over `MemoryEstateStorage` (it hashes with
//    SHA-256). The real workerd smoke is the repo's package smoke.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const meta = {
  id: "D2",
  title:
    "viborm/migrations loads without Node builtins; the fs writer is only at /storage/fs",
  plan: "phase-2/D2",
  needs: [],
  source:
    "docs/architecture/completion-plan-2026-10/code-check/migrations-sqlite.md (D2: src/migrations/index.ts:53, storage/fs-estate.ts:9-23, identity.ts:10, utils.ts:1,14,17, push-fingerprint.ts:12)",
};

const BUILTINS = new Set(builtinModules);
// Static `import … from "x"`, `import "x"`, `export … from "x"` at statement
// start; a dynamic `import("x")` is not loaded with the module.
const STATIC_IMPORT =
  /(?:^|[;\n}])\s*(?:import|export)\s*(?:[^;'"`()]*?\bfrom\s*)?["']([^"']+)["']/g;
// A `Buffer.x` member access; the lookbehind skips `ArrayBuffer.isView`.
const BUFFER_GLOBAL = /(?<![\w$.])Buffer\s*\.\s*\w+/;
const CHILD_TIMEOUT_MS = 30_000;
const CHILD_REPORT = /EDGE-OK|Error|refused|not defined/;

const isBuiltin = (specifier) =>
  specifier.startsWith("node:") || BUILTINS.has(specifier.split("/")[0]);

function walk(entryUrl) {
  const builtins = new Map();
  const externals = new Set();
  const bufferUsers = [];
  const seen = new Set();
  const queue = [entryUrl];
  while (queue.length > 0) {
    const url = queue.pop();
    if (seen.has(url)) continue;
    seen.add(url);
    const source = readFileSync(fileURLToPath(url), "utf8");
    if (BUFFER_GLOBAL.test(source)) {
      bufferUsers.push(url.slice(url.lastIndexOf("/") + 1));
    }
    for (const [, specifier] of source.matchAll(STATIC_IMPORT)) {
      if (isBuiltin(specifier)) {
        const file = url.slice(url.lastIndexOf("/") + 1);
        builtins.set(specifier, [...(builtins.get(specifier) ?? []), file]);
      } else if (specifier.startsWith(".")) {
        queue.push(new URL(specifier, url).href);
      } else {
        externals.add(specifier);
      }
    }
  }
  return { builtins, bufferUsers, externals, files: seen.size };
}

function runtimeEmulation(tmpDir, migrationsUrl) {
  const hooks = join(tmpDir, "refuse-builtins-hooks.mjs");
  const register = join(tmpDir, "refuse-builtins.mjs");
  const entry = join(tmpDir, "edge-entry.mjs");
  writeFileSync(
    hooks,
    `const builtins = new Set(${JSON.stringify([...BUILTINS])});
export async function resolve(specifier, context, next) {
  if (specifier.startsWith("node:") || builtins.has(specifier.split("/")[0])) {
    throw new Error(\`builtin \${specifier} refused (imported by \${context.parentURL?.split("/").pop()})\`);
  }
  return next(specifier, context);
}
`
  );
  writeFileSync(
    register,
    `import { register } from "node:module";\nregister(${JSON.stringify(pathToFileURL(hooks).href)});\n`
  );
  writeFileSync(
    entry,
    `delete globalThis.Buffer;
const { process } = globalThis;
delete globalThis.process;
const m = await import(${JSON.stringify(migrationsUrl)});
const suite = m.createStorageConformanceSuite(() => new m.MemoryEstateStorage());
for (const c of suite) await c.run();
process.stdout.write("EDGE-OK " + suite.length + " conformance cases\\n");
`
  );
  const child = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(register).href, entry],
    { encoding: "utf8", timeout: CHILD_TIMEOUT_MS }
  );
  const output = `${child.stdout}${child.stderr}`;
  const ok = child.status === 0 && output.includes("EDGE-OK");
  const reason =
    output
      .split("\n")
      .find((line) => CHILD_REPORT.test(line))
      ?.trim() ??
    `exit ${child.status}${child.error ? ` ${child.error.message}` : ""}`;
  return { ok, reason: reason.slice(0, 220) };
}

export default async function probe(ctx) {
  const migrationsUrl = import.meta.resolve("viborm/migrations");
  const problems = [];
  const facts = [];

  const graph = walk(migrationsUrl);
  facts.push(`static graph: ${graph.files} files`);
  if (graph.builtins.size > 0) {
    const listed = [...graph.builtins]
      .map(([name, files]) => `${name} (${[...new Set(files)].join(", ")})`)
      .join("; ");
    problems.push(`viborm/migrations statically loads ${listed}`);
  }
  if (graph.bufferUsers.length > 0) {
    problems.push(
      `viborm/migrations still uses the Buffer global in ${graph.bufferUsers.join(", ")}`
    );
  }
  if (graph.externals.size > 0) {
    facts.push(`external imports: ${[...graph.externals].join(", ")}`);
  }

  const migrations = await import("viborm/migrations");
  if ("createFsStorageWriter" in migrations) {
    problems.push("viborm/migrations still exports createFsStorageWriter");
  }
  let fsEntry;
  try {
    fsEntry = await import("viborm/migrations/storage/fs");
  } catch (error) {
    problems.push(`viborm/migrations/storage/fs does not load: ${error}`);
  }
  if (fsEntry && typeof fsEntry.createFsStorageWriter !== "function") {
    problems.push("viborm/migrations/storage/fs has no createFsStorageWriter");
  }

  const runtime = runtimeEmulation(ctx.tmpDir, migrationsUrl);
  if (runtime.ok) {
    facts.push(`builtins refused + no Buffer: ${runtime.reason}`);
  } else {
    problems.push(
      `with builtins refused and no Buffer, loading and hashing failed: ${runtime.reason}`
    );
  }

  return {
    status: problems.length === 0 ? "pass" : "fail",
    evidence: [...problems, ...facts].join(" | "),
  };
}
