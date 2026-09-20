/**
 * pg Driver Tests — the captured set's CONSUMPTION-TIME contract (FC-03)
 *
 * FC-03 records an UNEXECUTED concern: "ordinary EXISTS premises followed by an
 * ID-only mutation do not alone prove the relevant membership still holds when
 * the effect executes". This file executes it on real, multi-connection
 * PostgreSQL — the only substrate where a second transaction can hold a row
 * lock while the first one's capture and premises observe the old committed row.
 *
 * THE CONTRACT THIS FILE MEASURES AGAINST (established from the source before
 * any schedule was run, see the FCPG note):
 *
 *  - R1 (batch route, `OperationContext.requireCapturedSet`): every captured row
 *    is STILL PRESENT and STILL A MEMBER of the selection — asserted as
 *    statements inside the mutation's own batch, AHEAD OF THE WRITE.
 *  - R2 (batch route, unlimited capture only): NO ROW HAS JOINED the selection.
 *    A limited capture took one valid slice, so the complement is not claimed
 *    for it.
 *  - R3 (interactive route): no premise is stated at all, because the capture
 *    took `FOR UPDATE` and "the capture is protected by the lock it holds until
 *    the mutation".
 *  - R4 (both routes): the mutation's own row count equals the captured count,
 *    else the registered `<verb> selected-row cardinality changed during its
 *    locked mutation.` sentence.
 *  - Consumer 2 (`CommandExecution.requireNoAddedMember`): a captured MEMBER set
 *    is an assertion about the rows it does not contain — "connected ∧ filter ∧
 *    key ∉ captured is EMPTY", one raceable `requireAbsent` in the same batch,
 *    behind the series' own parent premise, plus each captured member's presence.
 *
 * Every sentence above places its claim AT A POSITION (ahead of the write),
 * never AT THE EFFECT. These cells measure what that positional reading costs
 * and what the `FOR UPDATE` route buys, and they are written to keep answering
 * whichever reading the ledger settles on: each one asserts the OBSERVED result
 * and the OBSERVED final table state, and names the reading it agrees with.
 *
 * THE INTERLEAVINGS ARE ORDERED, NOT INVENTED. `PgWindowedBatchDriver` splits
 * one atomic batch at the boundary between its last premise and its first write
 * and lets connection B commit there, on the SAME connection and inside the SAME
 * transaction the engine asked for. PostgreSQL READ COMMITTED takes a fresh
 * snapshot per statement, so a commit landing between two statements of one
 * transaction is ordinary substrate behaviour; the hook only makes the moment
 * deterministic. The lock-held schedules use no hook at all: B holds an
 * uncommitted row lock, A blocks on it, and B commits while A's mutation waits.
 *
 * NOTE: These tests require a running PostgreSQL database.
 * Skip in CI unless PostgreSQL is available.
 *
 * They run in a database of their own (`fcpg_closure`, created on the same
 * server from `PG_TEST_CONNECTION_STRING`): `syncLiveSchema` diffs against live
 * introspection, so pushing this file's three models into a shared database
 * would plan a drop for every table that is not one of them.
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

const note = s
  .model({
    id: s.string().id(),
    label: s.string(),
    active: s.boolean(),
  })
  .map("fcpg_notes");

const team = s
  .model({
    id: s.string().id(),
    name: s.string(),
    members: s
      .toMany(() => member)
      .through("fcpg_team_members")
      .source("team_ref")
      .target("member_ref"),
  })
  .map("fcpg_teams");

const member = s
  .model({
    id: s.string().id(),
    label: s.string(),
    active: s.boolean(),
    teams: s.toMany(() => team),
  })
  .map("fcpg_members");

const schema = { note, team, member };

type FcpgClient = VibORMClient<VibORMConfig<typeof schema>>;

const OWN_TABLES = [
  "fcpg_team_members",
  "fcpg_teams",
  "fcpg_members",
  "fcpg_notes",
];

const OWN_DATABASE = "fcpg_closure";

/** PostgreSQL's own "database already exists" answer — this file creates its
 *  database once and joins it on every later run. */
