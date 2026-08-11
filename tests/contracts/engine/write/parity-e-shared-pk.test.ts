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
import { publishedOutputs } from "@tests/fixtures/planning-published";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

/**
 * PARITY WITNESS — Package E (§6 E, "Lift shared-primary-key update roots").
 *
 * E1 LANDED 2026-08-10. A shared primary key at a selected record — the foreign key of a
 * parent-held to-one edge IS that record's row key — is no longer a shape the update
 * refuses. It is what it means: a PRIMARY-KEY TRANSITION OF THE RECORD BEING UPDATED,
 * folded into the one root UPDATE, ordered by the machinery every other key transition
 * already rides, and returned by the terminal read at the key the record ENDS on.
 *
 * WHAT MOVED, stated as the five plan rules and where each is pinned below:
 *   1. "Fold the final value into the root UPDATE" — every lifted arm compiles to ONE
 *      `UPDATE parity_e_cards SET "accountId" = …`, and there is no shared-PK Part and no
 *      second statement addressed at the record (rule 2);
 *   3. "Preserve destination uniqueness checks" — the `connectOrCreate` MISSING arm's
 *      target INSERT still carries the destination pin, and nothing else acquires one;
 *   4. "Preserve root primary-key transition ordering" — a fold writes the record's own
 *      row key from a RELATION arm, so it appears in no scalar payload. The transition
 *      machinery is fed from the fold as well as from the SET
 *      (`RecordUpdateCompilerState.sharedKeyMembers`), and the sibling block below is the
 *      proof: the occupied probe reads the OLD key, the nested create writes the NEW one
 *      AFTER the root UPDATE, and an OCCUPIED old slot refuses — byte-for-byte the shape
 *      a scalar `accountId: "a2"` produces on the same payload;
 *   5. "Return the final identity in terminal results" — every lifted terminal addresses
 *      the POST-fold key, including the one that is a `Ref` to the target INSERT that
 *      produces it (Package F's channel, lowered exactly as the create root lowers it);
 *   6. "Reject only if the exact final value cannot be captured or derived" — ONE
 *      narrowed refusal survives, quoted verbatim below, and it is about an ARM THAT
 *      NAMES NO ONE VALUE, never about the shape.
 *
 * THE SPLIT THIS FILE USED TO PIN IS HALF GONE, and the surviving half is why the CREATE
 * root's blocks stay untouched: `CreateOperation.assertSharedPkResolved` still refuses a
 * fresh record whose shared key is not a compile-time literal, because a fresh record has
 * no captured identity to move — there is nothing there yet to transition. Its three
 * refusals are re-asserted verbatim below so a future edit cannot quietly widen them
 * while reading this file as permission.
 *
 * DIMENSIONS PINNED (plan §6 A2's nine): planning IDs and order, planning SQL and
 * parameters, planning outputs; final IDs and order, final SQL and parameters; guards and
 * expects (the batch root re-assert, the occupied `notExists` guard and its `raceable`
 * flag, the terminal's transaction-only `exactlyOneRow`); race pins; exact errors — five
 * narrowed UPDATE-root refusals, three CREATE-root ones, and the two refusals a shared key
 * inherits from OTHER owners (the parse boundary and the nullability owner); statement
 * counts, which the step list IS. Round trips equal steps on both substrates.
 *
 * KINDS, and who answers each (the E1 disposition table, all measured):
 *   · `create`, `connect`, `connectOrCreate` — LIFTED. Their final value is the literal
 *     the arm spells or the `Ref` the target's INSERT publishes;
 *   · `upsert` — LIFTED only where its two arms AGREE, which for a shared key means the
 *     created target carries the key the record already holds: the found arm never moves
 *     it (the probe correlates the target on that very column) and the missing arm would.
 *     Two arms naming two keys is exactly "no one final value";
 *   · `disconnect` / `delete` — NOT lifted, and not E's to lift: a row-key member is never
 *     nullable, so `assertRelationCanDisconnect` refuses on an OPTIONAL shared edge and the
 *     parse boundary refuses first on a required one. Both pinned;
 *   · a target `update` — untouched, and its block is unchanged: the shared key rides as a
 *     READ (the probe binds it off the locate) and the record writes nothing.
 *
 * FALSIFIED 2026-08-10 against `src/query-engine/write-engine/RecordUpdateCompiler.ts`,
 * three separate mutations, each restored from a scratchpad copy taken before the edit:
 *   · returning an EMPTY set from `resolveSharedKeyMembers` turned exactly 3 of 45 red —
 *     the sibling block on both substrates and the occupied refusal. The occupied probe
 *     vanished, the nested INSERT moved ahead of the root UPDATE and carried the
 *     PRE-transition key. Every other shape, terminal reads included, stayed green,
 *     which is why rule 4 needed its own channel and not the scalar SET's;
 *   · iterating an empty list instead of `sharedKeyFinal` in `updatedPrimaryKeyWhere`
 *     turned 12 of 45 red — every row whose key MOVES, each failing on its terminal
 *     step's parameter (`"a1"` where the record now lives at `"a2"`), the produced-key
 *     row on its `Ref` — while the `upsert` row that moves nothing, all eight refusal
 *     rows and both control folds stayed green. That is rule 5, and the red state is the
 *     create-root defect `shared-pk-connect-or-create-behavior.ts` records (a terminal
 *     addressing a key no row holds), reproduced at the update root;
 *   · replacing the `fkEquals` agreement conjuncts in `recordSharedKeyFold` with "take
 *     whichever arm answered" turned 3 of the 4 no-one-final-value rows GREEN — both
 *     `connectOrCreate` spellings and the `upsert` one all compiled, leaving the record
 *     keyed at whichever arm the probe happened to take — while the bare `connect`
 *     lookup row stayed refusing, since its `where` names no referenced column at all.
 *     That is the DISAGREEMENT coverage and the NO-VALUE coverage, separated by
 *     measurement rather than by assertion.
 *
 * CORRECTED AT THE PACKAGE E GATE, because the record above claimed more than it
 * measured: that third falsification was first written up as leaving the `connect` row
 * "refusing on the `isSql` branch". It does not — it refuses on `value === undefined`,
 * and re-measuring showed `isSql` had NO producer at all on any of the four resolvers
 * (`freshReferenced` answers `undefined` for an `Sql`; the others read a parsed `where`
 * or the operation's own pinned selector). The disjunct was deleted. `value === null`
 * was audited the same way and KEPT, because measurement found its producer — a
 * NULLABLE referenced unique named NULL — which now has the witness it lacked.
 */

