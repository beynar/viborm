/**
 * An extension imports only what any extension author can import.
 *
 * `viborm/cache`, `viborm/on`, `viborm/ordering`, `viborm/permissions`,
 * `viborm/soft-delete` and `defaultOmit` (`viborm/client`) are built on the
 * public extension contract. Each file of theirs imports its own folder, a
 * package, or names the public entries export (`viborm`, `viborm/client`,
 * `viborm/validation`, and `viborm/instrumentation`, whose span and attribute
 * names the cache presents its units with). A name may be imported from the
 * module that defines it, which keeps the built chunks as they are, but it
 * must be a public name: anything else is a private channel into core, which
 * a third party could not take, and fails here. What an extension lacks
 * becomes public surface for everyone.
 *
 * `viborm/instrumentation` is not on the contract yet: it is listed below,
 * with what it still takes.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { PACKAGE_SURFACE_GOLDEN } from "@tests/package/public-surface-golden.mjs";
import { describe, expect, test } from "vitest";

const SRC = join(import.meta.dirname, "../../../src");

/** The source modules that are package entries, from the source root. */
const ENTRIES = new Set(["index", "client/exports", "validation"]);

/** Every name those entries export. */
const PUBLIC = new Set(
  [".", "./client", "./validation", "./instrumentation"].flatMap((entry) => {
    const surface = (
      PACKAGE_SURFACE_GOLDEN as Record<
        string,
        Record<"runtime" | "typeOnly" | "both", readonly string[]>
      >
    )[entry]!;
    return [...surface.runtime, ...surface.typeOnly, ...surface.both];
  })
);

/** The packages an extension may depend on. */
const PACKAGES = new Set([
  "@cloudflare/workers-types",
  "@standard-schema/spec",
]);

/**
 * The extensions built on the public contract: a folder of its own, or one
 * module (`defaultOmit` lives in the client's folder, and owns only itself).
 */
const ON_CONTRACT = [
  "cache",
  "client/default-omit-extension.ts",
  "on",
  "ordering",
  "permissions",
  "soft-delete",
];

/** The extensions that still take a private channel, and what is left. */
const PENDING: Readonly<Record<string, string>> = {
  instrumentation:
    "presents errors, parameters and log metadata through the package's private sanitizers (`sanitizeErrorForLogging`, `sanitizeDiagnosticParameters`, `sanitizeAllowedRecord`, `serializeTrustedError`): a public word for a disclosed error is the owner's to shape",
};

const IMPORT = /import\s+(type\s+)?([^;]*?)\s+from\s+"([^"]+)"/g;
const BINDING = /^(?:type\s+)?(\w+)(?:\s+as\s+\w+)?$/;

/** The imports of an extension's files that take something no public entry exports. */
function privateImportsOf(name: string, folder = name): string[] {
  if (name.endsWith(".ts")) return privateImportsOfFile(name, name);
  const found: string[] = [];
  for (const entry of readdirSync(join(SRC, folder), { withFileTypes: true })) {
    if (entry.isDirectory())
      found.push(...privateImportsOf(name, join(folder, entry.name)));
    else if (entry.name.endsWith(".ts"))
      found.push(...privateImportsOfFile(name, join(folder, entry.name)));
  }
  return found;
}

/** The private imports of one file of the extension `name`. */
function privateImportsOfFile(name: string, file: string): string[] {
  const found: string[] = [];
  const folder = dirname(file);
  const text = readFileSync(join(SRC, file), "utf8");
  for (const [, , clause, from] of text.matchAll(IMPORT)) {
    if (PACKAGES.has(from!)) continue;
    // A relative path is followed; a path alias reaches into core.
    const target = from!.startsWith(".")
      ? relative(SRC, resolve(SRC, folder, from!))
      : undefined;
    if (
      target !== undefined &&
      (target === name || target.startsWith(`${name}/`) || ENTRIES.has(target))
    )
      continue;
    // Any other module: each binding, default or named, a public name.
    for (const binding of bindingsOf(clause!)) {
      const imported = BINDING.exec(binding)?.[1];
      if (imported === undefined || !PUBLIC.has(imported))
        found.push(`${file} imports ${binding} from "${from}"`);
    }
  }
  return found;
}

/** The bindings of an import clause: `a`, `{ b, type C }`, or `a, { b }`. */
function bindingsOf(clause: string): string[] {
  const named = clause.indexOf("{");
  const first = (named === -1 ? clause : clause.slice(0, named))
    .replace(",", "")
    .trim();
  return [
    ...(first === "" ? [] : [first]),
    ...(named === -1
      ? []
      : clause
          .slice(named + 1, clause.lastIndexOf("}"))
          .split(",")
          .map((binding) => binding.trim())
          .filter(Boolean)),
  ];
}

describe("extension imports", () => {
  test.each(ON_CONTRACT)("viborm/%s imports only public entries", (name) => {
    expect(privateImportsOf(name)).toEqual([]);
  });

  test.each(
    Object.keys(PENDING)
  )("viborm/%s is not on the contract yet: when it is, it moves to the list above", (name) => {
    expect(privateImportsOf(name).length).toBeGreaterThan(0);
  });
});

/**
 * The engine knows no extension: it names the points it asks at, never what
 * answers. No word of its sources, comments included, is an extension's name
 * or an extension's own vocabulary (`engine-rewrite-plan.md`, "terminé").
 */
const EXTENSION_WORD =
  /official|permission|\bcach|\bactor|tenant|ordering's|ordering extension|respac|rekey|soft.?delet|instrumentation|viborm[./]|\bhook/i;

/** A module of one of the extensions, by its path. */
const EXTENSION_MODULE =
  /(^|\/)(on|ordering|permissions|soft-delete|cache|instrumentation)(\/|$)/;

function engineLinesNaming(folder: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(SRC, folder), { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...engineLinesNaming(path));
    else if (entry.name.endsWith(".ts"))
      for (const [at, line] of readFileSync(join(SRC, path), "utf8")
        .split("\n")
        .entries())
        if (EXTENSION_WORD.test(line))
          found.push(`${path}:${at + 1} ${line.trim()}`);
  }
  return found;
}

describe("the engine", () => {
  test("names no extension, in code or in comments", () => {
    expect(engineLinesNaming("query-engine/raptor3")).toEqual([]);
  });

  test("imports nothing of an extension", () => {
    const imports: string[] = [];
    const scan = (folder: string) => {
      for (const entry of readdirSync(join(SRC, folder), {
        withFileTypes: true,
      })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) scan(path);
        else if (entry.name.endsWith(".ts"))
          for (const [, , , from] of readFileSync(
            join(SRC, path),
            "utf8"
          ).matchAll(IMPORT))
            if (EXTENSION_MODULE.test(from!))
              imports.push(`${path} imports "${from}"`);
      }
    };
    scan("query-engine/raptor3");
    expect(imports).toEqual([]);
  });
});
