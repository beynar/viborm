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
 *    That answer is settled BEFORE the write-outcome hold is released, so a
 *    client listener that failed while this batch acknowledged is retained
 *    beside the operation's own failure rather than published in its place
 *    (`retainWriteOutcomeFailure`; repair prompt §3).
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

/** A REFERENCE membership, and one depth above the junction one: the member
 *  row holds its parent's key, so its membership and its identity are the same
 *  row, and its own body carries a second captured series. */
const org = s
  .model({
    id: s.string().id(),
    name: s.string(),
    teams: s.toMany(() => team),
  })
  .map("fcpg_orgs");

const team = s
  .model({
    id: s.string().id(),
    name: s.string(),
    active: s.boolean().default(true),
    orgId: s.string().nullable(),
    org: s
      .toOne(() => org)
      .fields("orgId")
      .references("id"),
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

const schema = { note, org, team, member, ticket };

type FcpgClient = VibORMClient<VibORMConfig<typeof schema>>;

const OWN_TABLES = [
  "fcpg_team_members",
  "fcpg_teams",
  "fcpg_orgs",
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

// --------------------------------------- the write-outcome rail that FAILS

/** What the client's listener throws when this batch acknowledges. */
const OUTCOME_THREW = "closure-repair write-outcome listener failed";
/** The publication owner's own sentence for it (`@extensions/query`). */
const LISTENER_FAILED =
  'Extension "failing-outcome" write-outcome listener failed after committed.';
/** The one composition of a primary with a retained listener failure
 *  (`retainWriteOutcomeFailure`, `@errors`). */
const COMPOSED = "Query execution and write-outcome publication both failed.";

/**
 * A listener on the write-outcome rail that fails exactly where the batch
 * transport HOLDS it: it is registered before the operation proceeds and throws
 * when the batch acknowledges its committed segment, which on this route
 * happens BEFORE the operation has answered for that batch.
 */
const withFailingOutcome = (client: FcpgClient) =>
  client.$extends({
    name: "failing-outcome",
    query: {
      note: {
        deleteMany({ onWriteOutcome, proceed }) {
          onWriteOutcome(() => {
            throw new Error(OUTCOME_THREW);
          });
          return proceed();
        },
        updateMany({ onWriteOutcome, proceed }) {
          onWriteOutcome(() => {
            throw new Error(OUTCOME_THREW);
          });
          return proceed();
        },
      },
    },
  });

/**
 * The composition, read as the estate's ONE composition states it
 * (`retainWriteOutcomeFailure`, `@errors`): one aggregate whose primary is the
 * OPERATION's own failure BY IDENTITY — `cause` and `errors[0]` are the same
 * object — with the listener's failure retained beside it, never discarded,
 * never re-wrapped into the operation's and never primary itself.
 */
const composition = (raised: unknown) => {
  const aggregate = raised instanceof AggregateError ? raised : undefined;
  return {
    message: aggregate?.message,
    errorCount: aggregate?.errors.length,
    primaryIsCause:
      aggregate !== undefined && aggregate.cause === aggregate.errors[0],
    primary: aggregate?.errors[0],
    retained: aggregate?.errors[1],
  };
};

/**
 * The listener's failure as the EXISTING error model carries it: the
 * publication owner's own `QueryError`, naming the extension, the method and
 * the certainty, with the value the listener threw kept as its cause — whose
 * message this estate's diagnostics redact by design (`sanitizeErrorCause`),
 * which is why the identifying facts are the class and the meta.
 */
const listenerFailure = (failure: unknown) => ({
  name: failure instanceof Error ? failure.name : undefined,
  message: messageOf(failure),
  meta: (failure as { meta?: unknown } | undefined)?.meta,
  keepsCause:
    (failure as { originalCause?: unknown } | undefined)
      ?.originalCause instanceof Error,
});

/** What every combined failure of this file must say about its composition. */
const COMPOSITION = {
  message: COMPOSED,
  errorCount: 2,
  primaryIsCause: true,
};

/** What every retained listener failure of this file must say about itself. */
const RETAINED_LISTENER = {
  name: "QueryError",
  message: LISTENER_FAILED,
  meta: { method: "onWriteOutcome", commitCertainty: "committed" },
  keepsCause: true,
};

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

  /** Two teams of one org, each with its own junction members: the outer
   *  captured series is a REFERENCE membership and each of its members carries
   *  a captured series of its own. */
  async function seedOrg(client: FcpgClient): Promise<void> {
    await client.org.createMany({
      data: [
        { id: "o1", name: "One" },
        { id: "o2", name: "Two" },
      ],
    });
    await client.member.createMany({
      data: [
        { id: "m1", label: "one", active: true },
        { id: "m2", label: "two", active: true },
        { id: "m3", label: "three", active: true },
        { id: "m4", label: "four", active: true },
      ],
    });
    await client.team.createMany({
      data: [
        { id: "t1", name: "Team", active: true, orgId: "o1" },
        { id: "t2", name: "Other", active: true, orgId: "o1" },
      ],
    });
    await client.team.update({
      where: { id: "t1" },
      data: { members: { connect: [{ id: "m1" }, { id: "m2" }] } },
    });
    await client.team.update({
      where: { id: "t2" },
      data: { members: { connect: [{ id: "m3" }, { id: "m4" }] } },
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
      "batch route: a held write-outcome listener failure does not take the captured DELETE's cardinality answer with it",
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
        // The same schedule as the cell above, with the client's write-outcome
        // rail failing on the acknowledgement this batch makes BEFORE it has
        // answered. Both failures are real and neither may eat the other.
        const client = withFailingOutcome(boot(driver));

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
        expect(driver.shape).toEqual([4, 3]);
        // The OPERATION's own answer is settled before the hold is released,
        // so the cardinality failure is the primary and the listener's is
        // retained beside it — not the other way round, and neither is lost.
        expect(raised).toBeInstanceOf(AggregateError);
        const composed = composition(raised);
        expect(composed).toMatchObject(COMPOSITION);
        expect(messageOf(composed.primary)).toContain(CHANGED("deleteMany"));
        expect(listenerFailure(composed.retained)).toMatchObject(
          RETAINED_LISTENER
        );
        // And the primary still carries what the batch committed: the answer
        // that failed is a RESULT-phase failure over an acknowledged segment.
        expect(progressOf(composed.primary)).toMatchObject({
          atomicity: "segment",
          phase: "result",
          committedSegments: 1,
        });
        // Exact committed state, and the proof that nothing was retried: a
        // re-planned second pass would capture `active: true` again — n1 is
        // inactive and n2 is gone, so it would capture nothing and publish an
        // empty success. The caller was handed a failure instead, and n2 alone
        // is missing, so the acknowledged work was neither replayed nor undone.
        expect(await noteIds(seeder)).toEqual(["n1", "n3"]);
        expect(
          (await seeder.note.findUnique({ where: { id: "n1" } }))?.active
        ).toBe(false);
      }
    );

    test(
      "batch route: a held write-outcome listener failure does not take the captured UPDATE's cardinality answer with it",
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
        const client = withFailingOutcome(boot(driver));

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
        expect(raised).toBeInstanceOf(AggregateError);
        const composed = composition(raised);
        expect(composed).toMatchObject(COMPOSITION);
        expect(messageOf(composed.primary)).toContain(CHANGED("updateMany"));
        expect(listenerFailure(composed.retained)).toMatchObject(
          RETAINED_LISTENER
        );
        expect(progressOf(composed.primary)).toMatchObject({
          atomicity: "segment",
          phase: "result",
          committedSegments: 1,
        });
        // The same exact state the undisturbed schedule leaves: n1 untouched,
        // n2 written once. The non-RETURNING read-back is behind the answer and
        // still did not run, so no result was published for either row.
        const rows = await seeder.note.findMany({ orderBy: { id: "asc" } });
        expect(rows.map((row) => [row.id, row.label])).toEqual([
          ["n1", "one"],
          ["n2", "renamed"],
          ["n3", "three"],
        ]);
      }
    );

    test(
      "batch route: a listener that fails beside a captured answer that SUCCEEDED is still published alone",
      { timeout: 90_000 },
      async () => {
        const seeder = interactive();
        await seedNotes(seeder);
        // No racer: every captured row still matches at the effect, so the
        // operation's own answer is a success and the only failure in the
        // window is the listener's.
        const client = withFailingOutcome(capturingBatch());

        const result = await settle(() =>
          client.note.deleteMany({
            where: { active: true },
            select: { id: true, label: true },
          })
        )();

        // Published alone, in its own class: no aggregate, and above all no
        // cardinality sentence invented for an answer that did not fail.
        expect(result.value).toBeUndefined();
        expect(result.error).not.toBeInstanceOf(AggregateError);
        expect(listenerFailure(result.error)).toMatchObject(RETAINED_LISTENER);
        // A listener failure beside a successful answer is not the operation's
        // own record-series failure, so it carries no progress — unchanged.
        expect(progressOf(result.error)).toBeUndefined();
        // The write is durable and complete: the failure is the listener's.
        expect(await noteIds(seeder)).toEqual(["n3"]);
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
        // Repair prompt §2: two statements more than the reviewed source in
        // front of the first write — the first member's own held requirement
        // and the junction row that stores it.
        expect(driver.shape).toEqual([9, 8]);
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
                where: { id: "m2" },
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
        // filter that SELECTED it is not a lasting per-member predicate, so m2
        // is deleted. This is the decided difference from consumer 1, whose ONE
        // set statement carries its own selector to its own effect.
        //
        // The filter change lands on the member whose own write is still
        // AHEAD (repair prompt §2): m1's row and membership are held for m1's
        // write by the time this window opens, so a concurrent change to m1
        // would now wait for this unit rather than interleave with it — the
        // guarantee the interactive route's `FOR UPDATE` capture always gave.
        // m2 is where the claim is still measurable, and it is the position
        // that matters: the filter is not re-asked at the member's OWN write.
        expect(driver.shape).toEqual([9, 8]);
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
      "batch route: a member reassigned between the last premise and its OWN write is not deleted, and the segment that committed is reported",
      { timeout: 90_000 },
      async () => {
        const seeder = interactive();
        await seedTeam(seeder);
        await seeder.team.create({ data: { id: "t2", name: "Other" } });
        const other = interactive();

        // The window the review measured, moved to the member the unit has not
        // reached yet: when it opens, m1's membership is already held for m1's
        // own write, and m2's is not yet taken — so the reassignment commits
        // there, exactly as it did on the reviewed source.
        const driver = new PgWindowedBatchDriver(
          {
            placement: "between-premises-and-writes",
            returning: true,
            interleave: async () => {
              await other.team.update({
                where: { id: "t1" },
                data: { members: { disconnect: { id: "m2" } } },
              });
              await other.team.update({
                where: { id: "t2" },
                data: { members: { connect: { id: "m2" } } },
              });
            },
          },
          { databaseUrl }
        );
        const client = boot(driver);

        const raised = await settle(() =>
          client.team.update({
            where: { id: "t1" },
            data: { members: { deleteMany: { active: true } } },
          })
        )();

        // The repair prompt §2: the membership a member is CONSUMED through is
        // held through its own write. m1 was consumed before the window and is
        // gone; m2 moved to t2 inside it and is not deleted for t1. What the
        // unit already acknowledged stands, and the failure says so.
        expect(await memberIds(seeder)).toEqual(["m2", "m3"]);
        expect(
          (
            (
              await seeder.team.findUnique({
                where: { id: "t2" },
                include: { members: true },
              })
            )?.members ?? []
          ).map((row) => row.id)
        ).toEqual(["m2"]);
        expect(await connectedIds(seeder)).toEqual([]);
        expect(messageOf(raised.error)).toBe(
          "Cannot delete relation 'members': a member was removed after the plan-time read; retry to converge."
        );
        expect(progressOf(raised.error)).toMatchObject({
          atomicity: "segment",
          phase: "member",
          committedSegments: 1,
        });
      }
    );

    test(
      "batch route: a member reassigned between the last premise and its OWN write is not UPDATED for the parent that no longer holds it",
      { timeout: 90_000 },
      async () => {
        const seeder = interactive();
        await seedTeam(seeder);
        await seeder.team.create({ data: { id: "t2", name: "Other" } });
        const other = interactive();

        const driver = new PgWindowedBatchDriver(
          {
            placement: "between-premises-and-writes",
            returning: true,
            interleave: async () => {
              await other.team.update({
                where: { id: "t1" },
                data: { members: { disconnect: { id: "m2" } } },
              });
              await other.team.update({
                where: { id: "t2" },
                data: { members: { connect: { id: "m2" } } },
              });
            },
          },
          { databaseUrl }
        );
        const client = boot(driver);

        const raised = await settle(() =>
          client.team.update({
            where: { id: "t1" },
            data: {
              members: {
                updateMany: {
                  where: { active: true },
                  data: { label: "renamed" },
                },
              },
            },
          })
        )();

        // The same requirement, the other verb: a captured UPDATE member owes
        // its membership at the position it is consumed (repair prompt §2).
        const rows = await seeder.member.findMany({ orderBy: { id: "asc" } });
        expect(rows.map((row) => [row.id, row.label])).toEqual([
          ["m1", "renamed"],
          ["m2", "two"],
          ["m3", "three"],
        ]);
        expect(messageOf(raised.error)).toBe(
          "Cannot update relation 'members': target record was not found for this parent."
        );
        expect(progressOf(raised.error)).toMatchObject({
          atomicity: "segment",
          phase: "member",
          committedSegments: 1,
        });
      }
    );

    test(
      "batch route, lock held: a reassignment the member's own requirement waits behind is observed, and the retry converges",
      { timeout: 90_000 },
      async () => {
        const seeder = interactive();
        await seedTeam(seeder);
        await seeder.team.create({ data: { id: "t2", name: "Other" } });
        // The batch route with its ordinary RETURNING profile, and a hook that
        // does nothing: the schedule here is B's own held row lock, not an
        // interleaving the driver plants.
        const client = boot(
          new PgWindowedBatchDriver(
            {
              placement: "before-premises",
              returning: true,
              interleave: async () => {
                // nothing: B's uncommitted lock is the whole schedule
              },
            },
            { databaseUrl }
          )
        );

        // B holds the reassignment UNCOMMITTED while A runs, so
        // A's capture and its plan-time premises read the OLD committed
        // membership and A's own requirement is what waits behind B's commit.
        // A stale cross-table snapshot would answer "still a member" here.
        const { result, blocked } = await heldRowLockSchedule({
          probe: seeder,
          hold: async (tx) => {
            await tx.team.update({
              where: { id: "t1" },
              data: { members: { disconnect: { id: "m1" } } },
            });
            await tx.team.update({
              where: { id: "t2" },
              data: { members: { connect: { id: "m1" } } },
            });
          },
          operation: settle(() =>
            client.team.update({
              where: { id: "t1" },
              data: { members: { deleteMany: { active: true } } },
            })
          ),
        });

        expect(blocked).toBe(true);
        // Nothing was acknowledged, so the raceable loss is recoverable: the
        // one re-plan reads the membership the race produced and deletes the
        // member t1 still holds. m1 belongs to t2 and is untouched.
        expect(result.error).toBeUndefined();
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
      "batch route, lock held: a captured UPDATE member's own requirement waits behind the reassignment it must observe",
      { timeout: 90_000 },
      async () => {
        const seeder = interactive();
        await seedTeam(seeder);
        await seeder.team.create({ data: { id: "t2", name: "Other" } });
        const client = boot(
          new PgWindowedBatchDriver(
            {
              placement: "before-premises",
              returning: true,
              interleave: async () => {
                // nothing: B's uncommitted lock is the whole schedule
              },
            },
            { databaseUrl }
          )
        );

        const { result, blocked } = await heldRowLockSchedule({
          probe: seeder,
          hold: async (tx) => {
            await tx.team.update({
              where: { id: "t1" },
              data: { members: { disconnect: { id: "m1" } } },
            });
            await tx.team.update({
              where: { id: "t2" },
              data: { members: { connect: { id: "m1" } } },
            });
          },
          operation: settle(() =>
            client.team.update({
              where: { id: "t1" },
              data: {
                members: {
                  updateMany: {
                    where: { active: true },
                    data: { label: "renamed" },
                  },
                },
              },
            })
          ),
        });

        // The UPDATE member's requirement already stood at its consumption
        // position; what it lacked was the HOLD, so it read the old committed
        // membership and the write behind it waited on B and then wrote m1 as
        // t1's member anyway (repair prompt §2).
        expect(blocked).toBe(true);
        // Its own failure and attribution, unchanged (repair prompt §1.4): a
        // captured UPDATE member names its row by the selector that located
        // it, so its loss is the identity sentence and NOT the raceable one —
        // a re-plan would act on whatever that selector answers now (D-34).
        expect(messageOf(result.error)).toBe(
          "Cannot update relation 'members': target record was not found for this parent."
        );
        expect(result.value).toBeUndefined();
        // Truthful progress: the requirement is lost in front of the FIRST
        // write of the unit, so nothing was acknowledged and there is no
        // record-series progress to report.
        expect(progressOf(result.error)).toBeUndefined();
        const rows = await seeder.member.findMany({ orderBy: { id: "asc" } });
        expect(rows.map((row) => [row.id, row.label])).toEqual([
          ["m1", "one"],
          ["m2", "two"],
          ["m3", "three"],
        ]);
      }
    );

    test(
      "batch route: a LATER member reassigned before the unit's premises aborts it before any write, and the retry converges",
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
                data: { members: { disconnect: { id: "m2" } } },
              });
              await other.team.update({
                where: { id: "t2" },
                data: { members: { connect: { id: "m2" } } },
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

        // The capture-position premise keeps its own coverage: a member already
        // lost when the unit begins aborts the WHOLE unit before any write, so
        // the one re-plan still converges instead of reporting a committed
        // segment. Deleting it would delete m1 first and refuse m2 afterwards.
        expect(await memberIds(seeder)).toEqual(["m2", "m3"]);
        expect(
          (
            (
              await seeder.team.findUnique({
                where: { id: "t2" },
                include: { members: true },
              })
            )?.members ?? []
          ).map((row) => row.id)
        ).toEqual(["m2"]);
        expect(await connectedIds(seeder)).toEqual([]);
      }
    );

    test(
      "batch route: a REFERENCE member reassigned in the window is not written as this parent's, and the series it carries never runs",
      { timeout: 90_000 },
      async () => {
        const seeder = interactive();
        await seedOrg(seeder);
        const other = interactive();

        // The same requirement one depth up, where the substrate stores it
        // differently: an org's team holds its own membership in its own row,
        // so the held premise over that row proves it, holds it and proves the
        // row is there in ONE statement — no junction row to take.
        const driver = new PgWindowedBatchDriver(
          {
            placement: "between-premises-and-writes",
            returning: true,
            interleave: async () => {
              await other.team.update({
                where: { id: "t2" },
                data: { orgId: "o2" },
              });
            },
          },
          { databaseUrl }
        );
        const client = boot(driver);

        const raised = await settle(() =>
          client.org.update({
            where: { id: "o1" },
            data: {
              teams: {
                updateMany: {
                  where: { active: true },
                  data: { members: { deleteMany: { active: true } } },
                },
              },
            },
          })
        )();

        // t1 was consumed before the window: its own captured series ran and
        // its members are gone. t2 left o1 inside it, so it is not written as
        // o1's team AND the second-depth series it carries never runs.
        expect(await memberIds(seeder)).toEqual(["m3", "m4"]);
        expect(
          (await seeder.team.findUnique({ where: { id: "t2" } }))?.orgId
        ).toBe("o2");
        expect(messageOf(raised.error)).toBe(
          "Cannot update relation 'teams': target record was not found for this parent."
        );
        // Two segments acknowledged (t1's two member deletions), and the
        // failure says so rather than erasing them (D-51).
        expect(progressOf(raised.error)).toMatchObject({
          atomicity: "segment",
          committedSegments: 2,
        });
      }
    );

    test(
      "batch route, lock held: a REFERENCE member's own requirement waits behind the reassignment it must observe",
      { timeout: 90_000 },
      async () => {
        const seeder = interactive();
        await seedOrg(seeder);
        const client = boot(
          new PgWindowedBatchDriver(
            {
              placement: "before-premises",
              returning: true,
              interleave: async () => {
                // nothing: B's uncommitted lock is the whole schedule
              },
            },
            { databaseUrl }
          )
        );

        const { result, blocked } = await heldRowLockSchedule({
          probe: seeder,
          hold: async (tx) => {
            await tx.team.update({
              where: { id: "t1" },
              data: { orgId: "o2" },
            });
          },
          operation: settle(() =>
            client.org.update({
              where: { id: "o1" },
              data: {
                teams: {
                  updateMany: {
                    where: { active: true },
                    data: {
                      name: "renamed",
                      members: { deleteMany: { active: true } },
                    },
                  },
                },
              },
            })
          ),
        });

        // A reference membership is a column of the member's OWN row, so the
        // held premise over that row is the whole protection: the substrate
        // re-evaluates a blocked read's qualification against the updated
        // target row, and the row it waited for no longer names o1.
        expect(blocked).toBe(true);
        expect(messageOf(result.error)).toBe(
          "Cannot update relation 'teams': target record was not found for this parent."
        );
        // In front of the FIRST write of the unit: nothing is renamed, no
        // member of either team is deleted, and there is no progress to report.
        expect(progressOf(result.error)).toBeUndefined();
        expect(await memberIds(seeder)).toEqual(["m1", "m2", "m3", "m4"]);
        const t1 = await seeder.team.findUnique({ where: { id: "t1" } });
        expect([t1?.name, t1?.orgId]).toEqual(["Team", "o2"]);
      }
    );

    test(
      "default native route: the capture's FOR UPDATE holds the member ROW, and the junction it is consumed through is held too",
      { timeout: 90_000 },
      async () => {
        const seeder = interactive();
        await seedTeam(seeder);
        await seeder.team.create({ data: { id: "t2", name: "Other" } });
        const client = interactive();

        // The interactive route's capture takes `FOR UPDATE`, which holds the
        // member ROWS it read — and nothing else. A junction membership lives
        // in a row of its own that no lock on the member reaches, so B can
        // disconnect m1 while A holds m1 (repair prompt §2). B holds that
        // disconnect uncommitted; A's own requirement is what waits behind it.
        const { result, blocked } = await heldRowLockSchedule({
          probe: seeder,
          hold: async (tx) => {
            // The junction ROW alone, and nothing else: an ordinary
            // `disconnect` locates the member first, so its own lock would
            // make the capture wait and re-read. This is the change a lock on
            // the member row cannot see.
            await tx.$executeRawUnsafe(
              "DELETE FROM fcpg_team_members WHERE team_ref = 't1' AND member_ref = 'm1'"
            );
          },
          operation: settle(() =>
            client.team.update({
              where: { id: "t1" },
              data: { members: { deleteMany: { active: true } } },
            })
          ),
        });

        expect(blocked).toBe(true);
        // The requirement is lost in front of every write of an
        // operation-owned interactive transaction, so its owner rolls back:
        // nothing is deleted, m1 keeps the membership the race left it, and
        // the failure is the raceable one its caller may retry on.
        expect(messageOf(result.error)).toBe(
          "Cannot delete relation 'members': a member was removed after the plan-time read; retry to converge."
        );
        expect(await memberIds(seeder)).toEqual(["m1", "m2", "m3"]);
        expect(await connectedIds(seeder)).toEqual(["m2"]);
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
        // its siblings, and the unit's shape is the repaired one (§2): the
        // first member's held requirement and its junction row.
        expect(driver.shape).toEqual([9, 8]);
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
