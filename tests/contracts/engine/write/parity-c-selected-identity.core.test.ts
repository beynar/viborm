import { createClient } from "@client/client";
import type { AnyDriver, QueryExecutionContext, QueryResult } from "@drivers";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import {
  isOperationValueReference,
  type OperationFragment,
  type OperationStep,
  type PlanningFragment,
  type StatementStep,
} from "@src/query-engine/write-engine/OperationFragment";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { publishedOutputs } from "@tests/fixtures/planning-published";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

/**
 * PARITY WITNESS — Package C (§6 C, "Make selected identity compound by construction").
 *
 * Package C gives `TargetProjection` an `identityFields` member and removes the scalar
 * `childPrimaryKey` channel from every selected-target consumer. §C3's demand is that
 * targeting stay EXACT: "Every targeted update, delete, guard, set membership read, and
 * upsert found arm must address all primary-key members captured from the probe. Never
 * reconstruct identity from the original public selector." A scalar-primary-key child is
 * the degenerate one-member case of that, and it must come out byte-identical.
 *
 * The shapes below make captured identity and public selector DIFFERENT VALUES: the
 * nested child is named by a non-primary-key unique (`code: "c1"`) while its probe row
 * carries `id: "iCaptured"`. Every statement that ADDRESSES the row therefore reads
 * "iCaptured" and every statement that RE-ASSERTS the premise reads "c1" — a pin a
 * selector-derived identity cannot satisfy by accident.
 *
 * C2's migration list is per owner, so the consumers are pinned per owner:
 *   · RelationWritePart's targeted `update` / `delete` / `set` (the first describe);
 *   · RelationJunctionPart's own selected-target three-way, which owns a SECOND
 *     membership predicate — both the join row's target key and the target table's own
 *     key must read the captured id, never the selector (the junction describe, with
 *     `name: "G"` against a probe row carrying `id: "gCaptured"`);
 *   · `buildUpdateMany` / `buildDeleteMany`, which capture NO identity at all today:
 *     they rewrite in place under a parent-correlated filter. That absence is pinned as
 *     an absence, so a C edit that gave them a captured-identity capture shows up as a
 *     new planning read rather than as nothing.
 *
 * DIMENSIONS PINNED (plan §6 A2's nine):
 *   · planning IDs and order, planning SQL and parameters, planning outputs — including
 *     WHICH probe publishes a `firstRowField` identity output and which publishes rows
 *     only;
 *   · final IDs and order, final SQL and parameters;
 *   · guards (batch premise SQL + failure) and expects;
 *   · race pins (none survive on these shapes — pinned as `null`);
 *   · exact errors — the child-requires-one-primary-key census below;
 *   · statement counts — the step list IS the statement count. Round-trip counts are not
 *     a separate fact here: each substrate issues one round trip per step it lists.
 *
 * THE CENSUS, AND WHAT PACKAGE C LIFTED FROM IT. `getPrimaryKeyFields(...).length !== 1`
 * refused at five `UnsupportedOperationError` sites when this witness was written. ALL
 * FIVE ARE NOW DELETED, because every owner they guarded addresses its target through the
 * projection's complete row key and needs no arity (the census entry is `29 -> 24` in
 * operation-construction-inventory). Four of them are pinned positively below:
 *   · RelationUpsertPart (the one text in this family that carried no `query-engine-v2`
 *     prefix, reachable only under a FRESH parent — under a selected parent the record
 *     compiler answers first): the adopt probe reads and addresses BOTH members.
 *   · nested-target-parts (reached through a fresh junction target, whose nestedBuilder
 *     seam is the create path): the deeper link probe's whole planning fragment.
 *   · RecordUpdateCompiler.interpretRelation, twice and on both substrates — a targeted
 *     update and the adopt payload under a SELECTED parent, which reached the same site.
 *     These two tests ARE the inverted refusal rows; the values are chosen so a
 *     selector-derived or one-member row key is a different string in the same SQL.
 * The fifth, the polymorphic child-held dispatch, needs a polymorphic inverse whose target
 * model has a compound primary key, which this schema has no member of. It has its own
 * dual-substrate contract instead: polymorphic-compound-target.test.ts, which also pins
 * the ACCEPTED path this file cannot reach — the exact `(discriminator, stored reference)`
 * membership on a compound-keyed selected target. The parent-held to-one site keeps its
 * DB-backed witness in parent-held-compound-edge-behavior.ts, inverted the same way.
 *
 * FALSIFIED 2026-08-09 against `src/query-engine/write-engine/RelationWritePart.ts`:
 * rewriting `capturedWhere` (:260) from `{ [childPrimaryKey]: capturedPk }` to the
 * target's own `where` turned the targeted-delete arm red on both substrates — the
 * DELETE addressed `"code" = $1` with "c1" instead of `"id" = $1` with "iCaptured".
 * `capturedWhere` feeds `buildDeleteOne` alone, so that mutation could only reach the
 * DELETE leg: the targeted-UPDATE leg's captured-identity source is RecordUpdateCompiler's
 * own target and is asserted below but not falsified by that edit. The original was
 * restored from a scratchpad copy taken before the edit.
 */

const paritySelectedSchema = (() => {
  const owner = s
    .model({
      id: s.string().id(),
      name: s.string(),
      items: s.toMany(() => item),
      pairs: s.toMany(() => pair),
      tags: s.toMany(() => tag),
    })
    .map("parity_c_owners");
  const item = s
    .model({
      id: s.string().id(),
      code: s.string().unique(),
      label: s.string(),
      ownerId: s.string().nullable(),
      owner: s
        .toOne(() => owner)
        .fields("ownerId")
        .references("id"),
    })
    .map("parity_c_items");
  /** The compound-row-key child: its captured handle is the PAIR, never one field. */
  const pair = s
    .model({
      tenantId: s.string(),
      slot: s.string(),
      note: s.string(),
      ownerId: s.string().nullable(),
      owner: s
        .toOne(() => owner)
        .fields("ownerId")
        .references("id"),
    })
    .id(["tenantId", "slot"])
    .map("parity_c_pairs");
  const tag = s
    .model({
      id: s.string().id(),
      name: s.string().unique(),
      owners: s.toMany(() => owner),
      slots: s.toMany(() => tagSlot),
    })
    .map("parity_c_tags");
  /** The same compound-primary-key shape one level deeper than a junction target. */
  const tagSlot = s
    .model({
      tenantId: s.string(),
      slot: s.string(),
      note: s.string(),
      tagId: s.string().nullable(),
      tag: s
        .toOne(() => tag)
        .fields("tagId")
        .references("id"),
    })
    .id(["tenantId", "slot"])
    .map("parity_c_tag_slots");
  /**
   * C4's separation, in one pair of models: the ANCHOR's ROW KEY is `[id]` and the
   * relation's REFERENCE KEY is `(tenantId, code)` — a compound unique that is not the
   * row key — while the child's STORED REFERENCE is `(tenantId, targetCode)`, whose
   * member names deliberately do not match the fields they point at.
   */
  const anchor = s
    .model({
      id: s.string().id(),
      tenantId: s.string(),
      code: s.string(),
      note: s.string(),
      refs: s.toMany(() => ref),
    })
    .unique(["tenantId", "code"])
    .map("parity_c_anchors");

  const ref = s
    .model({
      id: s.string().id(),
      label: s.string(),
      tenantId: s.string().nullable(),
      targetCode: s.string().nullable(),
      anchor: s
        .toOne(() => anchor)
        .fields("tenantId", "targetCode")
        .references("tenantId", "code"),
    })
    .map("parity_c_refs");

  return { owner, item, pair, tag, tagSlot, anchor, ref };
})();

