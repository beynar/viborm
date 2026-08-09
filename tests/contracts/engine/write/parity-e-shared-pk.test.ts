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
import { UnsupportedOperationError } from "@src/query-engine/write-engine/shared";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

/**
 * PARITY WITNESS — Package E (§6 E, "Lift shared-primary-key update roots").
 *
 * E1 lets the parent-held root fold consume the update root's captured identity for
 * shared-primary-key `create` / `connectOrCreate` / `upsert`, and refuse "only if the
 * exact final identity cannot be captured or derived". The shared-primary-key surface is
 * therefore SPLIT today, and this witness pins both halves so the lift can be read as a
 * move of one line rather than a rewrite of the family:
 *
 *   · the CREATE root's absorbed shape (§4.1's "one provenance, the probe deciding only
 *     which statement puts the row there") must come out unchanged — E touches the
 *     UPDATE root only;
 *   · the CREATE root's three surviving refusals must keep their exact text — E does not
 *     widen `assertSharedPkResolved` (CreateOperation.ts:2723);
 *   · the UPDATE root's three refusals (`assertNotSharedPk`, RecordUpdateCompiler.ts:3077,
 *     called at :2789 / :2982 / :3012) are what E deletes, so their exact text is the
 *     before-picture the lift is measured against;
 *   · the NON-shared parent-held `create` under the same update root is the fold E1 says
 *     the shared arms must JOIN — "fold the final value into the root UPDATE, do not
 *     create a shared-PK Part". Its byte-level plan is the target shape.
 *
 * DIMENSIONS PINNED (plan §6 A2's nine):
 *   · planning IDs and order, planning SQL and parameters, planning outputs — the arm
 *     probe is ONE read that publishes rows only, and its `FOR UPDATE` is the substrate's;
 *   · final IDs and order, final SQL and parameters — including that the FOUND arm emits
 *     NO target INSERT and the MISSING arm emits one BEFORE the record's own;
 *   · guards and expects — the batch found arm's re-assert, and the terminal read's
 *     `exactlyOneRow` in transaction mode against its absence in batch mode;
 *   · race pins — the missing arm's target INSERT carries the destination-uniqueness pin
 *     (E1: "preserve destination uniqueness checks"); nothing else does;
 *   · exact errors — six verbatim refusals across the two roots;
 *   · statement counts — the step list IS the statement count, and the refusals assert
 *     ZERO statements reached the driver.
 *
 * Round-trip counts are not a separate fact on these shapes: each substrate issues one
 * round trip per listed step.
 *
 * THE REST OF THE FOLD. `assertNotSharedPk` is called at three sites only, so the other
 * shared-primary-key kinds are answered elsewhere and are pinned as they answer today:
 * `connect` by the update's own key-transition derivation (a QueryEngineError at COMPILE,
 * after the planning locate has already been issued), `disconnect` by the parse boundary
 * (a required to-one has no such key), and a target `update` not at all — it is ACCEPTED,
 * and its probe binds the record's own primary key straight off the locate. E1 edits the
 * NON-shared halves of `interpretParentHeldUpsert` and `interpretParentHeldConnectOrCreate`
 * as well, so both of those, plus a root primary-key move riding the same fold, are pinned
 * byte-for-byte on both substrates below.
 *
 * FALSIFIED 2026-08-09 against `src/query-engine/write-engine/RecordUpdateCompiler.ts`:
 * emptying `assertNotSharedPk`'s `recordPk` (:3078) so its membership test can never hold
 * turned all three UPDATE-root refusals red — each operation ran to a statement instead of
 * throwing — while both CREATE-root refusals, the absorbed-plan assertions, and the
 * non-shared control all stayed green. That asymmetry IS the split this witness claims.
 * The original was restored from a scratchpad copy taken before the edit.
 */

