/**
 * The complete relation TOPOLOGY verdict matrix (plan §6.3, §6.5, §9.4, §10 A
 * items 4-6).
 *
 * The per-rule suites beside this one are indexed by RULE: they prove that
 * R008, FK008, JT004, P012 … each fire where they should. This suite is indexed
 * by the plan's topology CELLS and states something none of them states — the
 * complete verdict a whole schema receives for one cell, including the codes it
 * does NOT attract. The rule suites are deleted or rewritten with their rules
 * in Package C; the cell verdicts have to survive that, which is why they are
 * pinned separately and against a frozen artifact.
 *
 * What each assertion uniquely covers:
 *  - the coverage guard: a frozen verdict whose case no longer exists, or a
 *    case with no frozen verdict (nothing else notices either);
 *  - the per-case verdict: the cell's accept/refuse answer plus its exact
 *    codes and locations — the object §9.3 promises to preserve and §9.4
 *    promises to change, case by case;
 *  - the ledger tests: that the deliberate-break list is TOTAL, so a §9.4
 *    bullet cannot quietly ship without a before/after witness (§9.4 last
 *    line), and that no witness names a bullet that does not exist;
 *  - the registration pin: §9.4's model-object bullet, which is a hydration
 *    fact and has no schema-shaped cell;
 *  - the refusal-position pin: ruling D7 — WHICH junction physical name each
 *    consumer reaches first, which the caller-sequenced lazy name methods exist
 *    to preserve and which one shared resolver would move.
 */

import { ValidationError } from "@errors";
import { s } from "@schema";
import type { AnyModel } from "@schema/model";
import { hydrateSchemaNames } from "@src/schema/hydration";
import { SchemaValidator, validateSchema } from "@src/schema/validation";
import type { SchemaValidationIssue } from "@src/schema/validation/types";
import { relationTopologyBaseline } from "@tests/fixtures/relation-topology-baseline";
import {
  deliberateBreakLedger,
  type RelationTopologyCase,
  relationTopologyCorpus,
} from "@tests/fixtures/relation-topology-corpus";
import { describe, expect, it } from "vitest";

/** The frozen line shape: code, then where it was reported. */
function format(issue: SchemaValidationIssue): string {
  const at = issue.model ?? "schema";
  const relation = issue.relation ? `.${issue.relation}` : "";
  const field = issue.field ? ` field=${issue.field}` : "";
  return `${issue.code} @${at}${relation}${field}`;
}

/**
 * A cell whose refusal moved to the DECLARATION boundary never reaches the
 * definition gate, so its verdict is the construction refusal itself. The frozen
 * line shape is unchanged — `CODE @where` — and `V4002 @<builder> <path>` is as
 * inspectable as any gate line.
 */
function constructionRefusal(error: unknown): string | undefined {
  if (!(error instanceof ValidationError)) return undefined;
  const source = error.source;
  if (source.kind !== "schema-builder") return undefined;
  return `${error.code} @${source.builder} path=${source.path}`;
}

function verdictOf(testCase: RelationTopologyCase) {
  let schema: Record<string, AnyModel>;
  try {
    schema = testCase.build();
  } catch (error) {
    const refusal = constructionRefusal(error);
    if (!refusal) throw error;
    return { valid: false, errors: [refusal], warnings: [] };
  }
  hydrateSchemaNames(schema);
  const result = validateSchema(schema);
  return {
    valid: result.valid,
    errors: result.errors.map(format).sort(),
    warnings: result.warnings.map(format).sort(),
  };
}

describe("relation topology verdict matrix", () => {
  it("freezes one verdict per corpus case and nothing else", () => {
    expect(Object.keys(relationTopologyBaseline)).toEqual(
      relationTopologyCorpus.map((testCase) => testCase.id)
    );
  });

  it.each(
    relationTopologyCorpus
  )("$id: $title", (testCase: RelationTopologyCase) => {
    expect(verdictOf(testCase)).toEqual(relationTopologyBaseline[testCase.id]);
  });
});

