/**
 * `Row.verb`, `Row.located` and `Row.label` over the WHOLE corpus.
 *
 * Every row a verb plan created is stamped with that verb, the root (and its
 * arms) with the operation; the target-premise failure a verb's stamp selects
 * is byte-identical to today's message catalog; and the two facts the packer
 * READS instead of re-deriving are measured against today's own step ids:
 *
 *  - `located: "probe"` — the row sends its own match statement, so every
 *    `<model>.find` / `<model>.locate` today emits belongs to a probed row;
 *  - `label` — the id of the row's own write statement, byte-exact.
 *
 * The goldens are the oracle for both. What `label` deliberately does NOT
 * cover is the EXTRA statements a family emits beside a row's own write (an
 * orphan read, a slot vacate, a parent's cleared reference) and the ones a
 * packing FOLD adds or removes; those stay the packer's, and their count is
 * frozen here so neither side drifts silently.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "@schema/model";
import {
  constructPattern,
  type WriteOperation,
} from "@src/query-engine/pattern/construct";
import {
  locatedBy,
  targetNotFoundFailure,
  VERB_ORDER,
  writeLabel,
} from "@src/query-engine/pattern/sugar";
import {
  relationTargetNotFound,
  upsertTargetNotFoundForParent,
} from "@src/query-engine/write-engine/messages";
import { parseValidated } from "@src/query-engine/write-engine/parse-boundary";
import { isInvalidPayload, payloads } from "@tests/pattern/corpus/payloads";
import { schemas } from "@tests/pattern/corpus/schemas";
import { engineFor, planningDriver } from "@tests/pattern/harness/dump";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const WRITE_OPERATIONS = new Set<string>([
  "create",
  "update",
  "delete",
  "upsert",
  "createMany",
  "createManyAndReturn",
  "updateMany",
  "updateManyAndReturn",
  "deleteMany",
  "deleteManyAndReturn",
]);

/** Every verb key spelled anywhere in a payload's args. */
function spelledVerbs(value: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) spelledVerbs(item, into);
    return into;
  }
  if (typeof value !== "object" || value === null) return into;
  for (const [key, inner] of Object.entries(value)) {
    if ((VERB_ORDER as readonly string[]).includes(key)) into.add(key);
    spelledVerbs(inner, into);
  }
  return into;
}

const corpus = payloads.filter(
  (p) => WRITE_OPERATIONS.has(p.operation) && !isInvalidPayload(p)
);

describe("Row.verb over the corpus", () => {
  test.each(corpus.map((p) => [p.name, p] as const))("%s", (_name, payload) => {
    const schema = schemas[payload.schema] as Record<string, Model<any>>;
    const model = schema[payload.model] as Model<any>;
    const registry = createSchemaRegistry(schema);
    const args = parseValidated(
      Reflect.get(registry.getModelSchemas(model).args, payload.operation),
      payload.args,
      payload.operation as never,
      ""
    ) as Record<string, unknown>;
    const engine = engineFor(
      schema,
      planningDriver("postgresql", "transaction")
    );
    const { pattern } = constructPattern({
      index: engine.relations,
      model,
      operation: payload.operation as WriteOperation,
      validatedArgs: args,
    });
    const spelled = spelledVerbs(payload.args, new Set());
    for (const row of pattern.rows) {
      expect(row.verb).toBeDefined();
      if (row.id === pattern.root) {
        expect(row.verb).toBe(payload.operation);
        continue;
      }
      // A root arm (upsert's fresh row, createMany's rows) is the operation;
      // every other row was created by a verb the payload spelled.
      if (row.verb === payload.operation) continue;
      expect(spelled.has(row.verb!)).toBe(true);
    }
  });
});

const GOLDENS = join(import.meta.dirname, "..", "corpus", "goldens");
/** `StepScope` appends `#n` to a repeated label; the label is what we compare. */
const REPEAT_SUFFIX = /#\d+$/;

interface GoldenStep {
  readonly kind?: string;
  readonly id?: string;
}

