/**
 * pg Driver Tests — the captured set's consumption-time contract, as D-65
 * decides it (FC-03's concern, FCPG's schedules, unit R3's implementation)
 *
 * FC-03 recorded an UNEXECUTED concern: "ordinary EXISTS premises followed by an
 * ID-only mutation do not alone prove the relevant membership still holds when
 * the effect executes". FCPG executed it here on real multi-connection
 * PostgreSQL and measured, on the batch route, one window between a unit's last
 * premise and its first write — for both consumers. D-65 (the decided closure
 * handoff §1, adopted in the ledger) settles what that window means, and these
 * cells measure the DECIDED contract, not the implementation that preceded it:
 *
 *  - CONSUMER 1, a root selected UPDATE/DELETE over a captured set: EFFECT-TIME
 *    SELECTION. The consuming statement carries both the complete captured
 *    identity set and the prepared selector the capture ran
 *    (`OperationContext.capturedTarget` through `Queries.includeIdentities`), so
 *    a captured row that no longer satisfies that selector is NOT mutated. The
 *    premises `requireCapturedSet` states ahead of the write are unchanged, and
 *    so is the cardinality check behind it: fewer rows affected than captured is
 *    the registered `<verb> selected-row cardinality changed during its locked
 *    mutation.` sentence — never a silent success publishing the captured rows.
 *  - FAILURE AND COMMIT ARE SEPARATE FACTS. On an operation-owned interactive
 *    transaction the owner rolls back. On an atomic batch that ALREADY
 *    ACKNOWLEDGED, the rows it committed stand and the failure says so:
 *    `atomicity: "segment"`, `phase: "result"`, `committedSegments`. A check
 *    after dispatch cannot undo the batch it judges, and nothing is replayed.
 *  - CONSUMER 2, a nested captured series under a membership: a BOUNDED
 *    WORKLIST. The initial filter SELECTS the members this series writes; it is
 *    not a permanent per-member predicate, so an earlier member may legally
 *    change what a later one was selected by, and a member that qualifies after
 *    the complement premise stays outside the worklist (no enlargement, no
 *    second recovery). What each member owes AT THE POSITION IT IS CONSUMED —
 *    its identity, its parent's, and its relation membership — is unchanged and
 *    still enforced.
 *  - The interactive route's capture takes `FOR UPDATE`, which holds the rows it
 *    READ. That is a row lock and not phantom exclusion: a row that joins the
 *    selection afterwards is outside the captured set on either route.
 *
 * Every cell asserts the OBSERVED result and the OBSERVED final table state, and
 * names the part of the contract it answers to.
 *
 * DEFAULT ROUTES AND FORCED PROFILES ARE KEPT APART. PostgreSQL's own route
 * answers a selected bulk mutation with RETURNING and captures nothing, so the
 * cells that reach the capture at all run a capability-forced non-RETURNING pg
 * driver (the MySQL / PlanetScale profile) against real PostgreSQL: the
 * concurrency, the locks, the statements and the provider are native, the
 * capability profile is not. The default route has cells of its own, and a
 * forced profile is never reported as a native MySQL or hosted-driver receipt.
 *
 * THE INTERLEAVINGS ARE ORDERED, NOT INVENTED. `PgWindowedBatchDriver` splits
 * one atomic batch at the boundary between its last premise and its first write
 * and lets connection B commit there, on the SAME connection and inside the SAME
 * transaction the engine asked for. PostgreSQL READ COMMITTED takes a fresh
 * snapshot per statement, so a commit landing between two statements of one
 * transaction is ordinary substrate behaviour; the hook only makes the moment
 * deterministic. The lock-held schedules use no hook at all: B holds an
 * uncommitted row lock, A blocks on it, and B commits while A's statement waits.
 *
 * NOTE: These tests require a running PostgreSQL database.
 * Skip in CI unless PostgreSQL is available.
 *
 * They run in a database of their own (`fcpg_closure`, created on the same
 * server from `PG_TEST_CONNECTION_STRING`): `syncLiveSchema` diffs against live
 * introspection, so pushing this file's models into a shared database would plan
 * a drop for every table that is not one of them.
 */