hydrateSchemaNames(paritySelectedSchema);

class PGliteDriver extends PlanningDriver {
  constructor() {
    super("postgresql");
  }
}

class BatchOnlyPGliteDriver extends PlanningDriver {
  constructor() {
    super("postgresql", {
      supportsTransactions: false,
      supportsBatch: true,
    });
  }
}

class RecordingPGliteDriver extends PGliteDriver {
  readonly statements: string[] = [];
  recording = false;

  protected override execute<T>(
    _client: null,
    sql: string,
    _params: unknown[],
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(sql);
    return Promise.reject(
      new Error("Compiler witness reached provider dispatch.")
    );
  }

  protected override executeRaw<T>(
    _client: null,
    sql: string,
    _params: unknown[] | undefined,
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(sql);
    return Promise.reject(
      new Error("Compiler witness reached raw provider dispatch.")
    );
  }
}

function engineFor(driver: AnyDriver): QueryEngine {
  return new QueryEngine(
    driver,
    createModelRegistry(
      paritySelectedSchema,
      createSchemaRegistry(paritySelectedSchema)
    )
  );
}

function ownerUpdateArgs(relations: Record<string, unknown>) {
  return { where: { id: "o1" }, data: relations, select: { id: true } };
}

function ownerUpdate(
  driver: PGliteDriver,
  relations: Record<string, unknown>
): UpdateOperation {
  return new UpdateOperation(
    engineFor(driver),
    paritySelectedSchema.owner as Model<any>,
    ownerUpdateArgs(relations)
  );
}

function normalized(value: unknown): unknown {
  if (isOperationValueReference(value)) {
    return { ref: `${value.step}.${value.output}` };
  }
  if (Array.isArray(value)) return value.map(normalized);
  if (!(value && typeof value === "object")) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, member]) => [key, normalized(member)])
  );
}

function reference(step: string, output: string): unknown {
  return { ref: `${step}.${output}` };
}

function prepared(
  driver: PGliteDriver,
  current: StatementStep
): { readonly sql: string; readonly params: unknown } {
  const query = driver._prepare(current.statement);
  return { sql: query.sql, params: normalized(query.params) };
}

function effects(current: StatementStep): {
  readonly outputs: unknown;
  readonly expects: unknown;
  readonly racePin: unknown;
  readonly onUniqueConflict: unknown;
} {
  return {
    outputs: normalized(current.outputs),
    expects: current.expects ?? null,
    racePin: current.kind === "write" ? (current.racePin ?? null) : null,
    onUniqueConflict:
      current.kind === "write" ? (current.onUniqueConflict ?? null) : null,
  };
}

function guardContract(driver: PGliteDriver, current: OperationStep): unknown {
  if (current.kind !== "guard") throw new Error("Expected a guard step.");
  const query = driver._prepare(current.premise.statement);
  return {
    id: current.id,
    premise: {
      kind: current.premise.kind,
      sql: query.sql,
      params: normalized(query.params),
    },
    failure: current.failure,
  };
}

function fragmentContract(
  driver: PGliteDriver,
  fragment: PlanningFragment | OperationFragment
): unknown {
  return {
    steps: fragment.steps.map((current) =>
      current.kind === "guard"
        ? guardContract(driver, current)
        : {
            id: current.id,
            kind: current.kind,
            ...prepared(driver, current),
            ...effects(current),
          }
    ),
    outputs: normalized(publishedOutputs(fragment)),
  };
}

const OWNER_NOT_FOUND = {
  kind: "notFound",
  message:
    "query-engine-v2 update located no 'owner' row for its unique where.",
  raceable: false,
};

const OWNER_GUARD = {
  id: "owner.guard.exists",
  premise: {
    kind: "exists",
    sql: 'SELECT "t0"."id" AS "id" FROM "public"."parity_c_owners" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
    params: ["o1"],
  },
  failure: OWNER_NOT_FOUND,
};

const targetNotFound = (kind: "update" | "delete" | "set") => ({
  kind: "nestedWrite",
  message:
    kind === "set"
      ? "Cannot set relation 'items': target record was not found."
      : `Cannot ${kind} relation 'items': target record was not found for this parent.`,
  relation: "items",
  raceable: false,
});

/** The public selector says "c1"; the row the probe captured is "iCaptured". */
const PROBE_ROWS = {
  "owner.locate.rows": [{ id: "o1" }],
  "item.find.rows": [{ id: "iCaptured", code: "c1", ownerId: "o1" }],
};