/** Today's step ids for one payload, split into writes and reads. */
function goldenIds(name: string):
  | {
      writes: string[];
      reads: string[];
    }
  | undefined {
  const file = join(
    GOLDENS,
    `${name.replaceAll(":", "_")}.postgresql.transaction.found.json`
  );
  let dump: { planning?: GoldenStep[]; final?: GoldenStep[] };
  try {
    dump = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  const writes: string[] = [];
  const reads: string[] = [];
  for (const step of [...(dump.planning ?? []), ...(dump.final ?? [])]) {
    const id = (step.id ?? "").replace(REPEAT_SUFFIX, "");
    if (!id) continue;
    if (step.kind === "write") writes.push(id);
    else reads.push(id);
  }
  return { writes, reads };
}

/**
 * The statement families a row's `label` does not name: extras a family emits
 * beside the row's own write, and the two shapes a packing fold renames. Each
 * is the packer's to spell, because each depends on how the statements are
 * grouped rather than on which verb was written.
 */
const PACKER_OWNED = new Set([
  "orphan", // the required-foreign-key departure read
  "fknull", // the parent's cleared reference (`parent.fknull`)
  "delete.child", // a reference row's child cleanup
  "deleteMany", // a to-one delete lowered to a predicate delete
  "slot.vacate", // the singular member slot's transfer
  "slot.owners",
  "junction.delete", // a `deleteMany`'s reference-row cleanup
  "create", // a bulk member the packer did NOT fold into one insert
  "update", // a root merge's found arm, where the upsert did not fold
  "connect", // a collection `set` lowered into connect-shaped runs
]);

describe("Row.located and Row.label against today's step ids", () => {
  const measured = corpus.map((payload) => {
    const schema = schemas[payload.schema] as Record<string, Model<any>>;
    const model = schema[payload.model] as Model<any>;
    const registry = createSchemaRegistry(schema);
    const golden = goldenIds(payload.name);
    if (!golden) return undefined;
    let rows: ReturnType<typeof constructPattern>["pattern"]["rows"];
    try {
      const args = parseValidated(
        Reflect.get(registry.getModelSchemas(model).args, payload.operation),
        payload.args,
        payload.operation as never,
        ""
      ) as Record<string, unknown>;
      rows = constructPattern({
        index: engineFor(schema, planningDriver("postgresql", "transaction"))
          .relations,
        model,
        operation: payload.operation as WriteOperation,
        validatedArgs: args,
      }).pattern.rows;
    } catch {
      return undefined;
    }
    return { payload, rows, golden };
  });

  test("every row carries a verb, a located and a label", () => {
    const bare: string[] = [];
    for (const entry of measured) {
      if (!entry) continue;
      for (const row of entry.rows) {
        if (!(row.verb && row.located && row.label)) {
          bare.push(
            `${entry.payload.name}: row ${row.id} verb=${row.verb} located=${row.located} label=${row.label}`
          );
        }
      }
    }
    expect(bare).toEqual([]);
  });

  test("every write id today emits is a row's label, or a packer-owned extra", () => {
    let writes = 0;
    const owned: string[] = [];
    const unknown: string[] = [];
    for (const entry of measured) {
      if (!entry) continue;
      const labels = new Set(entry.rows.map((row) => row.label));
      for (const id of entry.golden.writes) {
        writes++;
        if (labels.has(id)) continue;
        const suffix = id.slice(id.indexOf(".") + 1);
        (PACKER_OWNED.has(suffix) ? owned : unknown).push(
          `${entry.payload.name}: ${id}`
        );
      }
    }
    expect(unknown).toEqual([]);
    // Frozen: construction names 273 of today's 316 write statements, and the
    // 43 it does not are the packer's own extras and folds.
    expect(writes).toBe(316);
    expect(owned.length).toBe(43);
  });

  test("every probe read today emits belongs to a row located by a probe", () => {
    let reads = 0;
    const unexplained: string[] = [];
    for (const entry of measured) {
      if (!entry) continue;
      const probed = new Set(
        entry.rows
          .filter((row) => row.located === "probe")
          .map((row) => (row.label ?? "").split(".")[0])
      );
      for (const id of entry.golden.reads) {
        const [stem, suffix] = id.split(".");
        if (suffix !== "find" && suffix !== "locate") continue;
        reads++;
        if (!probed.has(stem)) {
          unexplained.push(`${entry.payload.name}: ${id}`);
        }
      }
    }
    expect(reads).toBe(244);
    // The one exception, named: a polymorphic collection's `createMany` with
    // `skipDuplicates` probes a variant today's plan reads before the member
    // rows exist; construction builds no matched row for it.
    expect(unexplained).toEqual([
      "update:shelf:items.createMany.skipDuplicates: post.find",
    ]);
  });
});

describe("the two facts, spelled", () => {
  test("a write label is the verb, and a merge arm is what the arm writes", () => {
    expect(writeLabel("connect", false)).toBe("connect");
    expect(writeLabel("update", false)).toBe("update");
    expect(writeLabel("create", true)).toBe("create");
    expect(writeLabel("createMany", true)).toBe("createMany");
    expect(writeLabel("connectOrCreate", true)).toBe("create");
    expect(writeLabel("connectOrCreate", false)).toBe("update");
    expect(writeLabel("upsert", true)).toBe("create");
    expect(writeLabel("upsert", false)).toBe("update");
  });

  test("a row is probed when it names its own target, or the parent holds the reference", () => {
    const base = {
      fresh: false,
      targeted: false,
      parentHoldsReference: false,
      ownReferenceRow: false,
      clearable: true,
      setValued: false,
    } as const;
    // A fresh row needs no identity.
    expect(locatedBy({ ...base, verb: "create", fresh: true })).toBe("none");
    // Its own selector always probes.
    expect(locatedBy({ ...base, verb: "connect", targeted: true })).toBe(
      "probe"
    );
    // The target holds the reference: an untargeted removal correlates inline.
    expect(locatedBy({ ...base, verb: "disconnect" })).toBe("correlated");
    expect(locatedBy({ ...base, verb: "delete" })).toBe("correlated");
    // The parent holds it: the target's key must be read out of the parent.
    expect(
      locatedBy({ ...base, verb: "update", parentHoldsReference: true })
    ).toBe("probe");
    // An unbounded writer carries its own predicate.
    expect(locatedBy({ ...base, verb: "updateMany" })).toBe("correlated");
    expect(locatedBy({ ...base, verb: "deleteMany" })).toBe("correlated");
    // A departure is read only where it cannot be nulled.
    expect(
      locatedBy({ ...base, verb: "set", setValued: true, clearable: true })
    ).toBe("correlated");
    expect(
      locatedBy({ ...base, verb: "set", setValued: true, clearable: false })
    ).toBe("probe");
  });
});

describe("the failure a verb's stamp selects", () => {
  test.each([
    "connect",
    "set",
    "update",
    "delete",
    "disconnect",
  ] as const)("%s is today's relationTargetNotFound text", (verb) => {
    expect(targetNotFoundFailure(verb, "teams")).toBe(
      relationTargetNotFound({ name: "teams" } as never, verb)
    );
  });

  test("upsert is today's found-uncorrelated text", () => {
    expect(targetNotFoundFailure("upsert", "teams")).toBe(
      upsertTargetNotFoundForParent("teams")
    );
  });

  test("the verbs that tolerate an empty match select no failure", () => {
    for (const verb of [
      "connectOrCreate",
      "create",
      "createMany",
      "updateMany",
      "deleteMany",
      "update-root",
      undefined,
    ]) {
      expect(targetNotFoundFailure(verb, "teams")).toBeUndefined();
    }
  });

  test("the five spellings, verbatim", () => {
    expect(targetNotFoundFailure("connect", "teams")).toBe(
      "Cannot connect relation 'teams': target record was not found."
    );
    expect(targetNotFoundFailure("set", "teams")).toBe(
      "Cannot set relation 'teams': target record was not found."
    );
    expect(targetNotFoundFailure("disconnect", "teams")).toBe(
      "Cannot disconnect relation 'teams': target record was not found for this parent."
    );
    expect(targetNotFoundFailure("delete", "teams")).toBe(
      "Cannot delete relation 'teams': target record was not found for this parent."
    );
    expect(targetNotFoundFailure("update", "teams")).toBe(
      "Cannot update relation 'teams': target record was not found for this parent."
    );
    expect(targetNotFoundFailure("upsert", "teams")).toBe(
      "Cannot upsert relation 'teams': target record was not found for this parent."
    );
  });
});
