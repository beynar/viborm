import { createClient } from "@client/client";
import type { AnyDriver, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
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
import { UnsupportedOperationError } from "@src/query-engine/write-engine/shared";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
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
 * THE CENSUS. `getPrimaryKeyFields(...).length !== 1` refuses at five
 * `UnsupportedOperationError` sites, anchored on their `throw` statement as
 * forbidden-shapes-reference.md anchors them. Three are pinned below, each with a payload
 * measured to reach it: RelationUpsertPart.ts:1062 (the one text in this family with no
 * `query-engine-v2` prefix, and reachable only under a FRESH parent — under a selected
 * parent the record compiler answers first), RecordUpdateCompiler.ts:1324, and
 * nested-target-parts.ts:190 (reached through a fresh junction target, whose nestedBuilder
 * seam is the create path; a junction target's own `update` payload routes back through
 * RecordUpdateCompiler.ts:1324 instead). The two not pinned here are recorded so the
 * family stays auditable:
 *   · RecordUpdateCompiler.ts:2631 (parent-held to-one) already has its own DB-backed
 *     witness at parent-held-compound-edge-behavior.ts:335;
 *   · RecordUpdateCompiler.ts:1495 (`interpretPolymorphicChildHeld`) needs a polymorphic
 *     inverse whose target model has a compound primary key, which this schema has no
 *     member of. Its ACCEPTED path — the private `(type, id)` projection and the exact
 *     membership conjunct on a selected polymorphic target — is unpinned here for the
 *     same reason, and is C2 migration step 6's whole subject.
 *
 * NON-DISCRIMINATING. `query-engine-v2 update requires a child with one primary key for
 * relation '<r>'.` is emitted VERBATIM at RecordUpdateCompiler.ts:1324 AND :1495, so the
 * two rows below that assert it cannot say WHICH guard answered. That is a duplicate
 * cluster, and §O2 owns compressing it; recorded here rather than worked around.
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
      items: s.oneToMany(() => item),
      pairs: s.oneToMany(() => pair),
      tags: s.manyToMany(() => tag),
    })
    .map("parity_c_owners");
  const item = s
    .model({
      id: s.string().id(),
      code: s.string().unique(),
      label: s.string(),
      ownerId: s.string().nullable(),
      owner: s
        .manyToOne(() => owner)
        .fields("ownerId")
        .references("id")
        .optional(),
    })
    .map("parity_c_items");
  /** The compound-primary-key child: no single captured handle exists for it. */
  const pair = s
    .model({
      tenantId: s.string(),
      slot: s.string(),
      note: s.string(),
      ownerId: s.string().nullable(),
      owner: s
        .manyToOne(() => owner)
        .fields("ownerId")
        .references("id")
        .optional(),
    })
    .id(["tenantId", "slot"])
    .map("parity_c_pairs");
  const tag = s
    .model({
      id: s.string().id(),
      name: s.string().unique(),
      owners: s.manyToMany(() => owner),
      slots: s.oneToMany(() => tagSlot),
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
        .manyToOne(() => tag)
        .fields("tagId")
        .references("id")
        .optional(),
    })
    .id(["tenantId", "slot"])
    .map("parity_c_tag_slots");
  return { owner, item, pair, tag, tagSlot };
})();

hydrateSchemaNames(paritySelectedSchema);

class RecordingPGliteDriver extends PGliteDriver {
  readonly statements: string[] = [];
  recording = false;

