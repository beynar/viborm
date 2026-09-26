/**
 * G4 pattern-retirement INDEPENDENT review — the deletion closure.
 *
 * The reviewer's blocking question is "did a SURVIVING file import a DELETED
 * one?". This gate answers it mechanically rather than by reading the patch:
 * every import specifier in every `src/**\/*.ts` is resolved the way the
 * bundler resolves it (tsconfig `paths`, relative, `.js` -> `.ts`, directory
 * `index.ts`, and type-position `import("...")`), and a specifier that lands on
 * nothing is a dangling edge into the deleted estate.
 *
 * The remaining cells pin the shape of the retirement itself, so a later change
 * that re-creates the estate under another name fails here: `builders/`,
 * `pattern/`, `write-engine/` and `operations/` are gone, the two survivors the
 * note named live at the consumers follow-up F-2 moved them to
 * (`raptor3/shared/parse-boundary.ts`, `result/groupby-fields.ts`), `result/`
 * keeps exactly the cache tree plus that one arrival, and `createFailureError`
 * is declared in exactly one place.
 *
 * F-2/F-6 emptied and deleted the last two directories, so the survivor cell
 * asks the stronger question the deletion made available: not "does this
 * directory hold exactly one file?" but "is the directory gone, and is its
 * survivor at its new owner?".
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { PreparedBatchGuard } from "@query-engine/types";
import { REPOSITORY_ROOT } from "@tests/fixtures/repo-paths";
import { describe, expect, expectTypeOf, it } from "vitest";

const SRC = join(REPOSITORY_ROOT, "src");
const QUERY_ENGINE = join(SRC, "query-engine");

const PATHS: Record<string, string[]> = JSON.parse(
  readFileSync(join(REPOSITORY_ROOT, "tsconfig.json"), "utf8").replace(
    /^\s*\/\/.*$/gm,
    ""
  )
).compilerOptions.paths;

function walk(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) return walk(entryPath);
    return entry.name.endsWith(".ts") ? [entryPath] : [];
  });
}

function fileAt(candidate: string): string | null {
  for (const attempt of [
    candidate,
    `${candidate}.ts`,
    `${candidate}.tsx`,
    `${candidate}.d.ts`,
    join(candidate, "index.ts"),
  ]) {
    if (existsSync(attempt) && statSync(attempt).isFile()) return attempt;
  }
  return null;
}

function resolveSpecifier(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith(".")) {
    const base = resolve(dirname(fromFile), specifier);
    if (base.endsWith(".js")) {
      const stripped = fileAt(base.slice(0, -3));
      if (stripped) return stripped;
    }
    return fileAt(base);
  }
  for (const [key, targets] of Object.entries(PATHS)) {
    if (key.endsWith("/*")) {
      const prefix = key.slice(0, -1);
      if (!specifier.startsWith(prefix)) continue;
      const rest = specifier.slice(prefix.length);
      for (const target of targets) {
        const base = resolve(REPOSITORY_ROOT, target.replace("/*", `/${rest}`));
        const hit = base.endsWith(".js")
          ? (fileAt(base.slice(0, -3)) ?? fileAt(base))
          : fileAt(base);
        if (hit) return hit;
      }
    } else if (specifier === key) {
      for (const target of targets) {
        const hit = fileAt(resolve(REPOSITORY_ROOT, target));
        if (hit) return hit;
      }
    }
  }
  return null;
}

/** Only first-party specifiers are resolvable here; node_modules are not. */
function isFirstParty(specifier: string): boolean {
  if (specifier.startsWith(".")) return true;
  return Object.keys(PATHS).some((key) =>
    key.endsWith("/*")
      ? specifier.startsWith(key.slice(0, -1))
      : specifier === key
  );
}

const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bexport\s+\*\s+from\s*)["']([^"']+)["']/g;

