/**
 * MySQL2 concurrency policy — the three facts a deadlock repair must keep apart.
 *
 * A database-selected deadlock victim is a FAILED TRANSACTION. It is not a
 * rejected unique INSERT, and it is not an operation the engine may quietly run
 * again. The engine already separates the two at the driver boundary —
 * `ER_DUP_ENTRY` (1062) normalizes to `UniqueConstraintError`, which is the
 * signal `CommandExecution.recover` converges on, and `ER_LOCK_DEADLOCK` (1213)
 * normalizes to a `TransactionError` carrying `VibORMErrorCode.DEADLOCK`, which
 * nothing recovers. What the engine used to do was MANUFACTURE the second from
 * the first: an `upsert` / `connectOrCreate` probe asked for `FOR UPDATE`, and
 * MySQL answers a miss on a unique index with a gap lock over the index
 * supremum. Two racers were GRANTED that same gap lock at once, and the
 * insert-intention each then requested waited for the other's gap — a cycle
 * InnoDB breaks by aborting one whole transaction. Both schedules are measured
 * under `g4/release/closure-final/r2c/receipts/`.
 *
 * So the probe of an arm that INSERTS the key it just looked for no longer
 * locks that absence (`Selection.insertsWhenAbsent`), and the three groups
 * below state what must remain true afterwards:
 *
 *  1. an eligible unique-key race converges, on the producer the selector
 *     names, with ONE admission of the create arm and the correct winner;
 *  2. a real deadlock — two transactions taking two ROW locks in opposite
 *     order through the public client — still fails VISIBLY, with no committed
 *     victim effects, no replay, and a correct survivor;
 *  3. a BORROWED transaction keeps its caller's ownership: the member's own
 *     savepoint and nothing else — no retry, no replacement transaction, and
 *     the caller decides what happens next.
 *
 * A fourth section states what the withdrawal COSTS, because a statement is
 * chosen before its own answer is known: the probe reads unlocked in BOTH
 * outcomes, so a row it FINDS is not held BY THAT PROBE for the arm that
 * follows. That section has THREE rows, one per shape that pays it: a root
 * `upsert`'s found arm; a CHILD-HELD nested `connectOrCreate`, whose found arm
 * exists only to write the child's foreign key and demands nothing back at
 * all; and a nested to-ONE `upsert`, whose found arm carries the caller's
 * payload but no `where`, so no found membership confirmation is built for it
 * from its own payload.
 *
 * What answers all three is the shared FOUND-consumption rule (the repair
 * prompt §1, `CommandExecution.confirmFound`): ONE locked confirmation of the
 * found row, addressed by identity and taken between the observation and every
 * arm, carrying the requirement the operation already owns. So these three
 * schedules plant where that window now is — before the confirmation, which is
 * exactly where the effect used to be — and the loss is reported there, with
 * each arm's own sentence and nothing written. The readers those rows used to
 * name stay behind it: the CURRENT stored-row read `OperationContext.update`
 * issues of the row it has just written, and the target keys `RelationBody`
 * gives an arm whose probe did not lock, which are what answer where a
 * provider's select assembly takes no lock at all. What that rule must NOT
 * disturb is the whole of the first three sections, and it does not: a probe
 * that MISSES still locks nothing, which is the deadlock those sections are
 * about.
 *
 * NOTE: These tests require a running MySQL database (e.g. docker).
 * Set MYSQL_TEST_CONNECTION_STRING to enable.
 */

import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { QueryExecutionContext } from "@drivers/driver";
import { MySQL2Driver } from "@drivers/mysql2";
import type { QueryResult } from "@drivers/types";
import {
  TransactionError,
  UniqueConstraintError,
  VibORMErrorCode,
} from "@errors";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import type { Pool, PoolConnection } from "mysql2/promise";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { dropEveryLiveTable, TEST_CONNECTION_STRING } from "./mysql2-fixtures";

