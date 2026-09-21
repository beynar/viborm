/**
 * pg Driver Tests — the BATCH route's half of the shared FOUND-consumption
 * rule, on two real PostgreSQL connections (repair prompt §1).
 *
 * U1 closed the rule on the interactive route and recorded this half as open
 * (`g4/release/closure-repair/u1/note.md` §11): on the batch route
 * `CommandExecution.confirmFound` takes no read, so a PARENT-held
 * `connectOrCreate` whose probe FOUND its target bound the probe's literal
 * bytes and the holder's own statement spent them. What the unit states as
 * premises is the row's IDENTITY, its membership and its matched condition —
 * never the referenced COLUMN — so a key recycled between the plan-time probe
 * and the batch moved the connection to whichever row had acquired it.
 *
 * THE SCHEDULE, committed by a second real connection: `b1(slug: "chosen",
 * code: "G")` is observed; B commits `b1.code = 'M'` and creates
 * `b2(slug: "unselected", code: "G")`. The holder asked for the row its
 * selector names — `b1` — and must connect `b1` or fail; it must never connect
 * `b2`, which acquired the bytes and nothing else.
 *
 * THE TWO WINDOWS, ordered rather than invented. Before the unit, through the
 * repository's own `PgBeforeFirstWriteBatchDriver` (the forced batch profile's
 * hook, which fires once before the first batch that carries a mutation — the
 * unit itself). And AFTER the unit's premise has answered, through the split
 * this file's own driver performs at the same boundary
 * `PgWindowedBatchDriver` splits in `pg-captured-set-concurrency.test.ts`:
 * there the second window is where the repair's own premise HOLDS the row, so
 * what it measures is a lock, proved by B waiting on it.
 *
 * DEFAULT ROUTES AND FORCED PROFILES ARE KEPT APART. PostgreSQL's own route is
 * interactive and confirms under lock (U1's rule); these cells run the
 * capability-forced batch profile (no interactive transaction, one native
 * atomic batch) against real PostgreSQL, so the concurrency, the statements and
 * the provider are native and the capability profile is not.
 *
 * NOTE: These tests require a running PostgreSQL database.
 * Skip in CI unless PostgreSQL is available.
 *
 * They run in a database of their own (`te_brr_closure`, created on the same
 * server from `PG_TEST_CONNECTION_STRING`): `syncLiveSchema` diffs against live
 * introspection, so pushing this file's models into a shared database would
 * plan a drop for every table that is not one of them.
 */

import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { PgDriver } from "@drivers/pg";
import type { BatchQuery, QueryResult } from "@drivers/types";
import { s } from "@schema";
import { PgBeforeFirstWriteBatchDriver } from "@tests/fixtures/drivers/batch-forced-pg";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { Client as NativePgClient, type Pool, type PoolClient } from "pg";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { TEST_CONNECTION_STRING } from "./pg-fixtures";

// ---------------------------------------------------------------- the schema

/** The single-member bed: `code` is the referenced unique, `slug` the selector. */
const badge = s
  .model({
    id: s.string().id(),
    slug: s.string().unique(),
    code: s.string().nullable().unique(),
    holders: s.toMany(() => holder),
  })
  .map("te_brr_badges");
const holder = s
  .model({
    id: s.string().id(),
    name: s.string(),
    badgeCode: s.string().nullable(),
    badge: s
      .toOne(() => badge)
      .fields("badgeCode")
      .references("code"),
  })
  .map("te_brr_holders");
/** The COMPOUND bed: the referenced key is a two-member unique. */
const pass = s
  .model({
    id: s.string().id(),
    zone: s.string(),
    serial: s.string().nullable(),
    gates: s.toMany(() => gate),
  })
  .unique(["zone", "serial"])
  .map("te_brr_passes");
const gate = s
  .model({
    id: s.string().id(),
    label: s.string(),
    passZone: s.string().nullable(),
    passSerial: s.string().nullable(),
    pass: s
      .toOne(() => pass)
      .fields("passZone", "passSerial")
      .references("zone", "serial"),
  })
  .map("te_brr_gates");