const FAILURE_CONSTRUCTION = /function\s+createFailureError\b/;
const FRAGMENT_VOCABULARY =
  /\b(?:interface|type)\s+(?:OperationFragment|PlanningFragment|StatementStep|GuardStep|RecordSeriesStep)\b/;

function names(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".ts"))
    .sort();
}

describe("D-15 retirement closure: no surviving file reaches a deleted owner", () => {
  it("resolves every first-party import specifier under src/", () => {
    const dangling: string[] = [];
    for (const file of walk(SRC)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(SPECIFIER)) {
        const specifier = match[1];
        if (!(specifier && isFirstParty(specifier))) continue;
        // `./src/...` inside `src/` is never a first-party edge in this repo:
        // the three occurrences are CLI help text and a config docblock quoting
        // the USER's project layout. Unchanged at e8114ed9.
        if (specifier.startsWith("./src/")) continue;
        if (!resolveSpecifier(specifier, file)) {
          dangling.push(`${relative(REPOSITORY_ROOT, file)} -> ${specifier}`);
        }
      }
    }
    expect(dangling).toEqual([]);
  });

  it("leaves no directory of the retired estate behind", () => {
    expect(existsSync(join(QUERY_ENGINE, "pattern"))).toBe(false);
    expect(existsSync(join(QUERY_ENGINE, "builders"))).toBe(false);
    expect(existsSync(join(REPOSITORY_ROOT, "tests/pattern"))).toBe(false);
    // F-2/F-6: emptied by the two moves below, then deleted.
    expect(existsSync(join(QUERY_ENGINE, "write-engine"))).toBe(false);
    expect(existsSync(join(QUERY_ENGINE, "operations"))).toBe(false);
  });

  it("keeps exactly the survivors the note names, at their new owners", () => {
    expect(
      existsSync(join(QUERY_ENGINE, "raptor3/shared/parse-boundary.ts"))
    ).toBe(true);
    expect(names(join(QUERY_ENGINE, "result"))).toEqual([
      "cache-json-codec.ts",
      "cache-snapshot-structure.ts",
      "cache-value-codecs.ts",
      "groupby-fields.ts",
      "result-aggregate-leaf.ts",
      "result-column.ts",
      "result-shape.ts",
    ]);
  });

  it("declares the failure-to-error construction exactly once", () => {
    const declarations = walk(SRC).filter((file) =>
      FAILURE_CONSTRUCTION.test(readFileSync(file, "utf8"))
    );
    expect(declarations.map((file) => relative(REPOSITORY_ROOT, file))).toEqual(
      ["src/query-engine/batch-error-attribution.ts"]
    );
  });

  it("declares the guard's failure in the guard's own owner", () => {
    const types = readFileSync(join(QUERY_ENGINE, "types.ts"), "utf8");
    expect(types).toContain("interface PreparedGuardFailure");
    expect(types).toContain("readonly failure: PreparedGuardFailure;");
    expect(types).not.toContain("write-engine");
  });

  it("re-creates no OperationFragment under another name", () => {
    const offenders = walk(SRC).filter((file) => {
      const source = readFileSync(file, "utf8");
      return FRAGMENT_VOCABULARY.test(source);
    });
    expect(offenders.map((file) => relative(REPOSITORY_ROOT, file))).toEqual(
      []
    );
  });
});

describe("D-15 type anchor: the relocated shape is the base's shape", () => {
  /** `write-engine/OperationFragment.Failure` at e8114ed9, verbatim. */
  interface BaseFailure {
    readonly kind: "nestedWrite" | "notFound" | "query";
    readonly message: string;
    readonly relation?: string;
    readonly raceable: boolean;
  }

  it("is mutually assignable with the deleted declaration", () => {
    expectTypeOf<PreparedBatchGuard["failure"]>().toMatchTypeOf<BaseFailure>();
    expectTypeOf<BaseFailure>().toMatchTypeOf<PreparedBatchGuard["failure"]>();
  });
});