const schema = (() => {
  const tag = s
    .model({
      id: s.string().id(),
      name: s.string().unique(),
      slug: s.string().unique(),
      count: s.int().default(0),
    })
    .map("r2c_policy_tags");

  const author = s
    .model({
      id: s.string().id(),
      name: s.string(),
      posts: s.toMany(() => post),
    })
    .map("r2c_policy_authors");

  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      authorId: s.string().nullable(),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id"),
    })
    .map("r2c_policy_posts");

  // The to-ONE inverse side: the CHILD holds the reference, and the parent's
  // nested `upsert` of it carries no `where` of its own. That is the third
  // shape the withdrawn probe lock reaches, and section 4's third row.
  const owner = s
    .model({
      id: s.string().id(),
      name: s.string(),
      profile: s.toOne(() => profile),
    })
    .map("r2c_policy_owners");

  const profile = s
    .model({
      id: s.string().id(),
      bio: s.string().nullable(),
      ownerId: s.string().unique().nullable(),
      owner: s
        .toOne(() => owner)
        .fields("ownerId")
        .references("id"),
    })
    .map("r2c_policy_profiles");

  return { tag, author, post, owner, profile };
})();

type PolicyConfig = VibORMConfig<typeof schema>;
type PolicyClient = VibORMClient<PolicyConfig>;

type StatementHook = (statement: string) => void | Promise<void>;

/**
 * A driver that records every statement it sends and the provider client it
 * sent it on, and can run an arbitrary callback immediately BEFORE a chosen
 * statement. The callback is what turns a race into a SCHEDULE: the planting
 * client commits the winner on its own connection while the loser's
 * transaction is open and its plan-time probe has already answered "absent".
 * Under the old locking probe that planting INSERT would wait on the loser's
 * gap lock, so these rows also fail if the probe starts locking again.
 */
class RecordingMySQL2Driver extends MySQL2Driver {
  readonly statements: string[] = [];
  readonly providerClients: Array<Pool | PoolConnection> = [];
  private readonly before: StatementHook | undefined;

  constructor(hooks: { beforeStatement?: StatementHook } = {}) {
    // The URL's path binds the namespace and a docker MySQL reached directly is
    // not behind a rewriting proxy, so the attestation is true by construction
    // here — the same one every sibling fixture in this directory states.
    super({
      databaseUrl: TEST_CONNECTION_STRING,
      migrationNamespaceAttestation: "non-redirecting",
    });
    this.before = hooks.beforeStatement;
  }

  private async record(
    client: Pool | PoolConnection,
    statement: string
  ): Promise<void> {
    this.providerClients.push(client);
    this.statements.push(statement);
    await this.before?.(statement);
  }

  protected override async execute<T>(
    client: Pool | PoolConnection,
    statement: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    await this.record(client, statement);
    return await super.execute<T>(client, statement, params, context);
  }

  protected override async executeRaw<T>(
    client: Pool | PoolConnection,
    statement: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    await this.record(client, statement);
    return await super.executeRaw<T>(client, statement, params, context);
  }
}

const TAG_TABLE = /`?r2c_policy_tags`?/;
const AUTHOR_TABLE = /`?r2c_policy_authors`?/;
const POST_TABLE = /`?r2c_policy_posts`?/;
const PROFILE_TABLE = /`?r2c_policy_profiles`?/;
const MUTATION = /^(?:INSERT|UPDATE|DELETE)\b/i;
const SAVEPOINT_OPEN = /^SAVEPOINT /i;
const SAVEPOINT_ROLLBACK = /^ROLLBACK TO SAVEPOINT /i;
const SAVEPOINT_RELEASE = /^RELEASE SAVEPOINT /i;
const ANY_SAVEPOINT = /\bSAVEPOINT\b/i;
const FOR_UPDATE = /\bFOR UPDATE\b/i;
const WHITESPACE = /\s+/;
const matching = (
  driver: RecordingMySQL2Driver,
  verb: string,
  table: RegExp
): string[] =>
  driver.statements.filter(
    (statement) => statement.startsWith(verb) && table.test(statement)
  );

/**
 * The plan-time probe: the FIRST read this operation issued of that table, the
 * one whose arm may INSERT the key it looked for. The read a write issues of
 * the row it has just written is a different statement and a different fact —
 * it asks what this operation's own UPDATE did, which only a current read can
 * answer — so these rows name the probe rather than filtering every SELECT.
 */
const probeOf = (driver: RecordingMySQL2Driver, table: RegExp): string =>
  matching(driver, "SELECT", table)[0] ?? "";

