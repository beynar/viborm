import type { AnyDriver } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
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
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

/**
 * PARITY WITNESS — Package B (§6 B, "Trust the selected-record compiler").
 *
 * Package B's outcome (commit 4ef2fa57): `assertArmPkStable` and
 * `assertArmEdgeReferencesLocatedPk` are DELETED; `assertArmEdgeIsChildHeld`
 * (RelationUpsertPart.ts:1196) is RESTORED after a measured silent-write defect —
 * a parent-held to-one written on the relation the upsert ARRIVED THROUGH is
 * silently overridden by the arm's own reparent (its docblock carries the
 * measurement). Deleting a construction-time guard changes what the surface
 * ACCEPTS; it must not change how an already-accepted payload compiles. This
 * file is the "already-accepted" half, byte for byte, so the lift is proved
 * additive.
 *
 * DIMENSIONS PINNED (plan §6 A2's nine):
 *   · planning IDs and order, planning SQL and parameters, planning outputs;
 *   · final IDs and order, final SQL and parameters;
 *   · guards (batch premise SQL + failure) and expects;
 *   · race pins;
 *   · exact errors — none. The surviving refusal and the two lifted ones are
 *     pinned or quoted verbatim elsewhere (below); restating them here would be
 *     a second copy of one invariant;
 *   · statement counts — the step list IS the statement count, so the fragment
 *     equalities below are that pin. Round-trip counts are not a separate fact for
 *     these shapes: each substrate issues one round trip per step it lists.
 *
 * The refusal MESSAGES are not restated here. The surviving
 * `assertArmEdgeIsChildHeld` refusal is pinned exact-string with an empty
 * statement log at nested-arm-dispatch.test.ts (the PARENT_HELD block). The two
 * DELETED guards' former messages are quoted verbatim inside the accept
 * witnesses that replaced them (nested-arm-dispatch.test.ts for the PK move,
 * upsert-arm-referenced-edge.test.ts for the referenced edge), as the record of
 * what each lift discharged. This file carries the fragment dimension those
 * files do not, and nothing else.
 *
 * CAPTURED IDENTITY vs PUBLIC SELECTOR. `buildUpdateArm` addresses the arm by the
 * CAPTURED primary key (RelationUpsertPart.ts:455, reading :473's `locatedRow(rows)`),
 * never by the `where` the caller wrote. On an arm located by its own primary key the
 * two are the same string, so every such fragment is blind to that substitution — which
 * is the exact defect parity-c was built to catch one seam over. The last describe
 * therefore re-runs the found and untaken arms with the arm located by the non-primary-key
 * unique `slug`, against a probe row whose `id` is "tCaptured": every statement that
 * ADDRESSES the arm reads "tCaptured", and only the batch premise re-asserts "team-1".
 *
 * FALSIFIED 2026-08-09 against `src/query-engine/write-engine/RelationUpsertPart.ts`:
 * deleting the `if (Object.keys(relations).length === 0) return;` early exit from
 * `assertArmPkStable` (:1249) turned "a scalar-only arm moves its own primary key" red
 * with that guard's own refusal while the other accept fragments stayed green — so this
 * file distinguishes the guard's carve-out from its refusal. The original was restored
 * from a scratchpad copy taken before the edit.
 */

const parityArmSchema = (() => {
  const org = s
    .model({
      id: s.string().id(),
      name: s.string(),
      teams: s.oneToMany(() => team),
    })
    .map("parity_b_orgs");
  const team = s
    .model({
      id: s.string().id(),
      label: s.string(),
      region: s.string(),
      code: s.string(),
      slug: s.string().unique(),
      orgId: s.string().nullable(),
      org: s
        .manyToOne(() => org)
        .fields("orgId")
        .references("id")
        .optional(),
      ownerId: s.string().nullable(),
      // The PARENT-HELD to-one one level deeper on the arm — `assertArmEdgeIsChildHeld`.
      owner: s
        .manyToOne(() => worker)
        .fields("ownerId")
        .references("id")
        .optional(),
      // The accepted edge: note.teamId -> team.id, the arm row's own primary key.
      notes: s.oneToMany(() => note),
      // The COMPOUND referenced edge — `assertArmEdgeReferencesLocatedPk`.
      members: s.oneToMany(() => member),
    })
    .unique(["region", "code"])
    .map("parity_b_teams");
  const worker = s
    .model({ id: s.string().id(), name: s.string() })
    .map("parity_b_workers");
  const note = s
    .model({
      id: s.string().id(),
      body: s.string(),
      teamId: s.string().nullable(),
      team: s
        .manyToOne(() => team)
        .fields("teamId")
        .references("id")
        .optional(),
    })
    .map("parity_b_notes");
  const member = s
    .model({
      id: s.string().id(),
      nick: s.string(),
      mRegion: s.string().nullable(),
      mCode: s.string().nullable(),
      team: s
        .manyToOne(() => team)
        .fields("mRegion", "mCode")
        .references("region", "code")
        .optional(),
    })
    .map("parity_b_members");
  return { org, team, worker, note, member };
})();