const parityShared = (() => {
  const account = s
    .model({
      id: s.string().id(),
      email: s.string().unique(),
      name: s.string(),
      card: s.oneToOne(() => card).optional(),
      widgets: s.oneToMany(() => widget),
    })
    .map("parity_e_accounts");
  /** The shared-primary-key record: `accountId` is its identity AND its foreign key. */
  const card = s
    .model({
      accountId: s.string().id(),
      label: s.string(),
      account: s
        .oneToOne(() => account)
        .fields("accountId")
        .references("id"),
    })
    .map("parity_e_cards");
  /** The control: the same parent-held to-one kinds on an edge that is NOT the key. */
  const widget = s
    .model({
      id: s.string().id(),
      name: s.string(),
      ownerId: s.string().nullable(),
      owner: s
        .manyToOne(() => account)
        .fields("ownerId")
        .references("id")
        .optional(),
    })
    .map("parity_e_widgets");
  return { account, card, widget };
})();

hydrateSchemaNames(parityShared);

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
    createModelRegistry(parityShared, createSchemaRegistry(parityShared))
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
            outputs: normalized(current.outputs),
            expects: current.expects ?? null,
            racePin:
              current.kind === "write" ? (current.racePin ?? null) : null,
            onUniqueConflict:
              current.kind === "write"
                ? (current.onUniqueConflict ?? null)
                : null,
          }
    ),
    outputs: normalized(fragment.outputs),
  };
}

const ABSORBED_CARD_ARGS = {
  data: {
    label: "L",
    account: {
      connectOrCreate: {
        where: { id: "a1" },
        create: { id: "a1", email: "a1@x", name: "A" },
      },
    },
  },
  select: { accountId: true, label: true },
};

function absorbedCard(driver: PGliteDriver): CreateOperation {
  return new CreateOperation(
    engineFor(driver),
    parityShared.card as Model<any>,
    ABSORBED_CARD_ARGS
  );
}

/** The record's own INSERT: keyed by the `where`'s literal on BOTH arms. */
const CARD_INSERT = {
  id: "card.create",
  kind: "write",
  sql: 'INSERT INTO "parity_e_cards" ("accountId", "label") VALUES (CAST($1 AS TEXT), $2)',
  params: ["a1", "L"],
  outputs: {},
  expects: null,
  racePin: null,
  onUniqueConflict: null,
};

/** The target INSERT the MISSING arm adds, ahead of the record's own. */
const ACCOUNT_INSERT = {
  id: "account.create",
  kind: "write",
  sql: 'INSERT INTO "parity_e_accounts" ("id", "email", "name") VALUES ($1, $2, $3)',
  params: ["a1", "a1@x", "A"],
  outputs: {},
  expects: null,
  // E1: "preserve destination uniqueness checks".
  racePin: {
    fields: ["id"],
    table: "parity_e_accounts",
    columns: ["id"],
    constraints: ["parity_e_accounts_pkey", "PRIMARY"],
  },
  onUniqueConflict: null,
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

  /** The terminal read addresses the SAME literal the record's key took. */
  const cardTerminal = {
    id: "card.select",
    kind: "read",
    sql: 'SELECT "t0"."accountId" AS "accountId", "t0"."label" AS "label" FROM "parity_e_cards" AS "t0" WHERE "t0"."accountId" = $1 LIMIT 1',
    params: ["a1"],
    outputs: { result: { kind: "rows" } },
    expects: substrate.batch
      ? null
      : {
          kind: "exactlyOneRow",
          failure: {
            kind: "query",
            message:
              "query-engine-v2 create terminal read expected exactly one row.",
            raceable: false,
          },
        },
    racePin: null,
    onUniqueConflict: null,
  };

  describe(`parity E — the CREATE root's absorbed shared key (${substrate.name})`, () => {
    test("the arm probe is one read publishing rows only", () => {
      const driver = substrate.createDriver();
      expect(fragmentContract(driver, absorbedCard(driver).planning())).toEqual(
        {
          steps: [
            {
              id: "account.find",
              kind: "read",
              sql: `SELECT "t0"."id" AS "id" FROM "parity_e_accounts" AS "t0" WHERE "t0"."id" = $1 LIMIT 1${lock}`,
              params: ["a1"],
              outputs: { rows: { kind: "rows" } },
              expects: null,
              racePin: null,
              onUniqueConflict: null,
            },
          ],
          outputs: { "account.find.rows": reference("account.find", "rows") },
        }
      );
    });

    test("the FOUND arm writes no target and keys the record by the where's literal", () => {
      const driver = substrate.createDriver();
      const operation = absorbedCard(driver);
      operation.planning();
      expect(
        fragmentContract(
          driver,
          operation.compile({ "account.find.rows": [{ id: "a1" }] })
        )
      ).toEqual({
        steps: [
          ...(substrate.batch
            ? [
                {
                  id: "account.guard.exists",
                  premise: {
                    kind: "exists",
                    sql: 'SELECT "t0"."id" AS "id" FROM "parity_e_accounts" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
                    params: ["a1"],
                  },
                  failure: {
                    kind: "nestedWrite",
                    message:
                      "Record was replaced by another transaction during nested connectOrCreate",
                    relation: "account",
                    raceable: false,
                  },
                },
              ]
            : []),
          CARD_INSERT,
          cardTerminal,
        ],
        outputs: { result: reference("card.select", "result") },
      });
    });

    test("the MISSING arm adds the target INSERT ahead of the record's, on the same key", () => {
      const driver = substrate.createDriver();
      const operation = absorbedCard(driver);
      operation.planning();
      expect(
        fragmentContract(driver, operation.compile({ "account.find.rows": [] }))
      ).toEqual({
        steps: [ACCOUNT_INSERT, CARD_INSERT, cardTerminal],
        outputs: { result: reference("card.select", "result") },
      });
    });
  });
}