describe("deliberate-break ledger", () => {
  it("gives every §9.4 change at least one witness case", () => {
    const withoutWitness = Object.entries(deliberateBreakLedger)
      .filter(([, cases]) => cases.length === 0)
      .map(([bullet]) => bullet);
    // The one exception is documented in the fixture: registering one model
    // object under two schema keys is not a topology cell, and its witness is
    // the hydration pin below.
    expect(withoutWitness).toEqual(["model-object-registered-under-two-keys"]);
  });

  it("names only cases that exist, and covers every case that changes", () => {
    const ids = new Set(relationTopologyCorpus.map((testCase) => testCase.id));
    const listed = new Set(Object.values(deliberateBreakLedger).flat());
    expect([...listed].filter((id) => !ids.has(id))).toEqual([]);
    expect(
      relationTopologyCorpus
        .filter((testCase) => testCase.disposition !== "preserved")
        .filter((testCase) => !listed.has(testCase.id))
        .map((testCase) => testCase.id)
    ).toEqual([]);
  });

  it("states the intended verdict of every case whose verdict changes", () => {
    expect(
      relationTopologyCorpus
        .filter((testCase) => testCase.disposition !== "preserved")
        .filter((testCase) => !testCase.intended)
        .map((testCase) => testCase.id)
    ).toEqual([]);
  });
});

describe("model-object registration (plan §9.4 last bullet)", () => {
  it("binds one model object to one schema key, idempotently", () => {
    const shared = s.model({ id: s.string().id(), name: s.string() });

    hydrateSchemaNames({ alpha: shared });
    expect(shared["~"].names.ts).toBe("alpha");
    expect(shared["~"].names.sql).toBe("alpha");

    // Re-registering the SAME key is a normal thing to do — a second client
    // over the same models, or one schema composed twice.
    hydrateSchemaNames({ alpha: shared });
    expect(shared["~"].names.ts).toBe("alpha");
  });

  it("refuses a second key without touching the first binding", () => {
    const shared = s.model({ id: s.string().id(), name: s.string() });
    hydrateSchemaNames({ alpha: shared });

    expect(() => hydrateSchemaNames({ beta: shared })).toThrow(
      "one model object binds one schema key"
    );
    // The refusal happens in the preflight phase, BEFORE any registry write.
    expect(shared["~"].names.ts).toBe("alpha");
    expect(shared["~"].names.sql).toBe("alpha");
  });

  it("refuses one model object bound to two keys of ONE schema", () => {
    const shared = s.model({ id: s.string().id(), name: s.string() });

    expect(() => hydrateSchemaNames({ alpha: shared, beta: shared })).toThrow(
      "one model object binds one schema key"
    );
    expect(shared["~"].names.ts).toBeUndefined();
  });
});

describe("junction physical-name refusal position (ruling D7)", () => {
  // One junction whose table and side tokens are individually legal but whose
  // GENERATED constraint names all exceed the 63-byte identifier limit.
  //
  // Under the old two-consumer expansion this case had TWO answers, because the
  // validator and the serializer each expanded the junction again and asked its
  // names in a different order. `junction-topology.ts` is now invoked exactly
  // once, by the definition gate, so there is exactly one refusal position and
  // the DDL path never reaches a name at all: it never receives an index.
  const TABLE = "j".repeat(40);
  const SOURCE_TOKEN = "a".repeat(20);
  const TARGET_TOKEN = "b".repeat(20);

  const build = () => {
    const post = s.model({
      id: s.string().id(),
      tags: s
        .toMany(() => tag)
        .through(TABLE)
        .source(SOURCE_TOKEN)
        .target(TARGET_TOKEN),
    });
    const tag = s.model({ id: s.string().id(), posts: s.toMany(() => post) });
    const schema = { post, tag };
    hydrateSchemaNames(schema);
    return schema;
  };

  it("refuses the owning endpoint's own FKEY name, once, at the gate", () => {
    const errors = validateSchema(build()).errors;
    expect(errors.map((issue) => issue.message)).toEqual([
      `Generated junction fkey name '${TABLE}_${SOURCE_TOKEN}_fkey' is not a valid SQL identifier.`,
    ]);
    expect(errors.map((issue) => issue.code)).toEqual(["JT002"]);
  });

  it("publishes no index for that schema, so no consumer reaches a name", () => {
    const validator = new SchemaValidator();
    for (const [name, model] of Object.entries(build())) {
      validator.register(name, model);
    }
    expect(validator.resolve().ok).toBe(false);
  });
});