const parityShared = (() => {
  const account = s
    .model({
      id: s.string().id(),
      email: s.string().unique(),
      name: s.string(),
      card: s.oneToOne(() => card).optional(),
      stub: s.oneToOne(() => stub).optional(),
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
      /** A CHILD-HELD sibling on the shared key: what the fold's transition must reach. */
      notes: s.oneToMany(() => note),
    })
    .map("parity_e_cards");
  const note = s
    .model({
      id: s.string().id(),
      cardId: s.string(),
      body: s.string(),
      card: s
        .manyToOne(() => card)
        .fields("cardId")
        .references("accountId"),
    })
    .map("parity_e_notes");
  /** The same shared key on an OPTIONAL edge — the only spelling `disconnect` reaches. */
  const stub = s
    .model({
      accountId: s.string().id(),
      memo: s.string(),
      account: s
        .oneToOne(() => account)
        .fields("accountId")
        .references("id")
        .optional(),
    })
    .map("parity_e_stubs");
  const desk = s
    .model({
      id: s.int().id().increment(),
      title: s.string(),
      ticket: s.oneToOne(() => ticket).optional(),
    })
    .map("parity_e_desks");
  /** A shared key whose final value the TARGET's own INSERT produces (Package F). */
  const ticket = s
    .model({
      deskId: s.int().id(),
      note: s.string(),
      desk: s
        .oneToOne(() => desk)
        .fields("deskId")
        .references("id"),
    })
    .map("parity_e_tickets");
  /**
   * A shared key whose REFERENCED column is a NULLABLE unique, kept on its own pair of
   * models so the fixture that produces one refusal cannot move any other row's bytes.
   */
  const holder = s
    .model({
      id: s.string().id(),
      handle: s.string().unique().nullable(),
      badge: s.oneToOne(() => badge).optional(),
    })
    .map("parity_e_holders");
  const badge = s
    .model({
      handle: s.string().id(),
      caption: s.string(),
      holder: s
        .oneToOne(() => holder)
        .fields("handle")
        .references("handle"),
    })
    .map("parity_e_badges");
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
  return { account, badge, card, holder, note, stub, desk, ticket, widget };
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
    outputs: normalized(publishedOutputs(fragment)),
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

  /**
   * THE ONE SURVIVING UPDATE-ROOT REFUSAL, and the four payload classes that reach it.
   * It is no longer about the SHAPE — every row here has a lifted twin in the byte pins
   * below, differing only in whether the arm names ONE key for the record to end on.
   * THREE coverages, one per disjunct, each with its own rows below and none sharing a
   * witness (the Package E gate deleted a fourth — an `isSql` branch with no producer:
   * `freshReferenced` answers `undefined` for an `Sql`, and every other resolver reads a
   * parsed `where` or the operation's own pinned selector):
   *   · the arm answers with NO VALUE (`undefined`) — a `where` that does not spell the
   *     referenced column, so the foreign key resolves through a correlated lookup
   *     SUBQUERY and no literal keys the record; or two arms naming different rows;
   *   · the arm answers `null` — a NULLABLE referenced unique named NULL, the row below
   *     that no other row reaches;
   *   · a root SET spells the same row-key member the arm folds, disagreeing.
   *
   * Every row asserts ZERO statements: the refusal is at CONSTRUCTION, so unlike the
   * pre-E1 `connect` — which was answered at COMPILE by `getUpdatedPrimaryKeyValue`'s
   * `Sql` branch, in a sentence about "an unsupported operation", AFTER the planning
   * locate had already been issued — nothing is asked of the database first.
   */
  test.each([
    // A lookup SUBQUERY resolves the foreign key, so no literal keys the record.
    ["connect", { connect: { email: "a2@x" } }],
    // … the same, spelled as the found arm of a connectOrCreate.
    [
      "connectOrCreate",
      {
        connectOrCreate: {
          where: { email: "a2@x" },
          create: fresh,
        },
      },
    ],
    // Two arms, two keys, no one identity.
    [
      "connectOrCreate",
      {
        connectOrCreate: {
          where: { id: "a2" },
          create: { id: "elsewhere", email: "e@x", name: "E" },
        },
      },
    ],
    // The found arm keeps 'a1' (the probe correlates on the record's own key); the
    // missing arm would move the record to 'a2'.
    ["upsert", { upsert: { create: fresh, update: { name: "A3" } } }],
  ])("UPDATE root — a shared-primary-key %s that names no one final value refuses before any statement", async (kind, payload) => {
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
      message: `query-engine-v2 update does not support a shared-primary-key ${kind} on relation 'account' whose foreign key 'accountId' (this record's primary key) does not resolve to one final value.`,
    });
    expect(driver.statements).toEqual([]);
  });

  /**
   * The `null` disjunct's OWN witness, and the reason it survived the gate's audit of
   * `recordSharedKeyFold` while the `isSql` one did not: nothing upstream refuses a NULL
   * here. The parse boundary admits NULL for a nullable unique, and each arm's not-found
   * premise is about the PROBE, not about this record's key — so without this disjunct a
   * NULL would be assigned to a row-key column and the terminal would go looking for it.
   */
  test("UPDATE root — a shared key whose `where` names a NULLABLE referenced unique NULL refuses before any statement", async () => {
    const { client, driver } = clientOn();
    expect(
      await caught(() =>
        client.badge.update({
          where: { handle: "h1" },
          data: { holder: { connect: { handle: null } } },
          select: { handle: true },
        })
      )
    ).toEqual({
      name: "UnsupportedOperationError",
      message:
        "query-engine-v2 update does not support a shared-primary-key connect on relation 'holder' whose foreign key 'handle' (this record's primary key) does not resolve to one final value.",
    });
    expect(driver.statements).toEqual([]);
  });

  test("UPDATE root — a root SET and a fold that disagree about the row key refuse; agreeing ones compile", async () => {
    const { client, driver } = clientOn();
    expect(
      await caught(() =>
        client.card.update({
          where: { accountId: "a1" },
          // Two writers, one column: the fold would win the SET by assignment order and
          // the scalar value would vanish without a word.
          data: { accountId: "a3", account: { create: fresh } },
          select: { accountId: true },
        })
      )
    ).toEqual({
      name: "UnsupportedOperationError",
      message:
        "query-engine-v2 update does not support a shared-primary-key create on relation 'account' whose foreign key 'accountId' (this record's primary key) does not resolve to one final value.",
    });
    expect(driver.statements).toEqual([]);
    // The same payload with the two writers AGREEING is not a contradiction, and
    // compiles: the operation reaches the driver instead of throwing at construction.
    const operation = new UpdateOperation(
      engineFor(new PGliteDriver()),
      parityShared.card as Model<any>,
      {
        where: { accountId: "a1" },
        data: { accountId: "a2", account: { create: fresh } },
        select: { accountId: true },
      }
    );
    operation.planning();
    expect(
      operation
        .compile({ "card.locate.rows": [{ accountId: "a1" }] })
        .steps.map((step) => step.id)
    ).toEqual(["account.create", "card.update", "card.select"]);
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

  /**
   * VACATING a shared key is not E1's to lift, and the reason is arithmetic rather than
   * architectural: a row-key member is never nullable, so "remove the membership" and
   * "keep the record addressable" cannot both hold. Two owners already say so, at two
   * different boundaries, and both are pinned because the lift moved the third kind out
   * from behind them and left these two as the whole vacate surface.
   */
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

  test.each([
    ["disconnect", { disconnect: true }],
    ["delete", { delete: true }],
  ])("UPDATE root — an OPTIONAL shared-primary-key edge answers '%s' at the nullability owner", async (_kind, payload) => {
    const { client, driver } = clientOn();
    const thrown = await client.stub
      .update({
        where: { accountId: "a1" },
        data: { account: payload },
        select: { accountId: true },
      })
      .then(
        () => undefined,
        (error: unknown) => error as Error
      );
    // `assertRelationCanDisconnect` (relation-nullability.ts), not E1's guard: the
    // question it answers is about the COLUMN, and a row-key member is never nullable.
    expect({
      name: thrown?.constructor.name,
      message: thrown?.message,
    }).toEqual({
      name: "NestedWriteError",
      message:
        "Cannot disconnect relation 'account' because foreign key field(s) accountId are required.",
    });
    expect(driver.statements).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE LIFT: a shared primary key folded into the root UPDATE, byte for byte
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
  const cardNotFound = {
    kind: "notFound",
    message:
      "query-engine-v2 update located no 'card' row for its unique where.",
    raceable: false,
  };
  const CARD_LOCATE = {
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
  };
  const CARD_GUARD = {
    id: "card.guard.exists",
    premise: {
      kind: "exists",
      sql: 'SELECT "t0"."accountId" AS "accountId" FROM "parity_e_cards" AS "t0" WHERE "t0"."accountId" = $1 LIMIT 1',
      params: ["a1"],
    },
    failure: cardNotFound,
  };
  /** THE FOLD. One SET, on the record's OWN row key, addressed by the located key. */
  const cardFold = (key: string) => ({
    id: "card.update",
    kind: "write",
    sql: 'UPDATE "parity_e_cards" SET "accountId" = CAST($1 AS TEXT) WHERE "parity_e_cards"."accountId" = $2 RETURNING "accountId" AS "accountId"',
    params: [key, "a1"],
    outputs: {},
    expects: substrate.batch
      ? null
      : { kind: "affectedRows", expected: 1, failure: cardNotFound },
    racePin: null,
    onUniqueConflict: null,
  });
  const cardTerminalAt = (key: string) => ({
    id: "card.select",
    kind: "read",
    sql: 'SELECT "t0"."accountId" AS "accountId" FROM "parity_e_cards" AS "t0" WHERE "t0"."accountId" = $1 LIMIT 1',
    params: [key],
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
  });
  const ACCOUNT_A2_INSERT = {
    id: "account.create",
    kind: "write",
    sql: 'INSERT INTO "parity_e_accounts" ("id", "email", "name") VALUES ($1, $2, $3)',
    params: ["a2", "a2@x", "A2"],
    outputs: {},
    expects: null,
    racePin: null,
    onUniqueConflict: null,
  };
  const cardUpdate = (
    data: Record<string, unknown>,
    driver: PGliteDriver
  ): UpdateOperation =>
    new UpdateOperation(engineFor(driver), parityShared.card as Model<any>, {
      where: { accountId: "a1" },
      data,
      select: { accountId: true },
    });

  describe(`parity E — the shared key folded into the root UPDATE (${substrate.name})`, () => {
    test("create: the target INSERT leads, ONE SET moves the record's own key, the terminal follows it", () => {
      const driver = substrate.createDriver();
      const operation = cardUpdate(
        { account: { create: { id: "a2", email: "a2@x", name: "A2" } } },
        driver
      );
      // The record's key is not read from a payload selector and not probed: an
      // unconditional create arm publishes it, so planning is the locate alone.
      expect(fragmentContract(driver, operation.planning())).toEqual({
        steps: [CARD_LOCATE],
        outputs: {
          "card.locate.rows": reference("card.locate", "rows"),
          "card.locate.accountId": reference("card.locate", "accountId"),
        },
      });
      expect(
        fragmentContract(
          driver,
          operation.compile({ "card.locate.rows": [{ accountId: "a1" }] })
        )
      ).toEqual({
        steps: [
          ...(substrate.batch ? [CARD_GUARD] : []),
          ACCOUNT_A2_INSERT,
          cardFold("a2"),
          cardTerminalAt("a2"),
        ],
        outputs: { result: reference("card.select", "result") },
      });
    });

    test("connect: no write but the fold, and the arm's own probe still decides not-found", () => {
      const driver = substrate.createDriver();
      const operation = cardUpdate(
        { account: { connect: { id: "a2" } } },
        driver
      );
      expect(fragmentContract(driver, operation.planning())).toEqual({
        steps: [
          CARD_LOCATE,
          {
            id: "account.find",
            kind: "read",
            sql: `SELECT "t0"."id" AS "id" FROM "parity_e_accounts" AS "t0" WHERE "t0"."id" = $1 LIMIT 1${lock}`,
            params: ["a2"],
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
            "account.find.rows": [{ id: "a2" }],
          })
        )
      ).toEqual({
        steps: [
          ...(substrate.batch
            ? [
                CARD_GUARD,
                {
                  id: "account.guard.exists",
                  premise: {
                    kind: "exists",
                    sql: 'SELECT "t0"."id" AS "id" FROM "parity_e_accounts" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
                    params: ["a2"],
                  },
                  failure: {
                    kind: "nestedWrite",
                    message:
                      "Cannot connect relation 'account': target record was not found.",
                    relation: "account",
                    raceable: false,
                  },
                },
              ]
            : []),
          cardFold("a2"),
          cardTerminalAt("a2"),
        ],
        outputs: { result: reference("card.select", "result") },
      });
    });

    const COC = {
      account: {
        connectOrCreate: {
          where: { id: "a2" },
          create: { id: "a2", email: "a2@x", name: "A2" },
        },
      },
    };

    test("connectOrCreate FOUND: one SET, no target write", () => {
      const driver = substrate.createDriver();
      const operation = cardUpdate(COC, driver);
      operation.planning();
      expect(
        fragmentContract(
          driver,
          operation.compile({
            "card.locate.rows": [{ accountId: "a1" }],
            "account.find.rows": [{ id: "a2" }],
          })
        )
      ).toEqual({
        steps: [
          ...(substrate.batch
            ? [
                CARD_GUARD,
                {
                  id: "account.guard.exists",
                  premise: {
                    kind: "exists",
                    sql: 'SELECT "t0"."id" AS "id" FROM "parity_e_accounts" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
                    params: ["a2"],
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
          cardFold("a2"),
          cardTerminalAt("a2"),
        ],
        outputs: { result: reference("card.select", "result") },
      });
    });

    test("connectOrCreate MISSING: the destination pin survives the lift", () => {
      const driver = substrate.createDriver();
      const operation = cardUpdate(COC, driver);
      operation.planning();
      expect(
        fragmentContract(
          driver,
          operation.compile({
            "card.locate.rows": [{ accountId: "a1" }],
            "account.find.rows": [],
          })
        )
      ).toEqual({
        steps: [
          ...(substrate.batch ? [CARD_GUARD] : []),
          {
            ...ACCOUNT_A2_INSERT,
            // E1 rule 3: "preserve destination uniqueness checks".
            racePin: {
              fields: ["id"],
              table: "parity_e_accounts",
              columns: ["id"],
              constraints: ["parity_e_accounts_pkey", "PRIMARY"],
            },
          },
          cardFold("a2"),
          cardTerminalAt("a2"),
        ],
        outputs: { result: reference("card.select", "result") },
      });
    });

    test("upsert FOUND: the arms agree on the key the record already holds, so nothing moves", () => {
      const driver = substrate.createDriver();
      const operation = cardUpdate(
        {
          account: {
            upsert: {
              create: { id: "a1", email: "a1@x", name: "A" },
              update: { name: "A1b" },
            },
          },
        },
        driver
      );
      expect(fragmentContract(driver, operation.planning())).toEqual({
        steps: [
          CARD_LOCATE,
          {
            // One provenance again: the arm's probe binds the record's own key.
            id: "account.find",
            kind: "read",
            sql: `SELECT "t0"."id" AS "id" FROM "parity_e_accounts" AS "t0" WHERE "t0"."id" = $1 ORDER BY "t0"."id" ASC LIMIT $2${lock}`,
            params: [reference("card.locate", "accountId"), 1],
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
          "card.locate.rows": reference("card.locate", "rows"),
          "card.locate.accountId": reference("card.locate", "accountId"),
          "account.find.rows": reference("account.find", "rows"),
          "account.find.id": reference("account.find", "id"),
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
                CARD_GUARD,
                {
                  id: "account.guard.exists",
                  premise: {
                    kind: "exists",
                    sql: 'SELECT "t0"."id" AS "id" FROM "parity_e_accounts" AS "t0" WHERE ("t0"."id" = $1 AND "t0"."id" = $2) ORDER BY "t0"."id" ASC LIMIT $3',
                    params: ["a1", "a1", 1],
                  },
                  failure: {
                    kind: "nestedWrite",
                    message:
                      "Nested upsert premise changed for relation 'account'.",
                    relation: "account",
                    raceable: false,
                  },
                },
              ]
            : []),
          {
            id: "account.update",
            kind: "write",
            sql: 'UPDATE "parity_e_accounts" SET "name" = $1 WHERE "parity_e_accounts"."id" = $2 RETURNING "id" AS "id"',
            params: ["A1b", "a1"],
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
          // No `card.update` at all, and the terminal stays on the key the record has.
          cardTerminalAt("a1"),
        ],
        outputs: { result: reference("card.select", "result") },
      });
    });

    /**
     * RULE 4, the one that is WORK rather than preservation. The fold writes a column no
     * scalar payload names, so a child-held edge on that column has to learn about the
     * move from the fold. Compare this plan with the scalar twin
     * (`data: { accountId: "a2", notes: { create } }`): same probe on the OLD key, same
     * guard, same after-root INSERT carrying the NEW key. Only the value's provenance
     * differs, and that is exactly what must not be visible here.
     */
    test("a child-held sibling on the shared key sees the fold as the transition it is", () => {
      const driver = substrate.createDriver();
      const operation = cardUpdate(
        {
          account: { create: { id: "a2", email: "a2@x", name: "A2" } },
          notes: { create: { id: "n1", body: "B" } },
        },
        driver
      );
      const OCCUPIED_FIND = {
        id: "note.transition.find",
        kind: "read",
        sql: `SELECT "t0"."id" AS "id" FROM "parity_e_notes" AS "t0" WHERE "t0"."cardId" = $1 ORDER BY "t0"."id" ASC LIMIT $2${lock}`,
        // The OLD key: the slot the transition is about to vacate.
        params: ["a1", 1],
        outputs: { rows: { kind: "rows" } },
        expects: null,
        racePin: null,
        onUniqueConflict: null,
      };
      expect(fragmentContract(driver, operation.planning())).toEqual({
        steps: [CARD_LOCATE, OCCUPIED_FIND],
        outputs: {
          "card.locate.rows": reference("card.locate", "rows"),
          "card.locate.accountId": reference("card.locate", "accountId"),
          "note.transition.find.rows": reference(
            "note.transition.find",
            "rows"
          ),
        },
      });
      expect(
        fragmentContract(
          driver,
          operation.compile({
            "card.locate.rows": [{ accountId: "a1" }],
            "note.transition.find.rows": [],
          })
        )
      ).toEqual({
        steps: [
          ...(substrate.batch
            ? [
                CARD_GUARD,
                {
                  id: "note.guard.occupied",
                  premise: {
                    kind: "notExists",
                    sql: 'SELECT "t0"."id" AS "id" FROM "parity_e_notes" AS "t0" WHERE "t0"."cardId" = $1 ORDER BY "t0"."id" ASC LIMIT $2',
                    params: ["a1", 1],
                  },
                  failure: {
                    kind: "nestedWrite",
                    message:
                      "Cannot update relation 'notes' with onUpdate('restrict') while the current relation is occupied.",
                    relation: "notes",
                    raceable: true,
                  },
                },
              ]
            : []),
          ACCOUNT_A2_INSERT,
          cardFold("a2"),
          {
            // AFTER the root UPDATE, on the POST-transition key: a NO-ACTION foreign key
            // does not cascade a fresh row onto an id the transition has not written yet.
            id: "note.create",
            kind: "write",
            sql: 'INSERT INTO "parity_e_notes" ("id", "cardId", "body") VALUES ($1, CAST($2 AS TEXT), $3)',
            params: ["n1", "a2", "B"],
            outputs: {},
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          cardTerminalAt("a2"),
        ],
        outputs: { result: reference("card.select", "result") },
      });
    });

    /**
     * RULE 5 at its hardest: the record's final key is not a value at all until the
     * target's INSERT runs. The SET and the terminal read spend the SAME reference, and
     * the substrate decides only how that INSERT reports it — `RETURNING "id"` with a
     * `firstRowField` output in transaction mode, a bare INSERT with `insertId`
     * otherwise. This is Package F's channel consumed, not re-implemented.
     */
    test("a PRODUCED shared key rides one reference into both the SET and the terminal", () => {
      const driver = substrate.createDriver();
      const operation = new UpdateOperation(
        engineFor(driver),
        parityShared.ticket as Model<any>,
        {
          where: { deskId: 1 },
          data: { desk: { create: { title: "T" } } },
          select: { deskId: true },
        }
      );
      const ticketNotFound = {
        kind: "notFound",
        message:
          "query-engine-v2 update located no 'ticket' row for its unique where.",
        raceable: false,
      };
      operation.planning();
      expect(
        fragmentContract(
          driver,
          operation.compile({ "ticket.locate.rows": [{ deskId: 1 }] })
        )
      ).toEqual({
        steps: [
          ...(substrate.batch
            ? [
                {
                  id: "ticket.guard.exists",
                  premise: {
                    kind: "exists",
                    sql: 'SELECT "t0"."deskId" AS "deskId" FROM "parity_e_tickets" AS "t0" WHERE "t0"."deskId" = $1 LIMIT 1',
                    params: [1],
                  },
                  failure: ticketNotFound,
                },
              ]
            : []),
          {
            id: "desk.create",
            kind: "write",
            sql: substrate.batch
              ? 'INSERT INTO "parity_e_desks" ("title") VALUES ($1)'
              : 'INSERT INTO "parity_e_desks" ("title") VALUES ($1) RETURNING "id" AS "id"',
            params: ["T"],
            outputs: substrate.batch
              ? { id: { kind: "insertId" } }
              : { id: { kind: "firstRowField", field: "id" } },
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "ticket.update",
            kind: "write",
            sql: 'UPDATE "parity_e_tickets" SET "deskId" = CAST($1 AS INTEGER) WHERE "parity_e_tickets"."deskId" = $2 RETURNING "deskId" AS "deskId"',
            params: [reference("desk.create", "id"), 1],
            outputs: {},
            expects: substrate.batch
              ? null
              : { kind: "affectedRows", expected: 1, failure: ticketNotFound },
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "ticket.select",
            kind: "read",
            // The SAME reference, lowered by the same caster.
            sql: 'SELECT "t0"."deskId" AS "deskId" FROM "parity_e_tickets" AS "t0" WHERE "t0"."deskId" = CAST($1 AS INTEGER) LIMIT 1',
            params: [reference("desk.create", "id")],
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
        outputs: { result: reference("ticket.select", "result") },
      });
    });
  });
}

describe("parity E — an OCCUPIED old slot refuses the fold, exactly as it refuses a scalar move", () => {
  test("transaction mode throws before any write", () => {
    const driver = new PGliteDriver();
    const operation = new UpdateOperation(
      engineFor(driver),
      parityShared.card as Model<any>,
      {
        where: { accountId: "a1" },
        data: {
          account: { create: { id: "a2", email: "a2@x", name: "A2" } },
          notes: { create: { id: "n1", body: "B" } },
        },
        select: { accountId: true },
      }
    );
    operation.planning();
    let thrown: Error | undefined;
    try {
      operation.compile({
        "card.locate.rows": [{ accountId: "a1" }],
        "note.transition.find.rows": [{ id: "old" }],
      });
    } catch (error) {
      thrown = error as Error;
    }
    expect({
      name: thrown?.constructor.name,
      message: thrown?.message,
    }).toEqual({
      name: "NestedWriteError",
      message:
        "Cannot update relation 'notes' with onUpdate('restrict') while the current relation is occupied.",
    });
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

    /**
     * The NON-shared upsert's MISSING arm, pinned by Package E because it was the one
     * parent-held shape with no before-picture at an update root and the lift reads
     * every arm of this family. It is also the family's one ORDERING outlier: unlike
     * `create` and `connectOrCreate`, which fold into the root UPDATE's SET, this arm
     * emits a SEPARATE `parent.fkset` UPDATE after it. On a NON-shared edge that is
     * invisible to the terminal (the row key does not move, so the read still addresses
     * `w1`), which is exactly why a shared key on this arm is accepted only when the
     * two arms agree and nothing moves.
     */
    test("upsert, MISSING: the target INSERT plus a dedicated parent-FK write, terminal unmoved", () => {
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
      operation.planning();
      expect(
        fragmentContract(
          driver,
          operation.compile({
            "widget.locate.rows": [{ id: "w1", ownerId: "a9" }],
            "account.find.rows": [],
          })
        )
      ).toEqual({
        steps: [
          ...(substrate.batch ? [WIDGET_GUARD] : []),
          // No race pin on this arm: its missing premise is the parent's own FK, not a
          // payload selector, so there is no destination unique to reassert.
          { ...ACCOUNT_A9_INSERT, racePin: null },
          {
            id: "parent.fkset",
            kind: "write",
            sql: 'UPDATE "parity_e_widgets" SET "ownerId" = CAST($1 AS TEXT) WHERE "parity_e_widgets"."id" = $2 RETURNING "id" AS "id"',
            params: ["a9", "w1"],
            outputs: {},
            expects: null,
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
