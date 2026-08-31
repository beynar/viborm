import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";

import { describe, expect, test } from "vitest";
import {
  locatedParentRefSchema,
  runLocatedParentRefBehavior,
} from "@tests/contracts/engine/write/located-parent-ref-behavior";

import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { openTestPGlite as openBorrowedPGlite } from "@tests/fixtures/pglite-lifecycle";


/**
 * Records every statement the operation sends, in order. The hook is the PROTECTED
 * `execute`/`executeRaw` seam rather than `_execute`, because a transaction runs its
 * statements through a transaction-bound driver that delegates back to exactly these two
 * methods — so one hook sees both substrates.
 */
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

/**
 * Rewrites the value of one column in the rows the LOCATE read returns, after the
 * database answered and before the engine consumes it: the deterministic corruption the
 * staleness harness needs for a value that crosses the planning/compile seam.
 * `mode: "wrong"` substitutes another live row's key (the worst case — a value that
 * exists, so no constraint catches it); `mode: "drop"` removes the column entirely (the
 * locate that forgot to select what a Ref promised).
 */
class CorruptLocatePGliteDriver extends PGliteDriver {
  private readonly table: string;
  private readonly column: string;
  private readonly mode: "wrong" | "drop";
  private readonly wrongValue: unknown;
  private armed = true;

  constructor(
    options: ConstructorParameters<typeof PGliteDriver>[0],
    config: {
      table: string;
      column: string;
      mode: "wrong" | "drop";
      wrongValue?: unknown;
    }
  ) {
    super(options);
    this.table = config.table;
    this.column = config.column;
    this.mode = config.mode;
    this.wrongValue = config.wrongValue;
  }

  protected override async execute<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const result = await super.execute<T>(client, sql, params, context);
    const isLocate =
      this.armed &&
      sql.startsWith("SELECT") &&
      sql.includes(this.table) &&
      result.rows.length > 0;
    if (!isLocate) return result;
    this.armed = false;
    return {
      ...result,
      rows: result.rows.map((row) => {
        const next = { ...(row as Record<string, unknown>) };
        if (this.mode === "drop") delete next[this.column];
        else next[this.column] = this.wrongValue;
        return next as T;
      }),
    };
  }
}

/** The executor's typed refusal when a declared `firstRowField` output is absent. */
const UNRESOLVED_REFERENCED_COLUMN = /did not produce row field 'code'/;

function makeClient(driver: PGliteDriver) {
  return createClient({ schema: locatedParentRefSchema, driver });
}

async function seed(client: ReturnType<typeof makeClient>): Promise<void> {
  await client.account.create({
    data: { id: 1, email: "decoy@x", code: "DECOY", label: "same" },
  });
  await client.account.create({
    data: { id: 2, email: "target@x", code: "TARGET", label: "same" },
  });
}

// The whole located-parent-Ref family on PGlite, both substrates (the driver-matrix
// legs live in tests/drivers/{sqlite3,mysql2,pg,libsql}.test.ts).
runLocatedParentRefBehavior({
  name: "PGlite transaction",
  pgliteMode: "transaction",
});
runLocatedParentRefBehavior({
  name: "PGlite atomic batch",
  pgliteMode: "atomicBatch",
});

/**
 * N1-U3 — the DUAL-SUBSTRATE ORACLE.
 *
 * The behavior suite asserts fixed expectations on each substrate independently. That
 * proves each is right; it does not prove they AGREE, and agreement is the claim the atom
 * makes: one compile path, the substrate is a resolve function (ATOM §7). The Ref is the
 * sharpest test of that claim, because it is the one value that crosses the
 * planning/compile seam — under a transaction the locate is a locked read inside the same
 * scope as the writes; under an atomic batch it runs BEFORE the unit, against committed
 * state, and the value is inlined into entries the driver ships together.
 *
 * So: identical payloads, a FRESH database per arm, comparing the returned result, the
 * whole persisted state, AND the error class + message when the payload fails. Anything
 * the batch side could not express would show up here as a divergence rather than as an
 * assumption — and nothing did, which is why no substrate-naming refusal was added.
 */
interface OracleScenario {
  readonly name: string;
  seed(client: ReturnType<typeof makeClient>): Promise<void>;
  act(client: ReturnType<typeof makeClient>): PromiseLike<unknown>;
}

interface ArmOutcome {
  readonly result?: unknown;
  readonly error?: { name: string; message: string };
  readonly state: Record<string, unknown[]>;
}

