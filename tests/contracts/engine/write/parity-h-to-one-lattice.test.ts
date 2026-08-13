// biome-ignore-all lint/suspicious/noMisplacedAssertion: `check` is invoked only from test cases.
import { createClient } from "@client/client";
import type { AnyDriver, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { CreateOperation } from "@src/query-engine/write-engine/CreateOperation";
import {
  isOperationValueReference,
  type OperationFragment,
  type OperationStep,
  type PlanningFragment,
  type StatementStep,
} from "@src/query-engine/write-engine/OperationFragment";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { publishedOutputs } from "@tests/fixtures/planning-published";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

/**
 * PARITY WITNESS — Package H (§6 H, "Normalize to-one composition").
 *
 * Package H rewrites `to-one-mutation-schema.ts` (H2) and moves composition into the
 * relation owner (H3), so that supply-plus-modify becomes expressible. Everything the
 * lattice already accepts must come out the other side unchanged — single intents and
 * the five child-held vacate-then-supply pairs — and everything it refuses must either
 * keep refusing or be lifted deliberately, never by accident. This file is the record
 * of both halves as they stand today.
 *
 * DIMENSIONS PINNED (plan §6 A2's nine):
 *   · planning IDs and order, planning SQL and parameters, planning outputs — including
 *     the internal `{ ref: "hub.locate.id" }` parameter that correlates the child probe;
 *   · final IDs and order — H3's step 1-4 ("vacate, supply, capture, modify") is exactly
 *     an ORDER claim, and today's order is `RELATION_MUTATION_KEYS`, so the vacate/supply
 *     step sequence below IS the mechanism it replaces;
 *   · final SQL and parameters, verbatim, on PostgreSQL;
 *   · guards and expects — both substrates, because the guard pair only exists on the
 *     atomic batch and the `expects` only on the transaction: one arm cannot stand in
 *     for the other;
 *   · race pins — none survive on any of these shapes, asserted rather than assumed;
 *   · exact errors — every refusal message verbatim, including the ORDER its kinds are
 *     listed in. That order comes from the schema's entry declaration, not the payload,
 *     so an H2 rewrite into "one shallow mapped union" can silently permute all sixteen;
 *   · statement counts — the step list IS the statement count; round trips equal steps
 *     on these shapes, except the create-root CTE fold, which is pinned as one.
 *
 * `vacate-then-supply.test.ts` already enumerates all 21 update-root pairs by
 * DISPOSITION against a live database. What it cannot see is the compiled plan, which
 * is precisely what H3 rewrites: it would stay green if the five accepted pairs started
 * emitting their two writes in the other order.
 *
 * ALSO PINNED, each because H2's rewrite can move it silently:
 *   · the LONE `upsert`, both arms and both directions — the one accepted shape whose
 *     found arm Package G also rewrites;
 *   · `false` BESIDE an active intent. `enforceAtMostOneMutation` discounts `false`, so
 *     `{ disconnect: false, connect: {…} }` is a ONE-intent payload today; the probe is
 *     labelled `badge.find` with no `#1`, which is how the fragment says no vacate arm
 *     allocated a step id;
 *   · nested field-level validation paths, one probe per nesting level. H2 promises to
 *     "preserve precise nested validation paths" and every other refusal here is the
 *     arity sentence, so a shallow mapped union could flatten them with nothing red;
 *   · that `RELATION_MUTATION_KEYS`'s order, not the payload's, decides the lattice — the
 *     five accepted pairs spelled supplier-first still compile vacate-first.
 *
 * Every refusal below now enters through `createClient`, so route-wide gates and
 * `PendingOperation.resolveOperation` run ahead of the shell, and each asserts an empty
 * statement log beside its message.
 *
 * FALSIFIED 2026-08-09 against `src/query-engine/builders/relation-mutation-parser.ts`:
 * moving `"connect"`, `"create"` and `"connectOrCreate"` ahead of `"disconnect"` and
 * `"delete"` in `RELATION_MUTATION_KEYS` — the supply-before-vacate order — turned
 * exactly the ten pair tests red (five pairs on both substrates) while every
 * single-intent, inactive-payload, create-root and refusal test stayed green. The
 * failure was not a reordered plan but `assertToOneMutationArity` REFUSING all five:
 * `isVacateThenSupply` tests `kinds[0]` and `kinds[1]` positionally, so the accepted
 * half of the lattice is defined by this list's order and nothing else. H3 moves
 * composition into the relation owner, which is exactly this coupling. The original
 * was restored from a scratchpad copy taken before the edit.
 */

const parityHSchema = (() => {
  const hub = s
    .model({
      id: s.string().id(),
      label: s.string(),
      // Child-held to-one: `badge.hubId` is unique, a real 1:1 slot.
      badge: s.oneToOne(() => badge).optional(),
      ownerId: s.string().nullable(),
      // Parent-held to-one: this row holds the foreign key.
      owner: s
        .manyToOne(() => owner)
        .fields("ownerId")
        .references("id")
        .optional(),
    })
    .map("ph_hubs");
  const badge = s
    .model({
      id: s.string().id(),
      tag: s.string(),
      hubId: s.string().unique().nullable(),
      hub: s
        .oneToOne(() => hub)
        .fields("hubId")
        .references("id")
        .optional(),
    })
    .map("ph_badges");
  const owner = s
    .model({
      id: s.string().id(),
      name: s.string(),
      hubs: s.oneToMany(() => hub),
    })
    .map("ph_owners");
  return { hub, badge, owner };
})();

hydrateSchemaNames(parityHSchema);

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
    createModelRegistry(parityHSchema, createSchemaRegistry(parityHSchema))
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

function prepared(driver: AnyDriver, current: StatementStep) {
  const query = driver._prepare(current.statement);
  return { sql: query.sql, params: normalized(query.params) };
}

function stepContract(driver: AnyDriver, current: OperationStep): unknown {
  if (current.kind === "guard") {
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
  if (current.kind === "recordSeries") {
    return { id: current.id, kind: current.kind };
  }
  return {
    id: current.id,
    kind: current.kind,
    ...prepared(driver, current),
    outputs: normalized(current.outputs),
    expects: current.expects ?? null,
    racePin: current.kind === "write" ? (current.racePin ?? null) : null,
    onUniqueConflict:
      current.kind === "write" ? (current.onUniqueConflict ?? null) : null,
  };
}

function fragmentContract(
  driver: AnyDriver,
  fragment: PlanningFragment | OperationFragment
): unknown {
  return {
    steps: fragment.steps.map((current) => stepContract(driver, current)),
    outputs: normalized(publishedOutputs(fragment)),
  };
}

// =============================================================================
// THE EXPECTED VOCABULARY
// =============================================================================

type Step = {
  readonly id: string;
  readonly kind: "read" | "write";
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly outputs: Record<string, unknown>;
  readonly expects: unknown;
  readonly racePin: unknown;
  readonly onUniqueConflict: unknown;
};

function read(
  id: string,
  sql: string,
  params: readonly unknown[],
  outputs: Record<string, unknown>,
  expects: unknown = null
): Step {
  return {
    id,
    kind: "read",
    sql,
    params,
    outputs,
    expects,
    racePin: null,
    onUniqueConflict: null,
  };
}

function write(
  id: string,
  sql: string,
  params: readonly unknown[],
  expects: unknown = null,
  outputs: Record<string, unknown> = {}
): Step {
  return {
    id,
    kind: "write",
    sql,
    params,
    outputs,
    expects,
    racePin: null,
    onUniqueConflict: null,
  };
}

function guard(
  id: string,
  sql: string,
  params: readonly unknown[],
  failure: unknown
): unknown {
  return { id, premise: { kind: "exists", sql, params }, failure };
}

const ROWS = { kind: "rows" };
const firstRowField = (field: string) => ({ kind: "firstRowField", field });

const HUB_NOT_FOUND = {
  kind: "notFound",
  message: "query-engine-v2 update located no 'hub' row for its unique where.",
  raceable: false,
};

const UPDATE_TERMINAL_EXPECTS = {
  kind: "exactlyOneRow",
  failure: {
    kind: "query",
    message: "query-engine-v2 update terminal read expected exactly one row.",
    raceable: false,
  },
};

const CREATE_TERMINAL_EXPECTS = {
  kind: "exactlyOneRow",
  failure: {
    kind: "query",
    message: "query-engine-v2 create terminal read expected exactly one row.",
    raceable: false,
  },
};

const HUB_ROW_SQL =
  'SELECT "t0"."id" AS "id" FROM "ph_hubs" AS "t0" WHERE "t0"."id" = $1 LIMIT 1';

/** The planning outputs map is mechanically `<step>.<output>` for every statement
 *  output a planning step publishes — the rule, not a copy of what the engine did. */
function planningOf(steps: readonly Step[]): unknown {
  const outputs: Record<string, unknown> = {};
  for (const step of steps) {
    for (const key of Object.keys(step.outputs)) {
      outputs[`${step.id}.${key}`] = reference(step.id, key);
    }
  }
  return { steps, outputs };
}

const SUBSTRATES = [
  { name: "transaction", batch: false, make: () => new PGliteDriver() },
  {
    name: "atomic batch",
    batch: true,
    make: () => new BatchOnlyPGliteDriver(),
  },
] as const;

type Substrate = (typeof SUBSTRATES)[number];

function hubUpdateOperation(
  driver: AnyDriver,
  data: Record<string, unknown>
): UpdateOperation {
  return new UpdateOperation(
    engineFor(driver),
    parityHSchema.hub as Model<any>,
    { where: { id: "h1" }, data, select: { id: true } }
  );
}

function hubCreateOperation(
  driver: AnyDriver,
  data: Record<string, unknown>
): CreateOperation {
  return new CreateOperation(
    engineFor(driver),
    parityHSchema.hub as Model<any>,
    { data, select: { id: true } }
  );
}

/** The root locate. On the atomic batch the lock is gone; the guard replaces it. */
function hubLocate(substrate: Substrate): Step {
  return read(
    "hub.locate",
    `${HUB_ROW_SQL}${substrate.batch ? "" : " FOR UPDATE"}`,
    ["h1"],
    { rows: ROWS, id: firstRowField("id") },
    { kind: "exactlyOneRow", failure: HUB_NOT_FOUND }
  );
}

const HUB_ROOT_GUARD = guard(
  "hub.guard.exists",
  HUB_ROW_SQL,
  ["h1"],
  HUB_NOT_FOUND
);

/** The root UPDATE's affected-row expectation exists only where no guard stands in. */
function hubUpdate(
  substrate: Substrate,
  setClause: string,
  params: readonly unknown[]
): Step {
  return write(
    "hub.update",
    `UPDATE "ph_hubs" SET ${setClause} WHERE "ph_hubs"."id" = $${params.length} RETURNING "id" AS "id"`,
    params,
    substrate.batch
      ? null
      : { kind: "affectedRows", expected: 1, failure: HUB_NOT_FOUND }
  );
}

/** The terminal read's expectation belongs to the transaction only: on the atomic
 *  batch the guards carry the premise and the read asserts nothing. */
function hubSelect(substrate: Substrate, create = false): Step {
  return read(
    "hub.select",
    HUB_ROW_SQL,
    ["h1"],
    { result: ROWS },
    substrate.batch
      ? null
      : create
        ? CREATE_TERMINAL_EXPECTS
        : UPDATE_TERMINAL_EXPECTS
  );
}

const KNOWN = {
  "hub.locate.rows": [{ id: "h1" }],
  "hub.locate.id": "h1",
  "owner.find.rows": [{ id: "o1" }],
  "badge.find.rows": [{ id: "b-alt", hubId: null }],
  "badge.find.id": "b-alt",
  "badge.find#1.rows": [{ id: "b-alt", hubId: null }],
};

// =============================================================================
// UPDATE ROOT — one active intent
// =============================================================================

const OWNER_ROW_SQL =
  'SELECT "t0"."id" AS "id" FROM "ph_owners" AS "t0" WHERE "t0"."id" = $1 LIMIT 1';
const BADGE_BY_ID_SQL =
  'SELECT "t0"."id" AS "id" FROM "ph_badges" AS "t0" WHERE "t0"."id" = $1 LIMIT 1';

const CONNECT_OWNER_MISSING = {
  kind: "nestedWrite",
  message: "Cannot connect relation 'owner': target record was not found.",
  relation: "owner",
  raceable: false,
};
const CONNECT_BADGE_MISSING = {
  kind: "nestedWrite",
  message: "Cannot connect relation 'badge': target record was not found.",
  relation: "badge",
  raceable: false,
};
const BADGE_UPDATE_MISSING = {
  kind: "nestedWrite",
  message:
    "Cannot update relation 'badge': target record was not found for this parent.",
  relation: "badge",
  raceable: false,
};

const BADGE_DISCONNECT = write(
  "badge.disconnect",
  'UPDATE "ph_badges" SET "hubId" = NULL WHERE "ph_badges"."hubId" = $1',
  ["h1"]
);
const BADGE_DELETE = write(
  "badge.deleteMany",
  'DELETE FROM "ph_badges" WHERE "ph_badges"."hubId" = $1',
  ["h1"]
);
const BADGE_CREATE = write(
  "badge.create",
  'INSERT INTO "ph_badges" ("id", "tag", "hubId") VALUES ($1, $2, CAST($3 AS TEXT))',
  ["b9", "fresh", "h1"]
);
const BADGE_CONNECT = write(
  "badge.connect",
  'UPDATE "ph_badges" SET "hubId" = CAST($1 AS TEXT) WHERE "ph_badges"."id" = $2 RETURNING "id" AS "id"',
  ["h1", "b-alt"]
);

for (const substrate of SUBSTRATES) {
  describe(`parity H — update root, ONE active intent (${substrate.name})`, () => {
    const check = (
      data: Record<string, unknown>,
      planning: readonly Step[],
      guards: readonly unknown[],
      writes: readonly Step[]
    ) => {
      const driver = substrate.make();
      const operation = hubUpdateOperation(driver, data);
      expect(fragmentContract(driver, operation.planning())).toEqual(
        planningOf(planning)
      );
      expect(fragmentContract(driver, operation.compile(KNOWN))).toEqual({
        steps: [
          ...(substrate.batch ? [HUB_ROOT_GUARD, ...guards] : []),
          ...writes,
          hubSelect(substrate),
        ],
        outputs: { result: reference("hub.select", "result") },
      });
    };

    test("parent-held connect folds the probed key into the root UPDATE", () => {
      check(
        { owner: { connect: { id: "o1" } } },
        [
          hubLocate(substrate),
          read(
            "owner.find",
            `${OWNER_ROW_SQL}${substrate.batch ? "" : " FOR UPDATE"}`,
            ["o1"],
            { rows: ROWS }
          ),
        ],
        [
          guard(
            "owner.guard.exists",
            OWNER_ROW_SQL,
            ["o1"],
            CONNECT_OWNER_MISSING
          ),
        ],
        [hubUpdate(substrate, '"ownerId" = CAST($1 AS TEXT)', ["o1", "h1"])]
      );
    });

    test("parent-held disconnect NULLs the foreign key in that same UPDATE", () => {
      check(
        { owner: { disconnect: true } },
        [hubLocate(substrate)],
        [],
        [hubUpdate(substrate, '"ownerId" = NULL', ["h1"])]
      );
    });

    test("parent-held create writes the target BEFORE the root UPDATE", () => {
      check(
        { owner: { create: { id: "o9", name: "fresh" } } },
        [hubLocate(substrate)],
        [],
        [
          write(
            "owner.create",
            'INSERT INTO "ph_owners" ("id", "name") VALUES ($1, $2)',
            ["o9", "fresh"]
          ),
          hubUpdate(substrate, '"ownerId" = CAST($1 AS TEXT)', ["o9", "h1"]),
        ]
      );
    });

    test("child-held connect rebinds the target row, not the root", () => {
      check(
        { badge: { connect: { id: "b-alt" } } },
        [
          hubLocate(substrate),
          read(
            "badge.find",
            `${BADGE_BY_ID_SQL}${substrate.batch ? "" : " FOR UPDATE"}`,
            ["b-alt"],
            { rows: ROWS }
          ),
        ],
        [
          guard(
            "badge.guard.exists",
            BADGE_BY_ID_SQL,
            ["b-alt"],
            CONNECT_BADGE_MISSING
          ),
        ],
        [BADGE_CONNECT]
      );
    });

    test("child-held disconnect clears the slot by membership, with no probe", () => {
      check(
        { badge: { disconnect: true } },
        [hubLocate(substrate)],
        [],
        [BADGE_DISCONNECT]
      );
    });

    test("child-held delete removes the member by membership, with no probe", () => {
      check(
        { badge: { delete: true } },
        [hubLocate(substrate)],
        [],
        [BADGE_DELETE]
      );
    });

    test("child-held update probes the member by correlation, then writes by key", () => {
      check(
        { badge: { update: { tag: "t" } } },
        [
          hubLocate(substrate),
          read(
            "badge.find",
            `SELECT "t0"."id" AS "id" FROM "ph_badges" AS "t0" WHERE "t0"."hubId" = $1 ORDER BY "t0"."id" ASC LIMIT $2${substrate.batch ? "" : " FOR UPDATE"}`,
            // The parent value is a planning-internal reference, never a literal.
            [reference("hub.locate", "id"), 1],
            { rows: ROWS, id: firstRowField("id") },
            { kind: "exactlyOneRow", failure: BADGE_UPDATE_MISSING }
          ),
        ],
        [
          guard(
            "badge.guard.exists",
            'SELECT "t0"."id" AS "id" FROM "ph_badges" AS "t0" WHERE ("t0"."hubId" = $1 AND "t0"."id" = $2) ORDER BY "t0"."id" ASC LIMIT $3',
            ["h1", "b-alt", 1],
            BADGE_UPDATE_MISSING
          ),
        ],
        [
          write(
            "badge.update",
            'UPDATE "ph_badges" SET "tag" = $1 WHERE "ph_badges"."id" = $2 RETURNING "id" AS "id"',
            ["t", "b-alt"],
            substrate.batch
              ? null
              : {
                  kind: "affectedRows",
                  expected: 1,
                  failure: {
                    kind: "notFound",
                    message:
                      "query-engine-v2 update located no 'badge' row for its unique where.",
                    raceable: false,
                  },
                }
          ),
        ]
      );
    });

    test("child-held create inserts the member carrying the parent key", () => {
      check(
        { badge: { create: { id: "b9", tag: "fresh" } } },
        [hubLocate(substrate)],
        [],
        [BADGE_CREATE]
      );
    });
  });

  // ===========================================================================
  // UPDATE ROOT — the five accepted vacate-then-supply pairs
  // ===========================================================================

  describe(`parity H — the five accepted vacate-then-supply pairs (${substrate.name})`, () => {
    const check = (
      data: Record<string, unknown>,
      planning: readonly Step[],
      guards: readonly unknown[],
      writes: readonly Step[]
    ) => {
      const driver = substrate.make();
      const operation = hubUpdateOperation(driver, data);
      expect(fragmentContract(driver, operation.planning())).toEqual(
        planningOf(planning)
      );
      expect(fragmentContract(driver, operation.compile(KNOWN))).toEqual({
        steps: [
          ...(substrate.batch ? [HUB_ROOT_GUARD, ...guards] : []),
          ...writes,
          hubSelect(substrate),
        ],
        outputs: { result: reference("hub.select", "result") },
      });
    };

    /** The supplier's probe is `badge.find#1`, not `badge.find`. Alone, the same
     *  supplier probes as `badge.find` (above), and the vacate arms emit no read at
     *  all — so the vacate arm ALLOCATES the plain label from the step scope and then
     *  emits nothing under it. The suffix is part of the compiled identity today, and
     *  every reference into `known` depends on it. */
    const supplierProbe = (columns: string) =>
      read(
        "badge.find#1",
        `SELECT ${columns} FROM "ph_badges" AS "t0" WHERE "t0"."id" = $1 LIMIT 1${substrate.batch ? "" : " FOR UPDATE"}`,
        ["b-alt"],
        { rows: ROWS }
      );

    test("disconnect + connect: vacate by membership, then rebind by key", () => {
      check(
        { badge: { disconnect: true, connect: { id: "b-alt" } } },
        [hubLocate(substrate), supplierProbe('"t0"."id" AS "id"')],
        [
          guard(
            "badge.guard.exists",
            BADGE_BY_ID_SQL,
            ["b-alt"],
            CONNECT_BADGE_MISSING
          ),
        ],
        [BADGE_DISCONNECT, BADGE_CONNECT]
      );
    });

    test("disconnect + create: vacate, then insert the newcomer", () => {
      check(
        { badge: { disconnect: true, create: { id: "b9", tag: "fresh" } } },
        [hubLocate(substrate)],
        [],
        [BADGE_DISCONNECT, BADGE_CREATE]
      );
    });

    test("disconnect + connectOrCreate: vacate, then the found arm adopts", () => {
      check(
        {
          badge: {
            disconnect: true,
            connectOrCreate: {
              where: { id: "b-alt" },
              create: { id: "b-alt", tag: "n" },
            },
          },
        },
        [
          hubLocate(substrate),
          supplierProbe('"t0"."id" AS "id", "t0"."hubId" AS "hubId"'),
        ],
        [
          guard(
            "badge.guard.exists",
            'SELECT "t0"."id" AS "id", "t0"."hubId" AS "hubId" FROM "ph_badges" AS "t0" WHERE ("t0"."id" = $1 AND "t0"."id" = $2) ORDER BY "t0"."id" ASC LIMIT $3',
            ["b-alt", "b-alt", 1],
            {
              kind: "nestedWrite",
              message:
                "Record was replaced by another transaction during nested connectOrCreate",
              relation: "badge",
              raceable: false,
            }
          ),
        ],
        [
          BADGE_DISCONNECT,
          write(
            "badge.update",
            'UPDATE "ph_badges" SET "hubId" = CAST($1 AS TEXT) WHERE "ph_badges"."id" = $2 RETURNING "id" AS "id", "hubId" AS "hubId"',
            ["h1", "b-alt"],
            substrate.batch
              ? null
              : {
                  kind: "affectedRows",
                  expected: 1,
                  failure: {
                    kind: "notFound",
                    message:
                      "Record was replaced by another transaction during nested connectOrCreate",
                    relation: "badge",
                    raceable: false,
                  },
                }
          ),
        ]
      );
    });

    test("delete + connect: remove the incumbent, then rebind by key", () => {
      check(
        { badge: { delete: true, connect: { id: "b-alt" } } },
        [hubLocate(substrate), supplierProbe('"t0"."id" AS "id"')],
        // `#1` again, and on the GUARD label this time: the delete arm allocated
        // `badge.guard.exists` without emitting one.
        [
          guard(
            "badge.guard.exists#1",
            BADGE_BY_ID_SQL,
            ["b-alt"],
            CONNECT_BADGE_MISSING
          ),
        ],
        [BADGE_DELETE, BADGE_CONNECT]
      );
    });

    test("delete + create: remove the incumbent, then insert the newcomer", () => {
      check(
        { badge: { delete: true, create: { id: "b9", tag: "fresh" } } },
        [hubLocate(substrate)],
        [],
        [BADGE_DELETE, BADGE_CREATE]
      );
    });
  });

  // ===========================================================================
  // UPDATE ROOT — a LONE upsert, both arms and both directions
  // ===========================================================================

  /** H2 rewrites the schema owner that declares the `upsert` entry and H1 keeps refusing
   *  "upsert beside another target intent", so the accepted LONE upsert plan is exactly
   *  what the rewrite can move. Package G rewrites the same found arm. */
  describe(`parity H — a lone to-one upsert (${substrate.name})`, () => {
    const BADGE_UPSERT = {
      badge: {
        upsert: { create: { id: "b9", tag: "c" }, update: { tag: "u" } },
      },
    };

    const membershipProbe = read(
      "badge.find",
      `SELECT "t0"."id" AS "id" FROM "ph_badges" AS "t0" WHERE "t0"."hubId" = $1 ORDER BY "t0"."id" ASC LIMIT $2${substrate.batch ? "" : " FOR UPDATE"}`,
      [reference("hub.locate", "id"), 1],
      {
        rows: ROWS,
        id: { kind: "firstRowField", field: "id", optional: true },
      }
    );

    test("child-held, FOUND: the arm updates the captured member, guarded by membership", () => {
      const driver = substrate.make();
      const operation = hubUpdateOperation(driver, BADGE_UPSERT);
      expect(fragmentContract(driver, operation.planning())).toEqual(
        planningOf([hubLocate(substrate), membershipProbe])
      );
      expect(fragmentContract(driver, operation.compile(KNOWN))).toEqual({
        steps: [
          ...(substrate.batch
            ? [
                HUB_ROOT_GUARD,
                guard(
                  "badge.guard.exists",
                  'SELECT "t0"."id" AS "id" FROM "ph_badges" AS "t0" WHERE ("t0"."hubId" = $1 AND "t0"."id" = $2) ORDER BY "t0"."id" ASC LIMIT $3',
                  ["h1", "b-alt", 1],
                  {
                    kind: "nestedWrite",
                    message:
                      "Nested upsert premise changed for relation 'badge'.",
                    relation: "badge",
                    raceable: false,
                  }
                ),
              ]
            : []),
          write(
            "badge.update",
            'UPDATE "ph_badges" SET "tag" = $1 WHERE "ph_badges"."id" = $2 RETURNING "id" AS "id"',
            ["u", "b-alt"],
            substrate.batch
              ? null
              : {
                  kind: "affectedRows",
                  expected: 1,
                  failure: {
                    kind: "notFound",
                    message:
                      "Nested upsert target for relation 'badge' vanished before its update.",
                    relation: "badge",
                    raceable: false,
                  },
                }
          ),
          hubSelect(substrate),
        ],
        outputs: { result: reference("hub.select", "result") },
      });
    });

    test("child-held, MISSING: the create arm inserts carrying the parent key, no guard", () => {
      const driver = substrate.make();
      const operation = hubUpdateOperation(driver, BADGE_UPSERT);
      operation.planning();
      expect(
        fragmentContract(
          driver,
          operation.compile({ ...KNOWN, "badge.find.rows": [] })
        )
      ).toEqual({
        steps: [
          ...(substrate.batch ? [HUB_ROOT_GUARD] : []),
          write(
            "badge.create",
            'INSERT INTO "ph_badges" ("id", "tag", "hubId") VALUES ($1, $2, CAST($3 AS TEXT))',
            ["b9", "c", "h1"]
          ),
          hubSelect(substrate),
        ],
        outputs: { result: reference("hub.select", "result") },
      });
    });

    test("parent-held, FOUND: the probe rides the located FK and the root writes nothing", () => {
      const driver = substrate.make();
      const operation = hubUpdateOperation(driver, {
        owner: {
          upsert: { create: { id: "o9", name: "c" }, update: { name: "u" } },
        },
      });
      expect(fragmentContract(driver, operation.planning())).toEqual(
        planningOf([
          read(
            "hub.locate",
            `SELECT "t0"."id" AS "id", "t0"."ownerId" AS "ownerId" FROM "ph_hubs" AS "t0" WHERE "t0"."id" = $1 LIMIT 1${substrate.batch ? "" : " FOR UPDATE"}`,
            ["h1"],
            {
              rows: ROWS,
              id: firstRowField("id"),
              ownerId: firstRowField("ownerId"),
            },
            { kind: "exactlyOneRow", failure: HUB_NOT_FOUND }
          ),
          read(
            "owner.find",
            `SELECT "t0"."id" AS "id" FROM "ph_owners" AS "t0" WHERE "t0"."id" = $1 ORDER BY "t0"."id" ASC LIMIT $2${substrate.batch ? "" : " FOR UPDATE"}`,
            [reference("hub.locate", "ownerId"), 1],
            {
              rows: ROWS,
              id: { kind: "firstRowField", field: "id", optional: true },
            }
          ),
        ])
      );
      expect(
        fragmentContract(
          driver,
          operation.compile({
            ...KNOWN,
            "hub.locate.rows": [{ id: "h1", ownerId: "o1" }],
          })
        )
      ).toEqual({
        steps: [
          ...(substrate.batch
            ? [
                HUB_ROOT_GUARD,
                guard(
                  "owner.guard.exists",
                  'SELECT "t0"."id" AS "id" FROM "ph_owners" AS "t0" WHERE ("t0"."id" = $1 AND "t0"."id" = $2) ORDER BY "t0"."id" ASC LIMIT $3',
                  ["o1", "o1", 1],
                  {
                    kind: "nestedWrite",
                    message:
                      "Nested upsert premise changed for relation 'owner'.",
                    relation: "owner",
                    raceable: false,
                  }
                ),
              ]
            : []),
          write(
            "owner.update",
            'UPDATE "ph_owners" SET "name" = $1 WHERE "ph_owners"."id" = $2 RETURNING "id" AS "id"',
            ["u", "o1"],
            substrate.batch
              ? null
              : {
                  kind: "affectedRows",
                  expected: 1,
                  failure: {
                    kind: "notFound",
                    message:
                      "query-engine-v2 update located no 'owner' row for its unique where.",
                    raceable: false,
                  },
                }
          ),
          hubSelect(substrate),
        ],
        outputs: { result: reference("hub.select", "result") },
      });
    });
  });

  // ===========================================================================
  // UPDATE ROOT — inactive payloads
  // ===========================================================================

  describe(`parity H — an inactive to-one payload reaches no compiler (${substrate.name})`, () => {
    const rootOnly = write(
      "hub.update",
      'UPDATE "ph_hubs" SET "label" = $1 WHERE "ph_hubs"."id" = $2 RETURNING "id" AS "id"',
      ["L", "h1"],
      substrate.batch
        ? null
        : { kind: "affectedRows", expected: 1, failure: HUB_NOT_FOUND },
      { result: ROWS }
    );

    test("`false` BESIDE an active intent is still a one-intent payload", () => {
      // `enforceAtMostOneMutation` counts `value !== undefined && value !== false`, so this
      // is ONE intent — and the probe is labelled `badge.find`, with no `#1`: the inactive
      // verb allocated no step id and emitted no vacate arm.
      const driver = substrate.make();
      const operation = hubUpdateOperation(driver, {
        badge: { disconnect: false, connect: { id: "b-alt" } },
      });
      expect(fragmentContract(driver, operation.planning())).toEqual(
        planningOf([
          hubLocate(substrate),
          read(
            "badge.find",
            `${BADGE_BY_ID_SQL}${substrate.batch ? "" : " FOR UPDATE"}`,
            ["b-alt"],
            { rows: ROWS }
          ),
        ])
      );
      expect(fragmentContract(driver, operation.compile(KNOWN))).toEqual({
        steps: [
          ...(substrate.batch
            ? [
                HUB_ROOT_GUARD,
                guard(
                  "badge.guard.exists",
                  BADGE_BY_ID_SQL,
                  ["b-alt"],
                  CONNECT_BADGE_MISSING
                ),
              ]
            : []),
          BADGE_CONNECT,
          hubSelect(substrate),
        ],
        outputs: { result: reference("hub.select", "result") },
      });
    });

    test("the parent-held direction agrees: `delete: false` beside a create", () => {
      const driver = substrate.make();
      const operation = hubUpdateOperation(driver, {
        owner: { delete: false, create: { id: "o9", name: "fresh" } },
      });
      expect(fragmentContract(driver, operation.planning())).toEqual(
        planningOf([hubLocate(substrate)])
      );
      expect(fragmentContract(driver, operation.compile(KNOWN))).toEqual({
        steps: [
          ...(substrate.batch ? [HUB_ROOT_GUARD] : []),
          write(
            "owner.create",
            'INSERT INTO "ph_owners" ("id", "name") VALUES ($1, $2)',
            ["o9", "fresh"]
          ),
          hubUpdate(substrate, '"ownerId" = CAST($1 AS TEXT)', ["o9", "h1"]),
          hubSelect(substrate),
        ],
        outputs: { result: reference("hub.select", "result") },
      });
    });

    test.each([
      ["literal false", { disconnect: false }],
      ["an empty object", {}],
    ])("%s ALONE plans nothing and folds the root into ONE statement", (_name, badge) => {
      const driver = substrate.make();
      const operation = hubUpdateOperation(driver, { label: "L", badge });
      // No locate at all: with no relation program there is nothing to correlate,
      // so the scalar root update keeps its one-statement fast path.
      expect(fragmentContract(driver, operation.planning())).toEqual({
        steps: [],
        outputs: {},
      });
      expect(fragmentContract(driver, operation.compile({}))).toEqual({
        steps: [...(substrate.batch ? [HUB_ROOT_GUARD] : []), rootOnly],
        outputs: { result: reference("hub.update", "result") },
      });
    });
  });

  // ===========================================================================
  // CREATE ROOT — one active intent
  // ===========================================================================

  describe(`parity H — create root, ONE active intent (${substrate.name})`, () => {
    test("parent-held connect probes the target and folds its key into the INSERT", () => {
      const driver = substrate.make();
      const operation = hubCreateOperation(driver, {
        id: "h1",
        label: "L",
        owner: { connect: { id: "o1" } },
      });
      expect(fragmentContract(driver, operation.planning())).toEqual(
        planningOf([
          read(
            "owner.find",
            `${OWNER_ROW_SQL}${substrate.batch ? "" : " FOR UPDATE"}`,
            ["o1"],
            { rows: ROWS }
          ),
        ])
      );
      expect(fragmentContract(driver, operation.compile(KNOWN))).toEqual({
        steps: [
          ...(substrate.batch
            ? [
                guard(
                  "owner.guard.exists",
                  OWNER_ROW_SQL,
                  ["o1"],
                  CONNECT_OWNER_MISSING
                ),
              ]
            : []),
          write(
            "hub.create",
            'INSERT INTO "ph_hubs" ("id", "label", "ownerId") VALUES ($1, $2, CAST($3 AS TEXT))',
            ["h1", "L", "o1"]
          ),
          hubSelect(substrate, true),
        ],
        outputs: { result: reference("hub.select", "result") },
      });
    });

    test("parent-held create writes the target first — and does NOT fold", () => {
      // The child-held direction below folds into one CTE statement on both
      // substrates' shared PostgreSQL adapter; this direction does not, because the
      // root INSERT depends on the target's key rather than the other way round.
      const driver = substrate.make();
      const operation = hubCreateOperation(driver, {
        id: "h1",
        label: "L",
        owner: { create: { id: "o9", name: "fresh" } },
      });
      expect(operation.planning().steps).toEqual([]);
      expect(fragmentContract(driver, operation.compile({}))).toEqual({
        steps: [
          write(
            "owner.create",
            'INSERT INTO "ph_owners" ("id", "name") VALUES ($1, $2)',
            ["o9", "fresh"]
          ),
          write(
            "hub.create",
            'INSERT INTO "ph_hubs" ("id", "label", "ownerId") VALUES ($1, $2, CAST($3 AS TEXT))',
            ["h1", "L", "o9"]
          ),
          // No guard on either substrate: nothing was probed, so nothing is reasserted.
          hubSelect(substrate, true),
        ],
        outputs: { result: reference("hub.select", "result") },
      });
    });

    test("child-held connect inserts the root, then rebinds the probed target", () => {
      const driver = substrate.make();
      const operation = hubCreateOperation(driver, {
        id: "h1",
        label: "L",
        badge: { connect: { id: "b-alt" } },
      });
      expect(fragmentContract(driver, operation.planning())).toEqual(
        planningOf([
          read(
            "badge.find",
            `${BADGE_BY_ID_SQL}${substrate.batch ? "" : " FOR UPDATE"}`,
            ["b-alt"],
            { rows: ROWS }
          ),
        ])
      );
      expect(fragmentContract(driver, operation.compile(KNOWN))).toEqual({
        steps: [
          ...(substrate.batch
            ? [
                guard(
                  "badge.guard.exists",
                  BADGE_BY_ID_SQL,
                  ["b-alt"],
                  CONNECT_BADGE_MISSING
                ),
              ]
            : []),
          write(
            "hub.create",
            'INSERT INTO "ph_hubs" ("id", "label", "ownerId") VALUES ($1, $2, NULL)',
            ["h1", "L"]
          ),
          BADGE_CONNECT,
          hubSelect(substrate, true),
        ],
        outputs: { result: reference("hub.select", "result") },
      });
    });
  });
}

describe("parity H — create root, child-held create: the CTE fold", () => {
  test("a transaction driver folds root INSERT, member INSERT and read into ONE", () => {
    const driver = new PGliteDriver();
    const operation = hubCreateOperation(driver, {
      id: "h1",
      label: "L",
      badge: { create: { id: "b9", tag: "fresh" } },
    });
    expect(operation.planning().steps).toEqual([]);
    expect(fragmentContract(driver, operation.compile({}))).toEqual({
      steps: [
        write(
          "hub.create",
          'WITH "__viborm_mutation" AS (INSERT INTO "ph_hubs" ("id", "label", "ownerId") VALUES ($1, $2, NULL) RETURNING "id", "label", "ownerId"), "__viborm_write_0" AS (INSERT INTO "ph_badges" ("id", "tag", "hubId") VALUES ($3, $4, CAST($5 AS TEXT))) SELECT "t0"."id" AS "id" FROM "__viborm_mutation" AS "t0"',
          ["h1", "L", "b9", "fresh", "h1"],
          CREATE_TERMINAL_EXPECTS,
          { result: ROWS }
        ),
      ],
      outputs: { result: reference("hub.create", "result") },
    });
  });

  test("the atomic batch keeps the same three statements unfolded", () => {
    const driver = new BatchOnlyPGliteDriver();
    const operation = hubCreateOperation(driver, {
      id: "h1",
      label: "L",
      badge: { create: { id: "b9", tag: "fresh" } },
    });
    expect(operation.planning().steps).toEqual([]);
    expect(fragmentContract(driver, operation.compile({}))).toEqual({
      steps: [
        write(
          "hub.create",
          'INSERT INTO "ph_hubs" ("id", "label", "ownerId") VALUES ($1, $2, NULL)',
          ["h1", "L"]
        ),
        write(
          "badge.create",
          'INSERT INTO "ph_badges" ("id", "tag", "hubId") VALUES ($1, $2, CAST($3 AS TEXT))',
          ["b9", "fresh", "h1"]
        ),
        read("hub.select", HUB_ROW_SQL, ["h1"], { result: ROWS }),
      ],
      outputs: { result: reference("hub.select", "result") },
    });
  });
});

// =============================================================================
// THE REFUSALS — verbatim, including the order the kinds are listed in
// =============================================================================

describe("parity H — every multi-intent refusal, verbatim", () => {
  /** The PUBLIC path, on an in-memory PGlite: `constructRoutedOperation`'s route-wide
   *  gates and `PendingOperation.resolveOperation` both run ahead of the shell, and the
   *  empty statement log is the evidence that nothing half-landed. */
  const refusalOf = async (
    root: "create" | "update",
    data: Record<string, unknown>
  ): Promise<{ message: string; statements: string[] }> => {
    const driver = new RecordingPGliteDriver();
    const client = createClient({ schema: parityHSchema, driver }) as any;
    driver.recording = true;
    const args =
      root === "create"
        ? { data, select: { id: true } }
        : { where: { id: "h1" }, data, select: { id: true } };
    const message = await client.hub[root](args).then(
      () => {
        throw new Error("expected a refusal");
      },
      (thrown: unknown) => (thrown as Error).message
    );
    return { message, statements: driver.statements };
  };

  const COMBINATION = (root: string, kinds: string) =>
    `Validation failed for ${root}: Unsupported to-one operation combination: ${kinds}`;

  /**
   * The kind list follows the RELATION INPUT SCHEMA's entry order — create, connect,
   * connectOrCreate, update, upsert, disconnect, delete — not the payload's. Every row
   * below spells its payload in the other order where the two differ, so an H2 rewrite
   * that permutes the entries is caught by the message rather than by nothing.
   */
  test.each([
    // PACKAGE H RETARGET — these four are ACCEPTED by the lattice now, so this block no
    // longer owns them; their acceptance and final state are pinned in
    // "parity H — the compositions the lattice accepts" below. What stayed refused, and
    // what now owns each refusal, is recorded there too.
    //
    // The three composed shapes below reach a DIFFERENT owner than the arity guard H
    // deleted, and each is pinned here with the sentence that owner spells:
    [
      "connectOrCreate + update — the produced-identity channel, not arity",
      "update",
      {
        badge: {
          update: { tag: "t" },
          connectOrCreate: {
            where: { id: "b-alt" },
            create: { id: "b-alt", tag: "n" },
          },
        },
      },
      "query-engine-v2 update cannot compose 'connectOrCreate' with 'update' on the to-one relation 'badge': the modify addresses the supplied row through a planning read, and a 'connectOrCreate' supplier only produces that row's identity when it inserts it.",
    ],
    [
      "create + update — the produced-identity channel, not arity",
      "update",
      { badge: { update: { tag: "t" }, create: { id: "b9", tag: "fresh" } } },
      "query-engine-v2 update cannot compose 'create' with 'update' on the to-one relation 'badge': the modify addresses the supplied row through a planning read, and a 'create' supplier only produces that row's identity when it inserts it.",
    ],
    [
      "delete + create + update — the own-write ledger, not arity",
      "update",
      {
        badge: {
          delete: true,
          create: { id: "b9", tag: "fresh" },
          update: { tag: "t" },
        },
      },
      "Nested operation 'update' on relation 'badge' depends on an earlier 'delete' membership write in the same nested write. Split these operations into separate queries.",
    ],
    // H1 keeps refusing these. Same message shape, opposite fate.
    [
      "supplier + supplier",
      "update",
      { badge: { connect: { id: "b-alt" }, create: { id: "b9", tag: "f" } } },
      COMBINATION("update", "create, connect"),
    ],
    [
      "upsert beside a target intent",
      "update",
      {
        badge: {
          upsert: { update: { tag: "u" }, create: { id: "b9", tag: "c" } },
          connect: { id: "b-alt" },
        },
      },
      COMBINATION("update", "connect, upsert"),
    ],
    [
      "vacate + update with no supplier",
      "update",
      { badge: { disconnect: true, update: { tag: "t" } } },
      COMBINATION("update", "update, disconnect"),
    ],
    [
      "two vacates",
      "update",
      { badge: { disconnect: true, delete: true } },
      COMBINATION("update", "disconnect, delete"),
    ],
    [
      "the sixth vacate-then-supply pair, delete + connectOrCreate",
      "update",
      {
        badge: {
          delete: true,
          connectOrCreate: {
            where: { id: "b-alt" },
            create: { id: "b-alt", tag: "n" },
          },
        },
      },
      COMBINATION("update", "connectOrCreate, delete"),
    ],
    [
      "create root, child-held supplier + supplier",
      "create",
      {
        id: "h1",
        label: "L",
        badge: { connect: { id: "b-alt" }, create: { id: "b9", tag: "f" } },
      },
      COMBINATION("create", "create, connect"),
    ],
    [
      "create root, parent-held supplier + supplier",
      "create",
      {
        id: "h1",
        label: "L",
        owner: { connect: { id: "o1" }, create: { id: "o9", name: "fresh" } },
      },
      COMBINATION("create", "create, connect"),
    ],
  ])("%s", async (_name, root, data, message) => {
    expect(await refusalOf(root as "create" | "update", data)).toEqual({
      message,
      statements: [],
    });
  });

  test("under a CREATE root `update` is not a key at all, so it is not a combination", async () => {
    // A create-root to-one input has no `update` entry, so the diagnostic is the
    // parse boundary's unknown key — a different sentence H1's lattice must answer for.
    expect(
      await refusalOf("create", {
        id: "h1",
        label: "L",
        badge: { create: { id: "b9", tag: "f" }, update: { tag: "t" } },
      })
    ).toEqual({
      message: "Validation failed for create: Unknown key: update",
      statements: [],
    });
  });

  /** H2 promises to "preserve precise nested validation paths". Not one nested
   *  field-level issue is otherwise pinned in this file — every other refusal here is the
   *  arity sentence — so a shallow mapped union could keep the arity message perfect while
   *  flattening the path of everything inside an arm. One probe per nesting level. */
  test.each([
    [
      "inside a connect arm",
      { badge: { connect: { id: 123 } } },
      "data.badge.connect.id",
    ],
    [
      "inside a create arm",
      { badge: { create: { id: "b9", tag: 1 } } },
      "data.badge.create.tag",
    ],
    [
      "inside a parent-held create arm",
      { owner: { create: { id: "o9", name: 1 } } },
      "data.owner.create.name",
    ],
  ])("a nested field issue keeps its path %s", (_label, data, path) => {
    let thrown: unknown;
    try {
      hubUpdateOperation(new PGliteDriver(), data);
    } catch (error) {
      thrown = error;
    }
    expect({
      name: (thrown as Error).constructor.name,
      message: (thrown as Error).message,
      issues: (thrown as { issues?: unknown }).issues,
    }).toEqual({
      name: "ValidationError",
      message: "Validation failed for update: Expected string",
      issues: [{ path, message: "Expected string" }],
    });
  });
});

// =============================================================================
// THE ENGINE'S OWN TO-ONE ARITY GUARDS — a census, not a pin
// =============================================================================

/**
 * PACKAGE H RE-ANCHORED (2026-08-10). §1.1-§1.4 of forbidden-shapes-reference.md were
 * four ENGINE arity guards, none of them pinned anywhere in the estate:
 *
 *   · `CreateOperation.interpretParentHeld` (`entries.length !== 1`, with a `|| "none"`
 *     tail) and `CreateOperation.interpretChildHeld` (`> 1`), both spelling
 *     "query-engine-v2 create supports one operation on the to-one relation '<r>'…";
 *   · `RecordUpdateCompiler.interpretRelation`'s parent-held `kinds.length !== 1` and
 *     `assertToOneMutationArity` (reached from the ordinary and the polymorphic inverse
 *     dispatch), both spelling "query-engine-v2 update supports one mutation kind…".
 *
 * ALL FOUR ARE GONE. The reason the census recorded them as unpinnable is the reason they
 * could go: an arity count was never the question. A to-one relation supports one
 * COMPOSITION — `(vacate?, supplier, modify?)` — and `composeToOneEntries` /
 * `interpretParentHeldComposition` now enumerate that lattice TOTALLY, falling through to
 * a `QueryEngineError` that says the schema and the dispatch disagree. That fall-through
 * is an engine fault, not a declined shape, so it is not a census site (the X1c
 * precedent). The two create-root lines survive as exactly such assertions: under the
 * CREATE root the to-one input owns neither `update` nor a vacate, so their only
 * multi-entry payload is supplier + supplier, which the two create-root rows in the
 * refusal block above prove the SCHEMA answers first.
 *
 * ONE new site replaces them, and it is not the same claim: `create` / `connectOrCreate`
 * composed with `update` is refused by the engine's missing produced-identity channel,
 * pinned verbatim in the refusal block above. `connect + update` composes, because a
 * unique selector is an identity that exists before the fragment's first write.
 *
 * What this block pins, unchanged in claim and rewritten in mechanism: that the PAYLOAD's
 * key order does not decide the plan. Before H the accepted order came from
 * `RELATION_MUTATION_KEYS` — `isVacateThenSupply` read `kinds[0]`/`kinds[1]` POSITIONALLY
 * off that constant, which is what the falsification at the top of this file exploited.
 * Now `composeToOneEntries` classifies each entry by KIND and emits vacate → supplier →
 * modify, so the constant decides nothing and reordering it can no longer move a plan.
 * The rows below are therefore the same rows with a different owner, and the
 * composition block after them extends the same claim to the three-entry shapes.
 */
describe("parity H — payload key order is not the lattice's order", () => {
  test.each([
    [
      "disconnect + connect",
      { badge: { connect: { id: "b-alt" }, disconnect: true } },
      ["badge.disconnect", "badge.connect"],
    ],
    [
      "disconnect + create",
      { badge: { create: { id: "b9", tag: "fresh" }, disconnect: true } },
      ["badge.disconnect", "badge.create"],
    ],
    [
      "disconnect + connectOrCreate",
      {
        badge: {
          connectOrCreate: {
            where: { id: "b-alt" },
            create: { id: "b-alt", tag: "n" },
          },
          disconnect: true,
        },
      },
      ["badge.disconnect", "badge.update"],
    ],
    [
      "delete + connect",
      { badge: { connect: { id: "b-alt" }, delete: true } },
      ["badge.deleteMany", "badge.connect"],
    ],
    [
      "delete + create",
      { badge: { create: { id: "b9", tag: "fresh" }, delete: true } },
      ["badge.deleteMany", "badge.create"],
    ],
  ])("%s spelled supplier-first still compiles vacate-first", (_label, data, writes) => {
    const driver = new PGliteDriver();
    const operation = hubUpdateOperation(driver, data);
    operation.planning();
    expect(
      operation
        .compile(KNOWN)
        .steps.map((step) => step.id)
        .filter((id) => id.startsWith("badge."))
    ).toEqual(writes);
  });
});

/**
 * PACKAGE H — the compositions the lattice now ACCEPTS, on both substrates.
 *
 * These are the rows the refusal block used to own. What is pinned here is §6 H3's
 * step order — "vacate the prior member, supply the new one, capture its identity,
 * modify it" — as the compiled step sequence, because that order IS the mechanism H3
 * replaces. The final state each one produces is pinned against a live database by
 * `vacate-then-supply-behavior.ts` (both substrates, with an untouched decoy); this file
 * owns the plan.
 *
 * The modify's locator is the composition's whole difficulty and shows up here as a
 * DISTINCT probe: a lone to-one `update` correlates (`WHERE hubId = <located hub>`),
 * while a composed one reads the supplier's own unique selector. Correlating would
 * address the OUTGOING member — planning precedes every write, so at probe time the slot
 * still holds the incumbent, or is empty.
 */
describe("parity H — the compositions the lattice accepts", () => {
  /** The composed shapes read probes this file's shared `KNOWN` does not carry — a
   *  supplier probe under a suffixed label, and the parent's own foreign key for the
   *  correlated DELETE. Extending it per shape keeps the shared fixture untouched. */
  const COMPOSED_KNOWN = {
    ...KNOWN,
    "hub.locate.rows": [{ id: "h1", ownerId: "o-old" }],
    "hub.locate.ownerId": "o-old",
    "badge.find#2.rows": [{ id: "b-alt", hubId: null }],
    "owner.find#1.rows": [{ id: "o1" }],
  };

  const ids = (
    substrate: Substrate,
    data: Record<string, unknown>
  ): { planning: string[]; final: string[] } => {
    const driver = substrate.make();
    const operation = hubUpdateOperation(driver, data);
    const planning = operation.planning().steps.map((step) => step.id);
    return {
      planning,
      final: operation.compile(COMPOSED_KNOWN).steps.map((step) => step.id),
    };
  };

  for (const substrate of SUBSTRATES) {
    test(`child-held connect + update composes supply then modify (${substrate.name})`, () => {
      expect(
        ids(substrate, {
          badge: { update: { tag: "t" }, connect: { id: "b-alt" } },
        })
      ).toEqual({
        planning: ["hub.locate", "badge.find", "badge.find#1"],
        final: [
          ...(substrate.batch
            ? ["hub.guard.exists", "badge.guard.exists", "badge.guard.exists#1"]
            : []),
          "badge.connect",
          "badge.update",
          "hub.select",
        ],
      });
    });

    test(`child-held disconnect + connect + update composes all three (${substrate.name})`, () => {
      expect(
        ids(substrate, {
          badge: {
            update: { tag: "t" },
            connect: { id: "b-alt" },
            disconnect: true,
          },
        })
      ).toEqual({
        planning: ["hub.locate", "badge.find#1", "badge.find#2"],
        final: [
          ...(substrate.batch
            ? ["hub.guard.exists", "badge.guard.exists", "badge.guard.exists#1"]
            : []),
          "badge.disconnect",
          "badge.connect",
          "badge.update",
          "hub.select",
        ],
      });
    });

    test(`parent-held disconnect + connect is ONE root assignment (${substrate.name})`, () => {
      // The vacate contributes NO step at all: its whole parent-side effect is the
      // FK-null the supplier just replaced, and the supplier is the only writer of that
      // column. Before H the same outcome depended on which assignment
      // `Object.assign(parentSet, link.assignment)` happened to apply last.
      expect(
        ids(substrate, { owner: { disconnect: true, connect: { id: "o1" } } })
      ).toEqual({
        planning: ["hub.locate", "owner.find"],
        final: [
          ...(substrate.batch
            ? ["hub.guard.exists", "owner.guard.exists"]
            : []),
          "hub.update",
          "hub.select",
        ],
      });
    });

    test(`parent-held delete + create elides the FK-null write (${substrate.name})`, () => {
      // R2's elision. Without it the plan carries a `parent.fknull` UPDATE AFTER the
      // root — measured at 8c2908d as inserting the fresh row and then ORPHANING it.
      // The correlated DELETE stays, and still addresses the OLD foreign-key value.
      expect(
        ids(substrate, {
          owner: { delete: true, create: { id: "o9", name: "fresh" } },
        })
      ).toEqual({
        planning: ["hub.locate"],
        final: [
          ...(substrate.batch ? ["hub.guard.exists"] : []),
          "owner.create",
          "hub.update",
          "owner.delete",
          "hub.select",
        ],
      });
    });

    test(`parent-held connect + update correlates the modify on the SUPPLIED row (${substrate.name})`, () => {
      expect(
        ids(substrate, {
          owner: { connect: { id: "o1" }, update: { name: "n" } },
        })
      ).toEqual({
        planning: ["hub.locate", "owner.find", "owner.find#1"],
        final: [
          ...(substrate.batch
            ? ["hub.guard.exists", "owner.guard.exists", "owner.guard.exists#1"]
            : []),
          "hub.update",
          "owner.update",
          "hub.select",
        ],
      });
    });
  }

  /**
   * THE WRONG-ROW DECOY, at the level this file owns: the composed modify's probe must
   * not mention the parent's foreign key or the membership correlation at all. If it
   * did, it would address whoever occupies the slot NOW — the outgoing member — because
   * every probe here is a planning read and planning precedes every write.
   */
  test("a composed modify probes by the supplier's selector, never by correlation", () => {
    const driver = new PGliteDriver();
    const parentHeld = hubUpdateOperation(driver, {
      owner: { connect: { id: "o1" }, update: { name: "n" } },
    });
    const childHeld = hubUpdateOperation(driver, {
      badge: { update: { tag: "t" }, connect: { id: "b-alt" } },
    });
    const probeSql = (operation: ReturnType<typeof hubUpdateOperation>) =>
      operation
        .planning()
        .steps.filter((step) => step.id.endsWith("#1"))
        .map((step) => prepared(driver, step));
    expect(probeSql(parentHeld)).toEqual([
      {
        sql: 'SELECT "t0"."id" AS "id" FROM "ph_owners" AS "t0" WHERE "t0"."id" = $1 ORDER BY "t0"."id" ASC LIMIT $2 FOR UPDATE',
        params: ["o1", 1],
      },
    ]);
    expect(probeSql(childHeld)).toEqual([
      {
        sql: 'SELECT "t0"."id" AS "id" FROM "ph_badges" AS "t0" WHERE "t0"."id" = $1 ORDER BY "t0"."id" ASC LIMIT $2 FOR UPDATE',
        params: ["b-alt", 1],
      },
    ]);
  });
});

/**
 * PACKAGE H — ONE MORE INSTANCE OF PACKAGE G's MEASURED CLASS, recorded and NOT closed.
 *
 * G's carry-forward item 3: "an untaken create arm still runs every construction-time
 * SHAPE refusal in the found arm's subtree, because `RecordUpdateCompilerState`
 * interprets programs in its constructor". H's composition site is a construction-time
 * refusal in exactly that position, so a `create`/`connectOrCreate` supplier beside a
 * modify, spelled inside an upsert's UPDATE arm, refuses the whole tree even when the
 * row is ABSENT and the CREATE arm is the one that would run.
 *
 * MEASURED here rather than argued: the row does not exist, the create arm carries a
 * payload that would succeed on its own, and the tree is still refused with nothing
 * written. That is a fact about WHERE the site sits, not about the composition — every
 * other construction-time refusal in that subtree behaves the same way, which is why
 * this is one more instance of a class and not a new defect. Closing it means deferring
 * the whole selected-record interpretation to the taken branch (the shape of Package G's
 * `updateLegality` deferral, widened), which is a Package O decision, not H's.
 */
describe("parity H — the composition site is eager on an untaken upsert arm", () => {
  test("an absent row still refuses for its untaken update arm's composition", async () => {
    const driver = new RecordingPGliteDriver();
    const client = createClient({ schema: parityHSchema, driver }) as any;
    driver.recording = true;
    const message = await client.hub
      .upsert({
        where: { id: "h-absent" },
        create: { id: "h-absent", label: "L" },
        update: {
          badge: { create: { id: "b9", tag: "fresh" }, update: { tag: "t" } },
        },
        select: { id: true },
      })
      .then(
        () => "EXECUTED",
        (thrown: unknown) => (thrown as Error).message
      );
    expect({ message, statements: driver.statements }).toEqual({
      message:
        "query-engine-v2 update cannot compose 'create' with 'update' on the to-one relation 'badge': the modify addresses the supplied row through a planning read, and a 'create' supplier only produces that row's identity when it inserts it.",
      statements: [],
    });
  });
});
