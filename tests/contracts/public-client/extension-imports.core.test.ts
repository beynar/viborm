/**
 * An extension imports only what any extension author can import.
 *
 * `viborm/on`, `viborm/ordering`, `viborm/permissions` and
 * `viborm/soft-delete` are built on the public extension contract. Each file
 * of theirs imports its own folder, a package, or names the public entries
 * export (`viborm`, `viborm/client`, `viborm/validation`). A name may be
 * imported from the module that defines it, which keeps the built chunks as
 * they are, but it must be a public name: anything else is a private channel
 * into core, which a third party could not take, and fails here. What an
 * extension lacks becomes public surface for everyone.
 *
 * `viborm/cache` and `viborm/instrumentation` are not on the contract yet:
 * they are listed below, each with what it still takes.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { PACKAGE_SURFACE_GOLDEN } from "@tests/package/public-surface-golden.mjs";
import { describe, expect, test } from "vitest";

const SRC = join(import.meta.dirname, "../../../src");

/** The source modules that are package entries, from the source root. */
const ENTRIES = new Set(["index", "client/exports", "validation"]);

/** Every name those entries export. */
const PUBLIC = new Set(
  [".", "./client", "./validation"].flatMap((entry) => {
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
const PACKAGES = new Set(["@standard-schema/spec"]);

/** The extensions built on the public contract. */
const ON_CONTRACT = ["on", "ordering", "permissions", "soft-delete"];

/** The extensions that still take a private channel, and what is left. */
const PENDING: Readonly<Record<string, string>> = {
  cache:
    "its runtime is called by the client by name; needs the call's key and answer shape in `query`, and the models a write touched",
  instrumentation:
    "reads statement text and parameters through official-facts; needs them in `observe` on a declared need",
};

const IMPORT = /import\s+(type\s+)?([^;]*?)\s+from\s+"([^"]+)"/g;
const BINDING = /^(?:type\s+)?(\w+)(?:\s+as\s+\w+)?$/;

/** The imports of an extension's files that take something no public entry exports. */
function privateImportsOf(name: string, folder = name): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(SRC, folder), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...privateImportsOf(name, join(folder, entry.name)));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    const text = readFileSync(join(SRC, folder, entry.name), "utf8");
    for (const [, , clause, from] of text.matchAll(IMPORT)) {
      if (PACKAGES.has(from!)) continue;
      // A relative path is followed; a path alias reaches into core.
      const target = from!.startsWith(".")
        ? relative(SRC, resolve(SRC, folder, from!))
        : undefined;
      if (
        target !== undefined &&
        (target === name ||
          target.startsWith(`${name}/`) ||
          ENTRIES.has(target))
      )
        continue;
      // Any other module: only named bindings, each a public name.
      const named = clause!.trim().startsWith("{")
        ? clause!
            .trim()
            .slice(1, -1)
            .split(",")
            .map((binding) => binding.trim())
            .filter(Boolean)
        : [clause!];
      for (const binding of named) {
        const imported = BINDING.exec(binding)?.[1];
        if (imported === undefined || !PUBLIC.has(imported))
          found.push(
            `${join(folder, entry.name)} imports ${binding} from "${from}"`
          );
      }
    }
  }
  return found;
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
