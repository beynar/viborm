import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { sql } from "@sql";
import { createSchemaRegistry } from "@validation";
import type { Database as SQLite3Database } from "better-sqlite3";
import Database from "better-sqlite3";
import { beforeAll, describe, expect, test } from "vitest";
import { UpsertOperation } from "@src/query-engine/write-engine/UpsertOperation";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";

/**
 * PHASE 7 / Decision 7.1 — the scalar-upsert ON CONFLICT door (query-performance-plan).
 *
 * A top-level scalar upsert sent four or five round trips: BEGIN, a locate
 * SELECT, the INSERT or the UPDATE, a terminal SELECT on the create path, COMMIT.
 * ATOM §4 permits `INSERT … ON CONFLICT (target) DO UPDATE` for exactly this
 * shape and calls it a NARROW DOOR that needs a written disposition against the
 * oracle. The maintainer took the door on 2026-08-02.
 *
 * This file is the disposition's evidence. It has four jobs:
 *
 * 1. **the traffic** — the folded shape is ONE statement, on both arms and both
 *    substrates;
 * 2. **the oracle** — the folded answer and the persisted state are IDENTICAL to
 *    what the probe path answers for the same payload on the same seeded state.
 *    The two paths are driven off the SAME gate conjunct
 *    (`supportsTargetedUpsert`), so "the old path" here is the real old path;
 * 3. **the accepted divergence** — the sequence burn, MEASURED rather than
 *    asserted away, so a future reader sees the number and not a claim;
 * 4. **the gate's exclusions** — each one keeps its own statement count and its
 *    own contract, and each conjunct is falsified by a case that fails when the
 *    conjunct is removed.
 */

const account = s
  .model({
    id: s.int().id().increment(),
    email: s.string().unique(),
    handle: s.string().unique(),
    label: s.string(),
    score: s.int(),
    notes: s.toMany(() => note),
  })
  .map("p71_accounts");

const note = s
  .model({
    id: s.int().id(),
    body: s.string(),
    accountId: s.int().nullable(),
    account: s
      .toOne(() => account)
      .fields("accountId")
      .references("id"),
  })
  .map("p71_notes");

/**
 * A model whose only alternate constraint is COMPOUND — the control for conjunct
 * 5. One constraint spelled with two columns is a real index, so it folds; the
 * conjunct counts the discriminator's own KEYS, not the columns they expand to.
 */
const ledger = s
  .model({
    id: s.int().id().increment(),
    org: s.string(),
    slot: s.int(),
    label: s.string(),
  })
  .unique(["org", "slot"])
  .map("p71_ledgers");

const schema = { account, note, ledger };

beforeAll(() => {
  hydrateSchemaNames(schema);
});

const getFamily = usePGliteSchemaFamily(schema);

/** Records every statement the operation sends, in order — the same protected
 *  `execute`/`executeRaw` seam the Phase 3 fold witnesses hook, so one hook sees
 *  the transaction substrate and the batch substrate alike. */
class RecordingPGliteDriver extends PGliteDriver {
  readonly statements: string[] = [];
  recording = false;

  protected override execute<T>(
    client: PGlite | Transaction,
    text: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(text);
    return super.execute<T>(client, text, params, context);
  }

  protected override executeRaw<T>(
    client: PGlite | Transaction,
    text: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(text);
    return super.executeRaw<T>(client, text, params, context);
  }
}

class BatchOnlyRecordingDriver extends RecordingPGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (transaction) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(
          await this.executeRaw<T>(transaction, query.sql, query.params)
        );
      }
      return results;
    });
  }
}

async function boot(batch = false) {
  const family = getFamily();
  await family.reset();
  const driver = batch
    ? new BatchOnlyRecordingDriver({ client: family.database })
    : new RecordingPGliteDriver({ client: family.database });
  const client = createClient({ schema, driver });
  await client.account.create({
    data: { id: 1, email: "a1@x", handle: "h1", label: "L1", score: 10 },
  });
  await client.account.create({
    data: { id: 2, email: "a2@x", handle: "h2", label: "L2", score: 20 },
  });
  await client.ledger.create({
    data: { id: 1, org: "o1", slot: 1, label: "LG1" },
  });
  return { client, driver };
}

function drain(driver: { statements: string[] }): string[] {
  return driver.statements.splice(0, driver.statements.length);
}

/**
 * Close the ON CONFLICT door on this driver's adapter, leaving the probe-first
 * sequence — the OLD path. The lever is the gate's own arbiter conjunct, so
 * "old" here means literally what shipped before Decision 7.1, not a re-creation
 * of it.
 */
function closeTheDoor(driver: {
  adapter: { capabilities: { supportsTargetedUpsert: boolean } };
}): void {
  driver.adapter.capabilities.supportsTargetedUpsert = false;
}

