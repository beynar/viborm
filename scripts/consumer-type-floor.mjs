/**
 * The consumer type floor for `await using` (plan Phase T6).
 *
 * Adding `[Symbol.asyncDispose]` to a published type is the kind of change that
 * can quietly raise the compiler floor for EVERY consumer — including the ones
 * who never write `await using` — because a bare computed key needs
 * `SymbolConstructor.asyncDispose` to be declared before the `.d.mts` will
 * type-check at all. This script measures that, on the built artifact, so the
 * claim in the docs is a measurement and not a hope.
 *
 * Run after `pnpm package:build`. Three probes:
 *
 *   A. FLOOR       — a consumer who never writes `await using` compiles against
 *                    the published entrypoints at `lib: ["es2022"]`.
 *   B. ISOLATION   — viborm's own disposal carrier, lifted verbatim out of the
 *                    emitted `.d.mts` and compiled with NO ambient types at all,
 *                    still type-checks. This is the probe that fails if someone
 *                    replaces the mapped key with a bare `[Symbol.asyncDispose]`.
 *   C. CAPABILITY  — the same carrier, compiled where the symbol IS declared,
 *                    still yields a real `AsyncDisposable`. Without this, probe B
 *                    could be satisfied by degrading disposal away for everyone.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(repoRoot, "dist");
// Named by path, never `node_modules/.bin/tsc`: that link is whichever of the
// two installed TypeScripts won pnpm's bin collision, and today it is the
// native 7.0.2 - which refuses files on the command line beside a tsconfig
// (TS5112). The floor is about the JS compiler consumers run.
const tsc =
  process.env.VIBORM_TYPESCRIPT_BIN === undefined
    ? join(repoRoot, "node_modules", "typescript", "bin", "tsc")
    : resolve(repoRoot, process.env.VIBORM_TYPESCRIPT_BIN);

const BASE_FLAGS = [
  "--noEmit",
  "--strict",
  "--target",
  "es2022",
  "--module",
  "esnext",
  "--moduleResolution",
  "bundler",
];

const workDir = mkdtempSync(join(tmpdir(), "viborm-consumer-floor-"));
/** An empty directory, so `--typeRoots` finds genuinely nothing. */
const emptyTypeRoots = mkdtempSync(join(tmpdir(), "viborm-no-types-"));

function typeCheck(file, flags) {
  try {
    execFileSync(tsc, [...BASE_FLAGS, ...flags, file], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return "";
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
  }
}

function fail(probe, detail) {
  throw new Error(`[consumer-type-floor] ${probe} FAILED\n${detail}`);
}

// ---------------------------------------------------------------------------
// Probe A — the floor a non-user of `await using` pays.
// ---------------------------------------------------------------------------

const consumerFile = join(workDir, "consumer.ts");
writeFileSync(
  consumerFile,
  [
    `import { createClient } from ${JSON.stringify(join(distDir, "index.mjs"))};`,
    `import { Driver } from ${JSON.stringify(join(distDir, "driver.mjs"))};`,
    "export type Client = ReturnType<typeof createClient>;",
    "export type AnyDriverCtor = typeof Driver;",
    "",
  ].join("\n")
);

const floorErrors = typeCheck(consumerFile, [
  "--skipLibCheck",
  "--lib",
  "es2022",
]);
if (floorErrors !== "") {
  fail(
    "A (FLOOR: lib=es2022, skipLibCheck)",
    `A consumer who never writes 'await using' must compile at this floor.\n${floorErrors}`
  );
}

// ---------------------------------------------------------------------------
// Probes B and C — the disposal carrier, lifted verbatim from the artifact.
// ---------------------------------------------------------------------------

/**
 * Lift `AsyncDisposeMember` (and `AsyncDisposeKey`, if the member still leans on
 * it) verbatim out of the emitted declarations.
 *
 * Deliberately form-agnostic: it extracts whatever the build actually emitted,
 * so probe B judges the artifact rather than judging that the artifact matches
 * a spelling this script already expects.
 */
function extractAlias(source, name) {
  const start = source.indexOf(`type ${name}`);
  if (start === -1) return undefined;
  // Aliases here are object types; the declaration ends at the `;` that follows
  // the closing brace of the outermost body.
  const open = source.indexOf("{", start);
  if (open === -1) return undefined;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        const end = source.indexOf(";", i);
        return source.slice(start, end === -1 ? i + 1 : end + 1);
      }
    }
  }
  return undefined;
}

function extractCarrier() {
  for (const name of readdirSync(distDir)) {
    if (!name.endsWith(".d.mts")) continue;
    const source = readFileSync(join(distDir, name), "utf8");
    const member = extractAlias(source, "AsyncDisposeMember");
    if (member === undefined) continue;
    if (!member.includes("AsyncDisposeKey")) return member;
    const key = extractAlias(source, "AsyncDisposeKey");
    if (key === undefined) continue;
    return `${key}\n${member}`;
  }
  return undefined;
}

const carrier = extractCarrier();
if (carrier === undefined) {
  fail(
    "B/C (carrier lookup)",
    "No 'AsyncDisposeKey'/'AsyncDisposeMember' declaration found in any dist/*.d.mts. " +
      "Either the build is stale, or the disposal member is no longer carried by a " +
      "degrading alias — which is exactly the regression this script exists to catch."
  );
}

const isolationFile = join(workDir, "carrier-isolated.ts");
writeFileSync(
  isolationFile,
  `${carrier}\nexport type Carrier = AsyncDisposeMember;\nexport declare const carried: AsyncDisposeMember;\n`
);

const isolationErrors = typeCheck(isolationFile, [
  "--skipLibCheck",
  "false",
  "--lib",
  "es2022",
  "--typeRoots",
  emptyTypeRoots,
]);
if (isolationErrors !== "") {
  fail(
    "B (ISOLATION: lib=es2022, no ambient types, skipLibCheck OFF)",
    "viborm's disposal member raises the compiler floor for consumers who never " +
      "write 'await using'. Keep it keyed through the mapped 'AsyncDisposeKey' " +
      `rather than a bare '[Symbol.asyncDispose]'.\n${isolationErrors}`
  );
}

const capabilityFile = join(workDir, "carrier-capable.ts");
writeFileSync(
  capabilityFile,
  [
    carrier,
    "export declare const carried: AsyncDisposeMember;",
    "// Where the symbol IS declared, the carrier must still BE the protocol.",
    "export const asDisposable: AsyncDisposable = carried;",
    "export async function scoped() {",
    "  await using held = carried;",
    "  void held;",
    "}",
    "",
  ].join("\n")
);

const capabilityErrors = typeCheck(capabilityFile, [
  "--skipLibCheck",
  "false",
  "--lib",
  "es2022,esnext.disposable",
  "--typeRoots",
  emptyTypeRoots,
]);
if (capabilityErrors !== "") {
  fail(
    "C (CAPABILITY: lib=es2022,esnext.disposable)",
    "The carrier degraded away even where 'Symbol.asyncDispose' IS declared — " +
      `'await using' would not work for anyone.\n${capabilityErrors}`
  );
}

process.stdout.write(
  "[consumer-type-floor] A floor / B isolation / C capability: all green.\n" +
    '  Floor for consumers who never write `await using`: lib=["es2022"], no @types/node, skipLibCheck on.\n' +
    "  To USE `await using`: Symbol.asyncDispose must be declared — lib `esnext.disposable` (TS >=5.2) or @types/node >=20.\n"
);