const ALREADY_EXISTS = /already exists/i;

function ownDatabaseUrl(admin: string): string {
  const url = new URL(admin);
  url.pathname = `/${OWN_DATABASE}`;
  return url.toString();
}

// --------------------------------------------------------------- the drivers

/**
 * Native pg with RETURNING switched off — the capability profile on which a
 * selected bulk mutation MUST capture the rows it is about to change (MySQL and
 * PlanetScale carry it natively; here it is executed against real PostgreSQL so
 * the concurrency is real). PostgreSQL's own RETURNING route never captures, so
 * it cannot witness this contract at all.
 */
class PgCapturingDriver extends PgDriver {
  constructor(options: ConstructorParameters<typeof PgDriver>[0]) {
    super(options);
    this.adapter.capabilities.supportsReturning = false;
  }
}

/**
 * The same profile on the BATCH route: no interactive transaction, one native
 * atomic batch. This is the route on which `requireCapturedSet` and
 * `requireNoAddedMember` state their premises; the interactive route states
 * none and relies on `FOR UPDATE` instead.
 */
class PgCapturingBatchDriver extends PgCapturingDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override executeBatch<T>(
    client: Pool | PoolClient,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, (tx) => super.executeBatch<T>(tx, queries));
  }
}

/** Does this batch entry mutate? The atomic write unit is the only batch that
 *  carries one; a planning level and a capture segment are reads only. */
const MUTATION_STATEMENT = /^\s*(?:insert|update|delete)\b/i;

/**
 * Where connection B's commit lands relative to the atomic unit's own
 * statements:
 *
 *  - `before-premises` — inside the unit's transaction but ahead of its first
 *    premise. The premises then read B's committed change, which is the window
 *    the engine's guards exist to catch.
 *  - `between-premises-and-writes` — after the unit's LAST premise and before
 *    its FIRST write. This is exactly FC-03's sentence: premises, then an
 *    ID-only mutation.
 */
type WindowPlacement = "before-premises" | "between-premises-and-writes";

interface Window {
  readonly placement: WindowPlacement;
  readonly interleave: () => Promise<void>;
  /** `false` switches RETURNING off — the profile a selected BULK mutation
   *  needs to capture at all. A nested captured series needs no such profile. */
  readonly returning?: boolean;
}

class PgWindowedBatchDriver extends PgDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  /** The interleaving as it actually happened, in order. */
  readonly schedule: string[] = [];
  /** `[statements, premises ahead of the first write]` of the split unit. */
  shape: [number, number] = [0, 0];
  private fired = false;
  private readonly placement: WindowPlacement;
  private readonly interleave: () => Promise<void>;

  constructor(
    window: Window,
    options: ConstructorParameters<typeof PgDriver>[0]
  ) {
    super(options);
    if (window.returning === false)
      this.adapter.capabilities.supportsReturning = false;
    this.placement = window.placement;
    this.interleave = window.interleave;
  }

  protected override executeBatch<T>(
    client: Pool | PoolClient,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (tx) => {
      const firstWrite = queries.findIndex((query) =>
        MUTATION_STATEMENT.test(query.sql)
      );
      if (this.fired || firstWrite < 0) {
        return await super.executeBatch<T>(tx, queries);
      }
      this.fired = true;
      this.shape = [queries.length, firstWrite];
      this.schedule.push("A: the atomic unit began");
      if (this.placement === "before-premises") {
        await this.interleave();
        this.schedule.push("B: committed BEFORE the unit's first premise");
        return await super.executeBatch<T>(tx, queries);
      }
      const head =
        firstWrite === 0
          ? []
          : await super.executeBatch<T>(tx, queries.slice(0, firstWrite));
      this.schedule.push("A: every premise of the unit has answered");
      await this.interleave();
      this.schedule.push(
        "B: committed BETWEEN the unit's last premise and its first write"
      );
      const tail = await super.executeBatch<T>(tx, queries.slice(firstWrite));
      this.schedule.push("A: the unit's writes executed");
      return [...head, ...tail];
    });
  }
}