const schema = { badge, gate, holder, pass };

type ReuseConfig = VibORMConfig<typeof schema>;
type ReuseClient = VibORMClient<ReuseConfig>;

const OWN_TABLES = [
  "te_brr_gates",
  "te_brr_holders",
  "te_brr_passes",
  "te_brr_badges",
];
const OWN_DATABASE = "te_brr_closure";
const ALREADY_EXISTS = /already exists/i;

function ownDatabaseUrl(admin: string): string {
  const url = new URL(admin);
  url.pathname = `/${OWN_DATABASE}`;
  return url.toString();
}

/** The replacement race the `connectOrCreate` arm already owns. */
const REPLACED =
  "Record was replaced by another transaction during nested connectOrCreate";
/** The relation's one inherited representability sentence (R1). */
const NULL_CODE =
  "Cannot connect relation 'badge': the located target's referenced field 'code' is null.";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// --------------------------------------------------------------- the drivers

/** Does this batch entry mutate? The atomic write unit is the only batch that
 *  carries one; a planning level is reads only. */
const MUTATION_STATEMENT = /^\s*(?:insert|update|delete)\b/i;

/**
 * A batch-forced pg driver that splits ONE atomic batch at the boundary between
 * its last premise and its first write and lets connection B act there, on the
 * SAME connection and inside the SAME transaction the engine asked for — the
 * split `PgWindowedBatchDriver` performs for the captured-set schedules. The
 * interleave is not awaited to completion by the batch: a cell that measures a
 * LOCK starts B's statement, observes it pending, and lets the unit proceed.
 */
class PgSplitWriteBatchDriver extends PgDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  readonly schedule: string[] = [];
  /** `[statements, premises ahead of the first write]` of the split unit. */
  shape: [number, number] = [0, 0];
  private fired = false;
  private readonly interleave: () => Promise<void>;

  constructor(
    interleave: () => Promise<void>,
    options: ConstructorParameters<typeof PgDriver>[0]
  ) {
    super(options);
    this.interleave = interleave;
  }

  protected override executeBatch<T>(
    client: Pool | PoolClient,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (tx) => {
      const firstWrite = queries.findIndex((query) =>
        MUTATION_STATEMENT.test(query.sql)
      );
      if (this.fired || firstWrite < 1)
        return await super.executeBatch<T>(tx, queries);
      this.fired = true;
      this.shape = [queries.length, firstWrite];
      const head = await super.executeBatch<T>(
        tx,
        queries.slice(0, firstWrite)
      );
      this.schedule.push("A: every premise of the unit has answered");
      await this.interleave();
      const tail = await super.executeBatch<T>(tx, queries.slice(firstWrite));
      this.schedule.push("A: the unit's writes executed");
      return [...head, ...tail];
    });
  }
}