hydrateSchemaNames(parityArmSchema);

function engineFor(driver: AnyDriver): QueryEngine {
  return new QueryEngine(
    driver,
    createModelRegistry(parityArmSchema, createSchemaRegistry(parityArmSchema))
  );
}

/** `org.update` whose `teams` upsert is located by `armWhere`. */
function orgUpdateArgs(
  armUpdate: Record<string, unknown>,
  armWhere: Record<string, unknown> = { id: "t1" }
) {
  return {
    where: { id: "o1" },
    data: {
      teams: {
        upsert: [
          {
            where: armWhere,
            create: {
              id: "t1",
              label: "T1",
              region: "eu",
              code: "alpha",
              slug: "team-1",
            },
            update: armUpdate,
          },
        ],
      },
    },
    select: { id: true },
  };
}

function orgUpdate(
  driver: PGliteDriver,
  armUpdate: Record<string, unknown>,
  armWhere?: Record<string, unknown>
): UpdateOperation {
  return new UpdateOperation(
    engineFor(driver),
    parityArmSchema.org as Model<any>,
    orgUpdateArgs(armUpdate, armWhere)
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

const ORG_NOT_FOUND = {
  kind: "notFound",
  message: "query-engine-v2 update located no 'org' row for its unique where.",
  raceable: false,
};

const TERMINAL_EXPECTS = {
  kind: "exactlyOneRow",
  failure: {
    kind: "query",
    message: "query-engine-v2 update terminal read expected exactly one row.",
    raceable: false,
  },
};

const ARM_VANISHED = {
  kind: "affectedRows",
  expected: 1,
  failure: {
    kind: "notFound",
    message:
      "Nested upsert target for relation 'teams' vanished before its update.",
    relation: "teams",
    raceable: false,
  },
};

/** The batch pair that replaces the transaction's locks: the root premise, then the
 *  found premise reasserting the arm's ORIGINAL selector together with the captured
 *  primary key and the incoming membership. */
function batchGuards(): unknown[] {
  return [
    {
      id: "org.guard.exists",
      premise: {
        kind: "exists",
        sql: 'SELECT "t0"."id" AS "id" FROM "parity_b_orgs" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
        params: ["o1"],
      },
      failure: ORG_NOT_FOUND,
    },
    {
      id: "team.guard.exists",
      premise: {
        kind: "exists",
        sql: 'SELECT "t0"."id" AS "id", "t0"."orgId" AS "orgId" FROM "parity_b_teams" AS "t0" WHERE ("t0"."id" = $1 AND "t0"."id" = $2 AND "t0"."orgId" = $3) ORDER BY "t0"."id" ASC LIMIT $4',
        params: ["t1", "t1", "o1", 1],
      },
      failure: {
        kind: "nestedWrite",
        message: "Nested upsert premise changed for relation 'teams'.",
        relation: "teams",
        raceable: false,
      },
    },
  ];
}

function terminalStep(batch: boolean): unknown {
  return {
    id: "org.select",
    kind: "read",
    sql: 'SELECT "t0"."id" AS "id" FROM "parity_b_orgs" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
    params: ["o1"],
    outputs: { result: { kind: "rows" } },
    expects: batch ? null : TERMINAL_EXPECTS,
    racePin: null,
    onUniqueConflict: null,
  };
}

const NOTE_CREATE = {
  id: "note.create",
  kind: "write",
  sql: 'INSERT INTO "parity_b_notes" ("id", "body", "teamId") VALUES ($1, $2, CAST($3 AS TEXT))',
  params: ["nX", "x", "t1"],
  outputs: {},
  expects: null,
  racePin: null,
  onUniqueConflict: null,
};

const PROBE_ROWS = {
  "org.locate.rows": [{ id: "o1" }],
  "team.find.rows": [{ id: "t1", orgId: "o1" }],
  "note.find.rows": [{ id: "n1", teamId: "t1" }],
};

const DEEPER_CHILD_HELD_EDGE = {
  label: "T1b",
  notes: { create: [{ id: "nX", body: "x" }] },
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

  describe(`parity B — found-arm upsert (${substrate.name})`, () => {
    /** Identical for every arm payload below: the root locate, then the arm probe whose
     *  projection is the arm's primary key plus its OWN foreign-key column — the single
     *  captured identity every deeper write is correlated to. */
    const planningContract = {
      steps: [
        {
          id: "org.locate",
          kind: "read",
          sql: `SELECT "t0"."id" AS "id" FROM "parity_b_orgs" AS "t0" WHERE "t0"."id" = $1 LIMIT 1${lock}`,
          params: ["o1"],
          outputs: {
            rows: { kind: "rows" },
            id: { kind: "firstRowField", field: "id" },
          },
          expects: { kind: "exactlyOneRow", failure: ORG_NOT_FOUND },
          racePin: null,
          onUniqueConflict: null,
        },
        {
          id: "team.find",
          kind: "read",
          sql: `SELECT "t0"."id" AS "id", "t0"."orgId" AS "orgId" FROM "parity_b_teams" AS "t0" WHERE "t0"."id" = $1 LIMIT 1${lock}`,
          params: ["t1"],
          outputs: {
            rows: { kind: "rows" },
            id: { kind: "firstRowField", field: "id", optional: true },
          },
          expects: null,
          racePin: null,
          onUniqueConflict: null,
        },
      ],
      outputs: {
        "org.locate.rows": reference("org.locate", "rows"),
        "org.locate.id": reference("org.locate", "id"),
        "team.find.rows": reference("team.find", "rows"),
        "team.find.id": reference("team.find", "id"),
      },
    };

    test("a deeper primary-key-referenced child-held edge: planning and the found arm", () => {
      const driver = substrate.createDriver();
      const operation = orgUpdate(driver, DEEPER_CHILD_HELD_EDGE);
      expect(fragmentContract(driver, operation.planning())).toEqual(
        planningContract
      );
      expect(fragmentContract(driver, operation.compile(PROBE_ROWS))).toEqual({
        steps: [
          ...(substrate.batch ? batchGuards() : []),
          {
            id: "team.update",
            kind: "write",
            sql: 'UPDATE "parity_b_teams" SET "label" = $1, "orgId" = CAST($2 AS TEXT) WHERE "parity_b_teams"."id" = $3 RETURNING "id" AS "id"',
            params: ["T1b", "o1", "t1"],
            outputs: {},
            expects: substrate.batch ? null : ARM_VANISHED,
            racePin: null,
            onUniqueConflict: null,
          },
          NOTE_CREATE,
          terminalStep(substrate.batch),
        ],
        outputs: { result: reference("org.select", "result") },
      });
    });

    test("a deeper connect on the found arm binds the arm's parent value", () => {
      const driver = substrate.createDriver();
      const operation = orgUpdate(driver, {
        label: "T1b",
        notes: { connect: [{ id: "n1" }] },
      });
      expect(fragmentContract(driver, operation.planning())).toEqual({
        steps: [
          ...(planningContract.steps as unknown[]),
          {
            id: "note.find",
            kind: "read",
            sql: `SELECT "t0"."id" AS "id" FROM "parity_b_notes" AS "t0" WHERE "t0"."id" = $1 LIMIT 1${lock}`,
            params: ["n1"],
            outputs: { rows: { kind: "rows" } },
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
        ],
        outputs: {
          ...planningContract.outputs,
          "note.find.rows": reference("note.find", "rows"),
        },
      });
      expect(fragmentContract(driver, operation.compile(PROBE_ROWS))).toEqual({
        steps: [
          ...(substrate.batch
            ? [
                ...batchGuards(),
                {
                  id: "note.guard.exists",
                  premise: {
                    kind: "exists",
                    sql: 'SELECT "t0"."id" AS "id" FROM "parity_b_notes" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
                    params: ["n1"],
                  },
                  failure: {
                    kind: "nestedWrite",
                    message:
                      "Cannot connect relation 'notes': target record was not found.",
                    relation: "notes",
                    raceable: false,
                  },
                },
              ]
            : []),
          {
            id: "team.update",
            kind: "write",
            sql: 'UPDATE "parity_b_teams" SET "label" = $1, "orgId" = CAST($2 AS TEXT) WHERE "parity_b_teams"."id" = $3 RETURNING "id" AS "id"',
            params: ["T1b", "o1", "t1"],
            outputs: {},
            expects: substrate.batch ? null : ARM_VANISHED,
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "note.connect",
            kind: "write",
            sql: 'UPDATE "parity_b_notes" SET "teamId" = CAST($1 AS TEXT) WHERE "parity_b_notes"."id" = $2 RETURNING "id" AS "id"',
            params: ["t1", "n1"],
            outputs: {},
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          terminalStep(substrate.batch),
        ],
        outputs: { result: reference("org.select", "result") },
      });
    });

    test("a deeper targeted update on the found arm correlates on the arm's parent value", () => {
      const driver = substrate.createDriver();
      const operation = orgUpdate(driver, {
        label: "T1b",
        notes: { update: [{ where: { id: "n1" }, data: { body: "y" } }] },
      });
      expect(fragmentContract(driver, operation.planning())).toEqual({
        steps: [
          ...(planningContract.steps as unknown[]),
          {
            id: "note.find",
            kind: "read",
            sql: `SELECT "t0"."id" AS "id" FROM "parity_b_notes" AS "t0" WHERE ("t0"."id" = $1 AND "t0"."teamId" = $2) ORDER BY "t0"."id" ASC LIMIT $3${lock}`,
            // THE ARM'S PARENT VALUE, as a planning-internal reference to the captured
            // row — never the `where` literal the caller wrote one level up.
            params: ["n1", reference("team.find", "id"), 1],
            outputs: {
              rows: { kind: "rows" },
              id: { kind: "firstRowField", field: "id", optional: true },
            },
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
        ],
        outputs: {
          ...planningContract.outputs,
          "note.find.rows": reference("note.find", "rows"),
          "note.find.id": reference("note.find", "id"),
        },
      });
      expect(fragmentContract(driver, operation.compile(PROBE_ROWS))).toEqual({
        steps: [
          ...(substrate.batch
            ? [
                ...batchGuards(),
                {
                  id: "note.guard.exists",
                  premise: {
                    kind: "exists",
                    sql: 'SELECT "t0"."id" AS "id" FROM "parity_b_notes" AS "t0" WHERE ("t0"."id" = $1 AND "t0"."teamId" = $2 AND "t0"."id" = $3) ORDER BY "t0"."id" ASC LIMIT $4',
                    params: ["n1", "t1", "n1", 1],
                  },
                  failure: {
                    kind: "nestedWrite",
                    message:
                      "Cannot update relation 'notes': target record was not found for this parent.",
                    relation: "notes",
                    raceable: false,
                  },
                },
              ]
            : []),
          {
            id: "team.update",
            kind: "write",
            sql: 'UPDATE "parity_b_teams" SET "label" = $1, "orgId" = CAST($2 AS TEXT) WHERE "parity_b_teams"."id" = $3 RETURNING "id" AS "id"',
            params: ["T1b", "o1", "t1"],
            outputs: {},
            expects: substrate.batch ? null : ARM_VANISHED,
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "note.update",
            kind: "write",
            sql: 'UPDATE "parity_b_notes" SET "body" = $1 WHERE "parity_b_notes"."id" = $2 RETURNING "id" AS "id"',
            params: ["y", "n1"],
            outputs: {},
            expects: substrate.batch
              ? null
              : {
                  kind: "affectedRows",
                  expected: 1,
                  failure: {
                    kind: "notFound",
                    message:
                      "query-engine-v2 update located no 'note' row for its unique where.",
                    raceable: false,
                  },
                },
            racePin: null,
            onUniqueConflict: null,
          },
          terminalStep(substrate.batch),
        ],
        outputs: { result: reference("org.select", "result") },
      });
    });

    test("the untaken create arm carries the arm's race pin and nothing deeper", () => {
      const driver = substrate.createDriver();
      const operation = orgUpdate(driver, DEEPER_CHILD_HELD_EDGE);
      operation.planning();
      expect(
        fragmentContract(
          driver,
          operation.compile({
            "org.locate.rows": [{ id: "o1" }],
            "team.find.rows": [],
          })
        )
      ).toEqual({
        steps: [
          ...(substrate.batch ? [batchGuards()[0]] : []),
          {
            id: "team.create",
            kind: "write",
            sql: 'INSERT INTO "parity_b_teams" ("id", "label", "region", "code", "slug", "orgId", "ownerId") VALUES ($1, $2, $3, $4, $5, CAST($6 AS TEXT), NULL)',
            params: ["t1", "T1", "eu", "alpha", "team-1", "o1"],
            outputs: {},
            expects: null,
            racePin: {
              table: "parity_b_teams",
              fields: ["id"],
              columns: ["id"],
              constraints: ["parity_b_teams_pkey", "PRIMARY"],
            },
            onUniqueConflict: null,
          },
          terminalStep(substrate.batch),
        ],
        outputs: { result: reference("org.select", "result") },
      });
    });

    test("a same-value primary-key SET is not a move: it lands in the arm's own UPDATE", () => {
      const driver = substrate.createDriver();
      const operation = orgUpdate(driver, {
        id: "t1",
        ...DEEPER_CHILD_HELD_EDGE,
      });
      operation.planning();
      expect(fragmentContract(driver, operation.compile(PROBE_ROWS))).toEqual({
        steps: [
          ...(substrate.batch ? batchGuards() : []),
          {
            id: "team.update",
            kind: "write",
            sql: 'UPDATE "parity_b_teams" SET "id" = $1, "label" = $2, "orgId" = CAST($3 AS TEXT) WHERE "parity_b_teams"."id" = $4 RETURNING "id" AS "id"',
            params: ["t1", "T1b", "o1", "t1"],
            outputs: {},
            expects: substrate.batch ? null : ARM_VANISHED,
            racePin: null,
            onUniqueConflict: null,
          },
          NOTE_CREATE,
          terminalStep(substrate.batch),
        ],
        outputs: { result: reference("org.select", "result") },
      });
    });

    test("a scalar-only arm moves its own primary key freely", () => {
      const driver = substrate.createDriver();
      const operation = orgUpdate(driver, { id: "tMoved", label: "T1b" });
      operation.planning();
      expect(fragmentContract(driver, operation.compile(PROBE_ROWS))).toEqual({
        steps: [
          ...(substrate.batch ? batchGuards() : []),
          {
            id: "team.update",
            kind: "write",
            sql: 'UPDATE "parity_b_teams" SET "id" = $1, "label" = $2, "orgId" = CAST($3 AS TEXT) WHERE "parity_b_teams"."id" = $4 RETURNING "id" AS "id"',
            params: ["tMoved", "T1b", "o1", "t1"],
            outputs: {},
            expects: substrate.batch ? null : ARM_VANISHED,
            racePin: null,
            onUniqueConflict: null,
          },
          terminalStep(substrate.batch),
        ],
        outputs: { result: reference("org.select", "result") },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// The arm located by a NON-primary-key unique: captured identity ≠ selector
// ---------------------------------------------------------------------------

const BY_SLUG = { slug: "team-1" };

/** The row the probe captured is "tCaptured"; the caller wrote "team-1". */
const SLUG_PROBE_ROWS = {
  "org.locate.rows": [{ id: "o1" }],
  "team.find.rows": [{ id: "tCaptured", orgId: "o1" }],
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

  describe(`parity B — the found arm addresses the captured key (${substrate.name})`, () => {
    const slugGuards = (): unknown[] => [
      {
        id: "org.guard.exists",
        premise: {
          kind: "exists",
          sql: 'SELECT "t0"."id" AS "id" FROM "parity_b_orgs" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
          params: ["o1"],
        },
        failure: ORG_NOT_FOUND,
      },
      {
        // Both values, together: the ORIGINAL unique the caller wrote AND the key the
        // probe captured. A selector-derived identity cannot produce the second.
        id: "team.guard.exists",
        premise: {
          kind: "exists",
          sql: 'SELECT "t0"."id" AS "id", "t0"."orgId" AS "orgId" FROM "parity_b_teams" AS "t0" WHERE ("t0"."slug" = $1 AND "t0"."id" = $2 AND "t0"."orgId" = $3) ORDER BY "t0"."id" ASC LIMIT $4',
          params: ["team-1", "tCaptured", "o1", 1],
        },
        failure: {
          kind: "nestedWrite",
          message: "Nested upsert premise changed for relation 'teams'.",
          relation: "teams",
          raceable: false,
        },
      },
    ];

    test("planning locates by the unique and projects the identity the writes address", () => {
      const driver = substrate.createDriver();
      const operation = orgUpdate(driver, DEEPER_CHILD_HELD_EDGE, BY_SLUG);
      expect(fragmentContract(driver, operation.planning())).toEqual({
        steps: [
          {
            id: "org.locate",
            kind: "read",
            sql: `SELECT "t0"."id" AS "id" FROM "parity_b_orgs" AS "t0" WHERE "t0"."id" = $1 LIMIT 1${lock}`,
            params: ["o1"],
            outputs: {
              rows: { kind: "rows" },
              id: { kind: "firstRowField", field: "id" },
            },
            expects: { kind: "exactlyOneRow", failure: ORG_NOT_FOUND },
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "team.find",
            kind: "read",
            sql: `SELECT "t0"."id" AS "id", "t0"."orgId" AS "orgId" FROM "parity_b_teams" AS "t0" WHERE "t0"."slug" = $1 LIMIT 1${lock}`,
            params: ["team-1"],
            outputs: {
              rows: { kind: "rows" },
              id: { kind: "firstRowField", field: "id", optional: true },
            },
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
        ],
        outputs: {
          "org.locate.rows": reference("org.locate", "rows"),
          "org.locate.id": reference("org.locate", "id"),
          "team.find.rows": reference("team.find", "rows"),
          "team.find.id": reference("team.find", "id"),
        },
      });
    });

    test("the arm UPDATE and its deeper create both bind the captured key", () => {
      const driver = substrate.createDriver();
      const operation = orgUpdate(driver, DEEPER_CHILD_HELD_EDGE, BY_SLUG);
      operation.planning();
      expect(
        fragmentContract(driver, operation.compile(SLUG_PROBE_ROWS))
      ).toEqual({
        steps: [
          ...(substrate.batch ? slugGuards() : []),
          {
            id: "team.update",
            kind: "write",
            sql: 'UPDATE "parity_b_teams" SET "label" = $1, "orgId" = CAST($2 AS TEXT) WHERE "parity_b_teams"."id" = $3 RETURNING "id" AS "id"',
            params: ["T1b", "o1", "tCaptured"],
            outputs: {},
            expects: substrate.batch ? null : ARM_VANISHED,
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "note.create",
            kind: "write",
            sql: 'INSERT INTO "parity_b_notes" ("id", "body", "teamId") VALUES ($1, $2, CAST($3 AS TEXT))',
            params: ["nX", "x", "tCaptured"],
            outputs: {},
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          terminalStep(substrate.batch),
        ],
        outputs: { result: reference("org.select", "result") },
      });
    });

    test("the untaken create arm still keys on its own create data", () => {
      const driver = substrate.createDriver();
      const operation = orgUpdate(driver, DEEPER_CHILD_HELD_EDGE, BY_SLUG);
      operation.planning();
      expect(
        fragmentContract(
          driver,
          operation.compile({
            "org.locate.rows": [{ id: "o1" }],
            "team.find.rows": [],
          })
        )
      ).toEqual({
        steps: [
          ...(substrate.batch ? [slugGuards()[0]] : []),
          {
            id: "team.create",
            kind: "write",
            sql: 'INSERT INTO "parity_b_teams" ("id", "label", "region", "code", "slug", "orgId", "ownerId") VALUES ($1, $2, $3, $4, $5, CAST($6 AS TEXT), NULL)',
            params: ["t1", "T1", "eu", "alpha", "team-1", "o1"],
            outputs: {},
            expects: null,
            // The pin names the SELECTOR's uniqueness, not the primary key: this arm
            // was located by `slug`, so that is the constraint a concurrent insert races.
            racePin: {
              table: "parity_b_teams",
              fields: ["slug"],
              columns: ["slug"],
              constraints: ["parity_b_teams_slug_key"],
            },
            onUniqueConflict: null,
          },
          terminalStep(substrate.batch),
        ],
        outputs: { result: reference("org.select", "result") },
      });
    });
  });
}