/**
 * Every read this operation issued of that table BEFORE it wrote to it — the
 * whole plan-time group, not just its first member. An interpreted `upsert`
 * with a condition has two: the locator, and the condition probe that runs
 * before either arm is chosen on the locator's own selector narrowed by the
 * condition. Both name the key the missing arm inserts.
 */
const planTimeReads = (
  driver: RecordingMySQL2Driver,
  table: RegExp
): string[] => {
  const write = driver.statements.findIndex(
    (statement) => MUTATION.test(statement) && table.test(statement)
  );
  return driver.statements
    .slice(0, write < 0 ? driver.statements.length : write)
    .filter(
      (statement) => statement.startsWith("SELECT") && table.test(statement)
    );
};

/**
 * The window the shared FOUND-consumption rule leaves open (the repair prompt
 * §1): the first statement this operation sends to that table which is not an
 * unlocked read of it. Before the rule that statement was the EFFECT, and these
 * three schedules planted their DELETE in front of it. The rule takes a locked
 * confirmation of the found row first (`Selection.confirm`), so the effect's
 * window is now held and a plant in front of it would wait on a lock this code
 * correctly takes; the same predicate names the confirmation instead, which is
 * where the loss is now discovered. The price the section states is unchanged
 * in kind — a found row is still not held by its PROBE — and smaller in extent.
 */
const beforeConsumption =
  (table: RegExp) =>
  (statement: string): boolean =>
    table.test(statement) &&
    !(statement.startsWith("SELECT") && !FOR_UPDATE.test(statement));

/** Every failure the rejection carries, primary first, composed ones after. */
const composed = (failure: unknown): unknown[] => [
  failure,
  ...(failure instanceof AggregateError ? failure.errors : []),
];