describe("parity E — the NON-shared control fold at an update root", () => {
  test("a parent-held create folds its produced identity into the root UPDATE", () => {
    const driver = new PGliteDriver();
    const operation = new UpdateOperation(
      engineFor(driver),
      parityShared.widget as Model<any>,
      {
        where: { id: "w1" },
        data: { owner: { create: { id: "a9", email: "a9@x", name: "A9" } } },
        select: { id: true },
      }
    );
    const locateFailure = {
      kind: "notFound",
      message:
        "query-engine-v2 update located no 'widget' row for its unique where.",
      raceable: false,
    };
    expect(fragmentContract(driver, operation.planning())).toEqual({
      steps: [
        {
          id: "widget.locate",
          kind: "read",
          sql: 'SELECT "t0"."id" AS "id" FROM "parity_e_widgets" AS "t0" WHERE "t0"."id" = $1 LIMIT 1 FOR UPDATE',
          params: ["w1"],
          outputs: {
            rows: { kind: "rows" },
            id: { kind: "firstRowField", field: "id" },
          },
          expects: { kind: "exactlyOneRow", failure: locateFailure },
          racePin: null,
          onUniqueConflict: null,
        },
      ],
      outputs: {
        "widget.locate.rows": reference("widget.locate", "rows"),
        "widget.locate.id": reference("widget.locate", "id"),
      },
    });
    expect(
      fragmentContract(
        driver,
        operation.compile({ "widget.locate.rows": [{ id: "w1" }] })
      )
    ).toEqual({
      steps: [
        {
          id: "account.create",
          kind: "write",
          sql: 'INSERT INTO "parity_e_accounts" ("id", "email", "name") VALUES ($1, $2, $3)',
          params: ["a9", "a9@x", "A9"],
          outputs: {},
          expects: null,
          racePin: null,
          onUniqueConflict: null,
        },
        {
          // THE TARGET SHAPE. One UPDATE carries the edge's final value; there is no
          // second statement and no Part for the to-one target.
          id: "widget.update",
          kind: "write",
          sql: 'UPDATE "parity_e_widgets" SET "ownerId" = CAST($1 AS TEXT) WHERE "parity_e_widgets"."id" = $2 RETURNING "id" AS "id"',
          params: ["a9", "w1"],
          outputs: {},
          expects: {
            kind: "affectedRows",
            expected: 1,
            failure: locateFailure,
          },
          racePin: null,
          onUniqueConflict: null,
        },
        {
          id: "widget.select",
          kind: "read",
          sql: 'SELECT "t0"."id" AS "id" FROM "parity_e_widgets" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
          params: ["w1"],
          outputs: { result: { kind: "rows" } },
          expects: {
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
      outputs: { result: reference("widget.select", "result") },
    });
  });
});

describe("parity E — the two refusal surfaces, verbatim", () => {
  const clientOn = (): { client: any; driver: RecordingPGliteDriver } => {
    const driver = new RecordingPGliteDriver();
    const client = createClient({ schema: parityShared, driver }) as any;
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

  const fresh = { id: "a2", email: "a2@x", name: "A2" };

  test.each([
    ["create", { create: fresh }],
    [
      "connectOrCreate",
      { connectOrCreate: { where: { id: "a2" }, create: fresh } },
    ],
    ["upsert", { upsert: { create: fresh, update: { name: "A3" } } }],
  ])("UPDATE root — assertNotSharedPk refuses '%s' before any statement", async (kind, payload) => {
    const { client, driver } = clientOn();
    expect(
      await caught(() =>
        client.card.update({
          where: { accountId: "a1" },
          data: { account: payload },
          select: { accountId: true },
        })
      )
    ).toEqual({
      name: "UnsupportedOperationError",
      message: `query-engine-v2 update does not support a shared-primary-key ${kind} on relation 'account' (the foreign key 'accountId' is this record's primary key).`,
    });
    expect(driver.statements).toEqual([]);
  });

  test.each([
    // A lookup SUBQUERY resolves the foreign key, so no literal keys the record.
    [
      "a connect through a non-key unique",
      "connect",
      { connect: { email: "a1@x" } },
    ],
    // Two arms, two keys, no one identity — first the create arm disagreeing …
    [
      "a connectOrCreate whose arms name different rows",
      "connectOrCreate",
      {
        connectOrCreate: {
          where: { id: "a1" },
          create: { id: "elsewhere", email: "e@x", name: "E" },
        },
      },
    ],
    // … then the where arm naming the row through a non-key unique.
    [
      "a connectOrCreate located by a non-key unique",
      "connectOrCreate",
      {
        connectOrCreate: {
          where: { email: "a1@x" },
          create: { id: "a1", email: "a1@x", name: "A" },
        },
      },
    ],
  ])("CREATE root — assertSharedPkResolved keeps refusing %s before any statement", async (_label, kind, payload) => {
    const { client, driver } = clientOn();
    expect(
      await caught(() =>
        client.card.create({ data: { label: "L", account: payload } })
      )
    ).toEqual({
      name: "UnsupportedOperationError",
      message: `query-engine-v2 create does not support a shared-primary-key ${kind} on relation 'account' whose foreign key 'accountId' (this record's primary key) is not a compile-time literal.`,
    });
    expect(driver.statements).toEqual([]);
  });

  /** The two shared-primary-key kinds `assertNotSharedPk` never sees, because another
   *  owner answers first. E1 extends the parent-held fold these share, so a fold change
   *  that broke them would otherwise land with nothing red. */
  test("UPDATE root — a shared-primary-key connect is refused by the key-transition owner", async () => {
    const sharedConnect = {
      where: { accountId: "a1" },
      data: { account: { connect: { id: "a1" } } },
      select: { accountId: true },
    };
    const driver0 = new PGliteDriver();
    const operation = new UpdateOperation(
      engineFor(driver0),
      parityShared.card as Model<any>,
      sharedConnect
    );
    let thrown: unknown;
    let phase = "none";
    try {
      operation.planning();
      operation.compile({
        "card.locate.rows": [{ accountId: "a1" }],
        "account.find.rows": [{ id: "a1" }],
      });
    } catch (error) {
      thrown = error;
      phase = "planning-or-compile";
    }
    // A DIFFERENT owner, with a different sentence: the update's key-transition
    // derivation answers before `assertNotSharedPk` is consulted at all.
    expect({
      phase,
      name: (thrown as Error).constructor.name,
      message: (thrown as Error).message,
    }).toEqual({
      phase: "planning-or-compile",
      name: "QueryEngineError",
      message:
        "Cannot determine the updated primary key for model 'card' because field 'accountId' uses an unsupported operation.",
    });
    // Unlike the three `assertNotSharedPk` rows, this one refuses at COMPILE, so the
    // planning reads have already been issued — and only those.
    const { client, driver } = clientOn();
    await client.card.update(sharedConnect).then(
      () => undefined,
      () => undefined
    );
    expect(driver.statements).toEqual([
      'SELECT "t0"."accountId" AS "accountId" FROM "parity_e_cards" AS "t0" WHERE "t0"."accountId" = $1 LIMIT 1 FOR UPDATE',
    ]);
  });

  test("UPDATE root — a shared-primary-key disconnect is not a key on a required edge", async () => {
    const { client, driver } = clientOn();
    const message = await client.card
      .update({
        where: { accountId: "a1" },
        data: { account: { disconnect: true } },
        select: { accountId: true },
      })
      .then(
        () => undefined,
        (thrown: unknown) => (thrown as Error).message
      );
    expect(message).toBe(
      "Validation failed for update: Unknown key: disconnect"
    );
    expect(driver.statements).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The parent-held arms E1 joins, and the shared-key kind that already rides them
// ---------------------------------------------------------------------------

for (const substrate of [
  { name: "transaction", batch: false, createDriver: () => new PGliteDriver() },
  {
    name: "atomic batch",
    batch: true,
    createDriver: () => new BatchOnlyPGliteDriver(),
  },
]) {
  const lock = substrate.batch ? "" : " FOR UPDATE";

  const widgetNotFound = {
    kind: "notFound",
    message:
      "query-engine-v2 update located no 'widget' row for its unique where.",
    raceable: false,
  };
  const widgetTerminalFailure = {
    kind: "query",
    message: "query-engine-v2 update terminal read expected exactly one row.",
    raceable: false,
  };
  const WIDGET_GUARD = {
    id: "widget.guard.exists",
    premise: {
      kind: "exists",
      sql: 'SELECT "t0"."id" AS "id" FROM "parity_e_widgets" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
      params: ["w1"],
    },
    failure: widgetNotFound,
  };

  const widgetUpdate = (
    data: Record<string, unknown>,
    driver: PGliteDriver
  ): UpdateOperation =>
    new UpdateOperation(engineFor(driver), parityShared.widget as Model<any>, {
      where: { id: "w1" },
      data,
      select: { id: true },
    });

  const widgetTerminal = (key: string) => ({
    id: "widget.select",
    kind: "read",
    sql: 'SELECT "t0"."id" AS "id" FROM "parity_e_widgets" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
    params: [key],
    outputs: { result: { kind: "rows" } },
    expects: substrate.batch
      ? null
      : { kind: "exactlyOneRow", failure: widgetTerminalFailure },
    racePin: null,
    onUniqueConflict: null,
  });

  const ownerFold = {
    id: "widget.update",
    kind: "write",
    sql: 'UPDATE "parity_e_widgets" SET "ownerId" = CAST($1 AS TEXT) WHERE "parity_e_widgets"."id" = $2 RETURNING "id" AS "id"',
    params: ["a9", "w1"],
    outputs: {},
    expects: substrate.batch
      ? null
      : { kind: "affectedRows", expected: 1, failure: widgetNotFound },
    racePin: null,
    onUniqueConflict: null,
  };

  const ACCOUNT_A9_INSERT = {
    id: "account.create",
    kind: "write",
    sql: 'INSERT INTO "parity_e_accounts" ("id", "email", "name") VALUES ($1, $2, $3)',
    params: ["a9", "a9@x", "A9"],
    outputs: {},
    expects: null,
    racePin: {
      fields: ["id"],
      table: "parity_e_accounts",
      columns: ["id"],
      constraints: ["parity_e_accounts_pkey", "PRIMARY"],
    },
    onUniqueConflict: null,
  };

  describe(`parity E — the parent-held adopt arms (${substrate.name})`, () => {
    const COC = {
      owner: {
        connectOrCreate: {
          where: { id: "a9" },
          create: { id: "a9", email: "a9@x", name: "A9" },
        },
      },
    };

    const cocPlanning = {
      steps: [
        {
          id: "widget.locate",
          kind: "read",
          sql: `SELECT "t0"."id" AS "id" FROM "parity_e_widgets" AS "t0" WHERE "t0"."id" = $1 LIMIT 1${lock}`,
          params: ["w1"],
          outputs: {
            rows: { kind: "rows" },
            id: { kind: "firstRowField", field: "id" },
          },
          expects: { kind: "exactlyOneRow", failure: widgetNotFound },
          racePin: null,
          onUniqueConflict: null,
        },
        {
          id: "account.find",
          kind: "read",
          sql: `SELECT "t0"."id" AS "id" FROM "parity_e_accounts" AS "t0" WHERE "t0"."id" = $1 LIMIT 1${lock}`,
          params: ["a9"],
          outputs: { rows: { kind: "rows" } },
          expects: null,
          racePin: null,
          onUniqueConflict: null,
        },
      ],
      outputs: {
        "widget.locate.rows": reference("widget.locate", "rows"),
        "widget.locate.id": reference("widget.locate", "id"),
        "account.find.rows": reference("account.find", "rows"),
      },
    };

    test("connectOrCreate, FOUND: no target write, one root UPDATE, one re-assert", () => {
      const driver = substrate.createDriver();
      const operation = widgetUpdate(COC, driver);
      expect(fragmentContract(driver, operation.planning())).toEqual(
        cocPlanning
      );
      expect(
        fragmentContract(
          driver,
          operation.compile({
            "widget.locate.rows": [{ id: "w1" }],
            "account.find.rows": [{ id: "a9" }],
          })
        )
      ).toEqual({
        steps: [
          ...(substrate.batch
            ? [
                WIDGET_GUARD,
                {
                  id: "account.guard.exists",
                  premise: {
                    kind: "exists",
                    sql: 'SELECT "t0"."id" AS "id" FROM "parity_e_accounts" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
                    params: ["a9"],
                  },
                  failure: {
                    kind: "nestedWrite",
                    message:
                      "Record was replaced by another transaction during nested connectOrCreate",
                    relation: "owner",
                    raceable: false,
                  },
                },
              ]
            : []),
          ownerFold,
          widgetTerminal("w1"),
        ],
        outputs: { result: reference("widget.select", "result") },
      });
    });

    test("connectOrCreate, MISSING: the target INSERT carries the pin and leads", () => {
      const driver = substrate.createDriver();
      const operation = widgetUpdate(COC, driver);
      operation.planning();
      expect(
        fragmentContract(
          driver,
          operation.compile({
            "widget.locate.rows": [{ id: "w1" }],
            "account.find.rows": [],
          })
        )
      ).toEqual({
        steps: [
          ...(substrate.batch ? [WIDGET_GUARD] : []),
          ACCOUNT_A9_INSERT,
          ownerFold,
          widgetTerminal("w1"),
        ],
        outputs: { result: reference("widget.select", "result") },
      });
    });

    test("upsert, FOUND: the probe rides the located FK and the root writes nothing", () => {
      const driver = substrate.createDriver();
      const operation = widgetUpdate(
        {
          owner: {
            upsert: {
              create: { id: "a9", email: "a9@x", name: "A9" },
              update: { name: "A9b" },
            },
          },
        },
        driver
      );
      expect(fragmentContract(driver, operation.planning())).toEqual({
        steps: [
          {
            // The locate now projects the FK too: the upsert arm is decided from the
            // parent's own stored value, not from a payload selector.
            id: "widget.locate",
            kind: "read",
            sql: `SELECT "t0"."id" AS "id", "t0"."ownerId" AS "ownerId" FROM "parity_e_widgets" AS "t0" WHERE "t0"."id" = $1 LIMIT 1${lock}`,
            params: ["w1"],
            outputs: {
              rows: { kind: "rows" },
              id: { kind: "firstRowField", field: "id" },
              ownerId: { kind: "firstRowField", field: "ownerId" },
            },
            expects: { kind: "exactlyOneRow", failure: widgetNotFound },
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "account.find",
            kind: "read",
            sql: `SELECT "t0"."id" AS "id" FROM "parity_e_accounts" AS "t0" WHERE "t0"."id" = $1 ORDER BY "t0"."id" ASC LIMIT $2${lock}`,
            params: [reference("widget.locate", "ownerId"), 1],
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
          "widget.locate.rows": reference("widget.locate", "rows"),
          "widget.locate.id": reference("widget.locate", "id"),
          "widget.locate.ownerId": reference("widget.locate", "ownerId"),
          "account.find.rows": reference("account.find", "rows"),
          "account.find.id": reference("account.find", "id"),
        },
      });
      expect(
        fragmentContract(
          driver,
          operation.compile({
            "widget.locate.rows": [{ id: "w1", ownerId: "a9" }],
            "account.find.rows": [{ id: "a9" }],
          })
        )
      ).toEqual({
        steps: [
          ...(substrate.batch
            ? [
                WIDGET_GUARD,
                {
                  id: "account.guard.exists",
                  premise: {
                    kind: "exists",
                    sql: 'SELECT "t0"."id" AS "id" FROM "parity_e_accounts" AS "t0" WHERE ("t0"."id" = $1 AND "t0"."id" = $2) ORDER BY "t0"."id" ASC LIMIT $3',
                    params: ["a9", "a9", 1],
                  },
                  failure: {
                    kind: "nestedWrite",
                    message:
                      "Nested upsert premise changed for relation 'owner'.",
                    relation: "owner",
                    raceable: false,
                  },
                },
              ]
            : []),
          {
            id: "account.update",
            kind: "write",
            sql: 'UPDATE "parity_e_accounts" SET "name" = $1 WHERE "parity_e_accounts"."id" = $2 RETURNING "id" AS "id"',
            params: ["A9b", "a9"],
            outputs: {},
            expects: substrate.batch
              ? null
              : {
                  kind: "affectedRows",
                  expected: 1,
                  failure: {
                    kind: "notFound",
                    message:
                      "query-engine-v2 update located no 'account' row for its unique where.",
                    raceable: false,
                  },
                },
            racePin: null,
            onUniqueConflict: null,
          },
          widgetTerminal("w1"),
        ],
        outputs: { result: reference("widget.select", "result") },
      });
    });

    test("a root primary-key move beside a parent-held create: one UPDATE, POST-move terminal", () => {
      const driver = substrate.createDriver();
      const operation = widgetUpdate(
        {
          id: "w2",
          owner: { create: { id: "a9", email: "a9@x", name: "A9" } },
        },
        driver
      );
      operation.planning();
      expect(
        fragmentContract(
          driver,
          operation.compile({ "widget.locate.rows": [{ id: "w1" }] })
        )
      ).toEqual({
        steps: [
          ...(substrate.batch ? [WIDGET_GUARD] : []),
          { ...ACCOUNT_A9_INSERT, racePin: null },
          {
            // Both the moved key and the folded edge ride ONE SET, in that order.
            id: "widget.update",
            kind: "write",
            sql: 'UPDATE "parity_e_widgets" SET "id" = $1, "ownerId" = CAST($2 AS TEXT) WHERE "parity_e_widgets"."id" = $3 RETURNING "id" AS "id"',
            params: ["w2", "a9", "w1"],
            outputs: {},
            expects: substrate.batch
              ? null
              : { kind: "affectedRows", expected: 1, failure: widgetNotFound },
            racePin: null,
            onUniqueConflict: null,
          },
          // The terminal read follows the POST-transition identity.
          widgetTerminal("w2"),
        ],
        outputs: { result: reference("widget.select", "result") },
      });
    });
  });

  describe(`parity E — the shared key already flows through a target update (${substrate.name})`, () => {
    test("the target probe binds the record's own shared key, read from the locate", () => {
      const driver = substrate.createDriver();
      const operation = new UpdateOperation(
        engineFor(driver),
        parityShared.card as Model<any>,
        {
          where: { accountId: "a1" },
          data: { account: { update: { name: "X" } } },
          select: { accountId: true },
        }
      );
      const cardNotFound = {
        kind: "notFound",
        message:
          "query-engine-v2 update located no 'card' row for its unique where.",
        raceable: false,
      };
      const targetMissing = {
        kind: "nestedWrite",
        message:
          "Cannot update relation 'account': target record was not found for this parent.",
        relation: "account",
        raceable: false,
      };
      expect(fragmentContract(driver, operation.planning())).toEqual({
        steps: [
          {
            id: "card.locate",
            kind: "read",
            sql: `SELECT "t0"."accountId" AS "accountId" FROM "parity_e_cards" AS "t0" WHERE "t0"."accountId" = $1 LIMIT 1${lock}`,
            params: ["a1"],
            outputs: {
              rows: { kind: "rows" },
              accountId: { kind: "firstRowField", field: "accountId" },
            },
            expects: { kind: "exactlyOneRow", failure: cardNotFound },
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "account.find",
            kind: "read",
            sql: `SELECT "t0"."id" AS "id" FROM "parity_e_accounts" AS "t0" WHERE "t0"."id" = $1 ORDER BY "t0"."id" ASC LIMIT $2${lock}`,
            // One provenance: the record's primary key IS the edge's value.
            params: [reference("card.locate", "accountId"), 1],
            outputs: { rows: { kind: "rows" } },
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
        ],
        outputs: {
          "card.locate.rows": reference("card.locate", "rows"),
          "card.locate.accountId": reference("card.locate", "accountId"),
          "account.find.rows": reference("account.find", "rows"),
        },
      });
      expect(
        fragmentContract(
          driver,
          operation.compile({
            "card.locate.rows": [{ accountId: "a1" }],
            "account.find.rows": [{ id: "a1" }],
          })
        )
      ).toEqual({
        steps: [
          ...(substrate.batch
            ? [
                {
                  id: "card.guard.exists",
                  premise: {
                    kind: "exists",
                    sql: 'SELECT "t0"."accountId" AS "accountId" FROM "parity_e_cards" AS "t0" WHERE "t0"."accountId" = $1 LIMIT 1',
                    params: ["a1"],
                  },
                  failure: cardNotFound,
                },
                {
                  id: "account.guard.exists",
                  premise: {
                    kind: "exists",
                    sql: 'SELECT "t0"."id" AS "id" FROM "parity_e_accounts" AS "t0" WHERE ("t0"."id" = $1 AND "t0"."id" = $2) ORDER BY "t0"."id" ASC LIMIT $3',
                    params: ["a1", "a1", 1],
                  },
                  failure: targetMissing,
                },
              ]
            : []),
          {
            id: "account.update",
            kind: "write",
            sql: 'UPDATE "parity_e_accounts" SET "name" = $1 WHERE "parity_e_accounts"."id" = $2 RETURNING "id" AS "id"',
            params: ["X", "a1"],
            outputs: {},
            expects: substrate.batch
              ? null
              : {
                  kind: "affectedRows",
                  expected: 1,
                  failure: {
                    kind: "notFound",
                    message:
                      "query-engine-v2 update located no 'account' row for its unique where.",
                    raceable: false,
                  },
                },
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "card.select",
            kind: "read",
            sql: 'SELECT "t0"."accountId" AS "accountId" FROM "parity_e_cards" AS "t0" WHERE "t0"."accountId" = $1 LIMIT 1',
            params: ["a1"],
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
        outputs: { result: reference("card.select", "result") },
      });
    });
  });
}