/**
 * A SQLite driver that calls {@link RaceRecordingSQLiteDriver.onWindow} exactly
 * once, in the window between the operation's DECISION and its WRITE: right
 * after the first statement that reads the target table, or — when there is no
 * such statement, which is the whole point of the fold — right before the first
 * write. Both moments have no transaction open on this connection, so the
 * competitor's independent connection is not merely blocked.
 */
class RaceRecordingSQLiteDriver extends SQLite3Driver {
  readonly statements: string[] = [];
  recording = false;
  onWindow: (() => void) | undefined;
  // The BATCH substrate, so the probe path's planning locate runs OUTSIDE the
  // atomic unit. On the transaction substrate the locate holds a SHARED lock for
  // the rest of the operation and the competitor's commit would simply be
  // blocked — which would demonstrate SQLite's locking, not this fold.
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  private fire(): void {
    const hook = this.onWindow;
    this.onWindow = undefined;
    hook?.();
  }

  /** Both seams, because a parameterized statement goes through `execute` and
   *  the batch's own statements through `executeRaw`. */
  private around<T>(
    text: string,
    run: () => Promise<QueryResult<T>>
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(text);
    if (this.onWindow && text.includes("INSERT INTO")) this.fire();
    return run().then((result) => {
      if (
        this.onWindow &&
        text.startsWith("SELECT") &&
        text.includes("p71_accounts")
      ) {
        this.fire();
      }
      return result;
    });
  }

  protected override execute<T>(
    client: SQLite3Database,
    text: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    return this.around(text, () => super.execute<T>(client, text, params));
  }

  protected override executeRaw<T>(
    client: SQLite3Database,
    text: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    return this.around(text, () => super.executeRaw<T>(client, text, params));
  }
}

// ---------------------------------------------------------------------------
// 1. THE TRAFFIC
// ---------------------------------------------------------------------------