/** A latch over two real connections: both parties arrive, then both continue. */
function createArrivalLatch(parties: number, timeoutMs: number) {
  let arrived = 0;
  let open = () => {
    /* replaced below */
  };
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    arrive: async () => {
      arrived += 1;
      if (arrived >= parties) {
        open();
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stall = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      });
      await Promise.race([opened, stall]);
      if (timer) clearTimeout(timer);
    },
  };
}

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("MySQL2 concurrency policy", () => {
  let clients: PolicyClient[] = [];

  function boot(driver: MySQL2Driver): PolicyClient {
    const client = createClient({ schema, driver });
    clients.push(client);
    return client;
  }

  // The siblings' approved reset, and for their reason: this lane shares ONE
  // database and runs its files serially, so whatever the previous file left
  // standing is the normal state this one starts in. Dropping only the tables
  // named here leaves those foreign ones behind, and the push below
  // then reads one of them as a rename of a table this schema declares and
  // refuses the whole migration ("Unresolved ambiguous change"). Pushing the
  // EMPTY schema drops every live table, which is what makes the push that
  // follows an addition.
  beforeEach(dropEveryLiveTable);

  beforeEach(async () => {
    clients = [];
    // A persistent database keeps tables between runs and re-pushing a UNIQUE
    // is not idempotent, so every run starts from an empty schema.
    await syncLiveSchema(boot(new RecordingMySQL2Driver()));
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      await client.$disconnect();
    }
  });

  // === 1. The eligible unique-key race ===================================

  describe("an eligible unique-key race", () => {
    test("converges through the update arm on ONE admitted create", async () => {
      const planter = boot(new RecordingMySQL2Driver());
      let planted = false;
      const loserDriver = new RecordingMySQL2Driver({
        beforeStatement: async (statement) => {
          if (planted || !statement.startsWith("INSERT")) return;
          if (!TAG_TABLE.test(statement)) return;
          planted = true;
          await planter.tag.create({
            data: { id: "winner", name: "contested", slug: "winner-slug" },
          });
        },
      });
      const loser = boot(loserDriver);

      const result = await loser.tag.upsert({
        where: { name: "contested" },
        create: {
          id: "loser",
          name: "contested",
          slug: "loser-slug",
          count: 1,
        },
        update: { count: 42 },
      });

      // The correct winner: the row that committed first, carrying the update
      // the loser asked for — never a second row and never the loser's create.
      expect(result).toMatchObject({ id: "winner", count: 42 });
      const rows = await planter.tag.findMany({ where: { name: "contested" } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: "winner",
        slug: "winner-slug",
        count: 42,
      });

      // ONE admission of the create arm: the rejected INSERT is not retried,
      // and a lost race authorises no second INSERT.
      expect(matching(loserDriver, "INSERT", TAG_TABLE)).toHaveLength(1);
      // The probe of an arm that inserts its own key takes no lock. This is
      // the statement whose gap lock manufactured `ER_LOCK_DEADLOCK`.
      expect(FOR_UPDATE.test(probeOf(loserDriver, TAG_TABLE))).toBe(false);
    });

    test("converges through the connect arm of a nested connectOrCreate", async () => {
      const planter = boot(new RecordingMySQL2Driver());
      let planted = false;
      const loserDriver = new RecordingMySQL2Driver({
        beforeStatement: async (statement) => {
          if (planted || !statement.startsWith("INSERT")) return;
          if (!AUTHOR_TABLE.test(statement)) return;
          planted = true;
          await planter.author.create({
            data: { id: "shared-author", name: "planted-winner" },
          });
        },
      });
      const loser = boot(loserDriver);

      const post = await loser.post.create({
        data: {
          id: "loser-post",
          title: "Converged",
          author: {
            connectOrCreate: {
              where: { id: "shared-author" },
              create: { id: "shared-author", name: "loser" },
            },
          },
        },
      });

      expect(post.authorId).toBe("shared-author");
      const authors = await planter.author.findMany({});
      expect(authors).toHaveLength(1);
      expect(authors[0]).toMatchObject({ name: "planted-winner" });
      expect(matching(loserDriver, "INSERT", AUTHOR_TABLE)).toHaveLength(1);
      expect(FOR_UPDATE.test(probeOf(loserDriver, AUTHOR_TABLE))).toBe(false);
    });

    test("a rejection on a constraint the selector does NOT name is not a lost race", async () => {
      // Exact producer ownership: the convergence belongs to the constraint the
      // choose's own selector addresses (`matchesSelectedConstraint`). A create
      // arm refused by a DIFFERENT unique key is a failed write, not a race the
      // update arm may adopt.
      const planter = boot(new RecordingMySQL2Driver());
      let planted = false;
      const loserDriver = new RecordingMySQL2Driver({
        beforeStatement: async (statement) => {
          if (planted || !statement.startsWith("INSERT")) return;
          if (!TAG_TABLE.test(statement)) return;
          planted = true;
          await planter.tag.create({
            data: { id: "occupant", name: "other-name", slug: "occupied" },
          });
        },
      });
      const loser = boot(loserDriver);

      await expect(
        loser.tag.upsert({
          where: { name: "contested" },
          create: { id: "loser", name: "contested", slug: "occupied" },
          update: { count: 42 },
        })
      ).rejects.toBeInstanceOf(UniqueConstraintError);

      // The update arm was never taken and nothing of the loser committed: the
      // only row is the one the other connection wrote.
      expect(matching(loserDriver, "UPDATE", TAG_TABLE)).toEqual([]);
      const rows = await planter.tag.findMany({});
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: "occupant", slug: "occupied" });
      // The operation's ONE recovery allowance (D-25) is the only thing that
      // may put a second create attempt on the wire, and it is spent once: an
      // unbounded retry of a rejection that was never a race fails here.
      expect(
        matching(loserDriver, "INSERT", TAG_TABLE).length
      ).toBeLessThanOrEqual(2);
    });

    test("the CONDITION probe of a conditioned upsert locks no absence either", async () => {
      // `targetWhere` / `setWhere` are public arguments the folded probe-first
      // arm declines, so this is the only spelling that puts the interpreted
      // upsert's condition probe on the wire at all — and on MySQL, which has
      // no RETURNING, the interpreted form is the one every upsert takes. That
      // probe runs BEFORE either arm is chosen, on the locator's own selector
      // narrowed by the condition, so on a miss it names the very key the
      // create arm is about to INSERT: exactly the statement whose gap lock
      // manufactured `ER_LOCK_DEADLOCK`.
      const driver = new RecordingMySQL2Driver();
      const client = boot(driver);

      const created = await client.tag.upsert({
        where: { name: "conditioned" },
        targetWhere: { count: 7 },
        create: {
          id: "conditioned",
          name: "conditioned",
          slug: "conditioned-slug",
          count: 1,
        },
        update: { count: 42 },
      });

      // The key was missing, so the create arm ran and the condition decided
      // nothing — which is the outcome the gap lock was taken on.
      expect(created).toMatchObject({ id: "conditioned", count: 1 });
      expect(matching(driver, "INSERT", TAG_TABLE)).toHaveLength(1);

      // What the call read of the table before it wrote to it.
      const reads = planTimeReads(driver, TAG_TABLE);
      expect(reads.length).toBeGreaterThan(0);
      // Neither of them locked the absence the INSERT then filled.
      expect(reads.filter((statement) => FOR_UPDATE.test(statement))).toEqual(
        []
      );
    });
  });

  // === 2. The real deadlock ==============================================

  describe("a native deadlock", () => {
    beforeEach(async () => {
      await clients[0]!.tag.createMany({
        data: [
          { id: "row-a", name: "a", slug: "a", count: 0 },
          { id: "row-b", name: "b", slug: "b", count: 0 },
        ],
      });
    });

    test("the victim fails visibly, replays nothing, and leaves the survivor's state", async () => {
      // Two transactions take the SAME two ROW locks in OPPOSITE order through
      // the public client, inside `$transaction`. Nothing here is the engine's
      // doing — it is the textbook cycle on locks that are genuinely required,
      // and the contract is that the engine reports it as what it is rather
      // than replaying it or reading it as a rejected INSERT.
      const latch = createArrivalLatch(2, 15_000);
      const firstDriver = new RecordingMySQL2Driver();
      const secondDriver = new RecordingMySQL2Driver();
      const first = boot(firstDriver);
      const second = boot(secondDriver);

      const cross = (
        client: PolicyClient,
        one: string,
        two: string,
        base: number
      ) =>
        client.$transaction(async (tx) => {
          await tx.tag.update({ where: { id: one }, data: { count: base } });
          await latch.arrive();
          await tx.tag.update({
            where: { id: two },
            data: { count: base + 1 },
          });
        });

      const settled = await Promise.allSettled([
        cross(first, "row-a", "row-b", 11),
        cross(second, "row-b", "row-a", 21),
      ]);

      // Exactly one victim, chosen by the database — either party may be it.
      const victimIndex = settled.findIndex(
        (outcome) => outcome.status === "rejected"
      );
      expect(victimIndex).toBeGreaterThan(-1);
      expect(
        settled.filter((outcome) => outcome.status === "rejected")
      ).toHaveLength(1);

      const failure = (settled[victimIndex] as PromiseRejectedResult).reason;
      const carried = composed(failure);
      const deadlocks = carried.filter(
        (error): error is TransactionError =>
          error instanceof TransactionError &&
          error.code === VibORMErrorCode.DEADLOCK
      );
      // The normalized provider failure, with its own attribution — one
      // deadlock, and no constraint error anywhere in what the caller receives.
      expect(deadlocks).toHaveLength(1);
      expect(deadlocks[0]?.message).toBe("Transaction deadlock detected");
      expect(
        carried.some((error) => error instanceof UniqueConstraintError)
      ).toBe(false);

      // No replay and no borrowed-work retry: the victim rolled its member
      // back and issued nothing afterwards but the savepoint's own release.
      const victimDriver = victimIndex === 0 ? firstDriver : secondDriver;
      const victimStatements = victimDriver.statements;
      const rolledBackAt = victimStatements.findIndex((statement) =>
        SAVEPOINT_ROLLBACK.test(statement)
      );
      expect(rolledBackAt).toBeGreaterThan(-1);
      expect(
        victimStatements
          .slice(rolledBackAt + 1)
          .every((statement) => SAVEPOINT_RELEASE.test(statement))
      ).toBe(true);

      // The victim's transaction committed NOTHING — including the update it
      // had already applied before the cycle closed — and the survivor's two
      // updates are both durable.
      const survivorBase = victimIndex === 0 ? 21 : 11;
      const survivorFirst = victimIndex === 0 ? "row-b" : "row-a";
      const rows = await clients[0]!.tag.findMany({ orderBy: { id: "asc" } });
      const counts = new Map(rows.map((row) => [row.id, row.count]));
      expect(counts.get(survivorFirst)).toBe(survivorBase);
      expect(counts.get(survivorFirst === "row-a" ? "row-b" : "row-a")).toBe(
        survivorBase + 1
      );
    });

    test("the same two row locks in the SAME order both succeed", async () => {
      // The non-deadlocking control: the SCHEDULE is what makes a deadlock, so
      // a group that only ever asserted failure would pass against an engine
      // that could no longer write two rows under contention at all.
      const first = boot(new RecordingMySQL2Driver());
      const second = boot(new RecordingMySQL2Driver());

      const ordered = (client: PolicyClient, base: number) =>
        client.$transaction(async (tx) => {
          await tx.tag.update({
            where: { id: "row-a" },
            data: { count: base },
          });
          await tx.tag.update({
            where: { id: "row-b" },
            data: { count: base + 1 },
          });
        });

      const settled = await Promise.allSettled([
        ordered(first, 11),
        ordered(second, 21),
      ]);
      expect(settled.map((outcome) => outcome.status)).toEqual([
        "fulfilled",
        "fulfilled",
      ]);

      const rows = await clients[0]!.tag.findMany({ orderBy: { id: "asc" } });
      // Whichever committed last wrote both rows, so the pair is consistent.
      expect([
        [11, 12],
        [21, 22],
      ]).toContainEqual(rows.map((row) => row.count));
    });
  });

  // === 3. Borrowed execution =============================================

  describe("borrowed execution", () => {
    test("a selected-constraint lost race recovers inside the caller's transaction", async () => {
      const planter = boot(new RecordingMySQL2Driver());
      let planted = false;
      const borrowedDriver = new RecordingMySQL2Driver({
        beforeStatement: async (statement) => {
          if (planted || !statement.startsWith("INSERT")) return;
          if (!TAG_TABLE.test(statement)) return;
          planted = true;
          await planter.tag.create({
            data: { id: "winner", name: "contested", slug: "winner-slug" },
          });
        },
      });
      const borrower = boot(borrowedDriver);

      // Recovery rolls back the failed member's savepoint, re-observes the
      // selected unique identity once, and preserves the caller's transaction.
      const recovered = await borrower.$transaction(async (tx) => {
        return await tx.tag.upsert({
          where: { name: "contested" },
          create: {
            id: "borrowed",
            name: "contested",
            slug: "borrowed-slug",
            count: 1,
          },
          update: { count: 42 },
        });
      });
      expect(recovered).toMatchObject({ id: "winner", count: 42 });

      const statements = borrowedDriver.statements;
      // No second INSERT and no replacement transaction: ONE create attempt; every
      // statement of the borrowed operation on the ONE pooled connection the
      // caller's transaction holds.
      expect(matching(borrowedDriver, "INSERT", TAG_TABLE)).toHaveLength(1);
      const borrowedClients = new Set(borrowedDriver.providerClients);
      expect(borrowedClients.size).toBe(1);
      expect(
        [...borrowedClients].every(
          (client) =>
            "release" in client && typeof client.release === "function"
        )
      ).toBe(true);

      // Only the failed member attempt is rolled back. Its one fresh recovery
      // region uses a second savepoint; neither replaces the outer transaction.
      const savepoints = statements.filter((statement) =>
        ANY_SAVEPOINT.test(statement)
      );
      expect(savepoints).toHaveLength(5);
      expect(SAVEPOINT_OPEN.test(savepoints[0] ?? "")).toBe(true);
      expect(SAVEPOINT_ROLLBACK.test(savepoints[1] ?? "")).toBe(true);
      expect(SAVEPOINT_RELEASE.test(savepoints[2] ?? "")).toBe(true);
      expect(SAVEPOINT_OPEN.test(savepoints[3] ?? "")).toBe(true);
      expect(SAVEPOINT_RELEASE.test(savepoints[4] ?? "")).toBe(true);
      const names = new Set(
        savepoints.map((statement) => statement.split(WHITESPACE).pop())
      );
      expect(names.size).toBe(2);

      // The losing INSERT contributes no row; the winner receives the update.
      const rows = await planter.tag.findMany({});
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: "winner",
        slug: "winner-slug",
        count: 42,
      });
    });

    test("the caller's transaction remains usable after lost-race recovery", async () => {
      // The member's savepoint recovery leaves the caller free to continue
      // and commit later writes in the same outer transaction.
      const planter = boot(new RecordingMySQL2Driver());
      let planted = false;
      const borrowedDriver = new RecordingMySQL2Driver({
        beforeStatement: async (statement) => {
          if (planted || !statement.startsWith("INSERT")) return;
          if (!TAG_TABLE.test(statement)) return;
          planted = true;
          await planter.tag.create({
            data: { id: "winner", name: "contested", slug: "winner-slug" },
          });
        },
      });
      const borrower = boot(borrowedDriver);

      await borrower.$transaction(async (tx) => {
        await expect(
          tx.tag.upsert({
            where: { name: "contested" },
            create: {
              id: "borrowed",
              name: "contested",
              slug: "borrowed-slug",
            },
            update: { count: 42 },
          })
        ).resolves.toMatchObject({ id: "winner", count: 42 });
        // The caller keeps going and COMMITS: the engine neither took the
        // transaction over nor condemned it.
        await tx.tag.create({
          data: { id: "callers-own", name: "callers-own", slug: "callers-own" },
        });
      });

      const rows = await planter.tag.findMany({ orderBy: { id: "asc" } });
      expect(rows.map((row) => row.id)).toEqual(["callers-own", "winner"]);
      expect(rows.find((row) => row.id === "winner")?.count).toBe(42);
    });
  });

  // === 4. What the withdrawal costs, on the FOUND path ====================

  describe("the unlocked probe when it FINDS the row", () => {
    test("a row deleted before the update arm is found gone, and the call made again creates it", async () => {
      // The probe reads unlocked in both outcomes, so a row it FINDS is not
      // held by that probe: a committed DELETE between the probe and the arm
      // is reachable. The found row is asked again, held, before the arm; a
      // row that is gone by then undoes the unit and the call is made again,
      // once, on what the database holds now: an upsert of a row that is not
      // there creates it. Nothing is lost silently and no update is sent to a
      // row that is gone.
      const planter = boot(new RecordingMySQL2Driver());
      await planter.tag.create({
        data: { id: "present", name: "contested", slug: "present-slug" },
      });

      let deleted = false;
      const consumes = beforeConsumption(TAG_TABLE);
      const loserDriver = new RecordingMySQL2Driver({
        beforeStatement: async (statement) => {
          if (deleted || !consumes(statement)) return;
          deleted = true;
          await planter.tag.delete({ where: { id: "present" } });
        },
      });
      const loser = boot(loserDriver);

      const outcome = await loser.tag
        .upsert({
          where: { name: "contested" },
          create: { id: "recreated", name: "contested", slug: "recreated" },
          update: { count: 42 },
        })
        .then(
          (value) => ({ failure: undefined, value }),
          (failure: unknown) => ({ failure, value: undefined })
        );

      // The schedule really happened: the update arm was taken and the delete
      // was planted in front of the statement that consumes the found row.
      expect(deleted).toBe(true);
      // The update arm's effect never went out: the confirmation that precedes
      // it is where the loss is discovered, and the call made again finds no
      // row and creates one.
      expect(matching(loserDriver, "UPDATE", TAG_TABLE)).toEqual([]);
      expect(outcome.failure).toBeUndefined();
      expect(outcome.value).toMatchObject({
        id: "recreated",
        name: "contested",
        slug: "recreated",
      });
      expect(await planter.tag.findMany({})).toMatchObject([
        { id: "recreated", name: "contested", slug: "recreated" },
      ]);
      expect(matching(loserDriver, "INSERT", TAG_TABLE)).toHaveLength(1);

      // And the probe that handed the found row over took no lock — the fact
      // this cell is the price of.
      expect(FOR_UPDATE.test(probeOf(loserDriver, TAG_TABLE))).toBe(false);
    });

    test("a CHILD-HELD connectOrCreate whose found target moves out from under it is made again and creates it", async () => {
      // Where the CHILD holds the reference, the connection is an UPDATE of
      // the child the probe found. With the probe not holding that row,
      // "connected" must not be reported for a row that is not there: the
      // found row is asked again, held, before the arm; gone by then, the unit
      // is undone and the call made again, once, on what the database holds
      // now: nothing to connect, so the row is created.
      const planter = boot(new RecordingMySQL2Driver());
      await planter.post.create({ data: { id: "orphan", title: "Unowned" } });

      let removed = false;
      const consumes = beforeConsumption(POST_TABLE);
      const loserDriver = new RecordingMySQL2Driver({
        beforeStatement: async (statement) => {
          if (removed || !consumes(statement)) return;
          removed = true;
          await planter.post.delete({ where: { id: "orphan" } });
        },
      });
      const loser = boot(loserDriver);

      const outcome = await loser.author
        .create({
          data: {
            id: "new-author",
            name: "Connector",
            posts: {
              connectOrCreate: {
                where: { id: "orphan" },
                create: { id: "orphan", title: "Created instead" },
              },
            },
          },
        })
        .then(
          (value) => ({ failure: undefined, value }),
          (failure: unknown) => ({ failure, value: undefined })
        );

      // The schedule really happened: the delete was planted in front of the
      // statement that consumes the found row, and the arm's own UPDATE never
      // went out because the confirmation that precedes it found nothing.
      expect(removed).toBe(true);
      expect(matching(loserDriver, "UPDATE", POST_TABLE)).toEqual([]);
      // The probe that chose the found arm took no lock — the fact this cell
      // is the price of.
      expect(FOR_UPDATE.test(probeOf(loserDriver, POST_TABLE))).toBe(false);

      // The call made again found no row to connect and created it, with its
      // author.
      expect(outcome.failure).toBeUndefined();
      expect(outcome.value).toMatchObject({ id: "new-author" });
      expect(await planter.author.findMany({})).toMatchObject([
        { id: "new-author", name: "Connector" },
      ]);
      expect(await planter.post.findMany({})).toMatchObject([
        { id: "orphan", title: "Created instead", authorId: "new-author" },
      ]);
      expect(matching(loserDriver, "INSERT", POST_TABLE)).toHaveLength(1);
    });

    test("a nested to-ONE upsert whose found target is deleted before the update arm is made again and creates it", async () => {
      // A to-ONE nested `upsert` carries no `where`: its found arm is an
      // UPDATE of the probed row. The call must not resolve having written
      // nothing to a row that is gone: the found row is asked again, held,
      // before the arm; gone by then, the unit is undone and the call made
      // again, once: no profile is there, so one is created.
      const planter = boot(new RecordingMySQL2Driver());
      await planter.owner.create({
        data: {
          id: "o1",
          name: "Owner",
          profile: { create: { id: "pr1", bio: "Original" } },
        },
      });

      let deleted = false;
      const consumes = beforeConsumption(PROFILE_TABLE);
      const loserDriver = new RecordingMySQL2Driver({
        beforeStatement: async (statement) => {
          if (deleted || !consumes(statement)) return;
          deleted = true;
          await planter.profile.delete({ where: { id: "pr1" } });
        },
      });
      const loser = boot(loserDriver);

      const outcome = await loser.owner
        .update({
          where: { id: "o1" },
          data: {
            name: "Renamed",
            profile: {
              upsert: {
                create: { id: "pr-created", bio: "Created instead" },
                update: { bio: "Updated" },
              },
            },
          },
        })
        .then(
          (value) => ({ failure: undefined, value }),
          (failure: unknown) => ({ failure, value: undefined })
        );

      // The schedule really happened: the delete was planted in front of the
      // statement that consumes the found row, and the arm's own UPDATE never
      // went out because the confirmation that precedes it found nothing.
      expect(deleted).toBe(true);
      expect(matching(loserDriver, "UPDATE", PROFILE_TABLE)).toEqual([]);
      // The probe that chose the found arm took no lock — the fact this cell
      // is the price of.
      expect(FOR_UPDATE.test(probeOf(loserDriver, PROFILE_TABLE))).toBe(false);

      // The call made again created the profile and renamed its owner.
      expect(outcome.failure).toBeUndefined();
      expect(outcome.value).toMatchObject({ id: "o1", name: "Renamed" });
      expect(await planter.profile.findMany({})).toMatchObject([
        { id: "pr-created", bio: "Created instead", ownerId: "o1" },
      ]);
      expect(matching(loserDriver, "INSERT", PROFILE_TABLE)).toHaveLength(1);
      expect(await planter.owner.findMany({})).toEqual([
        { id: "o1", name: "Renamed" },
      ]);
    });
  });
});