async function dumpState(
  client: ReturnType<typeof makeClient>
): Promise<Record<string, unknown[]>> {
  const [accounts, notes, attachments, tickets, owners, memos] =
    await Promise.all([
      client.account.findMany({ orderBy: { id: "asc" } }),
      client.note.findMany({ orderBy: { id: "asc" } }),
      client.attachment.findMany({ orderBy: { id: "asc" } }),
      client.ticket.findMany({ orderBy: { id: "asc" } }),
      client.owner.findMany({
        orderBy: [{ tenantId: "asc" }, { slot: "asc" }],
      }),
      client.memo.findMany({ orderBy: { id: "asc" } }),
    ]);
  return { accounts, notes, attachments, tickets, owners, memos };
}

async function runOracleArm(
  substrate: "tx" | "batch",
  scenario: OracleScenario
): Promise<ArmOutcome> {
  const db = openBorrowedPGlite();
  const stateClient = makeClient(new PGliteDriver({ client: db }));
  await syncLiveSchema(stateClient);
  await scenario.seed(stateClient);
  const opClient =
    substrate === "tx"
      ? stateClient
      : makeClient(new BatchOnlyPGliteDriver({ client: db }));
  let result: unknown;
  let error: { name: string; message: string } | undefined;
  try {
    try {
      result = await scenario.act(opClient);
    } catch (thrown) {
      if (!(thrown instanceof Error)) throw thrown;
      error = { name: thrown.constructor.name, message: thrown.message };
    }
    const state = await dumpState(stateClient);
    return error ? { error, state } : { result, state };
  } finally {
    // ONE disconnect for both arms, because there is one database: the batch arm's
    // second driver is constructed over the SAME `db`, and closing that instance
    // through either client closes it for both. Disconnecting the batch arm's client
    // as well was tried and MEASURED — the second close raises `ConnectionError:
    // Database disconnection failed`, and seven oracle scenarios fail. What was
    // actually missing is this `finally`: a `dumpState` that threw used to skip the
    // one disconnect and strand the PGlite instance for the rest of the run.
    await stateClient.$disconnect();
  }
}

const oracleScenarios: OracleScenario[] = [
  {
    name: "nested create by a non-PK unique",
    seed: (c) => seed(c),
    act: (c) =>
      c.account.update({
        where: { email: "target@x" },
        data: { notes: { create: { id: 1, body: "b" } } },
        select: { id: true, notes: { select: { id: true, accountId: true } } },
      }),
  },
  {
    name: "nested createMany by a non-PK unique",
    seed: (c) => seed(c),
    act: (c) =>
      c.account.update({
        where: { email: "target@x" },
        data: {
          notes: {
            createMany: {
              data: [
                { id: 1, body: "b" },
                { id: 2, body: "c" },
              ],
            },
          },
        },
        select: { id: true, notes: { select: { id: true, accountId: true } } },
      }),
  },
  {
    name: "a D4 referenced column plus a scalar SET",
    seed: (c) => seed(c),
    act: (c) =>
      c.account.update({
        where: { email: "target@x" },
        data: {
          label: "renamed",
          tickets: { create: { id: 1, subject: "s" } },
        },
        select: {
          id: true,
          label: true,
          tickets: { select: { id: true, accountCode: true } },
        },
      }),
  },
  {
    name: "a relation-carrying create subtree",
    seed: (c) => seed(c),
    act: (c) =>
      c.account.update({
        where: { email: "target@x" },
        data: {
          notes: {
            create: {
              id: 1,
              body: "subtree",
              attachments: { create: { id: 2, name: "a.txt" } },
            },
          },
        },
        select: { id: true },
      }),
  },
  {
    name: "a compound reference located by a unique naming neither member",
    seed: async (c) => {
      await c.owner.create({
        data: { tenantId: "t1", slot: "a", handle: "h-t1-a" },
      });
      await c.owner.create({
        data: { tenantId: "t1", slot: "b", handle: "h-t1-b" },
      });
    },
    act: (c) =>
      c.owner.update({
        where: { handle: "h-t1-b" },
        data: { memos: { create: { id: 1, text: "m" } } },
        select: { handle: true },
      }),
  },
  {
    name: "the located row does not exist",
    seed: (c) => seed(c),
    act: (c) =>
      c.account.update({
        where: { email: "absent@x" },
        data: { notes: { create: { id: 1, body: "never" } } },
        select: { id: true },
      }),
  },
  {
    name: "the created child collides on its own primary key",
    seed: async (c) => {
      await seed(c);
      await c.note.create({ data: { id: 1, body: "taken", accountId: 1 } });
    },
    act: (c) =>
      c.account.update({
        where: { email: "target@x" },
        data: { notes: { create: { id: 1, body: "dup" } } },
        select: { id: true },
      }),
  },
];