// --------------------------------------------------------------- the harness

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("pg Driver captured-set consumption-time contract", () => {
  const databaseUrl = ownDatabaseUrl(TEST_CONNECTION_STRING ?? "");
  let clients: FcpgClient[] = [];

  function boot(driver: AnyDriver): FcpgClient {
    const client = createClient({ schema, driver }) as FcpgClient;
    clients.push(client);
    return client;
  }

  const interactive = () => boot(new PgDriver({ databaseUrl }));
  const capturingInteractive = () =>
    boot(new PgCapturingDriver({ databaseUrl }));
  const capturingBatch = () =>
    boot(new PgCapturingBatchDriver({ databaseUrl }));

  beforeAll(async () => {
    // One database of our own on the same server. `syncLiveSchema` diffs against
    // live introspection, so a shared database would make this file's push plan
    // a drop for every foreign table.
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

  // ------------------------------------------------------------- seeds

  async function seedNotes(client: FcpgClient): Promise<void> {
    await client.note.createMany({
      data: [
        { id: "n1", label: "one", active: true },
        { id: "n2", label: "two", active: true },
        { id: "n3", label: "three", active: false },
      ],
    });
  }

  async function seedTeam(client: FcpgClient): Promise<void> {
    await client.member.createMany({
      data: [
        { id: "m1", label: "one", active: true },
        { id: "m2", label: "two", active: true },
        { id: "m3", label: "three", active: true },
      ],
    });
    await client.team.create({ data: { id: "t1", name: "Team" } });
    await client.team.update({
      where: { id: "t1" },
      data: { members: { connect: [{ id: "m1" }, { id: "m2" }] } },
    });
  }

  const noteIds = async (client: FcpgClient) =>
    (await client.note.findMany({ orderBy: { id: "asc" } })).map(
      (row) => row.id
    );

  const memberIds = async (client: FcpgClient) =>
    (await client.member.findMany({ orderBy: { id: "asc" } })).map(
      (row) => row.id
    );

  const connectedIds = async (client: FcpgClient) =>
    (
      (
        await client.team.findUnique({
          where: { id: "t1" },
          include: { members: true },
        })
      )?.members ?? []
    )
      .map((row) => row.id)
      .sort();

  /**
   * Connection B takes a row lock inside a real interactive transaction and
   * HOLDS it uncommitted until the returned `commit()` is called. This is the
   * schedule FC-03 prescribes: A's capture and premises observe the OLD
   * committed row, and B's change lands while A's mutation is already waiting.
   */
  async function heldChange(
    client: FcpgClient,
    change: (tx: FcpgClient) => Promise<void>
  ): Promise<{ commit: () => Promise<void> }> {
    const taken = deferred();
    const release = deferred();
    const running = client
      .$transaction(
        async (tx) => {
          await change(tx as unknown as FcpgClient);
          taken.resolve();
          await release.promise;
        },
        { timeout: 60_000, maxWait: 60_000 }
      )
      .catch((error: unknown) => {
        taken.reject(error);
        throw error;
      });
    await taken.promise;
    return {
      commit: async () => {
        release.resolve();
        await running;
      },
    };
  }

  /**
   * The schedule FC-03 prescribes, run once: B changes a row and holds its lock
   * uncommitted, A runs the operation so its capture and premises observe the
   * OLD committed row, A blocks on B's row, and B commits while A's mutation is
   * already waiting. `blocked` reports whether A really waited on the lock —
   * the proof the schedule happened rather than raced past — and B is released
   * whatever A does, so a failing cell never strands the connection.
   */
  async function heldRowLockSchedule<T>(args: {
    probe: FcpgClient;
    hold: (tx: FcpgClient) => Promise<void>;
    operation: () => PromiseLike<T>;
  }): Promise<{ result: T; blocked: boolean }> {
    const holder = await heldChange(interactive(), args.hold);
    let settled: { ok: boolean; error?: unknown } | undefined;
    const running = Promise.resolve(args.operation());
    running.then(
      () => {
        settled = { ok: true };
      },
      (error: unknown) => {
        settled = { ok: false, error };
      }
    );
    let blocked = false;
    try {
      for (let attempt = 0; attempt < 300 && !settled; attempt += 1) {
        const rows = await args.probe.$queryRaw<{
          waiting: number | bigint;
        }>`SELECT count(*)::int AS waiting FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND a.datname = current_database()`;
        if (Number(rows[0]?.waiting ?? 0) > 0) {
          blocked = true;
          break;
        }
        await sleep(50);
      }
    } finally {
      await holder.commit();
    }
    return { result: await running, blocked };
  }

  // ==================================================================
  // Consumer 1 — a root selected bulk mutation with a captured set
  // ==================================================================

  describe("consumer 1: a selected deleteMany over a captured set", () => {
    test(
      "interactive route: FOR UPDATE makes the capture see B's committed change, and the row that stopped matching is not deleted",
      { timeout: 90_000 },
      async () => {
        const seeder = interactive();
        await seedNotes(seeder);
        const client = capturingInteractive();

        // A's capture is `SELECT ... FOR UPDATE`, so it BLOCKS on B's row.
        const { result: published, blocked } = await heldRowLockSchedule({
          probe: seeder,
          hold: async (tx) => {
            await tx.note.update({
              where: { id: "n1" },
              data: { active: false },
            });
          },
          operation: () =>
            client.note.deleteMany({
              where: { active: true },
              select: { id: true, label: true },
            }),
        });
        expect(blocked).toBe(true);

        // R3 held: the lock the capture takes is what protects it. PostgreSQL
        // re-evaluates the capture's predicate against the row version B
        // committed, so n1 was never captured and was never deleted.
        expect(published).toEqual([{ id: "n2", label: "two" }]);
        expect(await noteIds(seeder)).toEqual(["n1", "n3"]);
      }
    );

    test(
      "batch route: the same schedule deletes a row that had stopped being a member before the write executed",
      { timeout: 90_000 },
      async () => {
        const seeder = interactive();
        await seedNotes(seeder);
        const client = capturingBatch();

        // No FOR UPDATE on this route: the capture and the premises read the
        // OLD committed row and pass; the ID-only DELETE is what blocks.
        const { result: published, blocked } = await heldRowLockSchedule({
          probe: seeder,
          hold: async (tx) => {
            await tx.note.update({
              where: { id: "n1" },
              data: { active: false },
            });
          },
          operation: () =>
            client.note.deleteMany({
              where: { active: true },
              select: { id: true, label: true },
            }),
        });
        expect(blocked).toBe(true);

        // The premises answered honestly at their own position and the row
        // count matched, so R1/R4 are both satisfied as written — and n1, which
        // was no longer a member when the DELETE executed, is gone anyway.
        expect(published).toEqual([
          { id: "n1", label: "one" },
          { id: "n2", label: "two" },
        ]);
        expect(await noteIds(seeder)).toEqual(["n3"]);
      }
    );

    test(
      "batch route: a captured row that stops matching between the last premise and the first write is still deleted",
      { timeout: 90_000 },
      async () => {
        const seeder = interactive();
        await seedNotes(seeder);
        const other = interactive();

        const driver = new PgWindowedBatchDriver(
          {
            placement: "between-premises-and-writes",
            returning: false,
            interleave: async () => {
              await other.note.update({
                where: { id: "n1" },
                data: { active: false },
              });
            },
          },
          { databaseUrl }
        );
        const client = boot(driver);

        const published = await client.note.deleteMany({
          where: { active: true },
          select: { id: true, label: true },
        });

        expect(driver.schedule).toEqual([
          "A: the atomic unit began",
          "A: every premise of the unit has answered",
          "B: committed BETWEEN the unit's last premise and its first write",
          "A: the unit's writes executed",
        ]);
        // The unit really did carry premises ahead of its write.
        expect(driver.shape).toEqual([4, 3]);
        expect(published).toEqual([
          { id: "n1", label: "one" },
          { id: "n2", label: "two" },
        ]);
        expect(await noteIds(seeder)).toEqual(["n3"]);
      }
    );

    test(
      "batch route: a row that joins the selection between the last premise and the first write is not deleted, and nothing aborts",
      { timeout: 90_000 },
      async () => {
        const seeder = interactive();
        await seedNotes(seeder);
        const other = interactive();

        const driver = new PgWindowedBatchDriver(
          {
            placement: "between-premises-and-writes",
            returning: false,
            interleave: async () => {
              await other.note.create({
                data: { id: "n4", label: "four", active: true },
              });
            },
          },
          { databaseUrl }
        );
        const client = boot(driver);

        const published = await client.note.deleteMany({
          where: { active: true },
          select: { id: true, label: true },
        });

        expect(driver.shape).toEqual([4, 3]);
        // R2's complement ("no row has JOINED") answered before n4 existed, so
        // the joiner is not in the published set and not deleted.
        expect(published).toEqual([
          { id: "n1", label: "one" },
          { id: "n2", label: "two" },
        ]);
        expect(await noteIds(seeder)).toEqual(["n3", "n4"]);
        expect(
          (await seeder.note.findUnique({ where: { id: "n4" } }))?.active
        ).toBe(true);
      }
    );

    test(
      "batch route: a captured row removed before the premises aborts the unit with the registered sentence and writes nothing",
      { timeout: 90_000 },
      async () => {
        const seeder = interactive();
        await seedNotes(seeder);
        const other = interactive();

        const driver = new PgWindowedBatchDriver(
          {
            placement: "before-premises",
            returning: false,
            interleave: async () => {
              await other.note.delete({ where: { id: "n1" } });
            },
          },
          { databaseUrl }
        );
        const client = boot(driver);

        // The guard is live: the premise is a real statement in the unit's own
        // batch, and it aborts before any write.
        await expect(
          client.note.deleteMany({
            where: { active: true },
            select: { id: true, label: true },
          })
        ).rejects.toThrow(
          "deleteMany selected-row cardinality changed during its locked mutation."
        );
        expect(driver.schedule).toEqual([
          "A: the atomic unit began",
          "B: committed BEFORE the unit's first premise",
        ]);
        expect(driver.shape).toEqual([4, 3]);
        // n2 was captured too and survives: the unit wrote nothing.
        expect(await noteIds(seeder)).toEqual(["n2", "n3"]);
      }
    );

    test(
      "control: a truly irrelevant concurrent change in the same window changes nothing",
      { timeout: 90_000 },
      async () => {
        const seeder = interactive();
        await seedNotes(seeder);
        const other = interactive();

        const driver = new PgWindowedBatchDriver(
          {
            placement: "between-premises-and-writes",
            returning: false,
            interleave: async () => {
              await other.note.update({
                where: { id: "n3" },
                data: { label: "renamed" },
              });
            },
          },
          { databaseUrl }
        );
        const client = boot(driver);

        const published = await client.note.deleteMany({
          where: { active: true },
          select: { id: true, label: true },
        });

        expect(driver.shape).toEqual([4, 3]);
        expect(published).toEqual([
          { id: "n1", label: "one" },
          { id: "n2", label: "two" },
        ]);
        expect(await noteIds(seeder)).toEqual(["n3"]);
        expect(
          (await seeder.note.findUnique({ where: { id: "n3" } }))?.label
        ).toBe("renamed");
      }
    );
  });

  // ==================================================================
  // Consumer 2 — a nested captured deletion under a membership
  // ==================================================================

  describe("consumer 2: a nested captured deleteMany under a membership", () => {
    test(
      "batch route: a member added before the unit's premises aborts the complement raceably and the retry converges",
      { timeout: 90_000 },
      async () => {
        const seeder = interactive();
        await seedTeam(seeder);
        const other = interactive();

        const driver = new PgWindowedBatchDriver(
          {
            placement: "before-premises",
            returning: true,
            interleave: async () => {
              await other.team.update({
                where: { id: "t1" },
                data: { members: { connect: { id: "m3" } } },
              });
            },
          },
          { databaseUrl }
        );
        const client = boot(driver);

        await client.team.update({
          where: { id: "t1" },
          data: { members: { deleteMany: { active: true } } },
        });

        // The complement IS in this unit: with m3 committed ahead of the
        // premises it aborts the unit (raceable), and the one recovery re-plans
        // against the larger set and converges. This is what makes the cell
        // above a genuine miss rather than a missing guard.
        expect(driver.schedule).toEqual([
          "A: the atomic unit began",
          "B: committed BEFORE the unit's first premise",
        ]);
        expect(await memberIds(seeder)).toEqual([]);
        expect(await connectedIds(seeder)).toEqual([]);
      }
    );

    test(
      "batch route: a member added between the complement premise and the first write is silently missed",
      { timeout: 90_000 },
      async () => {
        const seeder = interactive();
        await seedTeam(seeder);
        const other = interactive();

        const driver = new PgWindowedBatchDriver(
          {
            placement: "between-premises-and-writes",
            returning: true,
            interleave: async () => {
              await other.team.update({
                where: { id: "t1" },
                data: { members: { connect: { id: "m3" } } },
              });
            },
          },
          { databaseUrl }
        );
        const client = boot(driver);

        await client.team.update({
          where: { id: "t1" },
          data: { members: { deleteMany: { active: true } } },
        });

        // `requireNoAddedMember` answered before m3 joined, so the operation
        // reports success while a matching member of the same parent survives.
        expect(await memberIds(seeder)).toEqual(["m3"]);
        expect(await connectedIds(seeder)).toEqual(["m3"]);
        expect(driver.schedule).toEqual([
          "A: the atomic unit began",
          "A: every premise of the unit has answered",
          "B: committed BETWEEN the unit's last premise and its first write",
          "A: the unit's writes executed",
        ]);
        expect(driver.shape).toEqual([7, 6]);
      }
    );

    test(
      "batch route: a captured member that stops matching the filter in the same window is still deleted",
      { timeout: 90_000 },
      async () => {
        const seeder = interactive();
        await seedTeam(seeder);
        const other = interactive();

        const driver = new PgWindowedBatchDriver(
          {
            placement: "between-premises-and-writes",
            returning: true,
            interleave: async () => {
              await other.member.update({
                where: { id: "m1" },
                data: { active: false },
              });
            },
          },
          { databaseUrl }
        );
        const client = boot(driver);

        await client.team.update({
          where: { id: "t1" },
          data: { members: { deleteMany: { active: true } } },
        });

        // The member is located by the key the capture named, so the filter it
        // no longer satisfies is not re-read at the effect.
        expect(driver.shape).toEqual([7, 6]);
        expect(await memberIds(seeder)).toEqual(["m3"]);
        expect(await connectedIds(seeder)).toEqual([]);
      }
    );

    test(
      "control: a truly irrelevant concurrent change in the same window changes nothing",
      { timeout: 90_000 },
      async () => {
        const seeder = interactive();
        await seedTeam(seeder);
        const other = interactive();

        const driver = new PgWindowedBatchDriver(
          {
            placement: "between-premises-and-writes",
            returning: true,
            interleave: async () => {
              await other.member.update({
                where: { id: "m3" },
                data: { label: "renamed" },
              });
            },
          },
          { databaseUrl }
        );
        const client = boot(driver);

        await client.team.update({
          where: { id: "t1" },
          data: { members: { deleteMany: { active: true } } },
        });

        expect(await memberIds(seeder)).toEqual(["m3"]);
        expect(await connectedIds(seeder)).toEqual([]);
        expect(
          (await seeder.member.findUnique({ where: { id: "m3" } }))?.label
        ).toBe("renamed");
        // The irrelevant change landed IN the premise -> write window, like
        // its siblings, and the unit's shape did not move.
        expect(driver.shape).toEqual([7, 6]);
        expect(driver.schedule).toEqual([
          "A: the atomic unit began",
          "A: every premise of the unit has answered",
          "B: committed BETWEEN the unit's last premise and its first write",
          "A: the unit's writes executed",
        ]);
      }
    );
  });
});