for (const substrate of [
  { name: "transaction", batch: false, createDriver: () => new PGliteDriver() },
  {
    name: "atomic batch",
    batch: true,
    createDriver: () => new BatchOnlyPGliteDriver(),
  },
]) {
  const lock = substrate.batch ? "" : " FOR UPDATE";

  const ownerLocate = {
    id: "owner.locate",
    kind: "read",
    sql: `SELECT "t0"."id" AS "id" FROM "public"."parity_c_owners" AS "t0" WHERE "t0"."id" = $1 LIMIT 1${lock}`,
    params: ["o1"],
    outputs: {
      rows: { kind: "rows" },
      id: { kind: "firstRowField", field: "id" },
    },
    expects: { kind: "exactlyOneRow", failure: OWNER_NOT_FOUND },
    racePin: null,
    onUniqueConflict: null,
  };

  const terminal = {
    id: "owner.select",
    kind: "read",
    sql: 'SELECT "t0"."id" AS "id" FROM "public"."parity_c_owners" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
    params: ["o1"],
    outputs: { result: { kind: "rows" } },
    expects: substrate.batch
      ? null
      : {
          kind: "exactlyOneRow",
          failure: {
            kind: "query",
            message:
              "query-engine-v2 update terminal read expected exactly one row.",
            raceable: false,
          },
        },
    racePin: null,
    onUniqueConflict: null,
  };

  const locateOutputs = {
    "owner.locate.rows": reference("owner.locate", "rows"),
    "owner.locate.id": reference("owner.locate", "id"),
    "item.find.rows": reference("item.find", "rows"),
  };

  /** The correlated probe: the public selector AND the parent membership, projecting
   *  exactly the identity the writes below address. */
  const correlatedFind = (publishesIdentity: boolean) => ({
    id: "item.find",
    kind: "read",
    sql: `SELECT "t0"."id" AS "id" FROM "public"."parity_c_items" AS "t0" WHERE ("t0"."code" = $1 AND "t0"."ownerId" = $2) ORDER BY "t0"."id" ASC LIMIT $3${lock}`,
    params: ["c1", reference("owner.locate", "id"), 1],
    outputs: publishesIdentity
      ? { rows: { kind: "rows" }, id: { kind: "firstRowField", field: "id" } }
      : { rows: { kind: "rows" } },
    expects: publishesIdentity
      ? { kind: "exactlyOneRow", failure: targetNotFound("update") }
      : null,
    racePin: null,
    onUniqueConflict: null,
  });

  /** The batch premise: the ORIGINAL selector re-asserted together with the captured
   *  identity, so a selector moved onto a replacement row finds nothing. */
  const capturedGuard = (sql: string, params: unknown[], failure: unknown) => ({
    id: "item.guard.exists",
    premise: { kind: "exists", sql, params },
    failure,
  });

  const CORRELATED_GUARD_SQL =
    'SELECT "t0"."id" AS "id" FROM "public"."parity_c_items" AS "t0" WHERE ("t0"."code" = $1 AND "t0"."ownerId" = $2 AND "t0"."id" = $3) ORDER BY "t0"."id" ASC LIMIT $4';

  /** The junction target: the public selector says "G", the captured row is "gCaptured". */
  const tagProbeRows = {
    "owner.locate.rows": [{ id: "o1" }],
    "tag.find.rows": [{ id: "gCaptured", name: "G" }],
  };

  const tagNotFound = (verb: "update" | "delete") => ({
    kind: "nestedWrite",
    message: `Cannot ${verb} relation 'tags': target record was not found for this parent.`,
    relation: "tags",
    raceable: false,
  });

  /** The membership-correlated junction probe. Its parent value is the planning-internal
   *  reference, and the batch premise adds the captured id to the ORIGINAL selector. */
  const junctionFind = {
    id: "tag.find",
    kind: "read",
    sql: `SELECT "parity_c_tags"."id" AS "id" FROM "public"."parity_c_tags" WHERE ("parity_c_tags"."id" IN (SELECT "tagId" FROM "public"."owner_tag" WHERE "ownerId" = $1) AND "parity_c_tags"."name" = $2) LIMIT $3${lock}`,
    params: [reference("owner.locate", "id"), "G", 1],
    outputs: { rows: { kind: "rows" } },
    expects: null,
    racePin: null,
    onUniqueConflict: null,
  };

  const junctionGuard = (failure: unknown) => ({
    id: "tag.guard.exists",
    premise: {
      kind: "exists",
      sql: 'SELECT "parity_c_tags"."id" AS "id" FROM "public"."parity_c_tags" WHERE ("parity_c_tags"."id" IN (SELECT "tagId" FROM "public"."owner_tag" WHERE "ownerId" = $1) AND "parity_c_tags"."name" = $2 AND "parity_c_tags"."id" = $3) LIMIT $4',
      params: ["o1", "G", "gCaptured", 1],
    },
    failure,
  });

  describe(`parity C — captured identity on a JUNCTION target (${substrate.name})`, () => {
    test("a targeted update addresses the captured id through the membership subquery", () => {
      const driver = substrate.createDriver();
      const operation = ownerUpdate(driver, {
        tags: { update: [{ where: { name: "G" }, data: { name: "G2" } }] },
      });
      expect(fragmentContract(driver, operation.planning())).toEqual({
        steps: [ownerLocate, junctionFind],
        outputs: {
          "owner.locate.rows": reference("owner.locate", "rows"),
          "owner.locate.id": reference("owner.locate", "id"),
          "tag.find.rows": reference("tag.find", "rows"),
        },
      });
      expect(fragmentContract(driver, operation.compile(tagProbeRows))).toEqual(
        {
          steps: [
            ...(substrate.batch
              ? [OWNER_GUARD, junctionGuard(tagNotFound("update"))]
              : []),
            {
              id: "tag.update",
              kind: "write",
              sql: 'UPDATE "public"."parity_c_tags" SET "name" = $1 WHERE "parity_c_tags"."id" = $2 RETURNING "id" AS "id"',
              params: ["G2", "gCaptured"],
              outputs: {},
              expects: substrate.batch
                ? null
                : {
                    kind: "affectedRows",
                    expected: 1,
                    failure: {
                      kind: "notFound",
                      message:
                        "query-engine-v2 update located no 'tag' row for its unique where.",
                      raceable: false,
                    },
                  },
              racePin: null,
              onUniqueConflict: null,
            },
            terminal,
          ],
          outputs: { result: reference("owner.select", "result") },
        }
      );
    });

    test("a targeted delete unlinks the join row and deletes the target on the SAME captured id", () => {
      const driver = substrate.createDriver();
      const operation = ownerUpdate(driver, {
        tags: { delete: [{ name: "G" }] },
      });
      expect(fragmentContract(driver, operation.planning())).toEqual({
        steps: [ownerLocate, junctionFind],
        outputs: {
          "owner.locate.rows": reference("owner.locate", "rows"),
          "owner.locate.id": reference("owner.locate", "id"),
          "tag.find.rows": reference("tag.find", "rows"),
        },
      });
      expect(fragmentContract(driver, operation.compile(tagProbeRows))).toEqual(
        {
          steps: [
            ...(substrate.batch
              ? [OWNER_GUARD, junctionGuard(tagNotFound("delete"))]
              : []),
            {
              // BOTH junction-row predicates: the source key is the parent literal, the
              // target key is the captured id — never the "G" the caller wrote.
              id: "tag.delete",
              kind: "write",
              sql: 'DELETE FROM "public"."owner_tag" WHERE "tagId" IN ($1)',
              params: ["gCaptured"],
              outputs: {},
              expects: null,
              racePin: null,
              onUniqueConflict: null,
            },
            {
              id: "tag.delete.child",
              kind: "write",
              sql: 'DELETE FROM "public"."parity_c_tags" WHERE "parity_c_tags"."id" = $1 RETURNING "id" AS "id", "name" AS "name"',
              params: ["gCaptured"],
              outputs: {},
              expects: null,
              racePin: null,
              onUniqueConflict: null,
            },
            terminal,
          ],
          outputs: { result: reference("owner.select", "result") },
        }
      );
    });

    test("a set clears by the parent key and re-inserts the captured id", () => {
      const driver = substrate.createDriver();
      const operation = ownerUpdate(driver, { tags: { set: [{ name: "G" }] } });
      expect(fragmentContract(driver, operation.planning())).toEqual({
        steps: [
          ownerLocate,
          {
            // `set` locates its new members GLOBALLY, so this probe carries no
            // membership subquery — the same split the child-held `set` shows above.
            id: "tag.find",
            kind: "read",
            sql: `SELECT "t0"."id" AS "id" FROM "public"."parity_c_tags" AS "t0" WHERE "t0"."name" = $1 LIMIT 1${lock}`,
            params: ["G"],
            outputs: { rows: { kind: "rows" } },
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
        ],
        outputs: {
          "owner.locate.rows": reference("owner.locate", "rows"),
          "owner.locate.id": reference("owner.locate", "id"),
          "tag.find.rows": reference("tag.find", "rows"),
        },
      });
      expect(fragmentContract(driver, operation.compile(tagProbeRows))).toEqual(
        {
          steps: [
            ...(substrate.batch
              ? [
                  OWNER_GUARD,
                  {
                    id: "tag.guard.exists",
                    premise: {
                      kind: "exists",
                      sql: 'SELECT "t0"."id" AS "id" FROM "public"."parity_c_tags" AS "t0" WHERE ("t0"."name" = $1 AND "t0"."id" = $2) ORDER BY "t0"."id" ASC LIMIT $3',
                      params: ["G", "gCaptured", 1],
                    },
                    failure: {
                      kind: "nestedWrite",
                      message:
                        "Cannot set relation 'tags': target record was not found.",
                      relation: "tags",
                      raceable: false,
                    },
                  },
                ]
              : []),
            {
              id: "tag.set.clear",
              kind: "write",
              sql: 'DELETE FROM "public"."owner_tag" WHERE "ownerId" = $1',
              params: ["o1"],
              outputs: {},
              expects: null,
              racePin: null,
              onUniqueConflict: null,
            },
            {
              id: "tag.set.insert",
              kind: "write",
              // §1.7 conflict policy: the junction skip NAMES the complete
              // membership key `(ownerId, tagId)`, uniformly for every junction
              // (§9.4 open question 1). Identical rows skipped, identically —
              // what changed is that a target-side UNIQUE, which only a
              // singular polymorphic member table has, can now raise instead of
              // being swallowed.
              sql: 'INSERT  INTO "public"."owner_tag" ("ownerId", "tagId") VALUES ($1, $2) ON CONFLICT ("ownerId", "tagId") DO NOTHING',
              params: ["o1", "gCaptured"],
              outputs: {},
              expects: null,
              racePin: null,
              onUniqueConflict: null,
            },
            terminal,
          ],
          outputs: { result: reference("owner.select", "result") },
        }
      );
    });
  });

  /** The two nested bulk kinds capture NO identity at all: the filter is correlated to
   *  the parent and rewritten in place, so there is no probe, no guard beyond the root's,
   *  and no primary-key handle for C to migrate. That absence is the pin — a C edit that
   *  routed these through a captured-identity capture would add a planning read here. */
  describe(`parity C — nested updateMany / deleteMany capture nothing (${substrate.name})`, () => {
    const planningOnlyLocate = {
      steps: [ownerLocate],
      outputs: {
        "owner.locate.rows": reference("owner.locate", "rows"),
        "owner.locate.id": reference("owner.locate", "id"),
      },
    };

    test("updateMany rewrites in place, correlated to the parent key", () => {
      const driver = substrate.createDriver();
      const operation = ownerUpdate(driver, {
        items: {
          updateMany: [{ where: { label: "L" }, data: { label: "L2" } }],
        },
      });
      expect(fragmentContract(driver, operation.planning())).toEqual(
        planningOnlyLocate
      );
      expect(
        fragmentContract(
          driver,
          operation.compile({ "owner.locate.rows": [{ id: "o1" }] })
        )
      ).toEqual({
        steps: [
          ...(substrate.batch ? [OWNER_GUARD] : []),
          {
            id: "item.updateMany",
            kind: "write",
            sql: 'UPDATE "public"."parity_c_items" SET "label" = $1 WHERE ("parity_c_items"."ownerId" = $2 AND "parity_c_items"."label" = $3)',
            params: ["L2", "o1", "L"],
            outputs: {},
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          terminal,
        ],
        outputs: { result: reference("owner.select", "result") },
      });
    });

    test("deleteMany removes in place, correlated to the parent key", () => {
      const driver = substrate.createDriver();
      const operation = ownerUpdate(driver, {
        items: { deleteMany: [{ label: "L" }] },
      });
      expect(fragmentContract(driver, operation.planning())).toEqual(
        planningOnlyLocate
      );
      expect(
        fragmentContract(
          driver,
          operation.compile({ "owner.locate.rows": [{ id: "o1" }] })
        )
      ).toEqual({
        steps: [
          ...(substrate.batch ? [OWNER_GUARD] : []),
          {
            id: "item.deleteMany",
            kind: "write",
            sql: 'DELETE FROM "public"."parity_c_items" WHERE ("parity_c_items"."ownerId" = $1 AND "parity_c_items"."label" = $2)',
            params: ["o1", "L"],
            outputs: {},
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          terminal,
        ],
        outputs: { result: reference("owner.select", "result") },
      });
    });
  });

  describe(`parity C — captured single-member identity (${substrate.name})`, () => {
    test("a nested targeted update addresses the captured id, never the selector", () => {
      const driver = substrate.createDriver();
      const operation = ownerUpdate(driver, {
        items: { update: [{ where: { code: "c1" }, data: { label: "L2" } }] },
      });
      expect(fragmentContract(driver, operation.planning())).toEqual({
        steps: [ownerLocate, correlatedFind(true)],
        outputs: {
          ...locateOutputs,
          "item.find.id": reference("item.find", "id"),
        },
      });
      expect(fragmentContract(driver, operation.compile(PROBE_ROWS))).toEqual({
        steps: [
          ...(substrate.batch
            ? [
                OWNER_GUARD,
                capturedGuard(
                  CORRELATED_GUARD_SQL,
                  ["c1", "o1", "iCaptured", 1],
                  targetNotFound("update")
                ),
              ]
            : []),
          {
            id: "item.update",
            kind: "write",
            sql: 'UPDATE "public"."parity_c_items" SET "label" = $1 WHERE "parity_c_items"."id" = $2 RETURNING "id" AS "id"',
            params: ["L2", "iCaptured"],
            outputs: {},
            expects: substrate.batch
              ? null
              : {
                  kind: "affectedRows",
                  expected: 1,
                  failure: {
                    kind: "notFound",
                    message:
                      "query-engine-v2 update located no 'item' row for its unique where.",
                    raceable: false,
                  },
                },
            racePin: null,
            onUniqueConflict: null,
          },
          terminal,
        ],
        outputs: { result: reference("owner.select", "result") },
      });
    });

    test("a nested targeted delete addresses the captured id and returns the whole row", () => {
      const driver = substrate.createDriver();
      const operation = ownerUpdate(driver, {
        items: { delete: [{ code: "c1" }] },
      });
      expect(fragmentContract(driver, operation.planning())).toEqual({
        steps: [ownerLocate, correlatedFind(false)],
        outputs: locateOutputs,
      });
      expect(fragmentContract(driver, operation.compile(PROBE_ROWS))).toEqual({
        steps: [
          ...(substrate.batch
            ? [
                OWNER_GUARD,
                capturedGuard(
                  CORRELATED_GUARD_SQL,
                  ["c1", "o1", "iCaptured", 1],
                  targetNotFound("delete")
                ),
              ]
            : []),
          {
            id: "item.delete",
            kind: "write",
            sql: 'DELETE FROM "public"."parity_c_items" WHERE "parity_c_items"."id" = $1 RETURNING "id" AS "id", "code" AS "code", "label" AS "label", "ownerId" AS "ownerId"',
            params: ["iCaptured"],
            outputs: {},
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          terminal,
        ],
        outputs: { result: reference("owner.select", "result") },
      });
    });

    test("a nested set reparents by captured id while its departing half excludes by selector", () => {
      const driver = substrate.createDriver();
      const operation = ownerUpdate(driver, {
        items: { set: [{ code: "c1" }] },
      });
      // `set` locates its new members globally — no parent correlation — so this probe
      // differs from the correlated one the targeted kinds use.
      expect(fragmentContract(driver, operation.planning())).toEqual({
        steps: [
          ownerLocate,
          {
            id: "item.find",
            kind: "read",
            sql: `SELECT "t0"."id" AS "id" FROM "public"."parity_c_items" AS "t0" WHERE "t0"."code" = $1 LIMIT 1${lock}`,
            params: ["c1"],
            outputs: { rows: { kind: "rows" } },
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
        ],
        outputs: locateOutputs,
      });
      expect(fragmentContract(driver, operation.compile(PROBE_ROWS))).toEqual({
        steps: [
          ...(substrate.batch
            ? [
                OWNER_GUARD,
                capturedGuard(
                  'SELECT "t0"."id" AS "id" FROM "public"."parity_c_items" AS "t0" WHERE ("t0"."code" = $1 AND "t0"."id" = $2) ORDER BY "t0"."id" ASC LIMIT $3',
                  ["c1", "iCaptured", 1],
                  targetNotFound("set")
                ),
              ]
            : []),
          {
            id: "item.orphan",
            kind: "write",
            sql: 'UPDATE "public"."parity_c_items" SET "ownerId" = NULL WHERE ("parity_c_items"."ownerId" = $1 AND NOT ("parity_c_items"."code" = $2))',
            params: ["o1", "c1"],
            outputs: {},
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "item.set",
            kind: "write",
            sql: 'UPDATE "public"."parity_c_items" SET "ownerId" = CAST($1 AS TEXT) WHERE "parity_c_items"."id" IN ($2)',
            params: ["o1", "iCaptured"],
            outputs: {},
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          terminal,
        ],
        outputs: { result: reference("owner.select", "result") },
      });
    });
  });
}

describe("parity C — compound child row keys, per owner", () => {
  const clientOn = (): { client: any; driver: RecordingPGliteDriver } => {
    const driver = new RecordingPGliteDriver();
    const client = createClient({
      schema: paritySelectedSchema,
      driver,
    }) as any;
    driver.recording = true;
    return { client, driver };
  };

  /**
   * LIFTED (C2 step 3). The adopt probe under a FRESH parent now READS both members of
   * the compound row key and ADDRESSES the target by both, so the found arm's captured
   * selector has every member it needs. The statement is captured off the driver rather
   * than off a fragment because this arm's owner is the create root; the database behind
   * it has no schema pushed, so the operation aborts AFTER the probe was issued, which is
   * exactly the statement this asserts. A regression to a single-member probe changes
   * this string.
   */
  test("RelationUpsertPart reads and addresses a whole compound row key", async () => {
    const { client, driver } = clientOn();
    await client.owner
      .create({
        data: {
          id: "o1",
          name: "O",
          pairs: {
            connectOrCreate: [
              {
                where: { tenantId_slot: { tenantId: "t1", slot: "s1" } },
                create: { tenantId: "t1", slot: "s1", note: "n" },
              },
            ],
          },
        },
      })
      .catch(() => undefined);
    expect(driver.statements).toEqual([
      'SELECT "t0"."tenantId" AS "tenantId", "t0"."slot" AS "slot", "t0"."ownerId" AS "ownerId" FROM "public"."parity_c_pairs" AS "t0" WHERE ("t0"."tenantId" = $1 AND "t0"."slot" = $2) LIMIT 1 FOR UPDATE',
    ]);
  });

  /**
   * LIFTED (C2 step 1). One level deeper than a FRESH junction target, the link probe
   * selects and addresses both row-key members. Asserted structurally, so no database is
   * involved and the whole planning fragment — ids, order, outputs — is pinned with it.
   */
  test("nested-target-parts links a compound-keyed target one level deeper", () => {
    const driver = new PGliteDriver();
    const operation = ownerUpdate(driver, {
      tags: {
        create: [
          {
            id: "g1",
            name: "G",
            slots: {
              connect: [{ tenantId_slot: { tenantId: "t1", slot: "s1" } }],
            },
          },
        ],
      },
    });
    expect(fragmentContract(driver, operation.planning())).toEqual({
      steps: [
        {
          id: "owner.locate",
          kind: "read",
          sql: 'SELECT "t0"."id" AS "id" FROM "public"."parity_c_owners" AS "t0" WHERE "t0"."id" = $1 LIMIT 1 FOR UPDATE',
          params: ["o1"],
          outputs: {
            rows: { kind: "rows" },
            id: { kind: "firstRowField", field: "id" },
          },
          expects: { kind: "exactlyOneRow", failure: OWNER_NOT_FOUND },
          racePin: null,
          onUniqueConflict: null,
        },
        {
          id: "tagSlot.find",
          kind: "read",
          sql: 'SELECT "t0"."tenantId" AS "tenantId", "t0"."slot" AS "slot" FROM "public"."parity_c_tag_slots" AS "t0" WHERE ("t0"."tenantId" = $1 AND "t0"."slot" = $2) LIMIT 1 FOR UPDATE',
          params: ["t1", "s1"],
          outputs: { rows: { kind: "rows" } },
          expects: null,
          racePin: null,
          onUniqueConflict: null,
        },
      ],
      outputs: {
        "owner.locate.rows": reference("owner.locate", "rows"),
        "owner.locate.id": reference("owner.locate", "id"),
        "tagSlot.find.rows": reference("tagSlot.find", "rows"),
      },
    });
  });

  /**
   * LIFTED (C2 step 4). `RecordUpdateCompiler.interpretRelation` refused a compound-keyed
   * child outright; it now hands its owners a `TargetProjection` and they address every
   * row-key member. The two payloads below are the ones that refusal answered — a targeted
   * `update` and the adopt (`upsert`) payload under a SELECTED parent, which reaches the
   * same site.
   *
   * WHY THE VALUES DISCRIMINATE. `tCap` / `sCap` are what the probe CAPTURED; `t1` / `s1`
   * are what the caller WROTE. Every write below addresses the captured pair and every
   * batch premise re-asserts the written pair BESIDE it, so:
   *   · a row key rebuilt from the public selector would read `t1` / `s1` in the UPDATE;
   *   · a row key narrowed to its first member would drop `"slot" = $…` from both the
   *     UPDATE and the guard.
   * Neither is a subtle difference in these strings.
   */
  const compoundKnown = {
    "owner.locate.rows": [{ id: "o1" }],
    "owner.locate.id": "o1",
    "pair.find.rows": [{ tenantId: "tCap", slot: "sCap", ownerId: "o1" }],
    "pair.find.tenantId": "tCap",
    "pair.find.slot": "sCap",
    "pair.find.ownerId": "o1",
  };

  const compoundTerminal = (batch: boolean) => ({
    id: "owner.select",
    kind: "read",
    sql: 'SELECT "t0"."id" AS "id" FROM "public"."parity_c_owners" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
    params: ["o1"],
    outputs: { result: { kind: "rows" } },
    expects: batch
      ? null
      : {
          kind: "exactlyOneRow",
          failure: {
            kind: "query",
            message:
              "query-engine-v2 update terminal read expected exactly one row.",
            raceable: false,
          },
        },
    racePin: null,
    onUniqueConflict: null,
  });

  const compoundOwnerLocate = (batch: boolean) => ({
    id: "owner.locate",
    kind: "read",
    sql: `SELECT "t0"."id" AS "id" FROM "public"."parity_c_owners" AS "t0" WHERE "t0"."id" = $1 LIMIT 1${
      batch ? "" : " FOR UPDATE"
    }`,
    params: ["o1"],
    outputs: {
      rows: { kind: "rows" },
      id: { kind: "firstRowField", field: "id" },
    },
    expects: { kind: "exactlyOneRow", failure: OWNER_NOT_FOUND },
    racePin: null,
    onUniqueConflict: null,
  });

  for (const substrate of [
    {
      name: "transaction",
      batch: false,
      createDriver: () => new PGliteDriver(),
    },
    {
      name: "atomic batch",
      batch: true,
      createDriver: () => new BatchOnlyPGliteDriver(),
    },
  ]) {
    const lock = substrate.batch ? "" : " FOR UPDATE";

    test(`RecordUpdateCompiler targets a compound-keyed child update by every captured member (${substrate.name})`, () => {
      const driver = substrate.createDriver();
      const operation = ownerUpdate(driver, {
        pairs: {
          update: [
            {
              where: { tenantId_slot: { tenantId: "t1", slot: "s1" } },
              data: { note: "n2" },
            },
          ],
        },
      });
      expect(fragmentContract(driver, operation.planning())).toEqual({
        steps: [
          compoundOwnerLocate(substrate.batch),
          {
            id: "pair.find",
            kind: "read",
            // The correlated probe publishes BOTH row-key members as firstRowField
            // outputs — the single-member version published one.
            sql: `SELECT "t0"."tenantId" AS "tenantId", "t0"."slot" AS "slot" FROM "public"."parity_c_pairs" AS "t0" WHERE ("t0"."tenantId" = $1 AND "t0"."slot" = $2 AND "t0"."ownerId" = $3) ORDER BY "t0"."tenantId" ASC, "t0"."slot" ASC LIMIT $4${lock}`,
            params: ["t1", "s1", reference("owner.locate", "id"), 1],
            outputs: {
              rows: { kind: "rows" },
              tenantId: { kind: "firstRowField", field: "tenantId" },
              slot: { kind: "firstRowField", field: "slot" },
            },
            expects: {
              kind: "exactlyOneRow",
              failure: {
                kind: "nestedWrite",
                message:
                  "Cannot update relation 'pairs': target record was not found for this parent.",
                relation: "pairs",
                raceable: false,
              },
            },
            racePin: null,
            onUniqueConflict: null,
          },
        ],
        outputs: {
          "owner.locate.rows": reference("owner.locate", "rows"),
          "owner.locate.id": reference("owner.locate", "id"),
          "pair.find.rows": reference("pair.find", "rows"),
          "pair.find.tenantId": reference("pair.find", "tenantId"),
          "pair.find.slot": reference("pair.find", "slot"),
        },
      });
      expect(
        fragmentContract(driver, operation.compile(compoundKnown))
      ).toEqual({
        steps: [
          ...(substrate.batch
            ? [
                OWNER_GUARD,
                {
                  id: "pair.guard.exists",
                  premise: {
                    kind: "exists",
                    sql: 'SELECT "t0"."tenantId" AS "tenantId", "t0"."slot" AS "slot" FROM "public"."parity_c_pairs" AS "t0" WHERE ("t0"."tenantId" = $1 AND "t0"."slot" = $2 AND "t0"."ownerId" = $3 AND "t0"."tenantId" = $4 AND "t0"."slot" = $5) ORDER BY "t0"."tenantId" ASC, "t0"."slot" ASC LIMIT $6',
                    params: ["t1", "s1", "o1", "tCap", "sCap", 1],
                  },
                  failure: {
                    kind: "nestedWrite",
                    message:
                      "Cannot update relation 'pairs': target record was not found for this parent.",
                    relation: "pairs",
                    raceable: false,
                  },
                },
              ]
            : []),
          {
            id: "pair.update",
            kind: "write",
            sql: 'UPDATE "public"."parity_c_pairs" SET "note" = $1 WHERE ("parity_c_pairs"."tenantId" = $2 AND "parity_c_pairs"."slot" = $3) RETURNING "tenantId" AS "tenantId", "slot" AS "slot"',
            params: ["n2", "tCap", "sCap"],
            outputs: {},
            expects: substrate.batch
              ? null
              : {
                  kind: "affectedRows",
                  expected: 1,
                  failure: {
                    kind: "notFound",
                    message:
                      "query-engine-v2 update located no 'pair' row for its unique where.",
                    raceable: false,
                  },
                },
            racePin: null,
            onUniqueConflict: null,
          },
          compoundTerminal(substrate.batch),
        ],
        outputs: { result: reference("owner.select", "result") },
      });
    });

    test(`RecordUpdateCompiler runs a compound-keyed adopt found arm on the captured row key (${substrate.name})`, () => {
      const driver = substrate.createDriver();
      const operation = ownerUpdate(driver, {
        pairs: {
          upsert: [
            {
              where: { tenantId_slot: { tenantId: "t1", slot: "s1" } },
              create: { tenantId: "t1", slot: "s1", note: "n" },
              update: { note: "n2" },
            },
          ],
        },
      });
      expect(fragmentContract(driver, operation.planning())).toEqual({
        steps: [
          compoundOwnerLocate(substrate.batch),
          {
            // The adopt probe is GLOBAL (an upsert may adopt a non-member), so it
            // also publishes the FK it will overwrite; both row-key members lead.
            id: "pair.find",
            kind: "read",
            sql: `SELECT "t0"."tenantId" AS "tenantId", "t0"."slot" AS "slot", "t0"."ownerId" AS "ownerId" FROM "public"."parity_c_pairs" AS "t0" WHERE ("t0"."tenantId" = $1 AND "t0"."slot" = $2) LIMIT 1${lock}`,
            params: ["t1", "s1"],
            outputs: {
              rows: { kind: "rows" },
              tenantId: {
                kind: "firstRowField",
                field: "tenantId",
                optional: true,
              },
              slot: { kind: "firstRowField", field: "slot", optional: true },
            },
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
        ],
        outputs: {
          "owner.locate.rows": reference("owner.locate", "rows"),
          "owner.locate.id": reference("owner.locate", "id"),
          "pair.find.rows": reference("pair.find", "rows"),
          "pair.find.tenantId": reference("pair.find", "tenantId"),
          "pair.find.slot": reference("pair.find", "slot"),
        },
      });
      expect(
        fragmentContract(driver, operation.compile(compoundKnown))
      ).toEqual({
        steps: [
          ...(substrate.batch
            ? [
                OWNER_GUARD,
                {
                  id: "pair.guard.exists",
                  premise: {
                    kind: "exists",
                    sql: 'SELECT "t0"."tenantId" AS "tenantId", "t0"."slot" AS "slot", "t0"."ownerId" AS "ownerId" FROM "public"."parity_c_pairs" AS "t0" WHERE ("t0"."tenantId" = $1 AND "t0"."slot" = $2 AND "t0"."tenantId" = $3 AND "t0"."slot" = $4 AND "t0"."ownerId" = $5) ORDER BY "t0"."tenantId" ASC, "t0"."slot" ASC LIMIT $6',
                    params: ["t1", "s1", "tCap", "sCap", "o1", 1],
                  },
                  failure: {
                    kind: "nestedWrite",
                    message:
                      "Nested upsert premise changed for relation 'pairs'.",
                    relation: "pairs",
                    raceable: false,
                  },
                },
              ]
            : []),
          {
            // Correlated found membership is locate/guard-only. The update addresses
            // the captured pair without redundantly rewriting the agreeing owner FK.
            id: "pair.update",
            kind: "write",
            sql: 'UPDATE "public"."parity_c_pairs" SET "note" = $1 WHERE ("parity_c_pairs"."tenantId" = $2 AND "parity_c_pairs"."slot" = $3) RETURNING "tenantId" AS "tenantId", "slot" AS "slot"',
            params: ["n2", "tCap", "sCap"],
            outputs: {},
            expects: substrate.batch
              ? null
              : {
                  kind: "affectedRows",
                  expected: 1,
                  failure: {
                    kind: "notFound",
                    message:
                      "Nested upsert target for relation 'pairs' vanished before its update.",
                    relation: "pairs",
                    raceable: false,
                  },
                },
            racePin: null,
            onUniqueConflict: null,
          },
          compoundTerminal(substrate.batch),
        ],
        outputs: { result: reference("owner.select", "result") },
      });
    });
  }
});

/**
 * PACKAGE C4 — THE MANDATED FALSIFIER: a selected target whose ROW KEY and the
 * relation's REFERENCE KEY are DIFFERENT ORDERED KEYS.
 *
 *   target row key:         [id]                     — addresses the anchor row
 *   target reference key:   [tenantId, code]         — a compound unique, not the row key
 *   child stored reference: [tenantId, targetCode]   — the member names do not match
 *
 * The payload selects the anchor through a parent-held to-one edge and mutates it while
 * a nested `connect` on the anchor's own inverse relation consumes the reference key. So
 * ONE probe has to publish both keys, and the two must not be confused anywhere:
 *
 * 1. THE PROBE PUBLISHES THREE VALUES, DETERMINISTICALLY. `SELECT "id", "tenantId",
 *    "code"` — the row key first (`identityFields` leads `fields`), then the demanded
 *    reference-key fields. Reordering the projection changes this string and its outputs.
 * 2. THE WRITE ADDRESSES THE ROW KEY, WHOLE AND ALONE. `UPDATE … WHERE "id" = 'aCaptured'`
 *    names neither `tenantId` nor `code` — putting reference-key fields into
 *    `identityFields` would add them here.
 * 3. THE ASSIGNMENT MAPS STORAGE TO REFERENCE KEY IN SCHEMA ORDER. `SET "tenantId" =
 *    'tCap', "targetCode" = 'cCap'` — `targetCode` takes `code`'s value. A projection
 *    that owned this mapping, or a pairing by position against the row key, writes
 *    'aCaptured' into one of these columns.
 * 4. NEITHER KEY IS RECONSTRUCTED FROM THE PUBLIC SELECTOR. Every captured value is
 *    spelled `…Cap`; the located parent's own FK values are spelled `…Sel`. The write
 *    parameters are the captured ones, and the BATCH guard re-asserts the selector-side
 *    correlation (`tSel`, `cSel`) BESIDE the captured row key (`aCaptured`) — the
 *    split-witness shape, with the two keys visibly distinct in one statement.
 *
 * WHAT THIS FILE CANNOT ASSERT, AND WHERE IT LIVES INSTEAD. "No configuration carries a
 * scalar child primary key beside a TargetProjection" is a static fact about private
 * fields: its owner is the `rg -n "childPrimaryKey" src/query-engine/write-engine` gate
 * plus `target-projection.core.test.ts`, which pins the projection's member set. "Existing
 * ordinary compound-FK and polymorphic membership SQL stays byte-identical" is likewise
 * carried by the pins that already exist — record-compiler-contract, compound-key,
 * compound-relation-adoption, nested-arm-dispatch and the polymorphic families — not by
 * re-asserting their strings here.
 *
 * FALSIFIED 2026-08-10, three times, each mutation restored from a copy taken before it:
 *   · `buildTargetProjection` returning `[...getPrimaryKeyFields(model), ...requiredFields]`
 *     as `identityFields` — claim 2's parenthetical, the "stuffed the reference key into
 *     the row key" bug this witness exists to catch. BOTH legs went red, at the anchor's
 *     own root UPDATE: with `tenantId` and `code` in the row key, the write's where-unique
 *     carries them and the builder refuses ("Filter for 'tenantId' must be a filter
 *     object"). This is the mutation that a second parallel row-key field in
 *     `RecordUpdateCompiler` used to absorb — the compiler addressed the root write by its
 *     own `getPrimaryKeyFields` copy, so the transaction leg stayed green and the claim
 *     was decorative. There is one row-key owner now, and the claim is measured.
 *   · `pairForeignKeyMembers` pairing each foreign field with the referenced field at the
 *     MIRRORED index (`referencedFields[len - 1 - index]`) — the "map the storage to the
 *     reference key in schema order" claim. Exactly these two tests went red, and nothing
 *     else in the file: `ref.connect` filed `'cCap'` into `tenantId` and `'tCap'` into
 *     `targetCode`. Every other witness here has a one-member or same-named edge, so this
 *     is the only place the order is observable.
 *   · `compileParentHeldUpdate` passing `undefined` where it passes the captured row —
 *     the "the guard re-asserts the captured row key BESIDE the selector correlation"
 *     claim. The atomic-batch leg alone went red (`"id" = $3` and its parameter vanished
 *     from `anchor.guard.exists`), which is correct: transaction mode locks the row at
 *     the probe and emits no guard at all.
 */
describe("parity C4 — a row key that is not the reference key", () => {
  /** The located parent's own FK values ("…Sel") differ from every captured anchor
   *  value ("…Cap"), so a selector-derived key cannot pass by accident. */
  const separationKnown = {
    "ref.locate.rows": [{ id: "r1", tenantId: "tSel", targetCode: "cSel" }],
    "ref.locate.id": "r1",
    "ref.locate.tenantId": "tSel",
    "ref.locate.targetCode": "cSel",
    "anchor.find.rows": [{ id: "aCaptured", tenantId: "tCap", code: "cCap" }],
    "anchor.find.id": "aCaptured",
    "anchor.find.tenantId": "tCap",
    "anchor.find.code": "cCap",
    "ref.find.rows": [{ id: "r2" }],
  };

  const refUpdate = (driver: PGliteDriver): UpdateOperation =>
    new UpdateOperation(
      engineFor(driver),
      paritySelectedSchema.ref as Model<any>,
      {
        where: { id: "r1" },
        data: {
          anchor: { update: { note: "n2", refs: { connect: [{ id: "r2" }] } } },
        },
        select: { id: true },
      }
    );

  for (const substrate of [
    {
      name: "transaction",
      batch: false,
      createDriver: () => new PGliteDriver(),
    },
    {
      name: "atomic batch",
      batch: true,
      createDriver: () => new BatchOnlyPGliteDriver(),
    },
  ]) {
    const lock = substrate.batch ? "" : " FOR UPDATE";

    test(`the probe publishes both keys and each is used for its own job (${substrate.name})`, () => {
      const driver = substrate.createDriver();
      const operation = refUpdate(driver);

      expect(fragmentContract(driver, operation.planning())).toEqual({
        steps: [
          {
            id: "ref.locate",
            kind: "read",
            sql: `SELECT "t0"."id" AS "id", "t0"."tenantId" AS "tenantId", "t0"."targetCode" AS "targetCode" FROM "public"."parity_c_refs" AS "t0" WHERE "t0"."id" = $1 LIMIT 1${lock}`,
            params: ["r1"],
            outputs: {
              rows: { kind: "rows" },
              id: { kind: "firstRowField", field: "id" },
              tenantId: { kind: "firstRowField", field: "tenantId" },
              targetCode: { kind: "firstRowField", field: "targetCode" },
            },
            expects: {
              kind: "exactlyOneRow",
              failure: {
                kind: "notFound",
                message:
                  "query-engine-v2 update located no 'ref' row for its unique where.",
                raceable: false,
              },
            },
            racePin: null,
            onUniqueConflict: null,
          },
          {
            // Row key FIRST, then the reference-key fields the nested relation demands.
            // The correlation itself is on the reference key, pairing the child's
            // `targetCode` with the target's `code`.
            id: "anchor.find",
            kind: "read",
            sql: `SELECT "t0"."id" AS "id", "t0"."tenantId" AS "tenantId", "t0"."code" AS "code" FROM "public"."parity_c_anchors" AS "t0" WHERE ("t0"."tenantId" = $1 AND "t0"."code" = $2) ORDER BY "t0"."id" ASC LIMIT $3${lock}`,
            params: [
              reference("ref.locate", "tenantId"),
              reference("ref.locate", "targetCode"),
              1,
            ],
            outputs: {
              rows: { kind: "rows" },
              id: { kind: "firstRowField", field: "id" },
              tenantId: { kind: "firstRowField", field: "tenantId" },
              code: { kind: "firstRowField", field: "code" },
            },
            expects: {
              kind: "exactlyOneRow",
              failure: {
                kind: "nestedWrite",
                message:
                  "Cannot update relation 'anchor': target record was not found for this parent.",
                relation: "anchor",
                raceable: false,
              },
            },
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "ref.find",
            kind: "read",
            sql: `SELECT "t0"."id" AS "id" FROM "public"."parity_c_refs" AS "t0" WHERE "t0"."id" = $1 LIMIT 1${lock}`,
            params: ["r2"],
            outputs: { rows: { kind: "rows" } },
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
        ],
        outputs: {
          "ref.locate.rows": reference("ref.locate", "rows"),
          "ref.locate.id": reference("ref.locate", "id"),
          "ref.locate.tenantId": reference("ref.locate", "tenantId"),
          "ref.locate.targetCode": reference("ref.locate", "targetCode"),
          "anchor.find.rows": reference("anchor.find", "rows"),
          "anchor.find.id": reference("anchor.find", "id"),
          "anchor.find.tenantId": reference("anchor.find", "tenantId"),
          "anchor.find.code": reference("anchor.find", "code"),
          "ref.find.rows": reference("ref.find", "rows"),
        },
      });

      expect(
        fragmentContract(driver, operation.compile(separationKnown))
      ).toEqual({
        steps: [
          ...(substrate.batch
            ? [
                {
                  id: "ref.guard.exists",
                  premise: {
                    kind: "exists",
                    sql: 'SELECT "t0"."id" AS "id" FROM "public"."parity_c_refs" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
                    params: ["r1"],
                  },
                  failure: {
                    kind: "notFound",
                    message:
                      "query-engine-v2 update located no 'ref' row for its unique where.",
                    raceable: false,
                  },
                },
                {
                  // The selector-side correlation (…Sel) AND the captured row key
                  // (aCaptured), in one premise: two keys, two jobs, one statement.
                  id: "anchor.guard.exists",
                  premise: {
                    kind: "exists",
                    sql: 'SELECT "t0"."id" AS "id" FROM "public"."parity_c_anchors" AS "t0" WHERE ("t0"."tenantId" = $1 AND "t0"."code" = $2 AND "t0"."id" = $3) ORDER BY "t0"."id" ASC LIMIT $4',
                    params: ["tSel", "cSel", "aCaptured", 1],
                  },
                  failure: {
                    kind: "nestedWrite",
                    message:
                      "Cannot update relation 'anchor': target record was not found for this parent.",
                    relation: "anchor",
                    raceable: false,
                  },
                },
                {
                  id: "ref.guard.exists#1",
                  premise: {
                    kind: "exists",
                    sql: 'SELECT "t0"."id" AS "id" FROM "public"."parity_c_refs" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
                    params: ["r2"],
                  },
                  failure: {
                    kind: "nestedWrite",
                    message:
                      "Cannot connect relation 'refs': target record was not found.",
                    relation: "refs",
                    raceable: false,
                  },
                },
              ]
            : []),
          {
            // The complete row key, and ONLY the row key.
            id: "anchor.update",
            kind: "write",
            sql: 'UPDATE "public"."parity_c_anchors" SET "note" = $1 WHERE "parity_c_anchors"."id" = $2 RETURNING "id" AS "id"',
            params: ["n2", "aCaptured"],
            outputs: {},
            expects: substrate.batch
              ? null
              : {
                  kind: "affectedRows",
                  expected: 1,
                  failure: {
                    kind: "notFound",
                    message:
                      "query-engine-v2 update located no 'anchor' row for its unique where.",
                    raceable: false,
                  },
                },
            racePin: null,
            onUniqueConflict: null,
          },
          {
            // tenantId ← tenantId, targetCode ← code: the stored reference paired with
            // the REFERENCE key in schema order, out of the captured row.
            id: "ref.connect",
            kind: "write",
            sql: 'UPDATE "public"."parity_c_refs" SET "tenantId" = CAST($1 AS TEXT), "targetCode" = CAST($2 AS TEXT) WHERE "parity_c_refs"."id" = $3 RETURNING "id" AS "id"',
            params: ["tCap", "cCap", "r2"],
            outputs: {},
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "ref.select",
            kind: "read",
            sql: 'SELECT "t0"."id" AS "id" FROM "public"."parity_c_refs" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
            params: ["r1"],
            outputs: { result: { kind: "rows" } },
            expects: substrate.batch
              ? null
              : {
                  kind: "exactlyOneRow",
                  failure: {
                    kind: "query",
                    message:
                      "query-engine-v2 update terminal read expected exactly one row.",
                    raceable: false,
                  },
                },
            racePin: null,
            onUniqueConflict: null,
          },
        ],
        outputs: { result: reference("ref.select", "result") },
      });
    });
  }
});