  protected override execute<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(sql);
    return super.execute<T>(client, sql, params, context);
  }

  protected override executeRaw<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(sql);
    return super.executeRaw<T>(client, sql, params, context);
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
    outputs: normalized(fragment.outputs),
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
    sql: 'SELECT "t0"."id" AS "id" FROM "parity_c_owners" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
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
    sql: `SELECT "t0"."id" AS "id" FROM "parity_c_owners" AS "t0" WHERE "t0"."id" = $1 LIMIT 1${lock}`,
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
    sql: 'SELECT "t0"."id" AS "id" FROM "parity_c_owners" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
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
    sql: `SELECT "t0"."id" AS "id" FROM "parity_c_items" AS "t0" WHERE ("t0"."code" = $1 AND "t0"."ownerId" = $2) ORDER BY "t0"."id" ASC LIMIT $3${lock}`,
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
    'SELECT "t0"."id" AS "id" FROM "parity_c_items" AS "t0" WHERE ("t0"."code" = $1 AND "t0"."ownerId" = $2 AND "t0"."id" = $3) ORDER BY "t0"."id" ASC LIMIT $4';

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
    sql: `SELECT "parity_c_tags"."id" AS "id" FROM "parity_c_tags" WHERE ("parity_c_tags"."id" IN (SELECT "tagId" FROM "owner_tag" WHERE "ownerId" = $1) AND "parity_c_tags"."name" = $2) LIMIT $3${lock}`,
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
      sql: 'SELECT "parity_c_tags"."id" AS "id" FROM "parity_c_tags" WHERE ("parity_c_tags"."id" IN (SELECT "tagId" FROM "owner_tag" WHERE "ownerId" = $1) AND "parity_c_tags"."name" = $2 AND "parity_c_tags"."id" = $3) LIMIT $4',
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
              sql: 'UPDATE "parity_c_tags" SET "name" = $1 WHERE "parity_c_tags"."id" = $2 RETURNING "id" AS "id"',
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
              sql: 'DELETE FROM "owner_tag" WHERE "tagId" IN ($1)',
              params: ["gCaptured"],
              outputs: {},
              expects: null,
              racePin: null,
              onUniqueConflict: null,
            },
            {
              id: "tag.delete.child",
              kind: "write",
              sql: 'DELETE FROM "parity_c_tags" WHERE "parity_c_tags"."id" = $1 RETURNING "id" AS "id", "name" AS "name"',
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
            sql: `SELECT "t0"."id" AS "id" FROM "parity_c_tags" AS "t0" WHERE "t0"."name" = $1 LIMIT 1${lock}`,
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
                      sql: 'SELECT "t0"."id" AS "id" FROM "parity_c_tags" AS "t0" WHERE ("t0"."name" = $1 AND "t0"."id" = $2) ORDER BY "t0"."id" ASC LIMIT $3',
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
              sql: 'DELETE FROM "owner_tag" WHERE "ownerId" = $1',
              params: ["o1"],
              outputs: {},
              expects: null,
              racePin: null,
              onUniqueConflict: null,
            },
            {
              id: "tag.set.insert",
              kind: "write",
              sql: 'INSERT  INTO "owner_tag" ("ownerId", "tagId") VALUES ($1, $2) ON CONFLICT DO NOTHING',
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
            sql: 'UPDATE "parity_c_items" SET "label" = $1 WHERE ("parity_c_items"."ownerId" = $2 AND "parity_c_items"."label" = $3)',
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
            sql: 'DELETE FROM "parity_c_items" WHERE ("parity_c_items"."ownerId" = $1 AND "parity_c_items"."label" = $2)',
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
            sql: 'UPDATE "parity_c_items" SET "label" = $1 WHERE "parity_c_items"."id" = $2 RETURNING "id" AS "id"',
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
            sql: 'DELETE FROM "parity_c_items" WHERE "parity_c_items"."id" = $1 RETURNING "id" AS "id", "code" AS "code", "label" AS "label", "ownerId" AS "ownerId"',
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
            sql: `SELECT "t0"."id" AS "id" FROM "parity_c_items" AS "t0" WHERE "t0"."code" = $1 LIMIT 1${lock}`,
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
                  'SELECT "t0"."id" AS "id" FROM "parity_c_items" AS "t0" WHERE ("t0"."code" = $1 AND "t0"."id" = $2) ORDER BY "t0"."id" ASC LIMIT $3',
                  ["c1", "iCaptured", 1],
                  targetNotFound("set")
                ),
              ]
            : []),
          {
            id: "item.orphan",
            kind: "write",
            sql: 'UPDATE "parity_c_items" SET "ownerId" = NULL WHERE ("parity_c_items"."ownerId" = $1 AND NOT ("parity_c_items"."code" = $2))',
            params: ["o1", "c1"],
            outputs: {},
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "item.set",
            kind: "write",
            sql: 'UPDATE "parity_c_items" SET "ownerId" = CAST($1 AS TEXT) WHERE "parity_c_items"."id" IN ($2)',
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

describe("parity C — child requires one primary key, verbatim", () => {
  const clientOn = (): { client: any; driver: RecordingPGliteDriver } => {
    const driver = new RecordingPGliteDriver();
    const client = createClient({
      schema: paritySelectedSchema,
      driver,
    }) as any;
    driver.recording = true;
    return { client, driver };
  };

  const caught = async (
    run: () => Promise<unknown>
  ): Promise<{ name: string; message: string }> => {
    const error = await run().then(
      () => undefined,
      (thrown: unknown) => thrown as Error
    );
    if (!(error instanceof UnsupportedOperationError)) {
      throw new Error(
        `Expected UnsupportedOperationError, got ${String(error)}`
      );
    }
    return { name: error.name, message: error.message };
  };

  test("RelationUpsertPart: an adopt part under a FRESH parent", async () => {
    const { client, driver } = clientOn();
    expect(
      await caught(() =>
        client.owner.create({
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
      )
    ).toEqual({
      name: "UnsupportedOperationError",
      // The one site in this family whose text carries no `query-engine-v2` prefix.
      message: "Relation 'pairs' requires a child with one primary key.",
    });
    expect(driver.statements).toEqual([]);
  });

  test.each([
    [
      "RecordUpdateCompiler.interpretRelation: a targeted update",
      {
        pairs: {
          update: [
            {
              where: { tenantId_slot: { tenantId: "t1", slot: "s1" } },
              data: { note: "n2" },
            },
          ],
        },
      },
      "query-engine-v2 update requires a child with one primary key for relation 'pairs'.",
    ],
    [
      // The same site answers the ADOPT payload under a SELECTED parent, so
      // RelationUpsertPart's own refusal is unreachable from an update root.
      "RecordUpdateCompiler.interpretRelation: an adopt part under a SELECTED parent",
      {
        pairs: {
          upsert: [
            {
              where: { tenantId_slot: { tenantId: "t1", slot: "s1" } },
              create: { tenantId: "t1", slot: "s1", note: "n" },
              update: { note: "n2" },
            },
          ],
        },
      },
      "query-engine-v2 update requires a child with one primary key for relation 'pairs'.",
    ],
    [
      "nested-target-parts: one level deeper than a FRESH junction target",
      {
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
      },
      "query-engine-v2 update requires a child with one primary key for relation 'slots' one level deeper.",
    ],
  ])("%s", async (_site, relations, message) => {
    const { client, driver } = clientOn();
    expect(
      await caught(() => client.owner.update(ownerUpdateArgs(relations)))
    ).toEqual({ name: "UnsupportedOperationError", message });
    expect(driver.statements).toEqual([]);
  });
});