// --------------------------------------------------------------- the cells

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("pg Driver batch reference reuse", () => {
  const databaseUrl = ownDatabaseUrl(TEST_CONNECTION_STRING ?? "");
  let clients: ReuseClient[] = [];

  function boot(driver: AnyDriver): ReuseClient {
    const client = createClient({ schema, driver }) as ReuseClient;
    clients.push(client);
    return client;
  }

  const interactive = () => boot(new PgDriver({ databaseUrl }));

  beforeAll(async () => {
    const admin = new NativePgClient({
      connectionString: TEST_CONNECTION_STRING,
    });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${OWN_DATABASE}`);
    } catch (error) {
      if (!ALREADY_EXISTS.test(String(error))) throw error;
    } finally {
      await admin.end();
    }
  }, 60_000);

  beforeEach(async () => {
    clients = [];
    const setup = interactive();
    for (const table of OWN_TABLES) {
      await setup.$executeRawUnsafe(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }
    await syncLiveSchema(setup);
  }, 60_000);

  afterEach(async () => {
    for (const client of clients) {
      await client.$disconnect();
    }
    clients = [];
  });

  async function seed(client: ReuseClient): Promise<void> {
    await client.badge.create({
      data: { id: "b1", slug: "chosen", code: "G" },
    });
    await client.holder.create({
      data: { id: "h1", name: "one", badgeCode: null },
    });
    await client.pass.create({
      data: { id: "p1", zone: "north", serial: "S1" },
    });
    await client.gate.create({
      data: { id: "g1", label: "gate-1", passZone: null, passSerial: null },
    });
  }

  const connectChosen = {
    connectOrCreate: {
      where: { slug: "chosen" },
      create: { id: "b9", slug: "chosen", code: "NEW" },
    },
  };

  /** The membership as the database holds it, read back on a fresh connection. */
  async function membership(
    client: ReuseClient
  ): Promise<[string, string[]][]> {
    const rows = await client.badge.findMany({
      include: { holders: { orderBy: { id: "asc" } } },
      orderBy: { id: "asc" },
    });
    return rows.map((row) => [row.id, row.holders.map((held) => held.id)]);
  }

  test(
    "a key recycled onto another row before the unit cannot move the connection",
    { timeout: 90_000 },
    async () => {
      // THE WITNESS. At the base the holder's UPDATE spent the probe's literal
      // `G`, which `b2` had acquired, so the holder became a member of `b2` —
      // a row its selector never named.
      const seeder = interactive();
      await seed(seeder);
      const other = interactive();

      const driver = new PgBeforeFirstWriteBatchDriver(
        async () => {
          await other.badge.update({
            where: { id: "b1" },
            data: { code: "M" },
          });
          await other.badge.create({
            data: { id: "b2", slug: "unselected", code: "G" },
          });
        },
        () => undefined,
        { databaseUrl }
      );
      const client = boot(driver);

      expect(
        await client.holder.update({
          where: { id: "h1" },
          data: { name: "connected", badge: connectChosen },
        })
      ).toEqual({ id: "h1", name: "connected", badgeCode: "M" });
      expect(await membership(seeder)).toEqual([
        ["b1", ["h1"]],
        ["b2", []],
      ]);
    }
  );

  test(
    "a COMPOUND key recycled before the unit cannot move the connection, in either member",
    { timeout: 90_000 },
    async () => {
      const seeder = interactive();
      await seed(seeder);
      const other = interactive();

      const driver = new PgBeforeFirstWriteBatchDriver(
        async () => {
          await other.pass.update({
            where: { id: "p1" },
            data: { serial: "S9" },
          });
          await other.pass.create({
            data: { id: "p2", zone: "north", serial: "S1" },
          });
        },
        () => undefined,
        { databaseUrl }
      );
      const client = boot(driver);

      expect(
        await client.gate.update({
          where: { id: "g1" },
          data: {
            label: "moved",
            pass: {
              connectOrCreate: {
                where: { id: "p1" },
                create: { id: "p9", zone: "north", serial: "S1" },
              },
            },
          },
        })
      ).toEqual({
        id: "g1",
        label: "moved",
        passZone: "north",
        passSerial: "S9",
      });
      const passes = await seeder.pass.findMany({
        include: { gates: true },
        orderBy: { id: "asc" },
      });
      expect(passes.map((row) => [row.id, row.gates.map((g) => g.id)])).toEqual(
        [
          ["p1", ["g1"]],
          ["p2", []],
        ]
      );
    }
  );

  test(
    "the unit's premise HOLDS the located row through the statement that spends it",
    { timeout: 90_000 },
    async () => {
      // The lock, proved by a schedule and not by a hook moved ahead of the
      // race: a second connection's UPDATE of the located row is started AFTER
      // the unit's premise has answered, is still pending when the unit's own
      // write goes out, and completes only once this operation has committed.
      const seeder = interactive();
      await seed(seeder);
      const other = interactive();

      let settled = false;
      let contender: Promise<unknown> | undefined;
      const driver = new PgSplitWriteBatchDriver(
        async () => {
          contender = other.badge
            .update({ where: { id: "b1" }, data: { slug: "moved" } })
            .then(
              (value) => {
                settled = true;
                return value;
              },
              (error: unknown) => {
                settled = true;
                throw error;
              }
            );
          await sleep(1000);
          driver.schedule.push(
            settled
              ? "B: its UPDATE of the located row completed"
              : "B: its UPDATE of the located row is still waiting"
          );
        },
        { databaseUrl }
      );
      const client = boot(driver);

      expect(
        await client.holder.update({
          where: { id: "h1" },
          data: { name: "connected", badge: connectChosen },
        })
      ).toEqual({ id: "h1", name: "connected", badgeCode: "G" });
      expect(driver.schedule).toEqual([
        "A: every premise of the unit has answered",
        "B: its UPDATE of the located row is still waiting",
        "A: the unit's writes executed",
      ]);
      // The unit really did carry its premise ahead of its write.
      expect(driver.shape[1]).toBeGreaterThan(0);
      await contender;
      expect(await membership(seeder)).toEqual([["b1", ["h1"]]]);
    }
  );

  test(
    "a located target that disappears before the unit aborts it with the arm's own failure",
    { timeout: 90_000 },
    async () => {
      const seeder = interactive();
      await seed(seeder);
      const other = interactive();

      const driver = new PgBeforeFirstWriteBatchDriver(
        async () => {
          await other.badge.delete({ where: { id: "b1" } });
          await other.badge.create({
            data: { id: "b2", slug: "unselected", code: "G" },
          });
        },
        () => undefined,
        { databaseUrl }
      );
      const client = boot(driver);

      const raised = await client.holder
        .update({
          where: { id: "h1" },
          data: { name: "connected", badge: connectChosen },
        })
        .then(
          () => undefined,
          (error: unknown) => error
        );

      expect(messageOf(raised)).toContain(REPLACED);
      expect(await seeder.holder.findMany()).toEqual([
        { id: "h1", name: "one", badgeCode: null },
      ]);
      expect(
        (await seeder.badge.findMany({ orderBy: { id: "asc" } })).map(
          (row) => row.id
        )
      ).toEqual(["b2"]);
    }
  );

  test(
    "a reference nulled before the unit is refused by the relation's own sentence, and the NULL is never written",
    { timeout: 90_000 },
    async () => {
      const seeder = interactive();
      await seed(seeder);
      const other = interactive();

      const driver = new PgBeforeFirstWriteBatchDriver(
        async () => {
          await other.badge.update({
            where: { id: "b1" },
            data: { code: null },
          });
        },
        () => undefined,
        { databaseUrl }
      );
      const client = boot(driver);

      const raised = await client.holder
        .update({
          where: { id: "h1" },
          data: { name: "connected", badge: connectChosen },
        })
        .then(
          () => undefined,
          (error: unknown) => error
        );

      expect(messageOf(raised)).toBe(NULL_CODE);
      expect(await seeder.holder.findMany()).toEqual([
        { id: "h1", name: "one", badgeCode: null },
      ]);
    }
  );

  test(
    "an uncontended found consumption commits its ordinary result on the forced batch profile",
    { timeout: 90_000 },
    async () => {
      // No blanket refusal: the uncontended consumption connects the row its
      // selector names, at that row's own value, and a MISSING target still
      // takes the create arm.
      const seeder = interactive();
      await seed(seeder);
      const client = boot(
        new PgBeforeFirstWriteBatchDriver(
          async () => undefined,
          () => undefined,
          { databaseUrl }
        )
      );

      expect(
        await client.holder.update({
          where: { id: "h1" },
          data: { name: "connected", badge: connectChosen },
        })
      ).toEqual({ id: "h1", name: "connected", badgeCode: "G" });
      expect(
        await client.holder.create({
          data: {
            id: "h4",
            name: "four",
            badge: {
              connectOrCreate: {
                where: { slug: "fresh" },
                create: { id: "b7", slug: "fresh", code: "F" },
              },
            },
          },
        })
      ).toEqual({ id: "h4", name: "four", badgeCode: "F" });
      expect(await membership(seeder)).toEqual([
        ["b1", ["h1"]],
        ["b7", ["h4"]],
      ]);
    }
  );
});