import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import type { QueryExecutionContext } from "@drivers/driver";
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

/** A COMPOUND identity: what the captured set has to carry completely. */
const ticket = s
  .model({
    tenant: s.string(),
    code: s.string(),
    active: s.boolean(),
  })
  .id(["tenant", "code"])
  .map("fcpg_tickets");

const schema = { note, team, member, ticket };

type FcpgClient = VibORMClient<VibORMConfig<typeof schema>>;

const OWN_TABLES = [
  "fcpg_team_members",
  "fcpg_teams",
  "fcpg_members",
  "fcpg_notes",
  "fcpg_tickets",
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

/**
 * The same non-RETURNING batch profile, recording every statement it sends.
 * A captured mutation that SUCCEEDS needs it: the question that cell answers is
 * WHICH statement produced the rows the caller was handed, and on this profile
 * the only one that can is the read-back issued after the write.
 */
class PgRecordingCapturingBatchDriver extends PgCapturingBatchDriver {
  readonly statements: string[] = [];

  protected override execute<T>(
    client: Pool | PoolClient,
    statement: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    return super.execute<T>(client, statement, params, context);
  }

  protected override executeRaw<T>(
    client: Pool | PoolClient,
    statement: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    return super.executeRaw<T>(client, statement, params, context);
  }
}

/** Does this batch entry mutate? The atomic write unit is the only batch that
 *  carries one; a planning level and a capture segment are reads only. */
const MUTATION_STATEMENT = /^\s*(?:insert|update|delete)\b/i;
const UPDATE_STATEMENT = /^\s*update\b/i;
const SELECT_STATEMENT = /^\s*select\b/i;

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

/** The registered sentence for a captured set the effect did not match. */
const CHANGED = (verb: string) =>
  `${verb} selected-row cardinality changed during its locked mutation.`;

interface Settled<T> {
  readonly value?: T;
  readonly error?: unknown;
}

/** An operation run for its OUTCOME, so a schedule can assert a rejection. */
const settle =
  <T>(run: () => PromiseLike<T>) =>
  (): Promise<Settled<T>> =>
    Promise.resolve(run()).then(
      (value): Settled<T> => ({ value }),
      (error: unknown): Settled<T> => ({ error })
    );

interface Progress {
  readonly atomicity?: string;
  readonly phase?: string;
  readonly committedSegments?: number;
}

/** What a failure says about the effects its batch already acknowledged. */
const progressOf = (error: unknown): Progress | undefined =>
  (error as { meta?: { recordSeriesProgress?: Progress } } | undefined)?.meta
    ?.recordSeriesProgress;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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

  async function seedTickets(client: FcpgClient): Promise<void> {
    await client.ticket.createMany({
      data: [
        { tenant: "t1", code: "a", active: true },
        { tenant: "t1", code: "b", active: true },
        { tenant: "t2", code: "a", active: false },
      ],
    });
  }

  const ticketKeys = async (client: FcpgClient) =>
    (await client.ticket.findMany())
      .map((row) => `${row.tenant}/${row.code}`)
      .sort();

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

  describe("consumer 1: a root selected bulk mutation over a captured set", () => {
    test(
      "default native route: nothing is captured, and the statement removes exactly the rows it still matches",
      { timeout: 90_000 },
      async () => {
        const seeder = interactive();
        await seedNotes(seeder);
        const client = interactive();

        // PostgreSQL's own route answers a selected deleteMany with RETURNING,
        // so there is no capture, no premise and no window to decide: the one
        // statement blocks on B's row and re-reads it when B commits.
        const { result, blocked } = await heldRowLockSchedule({
          probe: seeder,
          hold: async (tx) => {
            await tx.note.update({
              where: { id: "n1" },
              data: { active: false },
            });
          },
          operation: settle(() =>
            client.note.deleteMany({
              where: { active: true },
              select: { id: true, label: true },
            })
          ),
        });
        expect(blocked).toBe(true);

        expect(result.error).toBeUndefined();
        expect(result.value).toEqual([{ id: "n2", label: "two" }]);
        expect(await noteIds(seeder)).toEqual(["n1", "n3"]);
      }
    );

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

        // The lock the capture takes is what protects the rows it READ:
        // PostgreSQL re-evaluates the capture's predicate against the row
        // version B committed, so n1 was never captured and never deleted.
        expect(published).toEqual([{ id: "n2", label: "two" }]);
        expect(await noteIds(seeder)).toEqual(["n1", "n3"]);
      }
    );

    test(
      "batch route, lock held: the captured row that stopped matching survives the write, and the shortfall is the cardinality sentence",
      { timeout: 90_000 },
      async () => {
        const seeder = interactive();
        await seedNotes(seeder);
        const client = capturingBatch();

        // No FOR UPDATE on this route: the capture and the premises read the
        // OLD committed row and pass; the WRITE is what blocks on B's row.
        const { result, blocked } = await heldRowLockSchedule({
          probe: seeder,
          hold: async (tx) => {
            await tx.note.update({
              where: { id: "n1" },
              data: { active: false },
            });
          },
          operation: settle(() =>
            client.note.deleteMany({
              where: { active: true },
              select: { id: true, label: true },
            })
          ),
        });
        expect(blocked).toBe(true);

        // D-65: the DELETE carries the selector the capture ran, so the row
        // that stopped being a member before the write is NOT deleted, and the
        // rows it did not reach are the cardinality error — not a published
        // success over the captured set.
        expect(messageOf(result.error)).toContain(CHANGED("deleteMany"));
        expect(result.value).toBeUndefined();
        // Commit is the other fact: this batch ACKNOWLEDGED, so what it wrote
        // stands and is reported.
        expect(await noteIds(seeder)).toEqual(["n1", "n3"]);
        expect(
          (await seeder.note.findUnique({ where: { id: "n1" } }))?.active
        ).toBe(false);
        expect(progressOf(result.error)).toMatchObject({
          atomicity: "segment",
          phase: "result",
          committedSegments: 1,
        });
      }
    );

    test(
      "batch route: a captured row that stops matching between the last premise and the first write is not deleted, and the effects that committed are reported",
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

        const raised = await client.note
          .deleteMany({
            where: { active: true },
            select: { id: true, label: true },
          })
          .then(
            () => undefined,
            (error: unknown) => error
          );

        expect(driver.schedule).toEqual([
          "A: the atomic unit began",
          "A: every premise of the unit has answered",
          "B: committed BETWEEN the unit's last premise and its first write",
          "A: the unit's writes executed",
        ]);
        // The unit really did carry its premises ahead of its write.
        expect(driver.shape).toEqual([4, 3]);
        // The window D-65 decides: the premises answered honestly at their own
        // position, and the WRITE re-tested the selector at its own. n1 is not
        // deleted; n2, which still matched, is — and the batch acknowledged it.
        expect(messageOf(raised)).toContain(CHANGED("deleteMany"));
        expect(await noteIds(seeder)).toEqual(["n1", "n3"]);
        expect(progressOf(raised)).toMatchObject({
          atomicity: "segment",
          phase: "result",
          committedSegments: 1,
        });
      }
    );

    test(
      "batch route: a root UPDATE in the same window leaves the row that stopped matching untouched, and never reaches its non-RETURNING read-back",
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

        const raised = await client.note
          .updateMany({
            where: { active: true },
            data: { label: "renamed" },
            select: { id: true, label: true },
          })
          .then(
            () => undefined,
            (error: unknown) => error
          );

        expect(driver.shape).toEqual([4, 3]);
        expect(messageOf(raised)).toContain(CHANGED("updateMany"));
        // Both facts, measured: n1 keeps its label (the SET never reached it)
        // and n2 has the committed one. The selected form's read-back — the
        // non-RETURNING result path — is behind the cardinality answer and did
        // not run, so nothing was published for rows that were not written.
        const rows = await seeder.note.findMany({ orderBy: { id: "asc" } });
        expect(rows.map((row) => [row.id, row.label])).toEqual([
          ["n1", "one"],
          ["n2", "renamed"],
          ["n3", "three"],
        ]);
        expect(progressOf(raised)).toMatchObject({
          atomicity: "segment",
          phase: "result",
          committedSegments: 1,
        });
      }
    );

    test(
      "batch route: an undisturbed captured UPDATE succeeds, publishing the rows its non-RETURNING read-back produced",
      { timeout: 90_000 },
      async () => {
        const seeder = interactive();
        await seedNotes(seeder);
        const driver = new PgRecordingCapturingBatchDriver({ databaseUrl });
        const client = boot(driver);

        // The cell above measures the selected UPDATE when the cardinality
        // answer stops it BEFORE the result path. This is the other half of
        // the same route, undisturbed: every captured row still matches, the
        // write affects all of them, and the result is published through the
        // read-back a provider without RETURNING has to issue.
        const published = await client.note.updateMany({
          where: { active: true },
          data: { label: "renamed" },
          select: { id: true, label: true },
        });

        // The published labels are the ones the UPDATE WROTE, not the ones the
        // capture read — on this profile nothing but a read issued after the
        // write can answer `renamed`, so this is the read-back's own output.
        expect(published).toEqual([
          { id: "n1", label: "renamed" },
          { id: "n2", label: "renamed" },
        ]);

        const writeIndex = driver.statements.findIndex((statement) =>
          UPDATE_STATEMENT.test(statement)
        );
        expect(writeIndex).toBeGreaterThanOrEqual(0);
        // D-65's own half of it: the consuming UPDATE carries BOTH the captured
        // identity set and the prepared selector the capture ran.
        const write = driver.statements[writeIndex] ?? "";
        expect(write).toContain('"id"');
        expect(write).toContain('"active"');
        // And the read-back is a statement of its own, behind that write.
        expect(
          driver.statements
            .slice(writeIndex + 1)
            .some((statement) => SELECT_STATEMENT.test(statement))
        ).toBe(true);

        // The effect is the one the result claims.
        const rows = await seeder.note.findMany({ orderBy: { id: "asc" } });
        expect(rows.map((row) => [row.id, row.label])).toEqual([
          ["n1", "renamed"],
          ["n2", "renamed"],
          ["n3", "three"],
        ]);
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
        // The captured set IS the set this statement is about (D-65): a row
        // that joined after the capture is not one of its rows, the complement
        // premise answered before n4 existed, and nothing about n4 is claimed.
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
      "batch route: a LIMITED capture claims no complement, and a newly eligible row outside its slice is not mutated",
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
              // Newly eligible for the same filter, in the same window.
              await other.note.create({
                data: { id: "n4", label: "one", active: true },
              });
            },
          },
          { databaseUrl }
        );
        const client = boot(driver);

        const published = await client.note.deleteMany({
          where: { label: "one" },
          limit: 1,
          select: { id: true, label: true },
        });

        // One presence premise and the write: a limited capture took one valid
        // slice, so it states no complement — and the bound is the captured
        // set itself, which is why n4 is untouched rather than competing for
        // the limit.
        expect(driver.shape).toEqual([2, 1]);
        expect(published).toEqual([{ id: "n1", label: "one" }]);
        expect(await noteIds(seeder)).toEqual(["n2", "n3", "n4"]);
      }
    );

    test(
      "batch route: a COMPOUND captured identity is carried completely, and only the row that still matches is deleted",
      { timeout: 90_000 },
      async () => {
        const seeder = interactive();
        await seedTickets(seeder);
        const other = interactive();

        const driver = new PgWindowedBatchDriver(
          {
            placement: "between-premises-and-writes",
            returning: false,
            interleave: async () => {
              await other.ticket.updateMany({
                where: { tenant: "t1", code: "a" },
                data: { active: false },
              });
            },
          },
          { databaseUrl }
        );
        const client = boot(driver);

        const raised = await client.ticket
          .deleteMany({
            where: { active: true },
            select: { tenant: true, code: true },
          })
          .then(
            () => undefined,
            (error: unknown) => error
          );

        expect(driver.shape).toEqual([4, 3]);
        expect(messageOf(raised)).toContain(CHANGED("deleteMany"));
        // t1/a stopped matching and survives with BOTH key components intact;
        // t1/b still matched and was deleted; t2/a was never in the selection.
        expect(await ticketKeys(seeder)).toEqual(["t1/a", "t2/a"]);
        expect(progressOf(raised)).toMatchObject({
          atomicity: "segment",
          phase: "result",
          committedSegments: 1,
        });
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

        // The premises are unchanged by D-65 and still live: a capture already
        // stale when the unit begins aborts it before any write.
        await expect(
          client.note.deleteMany({
            where: { active: true },
            select: { id: true, label: true },
          })
        ).rejects.toThrow(CHANGED("deleteMany"));
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
        // against the larger set and converges. That is the boundary D-65
        // bounds the worklist AT — it is a live guard, not a missing one.
        expect(driver.schedule).toEqual([
          "A: the atomic unit began",
          "B: committed BEFORE the unit's first premise",
        ]);
        expect(await memberIds(seeder)).toEqual([]);
        expect(await connectedIds(seeder)).toEqual([]);
      }
    );

    test(
      "batch route: a member added after that boundary stays outside the captured worklist",
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

        // D-65, the nested bound: the captured worklist is the members the
        // complement premise answered for. A member that qualifies after it
        // neither enlarges the worklist nor earns a second recovery, so m3
        // survives, still connected — and the operation succeeds, because no
        // claim was made about it. (No predicate on the delete could see it:
        // it is a row that did not exist in the set when the set was fixed.)
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
      "batch route: the initial filter selected the worklist and is not re-asked at each member's own write",
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

        // D-65, the nested bound: the member is located by the key the capture
        // named and by the membership it is consumed through; the arbitrary
        // filter that SELECTED it is not a lasting per-member predicate, so m1
        // is deleted. This is the decided difference from consumer 1, whose ONE
        // set statement carries its own selector to its own effect.
        expect(driver.shape).toEqual([7, 6]);
        expect(await memberIds(seeder)).toEqual(["m3"]);
        expect(await connectedIds(seeder)).toEqual([]);
      }
    );

    test(
      "batch route: a member whose required membership was reassigned is not deleted for the parent that no longer holds it",
      { timeout: 90_000 },
      async () => {
        const seeder = interactive();
        await seedTeam(seeder);
        await seeder.team.create({ data: { id: "t2", name: "Other" } });
        const other = interactive();

        const driver = new PgWindowedBatchDriver(
          {
            placement: "before-premises",
            returning: true,
            interleave: async () => {
              await other.team.update({
                where: { id: "t1" },
                data: { members: { disconnect: { id: "m1" } } },
              });
              await other.team.update({
                where: { id: "t2" },
                data: { members: { connect: { id: "m1" } } },
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

        // The membership each member is CONSUMED through is still required at
        // its own boundary: m1 moved to another parent, the premise that says
        // "still a member of t1" rejects raceably, and the one recovery
        // re-plans against t1's current members. D-65 bounds the worklist; it
        // is not permission to delete another parent's member after it moves.
        expect(await memberIds(seeder)).toEqual(["m1", "m3"]);
        expect(
          (
            (
              await seeder.team.findUnique({
                where: { id: "t2" },
                include: { members: true },
              })
            )?.members ?? []
          ).map((row) => row.id)
        ).toEqual(["m1"]);
        expect(await connectedIds(seeder)).toEqual([]);
      }
    );

    test(
      "default native route: an earlier member's own write does not invalidate the worklist a sibling was selected into",
      { timeout: 90_000 },
      async () => {
        const seeder = interactive();
        await seedTeam(seeder);
        const client = interactive();

        // The first member's update makes the second stop matching the filter
        // that selected it. D-65: the filter selected the worklist, so both
        // captured members are written and no member re-reads the filter.
        await client.team.update({
          where: { id: "t1" },
          data: {
            members: {
              updateMany: { where: { active: true }, data: { active: false } },
            },
          },
        });

        const rows = await seeder.member.findMany({ orderBy: { id: "asc" } });
        expect(rows.map((row) => [row.id, row.active])).toEqual([
          ["m1", false],
          ["m2", false],
          ["m3", true],
        ]);
        expect(await connectedIds(seeder)).toEqual(["m1", "m2"]);
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
