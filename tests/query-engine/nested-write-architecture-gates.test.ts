import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The permanent M10 grep gates (§8.4, §11 M10). These are the structural
 * invariants of the one-interpreter architecture; they must hold on every run,
 * not just at the migration merge. Each gate is stated once here so a future
 * change that reintroduces a second engine, a capability branch outside the
 * fork, or a mode file that reaches into semantics fails CI loudly.
 *
 * Gates are checked against source with comments stripped, so provenance notes
 * that mention a deleted symbol by name cannot produce a false positive — only
 * live code counts.
 */

const NESTED_WRITES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/query-engine/operations/nested-writes"
);

const MODE_FILES = new Set(["mode.ts", "live-mode.ts", "planned-mode.ts"]);

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /\/\/[^\n]*/g;

/** A driver capability read — only legal inside the mode files (gate 1). */
const CAPABILITY_READ = /supportsTransactions|supportsBatch/;

/** A mode file importing the semantic layer — forbidden (gate 2). */
const SEMANTIC_IMPORT =
  /from\s+["']\.\/(semantic-plan|fk)["']|relation-data-builder/;

/** Strip block and line comments so gates match executable code only. */
function stripComments(source: string): string {
  return source.replace(BLOCK_COMMENT, "").replace(LINE_COMMENT, "");
}

function sourceFiles(): { name: string; code: string }[] {
  return readdirSync(NESTED_WRITES_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => ({
      name,
      code: stripComments(readFileSync(join(NESTED_WRITES_DIR, name), "utf8")),
    }));
}

describe("nested-write interpreter architecture gates (§8.4, §11 M10)", () => {
  it("gate 1: reads a driver's atomic-strategy capabilities only in the mode files (the selectMode fork)", () => {
    const offenders = sourceFiles()
      .filter((file) => !MODE_FILES.has(file.name))
      .filter((file) => CAPABILITY_READ.test(file.code))
      .map((file) => file.name);

    expect(
      offenders,
      `supportsTransactions/supportsBatch may only be read inside selectMode (mode.ts) and the two mode files; found in: ${offenders.join(", ")}`
    ).toEqual([]);
  });

  it("gate 2: the mode files import no semantic layer (semantic-plan.ts, fk.ts, relation-data-builder.ts)", () => {
    const offenders = sourceFiles()
      .filter((file) => MODE_FILES.has(file.name))
      .filter((file) => SEMANTIC_IMPORT.test(file.code))
      .map((file) => file.name);

    expect(
      offenders,
      `mode files must contain only substrate mechanics — no relation/step/branch decisions — so they may not import semantic-plan.ts, fk.ts, or relation-data-builder.ts; found in: ${offenders.join(", ")}`
    ).toEqual([]);
  });

  it("gate 3: nothing imports a deleted engine or scaffolding module (no second implementation of any mutation kind)", () => {
    // The old engines (M9) and the M10 scaffolding, by module basename. A live
    // import of any of these means a second implementation crept back.
    const deletedModules = [
      "create",
      "connect",
      "connect-or-create",
      "update",
      "update-many",
      "upsert",
      "disconnect",
      "delete",
      "delete-many",
      "set",
      "relation-mutation",
      "many-to-many",
      "batch-plan",
      "batch-relations",
      "batch-relation-links",
      "batch-many-to-many",
      "batch-updated-primary-keys",
      "update-plan",
      "atomic-runner",
      "batch-references",
      "planned-mutation",
      "routing",
    ];
    const deletedImport = new RegExp(
      `from\\s+["']\\./(?:${deletedModules.join("|")})["']`
    );

    const offenders = sourceFiles()
      .filter((file) => deletedImport.test(file.code))
      .map((file) => file.name);

    expect(
      offenders,
      `a deleted engine/scaffolding module is imported again — the interpreter must own every mutation kind exactly once; found in: ${offenders.join(", ")}`
    ).toEqual([]);
  });

  it("gate 4: the directory holds only the interpreter, the two modes, and the kept shared builders", () => {
    // The design's kept surface (§4 file roster, §11 M9/M10 deletions), plus the
    // interpret-*.ts family modules of the M10 navigability split (one semantic
    // body, split along mutation-family seams — §11 M10 gate 4 follow-up). If a
    // new module appears here it must be a deliberate, reviewed addition —
    // update this list so the gate keeps meaning something.
    const expected = [
      "assertions.ts",
      "effect-lowering.ts",
      "effects.ts",
      "expr.ts",
      "fk.ts",
      "interpret-create-family.ts",
      "interpret-m2m.ts",
      "interpret-shared.ts",
      "interpret-update-family.ts",
      "interpret-upsert-family.ts",
      "interpreter.ts",
      "legality.ts",
      "live-mode.ts",
      "mode.ts",
      "planned-mode.ts",
      "record-access.ts",
      "semantic-plan.ts",
    ].sort();

    const actual = readdirSync(NESTED_WRITES_DIR)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .sort();

    expect(actual).toEqual(expected);
  });

  it("gate 5: the interpret-*.ts family modules import no mode implementation (live-mode.ts, planned-mode.ts)", () => {
    // The family split (gate 4) is navigability only: the interpreter stays ONE
    // semantic body. Only the entry (interpreter.ts, for bindContext) and
    // mode.ts (for selectMode) may reach a concrete mode; a family module that
    // imports one is a per-mode branch smuggled into the semantics.
    const modeImplImport = /from\s+["']\.\/(live-mode|planned-mode)["']/;

    const offenders = sourceFiles()
      .filter((file) => file.name.startsWith("interpret-"))
      .filter((file) => modeImplImport.test(file.code))
      .map((file) => file.name);

    expect(
      offenders,
      `interpret-*.ts modules hold semantics for both modes at once — they may not import live-mode.ts or planned-mode.ts (only the interpreter.ts entry and mode.ts may); found in: ${offenders.join(", ")}`
    ).toEqual([]);
  });
});