describe("the ON CONFLICT fold — statement traffic", () => {
  test("the CREATE arm is ONE statement (was 3, in a transaction: 5 round trips)", async () => {
    const { driver, client } = await boot();

    driver.recording = true;
    const created = await client.account.upsert({
      where: { id: 10 },
      create: { id: 10, email: "n10@x", handle: "h10", label: "N10", score: 1 },
      update: { label: "U10" },
    });
    const statements = drain(driver);
    driver.recording = false;

    // THE measurement. Three payload statements (locate FOR UPDATE, INSERT,
    // terminal SELECT) inside BEGIN/COMMIT became one statement with no
    // envelope: empty planning routes the operation through the executor's
    // statement-atomic path.
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("INSERT INTO");
    expect(statements[0]).toContain("ON CONFLICT");
    expect(statements[0]).toContain("DO UPDATE");
    expect(statements[0]).toContain("RETURNING");

    expect(created).toEqual({
      id: 10,
      email: "n10@x",
      handle: "h10",
      label: "N10",
      score: 1,
    });
  });

  test("the UPDATE arm is ONE statement (was 2, in a transaction: 4 round trips)", async () => {
    const { driver, client } = await boot();

    driver.recording = true;
    const updated = await client.account.upsert({
      where: { id: 1 },
      create: { id: 1, email: "a1@x", handle: "h1", label: "NEW", score: 99 },
      update: { label: "UPD" },
    });
    const statements = drain(driver);
    driver.recording = false;

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("ON CONFLICT");
    // The row already existed, so the DO UPDATE arm ran: the `label` is the
    // UPDATE payload's, and every other column is the pre-existing row's — the
    // INSERT's `VALUES` half was discarded, exactly as the probe path discards it
    // by never running an INSERT at all.
    expect(updated).toEqual({
      id: 1,
      email: "a1@x",
      handle: "h1",
      label: "UPD",
      score: 10,
    });
  });

  test("the batch substrate folds to ONE statement too, on both arms", async () => {
    const { driver, client } = await boot(true);

    driver.recording = true;
    await client.account.upsert({
      where: { id: 11 },
      create: { id: 11, email: "n11@x", handle: "h11", label: "N11", score: 1 },
      update: { label: "U11" },
    });
    const createArm = drain(driver);
    await client.account.upsert({
      where: { id: 11 },
      create: { id: 11, email: "n11@x", handle: "h11", label: "N11", score: 1 },
      update: { label: "U11-again" },
    });
    const updateArm = drain(driver);
    driver.recording = false;

    // Was 3 on each arm. The batch substrate's presence guard is gone with the
    // premise it pinned: there is no window between a locate and a write to pin.
    expect(createArm).toHaveLength(1);
    expect(updateArm).toHaveLength(1);
    expect(createArm[0]).toContain("ON CONFLICT");
    expect(updateArm[0]).toContain("ON CONFLICT");
  });

  test("an ALTERNATE unique is the conflict target when the `where` names it", async () => {
    const { driver, client } = await boot();

    driver.recording = true;
    const result = await client.account.upsert({
      where: { email: "a2@x" },
      create: { email: "a2@x", handle: "hZ", label: "NEW", score: 0 },
      update: { label: "BY-EMAIL" },
      select: { id: true, label: true },
    });
    const statements = drain(driver);
    driver.recording = false;

    expect(statements).toHaveLength(1);
    // The arbiter is the unique the CALLER named, not the primary key.
    expect(statements[0]).toContain('ON CONFLICT ("email")');
    expect(result).toEqual({ id: 2, label: "BY-EMAIL" });
  });

  test("the folded fragment has EMPTY planning and exactly one step", () => {
    const engine = new QueryEngine(
      new PGliteDriver(),
      createModelRegistry(schema, createSchemaRegistry(schema))
    );
    const operation = new UpsertOperation(engine, schema.account, {
      where: { id: 1 },
      create: { id: 1, email: "e@x", handle: "h@x", label: "L", score: 1 },
      update: { label: "U" },
    });

    // The structural claim behind every round-trip number above, and behind the
    // race disposition: nothing is asked before the write, so there is no window
    // between a decision and the write that acts on it.
    expect(operation.planning().steps).toHaveLength(0);
    const fragment = operation.compile({});
    expect(fragment.steps).toHaveLength(1);
    const [step] = fragment.steps;
    expect(step?.kind).toBe("write");
    // A racePin would be a claim that a probe proved a premise this write
    // depends on. No probe ran, and none is needed: ON CONFLICT decides in the
    // database. The executor's statement-atomic path also refuses a step that
    // carries one, so this is what keeps the single round trip.
    expect(
      step && "racePin" in step ? step.racePin : undefined
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. THE DUAL-RUN ORACLE
// ---------------------------------------------------------------------------

/**
 * Run one payload twice from the SAME seeded state — once with the door open
 * (folded) and once with it closed (probe-first) — and return both answers, both
 * persisted states and both statement counts.
 */
async function dualRun(
  payload: Record<string, unknown>,
  seed?: (client: any) => Promise<void>
) {
  const run = async (folded: boolean) => {
    const { driver, client } = await boot();
    if (!folded) closeTheDoor(driver);
    await seed?.(client);
    driver.recording = true;
    let answer: unknown;
    let error: unknown;
    try {
      answer = await client.account.upsert(payload as any);
    } catch (caught) {
      error = caught;
    }
    const statements = drain(driver);
    driver.recording = false;
    const rows = await client.account.findMany({ orderBy: { id: "asc" } });
    return { answer, error, statements, rows };
  };
  return { folded: await run(true), probeFirst: await run(false) };
}

/** The comparable shape of a thrown error: class, code and the attribution meta
 *  a caller can branch on. `correlationId` is per-run and is dropped. */
function errorShape(error: unknown): unknown {
  if (error === undefined) return undefined;
  const err = error as {
    constructor: { name: string };
    message: string;
    code?: string;
    meta?: Record<string, unknown>;
  };
  const { correlationId: _drop, ...meta } = err.meta ?? {};
  return {
    class: err.constructor.name,
    message: err.message,
    code: err.code,
    meta,
  };
}

describe("the ON CONFLICT fold — the dual-run oracle", () => {
  const cases: {
    name: string;
    payload: Record<string, unknown>;
    seed?: (client: any) => Promise<void>;
  }[] = [
    {
      name: "create arm, literal primary key",
      payload: {
        where: { id: 50 },
        create: {
          id: 50,
          email: "n50@x",
          handle: "h50",
          label: "N50",
          score: 5,
        },
        update: { label: "U50" },
      },
    },
    {
      name: "update arm, literal primary key",
      payload: {
        where: { id: 1 },
        create: { id: 1, email: "a1@x", handle: "h1", label: "NEW", score: 99 },
        update: { label: "UPD", score: 77 },
      },
    },
    {
      name: "create arm by an alternate unique, generated primary key",
      payload: {
        where: { email: "fresh@x" },
        create: { email: "fresh@x", handle: "hf", label: "F", score: 3 },
        update: { label: "UF" },
      },
    },
    {
      name: "update arm by an alternate unique",
      payload: {
        where: { email: "a2@x" },
        create: { email: "a2@x", handle: "hZ", label: "NEW", score: 0 },
        update: { label: "BY-EMAIL" },
      },
    },
    {
      name: "a narrow `select` narrows what comes back",
      payload: {
        where: { id: 1 },
        create: { id: 1, email: "a1@x", handle: "h1", label: "N", score: 0 },
        update: { label: "SEL" },
        select: { label: true, score: true },
      },
    },
    {
      name: "`omit` desugars to the same projection on both paths",
      payload: {
        where: { id: 1 },
        create: { id: 1, email: "a1@x", handle: "h1", label: "N", score: 0 },
        update: { label: "OMIT" },
        omit: { handle: true },
      },
    },
    {
      name: "setting a null",
      payload: {
        where: { id: 60 },
        create: {
          id: 60,
          email: "n60@x",
          handle: "h60",
          label: "N60",
          score: 6,
        },
        update: { label: "U60" },
      },
    },
    {
      name: "UNRELATED unique collision on the create arm",
      payload: {
        where: { id: 70 },
        // `where` names an absent row, so both paths take the create arm — but
        // the create data's `email` belongs to the existing row 1. The plan calls
        // this the unrelated-collision case, and it is the one the MySQL grammar
        // would break. On a targeted-conflict dialect the arbiter is `id`, the
        // `email` index is not the arbiter, and the violation is raised as itself.
        create: {
          id: 70,
          email: "a1@x",
          handle: "h70",
          label: "N70",
          score: 7,
        },
        update: { label: "U70" },
      },
    },
    {
      name: "UNRELATED unique collision produced by the UPDATE payload",
      payload: {
        where: { id: 1 },
        create: { id: 1, email: "a1@x", handle: "h1", label: "N", score: 0 },
        // The DO UPDATE moves `handle` onto row 2's handle. Probe-first runs the
        // identical UPDATE, so both must fail the same way.
        update: { handle: "h2" },
      },
    },
    {
      name: "the create half carries a collision the UPDATE arm discards",
      payload: {
        where: { id: 1 },
        // Row 1 exists so the update arm is taken. The INSERT's `VALUES` half
        // proposes row 2's email — probe-first never runs an INSERT at all, and
        // the fold's speculative insertion is rolled back into the DO UPDATE, so
        // neither path raises. Measured, not assumed.
        create: { id: 1, email: "a2@x", handle: "hQ", label: "N", score: 0 },
        update: { label: "DISCARDED" },
      },
    },
  ];

  for (const { name, payload, seed } of cases) {
    test(`${name} — folded === probe-first`, async () => {
      const { folded, probeFirst } = await dualRun(payload, seed);

      // The answer the caller gets.
      expect(errorShape(folded.error)).toEqual(errorShape(probeFirst.error));
      expect(folded.answer).toEqual(probeFirst.answer);
      // The state the database is left in.
      expect(folded.rows).toEqual(probeFirst.rows);
      // And the reason this phase exists: strictly fewer statements, never more.
      expect(folded.statements.length).toBeLessThanOrEqual(
        probeFirst.statements.length
      );
    });
  }

  test("the oracle's lever really does select the two paths", async () => {
    // A meta-check: without it every equality above could be two runs of the
    // same path agreeing with itself.
    const { folded, probeFirst } = await dualRun({
      where: { id: 1 },
      create: { id: 1, email: "a1@x", handle: "h1", label: "N", score: 0 },
      update: { label: "LEVER" },
    });
    expect(folded.statements).toHaveLength(1);
    expect(folded.statements[0]).toContain("ON CONFLICT");
    expect(probeFirst.statements.length).toBeGreaterThan(1);
    expect(probeFirst.statements.join("\n")).not.toContain("ON CONFLICT");
  });
});

// ---------------------------------------------------------------------------
// 3. THE ACCEPTED DIVERGENCES — measured, and pinned here so they stay measured
// ---------------------------------------------------------------------------

describe("the ON CONFLICT fold — the accepted divergences", () => {
  test("DIVERGENCE 1: the update arm BURNS one sequence value the probe path did not", async () => {
    const burn = async (folded: boolean) => {
      const family = getFamily();
      await family.reset();
      const driver = new RecordingPGliteDriver({ client: family.database });
      if (!folded) closeTheDoor(driver);
      // A seed with NO literal primary keys, so the sequence and the rows agree.
      const client = createClient({ schema, driver });
      await client.account.create({
        data: { email: "a1@x", handle: "h1", label: "L1", score: 10 },
      });
      // Let the database assign an identity so the sequence has a known position.
      const before = await client.account.create({
        data: { email: "s1@x", handle: "sq1", label: "S1", score: 0 },
      });
      // An UPDATE-path upsert whose create data OMITS the generated primary key.
      // The folded statement still evaluates the INSERT's defaults — including
      // `nextval` — before it detects the conflict and switches to DO UPDATE.
      await client.account.upsert({
        where: { email: "a1@x" },
        create: { email: "a1@x", handle: "never", label: "NEVER", score: 0 },
        update: { label: "BURNED" },
      });
      const after = await client.account.create({
        data: { email: "s2@x", handle: "sq2", label: "S2", score: 0 },
      });
      return (after as { id: number }).id - (before as { id: number }).id;
    };

    // THE measured divergence. Probe-first runs no INSERT on the update path, so
    // the next identity is the previous one plus one. The fold consumes one extra.
    expect(await burn(false)).toBe(1);
    expect(await burn(true)).toBe(2);

    // What does NOT diverge: the answer and the state. A sequence is documented
    // as non-gap-free on both PostgreSQL and SQLite, and ATOM §4 names this burn
    // as the divergence the door's written disposition covers.
  });

  test("DIVERGENCE 2: the create arm no longer needs — or takes — a race retry", async () => {
    /**
     * A deterministic approximation of the concurrent-insert race. A competitor
     * commits the very key the operation is about to write, in the window between
     * the operation's DECISION and its WRITE.
     *
     * The injection point is the same rule on both paths: immediately after the
     * first statement that reads the target table, and otherwise immediately
     * before the first write. On the probe path (batch substrate) the planning
     * locate runs outside the atomic unit, so that is a real, uncommitted-nothing
     * window. On the folded path there is no read at all and no envelope, so the
     * competitor lands right before the single statement. Both injections happen
     * with no transaction bound, which is what makes them a race rather than a
     * self-deadlock.
     */
    const raced = async (folded: boolean) => {
      // A file-backed SQLite database so the competitor gets its OWN connection.
      // (An in-process PGlite cannot be raced against itself: re-entering the
      // driver from inside a statement deadlocks its serialization queue, which
      // would be an artefact of the harness rather than a property of the code.)
      const file = join(
        mkdtempSync(join(tmpdir(), "p71-race-")),
        "race.sqlite"
      );
      const driver = new RaceRecordingSQLiteDriver({ dataDir: file });
      if (!folded) closeTheDoor(driver);
      const client = createClient({ schema, driver });
      await push(client, { force: true });

      const competitor = new Database(file);
      driver.onWindow = () => {
        // The competitor commits the very key the operation is about to write.
        competitor
          .prepare(
            'INSERT INTO "p71_accounts" ("id","email","handle","label","score") VALUES (80, ?, ?, ?, 0)'
          )
          .run("rival@x", "rival", "RIVAL");
      };

      driver.recording = true;
      const answer = await client.account.upsert({
        where: { id: 80 },
        create: {
          id: 80,
          email: "mine@x",
          handle: "mine",
          label: "MINE",
          score: 0,
        },
        update: { label: "ADOPTED" },
      });
      const statements = drain(driver);
      driver.recording = false;
      competitor.close();
      await client.$disconnect();
      return { answer, statements };
    };

    // Probe-first: the locate proved the row absent, the competitor then took the
    // key, the INSERT lost, its racePin classified the violation as the raceable
    // create-branch signal, and the routed retry re-planned into the update arm.
    // The operation converges — and pays for a whole second round of statements.
    const probeFirst = await raced(false);
    expect(probeFirst.answer).toMatchObject({ id: 80, label: "ADOPTED" });
    expect(probeFirst.statements.length).toBeGreaterThan(3);

    // Folded: the same competitor, the same window, and the statement simply
    // takes its DO UPDATE arm. One statement, no retry, the same answer. The race
    // protection is not removed here — it is discharged by the database, which is
    // what makes the missing racePin sound rather than a hole.
    const folded = await raced(true);
    expect(folded.answer).toMatchObject({ id: 80, label: "ADOPTED" });
    expect(folded.statements).toHaveLength(1);
  });

  test("NOT a divergence: the unrelated-collision error is the same class, code and constraint", async () => {
    const { folded, probeFirst } = await dualRun({
      where: { id: 90 },
      create: { id: 90, email: "a1@x", handle: "h90", label: "N90", score: 0 },
      update: { label: "U90" },
    });
    // Stated positively rather than left to the oracle loop, because this is the
    // observable the plan singled out as the reason MySQL cannot come through
    // this door. On a dialect that arbitrates on the NAMED target the non-arbiter
    // index raises its own violation, attributed to its own constraint.
    const shape = errorShape(folded.error) as {
      class: string;
      code: string;
      meta: Record<string, unknown>;
    };
    expect(shape.class).toBe("UniqueConstraintError");
    expect(shape.code).toBe("V3001");
    expect(shape.meta.constraint).toBe("p71_accounts_email_key");
    expect(shape).toEqual(errorShape(probeFirst.error));
  });

  test("NOT a divergence: both arms report exactly one affected row", async () => {
    // The probe path's update arm carries `affectedRows(1, notFound)` to catch a
    // concurrent delete between the locate and the UPDATE. The fold has no such
    // window, and its statement cannot affect zero rows: it either inserts or
    // updates. The observable — one row back — is unchanged, which is why no
    // postcondition was moved or dropped.
    const { client } = await boot();
    const created = await client.account.upsert({
      where: { id: 95 },
      create: { id: 95, email: "n95@x", handle: "h95", label: "N", score: 0 },
      update: { label: "U" },
    });
    const updated = await client.account.upsert({
      where: { id: 95 },
      create: { id: 95, email: "n95@x", handle: "h95", label: "N", score: 0 },
      update: { label: "U" },
    });
    expect(created).toMatchObject({ id: 95, label: "N" });
    expect(updated).toMatchObject({ id: 95, label: "U" });
  });
});

// ---------------------------------------------------------------------------
// 4. THE GATE'S EXCLUSIONS — one case per conjunct, each keeping its own contract
// ---------------------------------------------------------------------------

/** Run one upsert and return the statements it sent. */
async function traffic(
  payload: Record<string, unknown>
): Promise<{ statements: string[]; answer: unknown }> {
  const { driver, client } = await boot();
  driver.recording = true;
  const answer = await client.account.upsert(payload as any);
  const statements = drain(driver);
  driver.recording = false;
  return { statements, answer };
}

describe("the ON CONFLICT fold — what stays on the probe path", () => {
  test("conjunct 2 (the arbiter): MySQL declares itself out, and says why", () => {
    // The capability IS the conjunct, and it reads false on MySQL for the reason
    // the plan gives: `ON DUPLICATE KEY UPDATE` carries no conflict target, so an
    // unrelated collision would adopt a row the caller never named. Asserted on
    // the adapters themselves, so the falsification the phase brief names —
    // open the gate to MySQL — has a witness that fails on the one-line edit.
    expect(new MySQLAdapter().capabilities.supportsTargetedUpsert).toBe(false);
    expect(new PostgresAdapter().capabilities.supportsTargetedUpsert).toBe(
      true
    );
    expect(new SQLiteAdapter().capabilities.supportsTargetedUpsert).toBe(true);

    // And the emitter that makes it true: MySQL's `onConflict` discards the
    // target it is handed. This is the measured fact the capability records.
    const mysqlUpsert = new MySQLAdapter().mutations.onConflict(
      sql`\`id\``,
      sql`\`label\` = 'x'`
    );
    expect(mysqlUpsert.strings.join("")).not.toContain("id");
    expect(mysqlUpsert.strings.join("")).toContain("ON DUPLICATE KEY UPDATE");
  });

  test("conjunct 3: a `targetWhere` keeps the probe path AND its silent no-op", async () => {
    const { driver, client } = await boot();
    driver.recording = true;
    const result = await client.account.upsert({
      where: { id: 1 },
      targetWhere: { score: 999 },
      create: { id: 1, email: "a1@x", handle: "h1", label: "N", score: 0 },
      update: { label: "SHOULD-NOT-APPLY" },
    });
    const statements = drain(driver);
    driver.recording = false;

    expect(statements.length).toBeGreaterThan(1);
    expect(statements.join("\n")).not.toContain("ON CONFLICT");
    // The contract this conjunct protects: no write, and the UNCHANGED row is
    // still what comes back. A folded `DO UPDATE … WHERE <no match>` returns zero
    // rows, so the caller would have got nothing.
    expect(result).toMatchObject({ id: 1, label: "L1", score: 10 });
  });

  test("conjunct 3: a `setWhere` keeps the probe path too", async () => {
    const { statements } = await traffic({
      where: { id: 1 },
      setWhere: { score: 999 },
      create: { id: 1, email: "a1@x", handle: "h1", label: "N", score: 0 },
      update: { label: "NOPE" },
    });
    expect(statements.join("\n")).not.toContain("ON CONFLICT");
  });

  test("conjunct 4: an extended selector whose filter EXCLUDES the row keeps the probe path", async () => {
    const { driver, client } = await boot();
    driver.recording = true;
    // The unique half names row 1; the filter half excludes it. The contract is
    // that this is the CREATE arm — and a fold would have arbitrated on `id = 1`
    // and adopted the very row the filter excluded.
    let caught: unknown;
    try {
      await client.account.upsert({
        where: { id: 1, score: 999 },
        create: { id: 1, email: "dup@x", handle: "hd", label: "N", score: 0 },
        update: { label: "NOPE" },
      });
    } catch (error) {
      caught = error;
    }
    const statements = drain(driver);
    driver.recording = false;

    expect(statements.join("\n")).not.toContain("ON CONFLICT");
    // The create arm runs and its INSERT collides with the excluded row's own
    // primary key — a genuine conflict, which is exactly what `childRacePin`
    // already says about an extended selector. A fold would have silently
    // UPDATED row 1 instead.
    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe("V3001");
    expect(await client.account.findUnique({ where: { id: 1 } })).toMatchObject(
      { label: "L1" }
    );
  });

  test("conjunct 5: TWO independent uniques in one selector keep the probe path — UPDATE arm", async () => {
    const { driver, client } = await boot();
    driver.recording = true;
    // Both keys are DISCRIMINATORS, so conjunct 4 sees no filter half; the create
    // data spells both with the `where`'s own values, so conjunct 6 is satisfied
    // — the natural spelling. What the fold would emit is
    // `ON CONFLICT ("id", "email")`: a column pair with no unique index behind
    // it, which PostgreSQL rejects with `42P10` and SQLite rejects likewise. The
    // probe path names the row in a WHERE, where a conjunction of uniques is
    // ordinary, and has always answered this shape — as `findUnique` and
    // `update` do for the same selector.
    const updated = await client.account.upsert({
      where: { id: 1, email: "a1@x" },
      create: { id: 1, email: "a1@x", handle: "h1", label: "N", score: 0 },
      update: { label: "TWO-UNIQUES-UPDATE" },
    });
    const statements = drain(driver);
    driver.recording = false;

    expect(statements.join("\n")).not.toContain("ON CONFLICT");
    expect(updated).toMatchObject({ id: 1, label: "TWO-UNIQUES-UPDATE" });
    // And the row really moved — the answer is not a RETURNING that never landed.
    expect(await client.account.findUnique({ where: { id: 1 } })).toMatchObject(
      {
        label: "TWO-UNIQUES-UPDATE",
      }
    );
  });

  test("conjunct 5: TWO independent uniques keep the probe path on the CREATE arm too", async () => {
    const { driver, client } = await boot();
    driver.recording = true;
    const created = await client.account.upsert({
      where: { id: 90, email: "n90@x" },
      create: { id: 90, email: "n90@x", handle: "h90", label: "N90", score: 0 },
      update: { label: "NOPE" },
    });
    const statements = drain(driver);
    driver.recording = false;

    expect(statements.join("\n")).not.toContain("ON CONFLICT");
    expect(created).toMatchObject({ id: 90, email: "n90@x", label: "N90" });
  });

  test("conjunct 5: SQLite answers the same selector on the probe path", async () => {
    // The arbiter capability is true on SQLite too, so the same fold would have
    // been built there — and SQLite rejects an ON CONFLICT target with no
    // matching index just as PostgreSQL does. One live witness on the second
    // substrate, so the conjunct is not pinned to one dialect's error code.
    const driver = new SQLite3Driver({ dataDir: ":memory:" });
    const client = createClient({ schema, driver });
    await push(client, { force: true });
    await client.account.create({
      data: { id: 1, email: "a1@x", handle: "h1", label: "L1", score: 10 },
    });

    const updated = await client.account.upsert({
      where: { id: 1, email: "a1@x" },
      create: { id: 1, email: "a1@x", handle: "h1", label: "N", score: 0 },
      update: { label: "SQLITE-TWO-UNIQUES" },
    });
    expect(updated).toMatchObject({ id: 1, label: "SQLITE-TWO-UNIQUES" });
    await client.$disconnect();
  });

  test("conjunct 5: a COMPOUND unique is ONE constraint and still folds — the control", async () => {
    const { driver, client } = await boot();

    driver.recording = true;
    const updated = await client.ledger.upsert({
      where: { org_slot: { org: "o1", slot: 1 } },
      create: { org: "o1", slot: 1, label: "NEW" },
      update: { label: "BY-COMPOUND" },
    });
    const updateArm = drain(driver);
    const created = await client.ledger.upsert({
      where: { org_slot: { org: "o2", slot: 7 } },
      create: { org: "o2", slot: 7, label: "MADE" },
      update: { label: "NOPE" },
    });
    const createArm = drain(driver);
    driver.recording = false;

    // The control that keeps the conjunct honest: a compound is ONE key in the
    // discriminator and TWO entries after flattening, and `ON CONFLICT
    // ("org", "slot")` is a real index. Counting the flattened ENTRIES instead of
    // the discriminator's own keys would decline this and give the compound
    // upsert back its four round trips.
    expect(updateArm).toHaveLength(1);
    expect(updateArm[0]).toContain('ON CONFLICT ("org", "slot")');
    expect(updated).toMatchObject({ id: 1, label: "BY-COMPOUND" });
    expect(createArm).toHaveLength(1);
    expect(created).toMatchObject({ org: "o2", slot: 7, label: "MADE" });
  });

  test("conjunct 6: `create` that does not satisfy `where` keeps the probe path", async () => {
    const { driver, client } = await boot();
    driver.recording = true;
    // `where` names row 40 (absent) but the create data writes row 41. Prisma
    // permits this. `ON CONFLICT` would arbitrate on 41 — a different question —
    // so the fold declines and the probe path inserts row 41, as it always did.
    const result = await client.account.upsert({
      where: { id: 40 },
      create: { id: 41, email: "n41@x", handle: "h41", label: "N41", score: 0 },
      update: { label: "U40" },
    });
    const statements = drain(driver);
    driver.recording = false;

    expect(statements.join("\n")).not.toContain("ON CONFLICT");
    expect(result).toMatchObject({ id: 41, label: "N41" });
  });

  test("conjunct 6: the SAME key spelled with the SAME value does fold — the control", async () => {
    const { statements, answer } = await traffic({
      where: { handle: "h1" },
      create: { email: "a1@x", handle: "h1", label: "N", score: 0 },
      update: { label: "BY-HANDLE" },
    });
    // The control for the two declines above: this is the identical shape with
    // the one difference that the create data spells the conflict target with the
    // `where`'s own value, and it folds.
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('ON CONFLICT ("handle")');
    expect(answer).toMatchObject({ id: 1, label: "BY-HANDLE" });
  });

  test("conjunct 7: atomic arithmetic in the update payload keeps the probe path", async () => {
    const { driver, client } = await boot();
    driver.recording = true;
    const result = await client.account.upsert({
      where: { id: 1 },
      create: { id: 1, email: "a1@x", handle: "h1", label: "N", score: 0 },
      update: { score: { increment: 5 } },
    });
    const statements = drain(driver);
    driver.recording = false;

    // `buildSet` spells this `"score" = "score" + $1`, and inside DO UPDATE
    // PostgreSQL calls the bare reference ambiguous (42702). The probe path's
    // plain UPDATE has no such ambiguity, so the payload keeps it — and still
    // answers correctly.
    expect(statements.join("\n")).not.toContain("ON CONFLICT");
    expect(result).toMatchObject({ id: 1, score: 15 });
  });

  test("conjunct 1: a relation `include` keeps the probe path and reads the relation", async () => {
    const { driver, client } = await boot();
    await client.note.create({ data: { id: 5, body: "n5", accountId: 1 } });
    driver.recording = true;
    const result = await client.account.upsert({
      where: { id: 1 },
      create: { id: 1, email: "a1@x", handle: "h1", label: "N", score: 0 },
      update: { label: "WITH-INCLUDE" },
      include: { notes: true },
    });
    const statements = drain(driver);
    driver.recording = false;

    expect(statements.join("\n")).not.toContain("ON CONFLICT");
    expect(result).toMatchObject({
      label: "WITH-INCLUDE",
      notes: [{ id: 5, body: "n5" }],
    });
  });

  test("conjunct 1: a `_count` projection keeps the probe path and counts correctly", async () => {
    const { driver, client } = await boot();
    await client.note.create({ data: { id: 6, body: "n6", accountId: 1 } });
    await client.note.create({ data: { id: 7, body: "n7", accountId: 1 } });
    driver.recording = true;
    const result = await client.account.upsert({
      where: { id: 1 },
      create: { id: 1, email: "a1@x", handle: "h1", label: "N", score: 0 },
      update: { label: "WITH-COUNT" },
      select: { id: true, _count: { select: { notes: true } } },
    });
    const statements = drain(driver);
    driver.recording = false;

    expect(statements.join("\n")).not.toContain("ON CONFLICT");
    // The P3 `_count` defect, held: a relation-derived projection read off a
    // RETURNING subquery binds by name and answers the wrong number.
    expect(result).toEqual({ id: 1, _count: { notes: 2 } });
  });

  test("conjunct 6 also covers a relation-bearing create arm — and the child is written", async () => {
    const { driver, client } = await boot();
    driver.recording = true;
    await client.account.upsert({
      where: { id: 45 },
      create: {
        id: 45,
        email: "n45@x",
        handle: "h45",
        label: "N45",
        score: 0,
        notes: { create: { id: 9, body: "child" } },
      },
      update: { label: "U45" },
    });
    const statements = drain(driver);
    driver.recording = false;

    expect(statements.join("\n")).not.toContain("ON CONFLICT");
    // A `!createHasRelations` conjunct was written and then REMOVED: nothing in
    // the estate could distinguish it from conjunct 5, because `createData` is
    // empty for a relation-bearing payload and the conflict target therefore
    // reads `undefined`. This assertion is what the removed conjunct was really
    // protecting — that the child write is not silently dropped — so it is
    // stated on the effect rather than on the decline.
    expect(await client.note.findUnique({ where: { id: 9 } })).toMatchObject({
      id: 9,
      body: "child",
      accountId: 45,
    });
  });

  test("conjunct 1: a relation-bearing update arm keeps the probe path", async () => {
    const { statements } = await traffic({
      where: { id: 1 },
      create: { id: 1, email: "a1@x", handle: "h1", label: "N", score: 0 },
      update: {
        label: "U",
        notes: { create: { id: 8, body: "child" } },
      },
    });
    expect(statements.join("\n")).not.toContain("ON CONFLICT");
  });
});