describe("located-parent Ref dual-substrate oracle (N1-U3)", () => {
  for (const scenario of oracleScenarios) {
    test(
      `${scenario.name}: transaction and atomic batch agree on result, state and error`,
      { timeout: 30_000 },
      async () => {
        const [tx, batch] = await Promise.all([
          runOracleArm("tx", scenario),
          runOracleArm("batch", scenario),
        ]);
        expect(batch).toEqual(tx);
      }
    );
  }
});

describe("located-parent Ref compiles the same plan as the pinned spelling", () => {
  for (const kind of ["create", "createMany"] as const) {
    test(
      `${kind}: the where:{email} spelling issues the same statement count and the same write SQL as where:{id}`,
      { timeout: 30_000 },
      async () => {
        const db = openBorrowedPGlite();
        const driver = new RecordingPGliteDriver({ client: db });
        const client = makeClient(driver);
        await syncLiveSchema(client);
        await seed(client);

        const payload = (noteId: number) =>
          kind === "create"
            ? { notes: { create: { id: noteId, body: "b" } } }
            : {
                notes: {
                  createMany: {
                    data: [
                      { id: noteId, body: "b" },
                      { id: noteId + 1, body: "c" },
                    ],
                  },
                },
              };

        driver.recording = true;
        await client.account.update({
          where: { id: 2 },
          data: payload(100),
        });
        const pinned = driver.statements.splice(0, driver.statements.length);
        await client.account.update({
          where: { email: "target@x" },
          data: payload(200),
        });
        const reffed = driver.statements.splice(0, driver.statements.length);
        driver.recording = false;

        // Same number of round-trips: the Ref adds no statement. The locate differs in
        // its WHERE (that IS the spelling) and in selecting the referenced column when
        // the discriminator is not it; every other statement is byte-identical modulo
        // the literal note ids the payloads chose.
        expect(reffed.length).toBe(pinned.length);
        const writes = (statements: string[]) =>
          statements.filter((sql) => sql.startsWith("INSERT"));
        expect(writes(reffed).map((sql) => sql.replace(/2\d\d/g, "#"))).toEqual(
          writes(pinned).map((sql) => sql.replace(/1\d\d/g, "#"))
        );
        expect(writes(reffed).length).toBeGreaterThan(0);

        await expect(
          client.note.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual(
          [100, 200]
            .flatMap((base) => (kind === "create" ? [base] : [base, base + 1]))
            .map((id) => ({
              id,
              body: id % 100 === 0 ? "b" : "c",
              accountId: 2,
            }))
        );
        await client.$disconnect();
      }
    );
  }
});

/**
 * The BATCH root address, spelled out statement by statement.
 *
 * On an atomic batch the located-parent update carries two statements that used to
 * re-consult the caller's `where` — the root-presence guard and the root UPDATE —
 * while every child edge addressed the CAPTURED row. A discriminator the `where`
 * does not fix to the primary key is reassignable, so those two could name a
 * different row than the children did.
 *
 * The two statements did NOT end up with the same rule, and the difference is what
 * this file pins:
 * - the root UPDATE always addresses the captured PK, whatever the `where` named.
 * - the guard conjoins the captured PK only when the `where` does NOT name it; a
 *   selector that pins the PK already answers the guard's question, and a second
 *   copy would be a duplicate conjunct (AGENTS.md: one guard per invariant).
 *
 * So the `where: { id }` arm is a genuine byte-compare — its five statements are
 * asserted verbatim and are identical to the pre-change plan — but for the UPDATE
 * that is a CONSEQUENCE, not an exemption: `buildPrimaryKeyWhereUnique` reproduces a
 * PK-only selector exactly (flat for a single PK, nested under the constraint name for
 * a compound one), so "address the capture" and "keep the `where`" emit the same
 * string. The `where: { email }` arm asserts the two statements that DO move, and only
 * those two. The compound-PK spelling of the same shape is certified behaviorally, on
 * both substrates and every driver leg, in `located-parent-ref-behavior.ts`
 * ("compound primary-key reference: both members come from the located row").
 *
 * Note what this file therefore CANNOT witness: an `if` at the write site that left a
 * PK-only `where` alone would keep every assertion here green. One existed and was
 * deleted for exactly that reason — a branch nothing can tell apart from its own
 * fall-through. What the address rule IS falsified by lives in
 * `staleness-injection.test.ts` ("batch root address"), where re-consulting the
 * selector mid-batch changes the row that gets written.
 */
describe("the batch root address, statement by statement", () => {
  class RecordingBatchOnlyPGliteDriver extends BatchOnlyPGliteDriver {
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

  // `ACCOUNTS` is the CORRELATION name and stays bare beside a qualified target;
  // `ACCOUNTS_TABLE` is the persistent identifier, which PostgreSQL always
  // qualifies. One constant cannot serve both positions.
  const ACCOUNTS = '"n1_ref_accounts"';
  const ACCOUNTS_TABLE = `"public".${ACCOUNTS}`;
  const PK_LOCATE = `SELECT "t0"."id" AS "id" FROM ${ACCOUNTS_TABLE} AS "t0" WHERE "t0"."id" = $1 LIMIT 1`;
  const TERMINAL = `SELECT "t0"."id" AS "id", "t0"."email" AS "email", "t0"."code" AS "code", "t0"."label" AS "label" FROM ${ACCOUNTS_TABLE} AS "t0" WHERE "t0"."id" = $1 LIMIT 1`;
  const NOTE_INSERT = `INSERT INTO "public"."n1_ref_notes" ("id", "body", "accountId") VALUES ($1, $2, CAST($3 AS INTEGER))`;

  test("where:{id} issues the pre-change batch, statement for statement", async () => {
    const db = openBorrowedPGlite();
    const driver = new RecordingBatchOnlyPGliteDriver({ client: db });
    const client = makeClient(driver);
    try {
      await syncLiveSchema(client);
      await seed(client);

      driver.recording = true;
      await client.account.update({
        where: { id: 2 },
        data: { label: "pinned", notes: { create: { id: 300, body: "b" } } },
      });
      driver.recording = false;

      expect(driver.statements).toEqual([
        // The locate, unchanged.
        PK_LOCATE,
        // The presence guard: still `findUnique(where)`. The captured PK would be the
        // same column with the same literal, and a duplicated conjunct is a second
        // guard on one invariant.
        `SELECT 1 / CASE WHEN EXISTS (${PK_LOCATE}) THEN 1 ELSE 0 END AS "__viborm_assert__"`,
        // The root UPDATE addresses the captured PK, as it always does. The statement is
        // unchanged because here the captured PK and the `where` are the same conjunct
        // with the same literal — which is also why the write site carries no branch for
        // this shape: there would be nothing to tell the two arms apart.
        `UPDATE ${ACCOUNTS_TABLE} SET "label" = $1 WHERE ${ACCOUNTS}."id" = $2 RETURNING "id" AS "id"`,
        NOTE_INSERT,
        TERMINAL,
      ]);
    } finally {
      await client.$disconnect();
    }
  });

  test("where:{email} moves exactly the guard and the root UPDATE onto the captured PK", async () => {
    const db = openBorrowedPGlite();
    const driver = new RecordingBatchOnlyPGliteDriver({ client: db });
    const client = makeClient(driver);
    try {
      await syncLiveSchema(client);
      await seed(client);

      driver.recording = true;
      await client.account.update({
        where: { email: "target@x" },
        data: { label: "reffed", notes: { create: { id: 400, body: "b" } } },
      });
      driver.recording = false;

      expect(driver.statements).toEqual([
        // The locate still asks the question the caller asked.
        `SELECT "t0"."id" AS "id" FROM ${ACCOUNTS_TABLE} AS "t0" WHERE "t0"."email" = $1 LIMIT 1`,
        // The guard is now the split-witness: the selector AND the row it located.
        // The tie-breaker carries no null placement (query-performance plan
        // Unit 5.1): `id` is NOT NULL, so `NULLS LAST` named nothing and cost
        // the index. The guard's meaning is unchanged.
        `SELECT 1 / CASE WHEN EXISTS (SELECT "t0"."id" AS "id" FROM ${ACCOUNTS_TABLE} AS "t0" WHERE ("t0"."email" = $1 AND "t0"."id" = $2) ORDER BY "t0"."id" ASC LIMIT $3) THEN 1 ELSE 0 END AS "__viborm_assert__"`,
        // The root UPDATE addresses the captured PK — the same row the note INSERT
        // below and the terminal read already address.
        `UPDATE ${ACCOUNTS_TABLE} SET "label" = $1 WHERE ${ACCOUNTS}."id" = $2 RETURNING "id" AS "id"`,
        NOTE_INSERT,
        TERMINAL,
      ]);
    } finally {
      await client.$disconnect();
    }
  });
});

/**
 * Staleness injection for the new Ref path (the harness convention of
 * `staleness-injection.test.ts`, one step deeper: that file corrupts committed STATE
 * between planning and the batch; this one corrupts the VALUE that crosses the
 * planning/compile seam, which is what a Ref actually is).
 */
describe("located-parent Ref staleness injection", () => {
  const setupDb = async () => {
    const db = openBorrowedPGlite();
    const stateClient = makeClient(new PGliteDriver({ client: db }));
    await syncLiveSchema(stateClient);
    await seed(stateClient);
    return { db, stateClient };
  };

  test(
    "the created foreign key follows the LOCATE's returned value, not the where",
    { timeout: 30_000 },
    async () => {
      const { db, stateClient } = await setupDb();
      // The corrupted locate hands back the DECOY's id — a value that EXISTS, so no
      // constraint can catch it. This is the PROVENANCE probe: if the create still
      // wrote `accountId: 2` it would be re-deriving the value from the `where` instead
      // of consuming the row the locate acted on, and the wrong-row doctrine would be
      // unenforced (that is precisely how the upsert create-arm bug W4 fixed arose).
      const client = makeClient(
        new CorruptLocatePGliteDriver(
          { client: db },
          {
            table: "n1_ref_accounts",
            column: "id",
            mode: "wrong",
            wrongValue: 1,
          }
        )
      );
      await client.account.update({
        where: { email: "target@x" },
        data: { notes: { create: { id: 300, body: "stale" } } },
      });
      await expect(
        stateClient.note.findUnique({ where: { id: 300 } })
      ).resolves.toEqual({ id: 300, body: "stale", accountId: 1 });
      await stateClient.$disconnect();
    }
  );

  test(
    "a locate value corrupted to a non-existent key fails closed with nothing persisted",
    { timeout: 30_000 },
    async () => {
      const { db, stateClient } = await setupDb();
      const client = makeClient(
        new CorruptLocatePGliteDriver(
          { client: db },
          {
            table: "n1_ref_accounts",
            column: "id",
            mode: "wrong",
            wrongValue: 999,
          }
        )
      );
      await expect(
        client.account.update({
          where: { email: "target@x" },
          data: { notes: { create: { id: 310, body: "orphan" } } },
        })
      ).rejects.toThrow();
      // The stale foreign key never landed: the whole atomic unit rolled back.
      await expect(stateClient.note.findMany()).resolves.toEqual([]);
      await stateClient.$disconnect();
    }
  );

  test(
    "one corrupted member of a COMPOUND reference moves the whole tuple",
    { timeout: 30_000 },
    async () => {
      const db = openBorrowedPGlite();
      const stateClient = makeClient(new PGliteDriver({ client: db }));
      await syncLiveSchema(stateClient);
      await stateClient.owner.create({
        data: { tenantId: "t1", slot: "a", handle: "h-t1-a" },
      });
      await stateClient.owner.create({
        data: { tenantId: "t1", slot: "b", handle: "h-t1-b" },
      });
      // Corrupt ONLY `slot`. `tenantId` is untouched, so a resolution that read
      // one member from the located row and the other from anywhere else would
      // still land on `t1/b`. Landing on `t1/a` is the proof that EVERY member
      // travels from the same located row.
      const client = makeClient(
        new CorruptLocatePGliteDriver(
          { client: db },
          {
            table: "n1_ref_owners",
            column: "slot",
            mode: "wrong",
            wrongValue: "a",
          }
        )
      );
      await client.owner.update({
        where: { handle: "h-t1-b" },
        data: { memos: { create: { id: 500, text: "compound provenance" } } },
      });
      await expect(
        stateClient.memo.findUnique({ where: { id: 500 } })
      ).resolves.toEqual({
        id: 500,
        text: "compound provenance",
        ownerTenant: "t1",
        ownerSlot: "a",
      });
      await stateClient.$disconnect();
    }
  );

  test(
    "a locate row that does not carry the referenced column fails closed at planning",
    { timeout: 30_000 },
    async () => {
      const { db, stateClient } = await setupDb();
      const client = makeClient(
        new CorruptLocatePGliteDriver(
          { client: db },
          { table: "n1_ref_accounts", column: "code", mode: "drop" }
        )
      );
      // Registering the referenced column in `locateFields` makes it a DECLARED
      // `firstRowField` output of the locate — which is what makes an absent value a
      // typed failure during planning (`extractOutput`), before any write, rather than
      // an `undefined` that would reach the INSERT as a NULL foreign key. This pins
      // that the Ref rides a declared output and not a raw row read.
      await expect(
        client.account.update({
          where: { email: "target@x" },
          data: { tickets: { create: { id: 400, subject: "no code" } } },
        })
      ).rejects.toThrow(UNRESOLVED_REFERENCED_COLUMN);
      await expect(stateClient.ticket.findMany()).resolves.toEqual([]);
      await stateClient.$disconnect();
    }
  );
});
