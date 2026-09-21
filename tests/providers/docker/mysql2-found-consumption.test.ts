/**
 * The shared FOUND-consumption rule, on the provider that measured its absence.
 *
 * A probe whose other arm INSERTS the key it just looked for reads without
 * locking (`Selection.insertsWhenAbsent`): a lock cannot protect an absence,
 * and on MySQL asking for one costs the operation its convergence. Its sibling
 * `mysql2-concurrency-policy.test.ts` owns that withdrawal and what it must
 * keep — the unique-key races, the visible deadlock, borrowed ownership.
 *
 * This file owns the other half of the same statement: what the withdrawal
 * gives up when the probe FINDS a row. An unlocked observation may SELECT an
 * arm, but it protects nothing that arm later consumes, and a read taken after
 * the effect cannot restore it — it proves the row still exists, not that the
 * identity, the membership, the matched condition and the reference the effect
 * spent were still the ones the operation was promised. Three native schedules
 * measured each of those losses separately on unchanged production source (the
 * review of `bc18b4e23`, repair prompt §1):
 *
 *  1. a holder connected to `b2`, a row that acquired the referenced key
 *     `G` after the probe read it off `b1`;
 *  2. a conditional upsert wrote `42` after the `count: 7` it matched had
 *     become `8`;
 *  3. a nested to-one upsert wrote a profile after it had been reparented to
 *     another owner.
 *
 * The rule is one read, taken between the observation and every arm
 * (`CommandExecution.confirmFound` → `Selection.confirm`): the located row,
 * addressed by IDENTITY, re-taken under the operation's own transaction with
 * `FOR UPDATE`, carrying the requirement the operation already owns. Its lock
 * lasts through the consuming effect, and its row — not the probe's bytes —
 * is what every consumer then spends.
 *
 * Every schedule below plants in the ONE window that exists on both trees:
 * immediately before the first statement this operation sends after its
 * unlocked plan-time read of the table that is not itself another unlocked
 * read of it. On the reviewed source that statement is the EFFECT, which is
 * what made these cells red there; with the rule it is the CONFIRMATION, which
 * is why they are green here and why no cell waits for a write the repair now
 * correctly blocks. The lock itself is proved separately, by a schedule that
 * starts a conflicting write AFTER the confirmation and observes it still
 * waiting when the effect goes out.
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
  NotFoundError,
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
  /**
   * The recycled reference key, with the witness's explicit `ON UPDATE
   * CASCADE`: the holder's value follows `b1` wherever `b1` takes it, so
   * neither a valid before-B nor a valid after-B connection to `b1` can
   * produce a holder pointing at `b2`.
   */
  const badge = s
    .model({
      id: s.string().id(),
      slug: s.string().unique(),
      code: s.string().unique(),
      holders: s.toMany(() => holder),
    })
    .map("fcx_badges");

  const holder = s
    .model({
      id: s.string().id(),
      badgeCode: s.string(),
      badge: s
        .toOne(() => badge)
        .fields("badgeCode")
        .references("code")
        .onUpdate("cascade"),
    })
    .map("fcx_holders");

  /** The ROOT placement: an interpreted conditional upsert. */
  const tag = s
    .model({
      id: s.string().id(),
      name: s.string().unique(),
      slug: s.string().unique(),
      count: s.int().default(0),
    })
    .map("fcx_tags");

  const owner = s
    .model({
      id: s.string().id(),
      name: s.string(),
      profile: s.toOne(() => profile),
      notes: s.toMany(() => note),
    })
    .map("fcx_owners");

  /** The to-ONE nested upsert's membership: the CHILD holds the reference. */
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
    .map("fcx_profiles");

  /**
   * The to-MANY arm, which carries its OWN `where` and therefore builds the
   * found membership confirmation (`Choose.foundRequirement`) the to-one arm
   * never has — and a unique `slug`, so a target can be replaced UNDER the
   * selector without leaving the table.
   */
  const note = s
    .model({
      id: s.string().id(),
      slug: s.string().unique(),
      body: s.string(),
      ownerId: s.string().nullable(),
      owner: s
        .toOne(() => owner)
        .fields("ownerId")
        .references("id"),
    })
    .map("fcx_notes");

  /** A COMPOUND, column-mapped reference key addressed through a mapped unique. */
  const depot = s
    .model({
      id: s.string().id().map("depot_id"),
      region: s.string().map("depot_region"),
      serial: s.string().map("depot_serial"),
      pass: s.string().unique().map("depot_pass"),
      crates: s.toMany(() => crate),
    })
    .map("fcx_depots")
    .unique(["region", "serial"]);

  const crate = s
    .model({
      id: s.string().id().map("crate_id"),
      depotRegion: s.string().nullable().map("crate_region"),
      depotSerial: s.string().nullable().map("crate_serial"),
      depot: s
        .toOne(() => depot)
        .fields("depotRegion", "depotSerial")
        .references("region", "serial"),
    })
    .map("fcx_crates");

  return { badge, holder, tag, owner, profile, note, depot, crate };
})();

type FoundConfig = VibORMConfig<typeof schema>;
type FoundClient = VibORMClient<FoundConfig>;

type StatementHook = (statement: string) => void | Promise<void>;

/** Records every statement it sends, and can run a callback before a chosen one. */
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

const BADGE_TABLE = /`?fcx_badges`?/;
const HOLDER_TABLE = /`?fcx_holders`?/;
const TAG_TABLE = /`?fcx_tags`?/;
const PROFILE_TABLE = /`?fcx_profiles`?/;
const NOTE_TABLE = /`?fcx_notes`?/;
const DEPOT_TABLE = /`?fcx_depots`?/;
const FOR_UPDATE = /\bFOR UPDATE\b/i;
const WHERE_CLAUSE = /\bWHERE\b/i;
const MUTATION = /^(?:INSERT|UPDATE|DELETE)\b/i;

const matching = (
  driver: RecordingMySQL2Driver,
  verb: string,
  table: RegExp
): string[] =>
  driver.statements.filter(
    (statement) => statement.startsWith(verb) && table.test(statement)
  );

/**
 * The locking reads this operation took of that table BEFORE it wrote to it —
 * the confirmations. The read a write issues of the row it has just written
 * locks too (`OperationContext.update`, the CURRENT stored-row read), and it is
 * a different statement answering a different question, so these rows name the
 * plan-time group rather than filtering every locked SELECT.
 */
const confirmationsOf = (
  driver: RecordingMySQL2Driver,
  table: RegExp
): string[] => {
  const write = driver.statements.findIndex(
    (statement) => MUTATION.test(statement) && table.test(statement)
  );
  return driver.statements
    .slice(0, write < 0 ? driver.statements.length : write)
    .filter(
      (statement) =>
        statement.startsWith("SELECT") &&
        table.test(statement) &&
        FOR_UPDATE.test(statement)
    );
};

/** The plan-time probe: the FIRST read this operation issued of that table. */
const probeOf = (driver: RecordingMySQL2Driver, table: RegExp): string =>
  matching(driver, "SELECT", table)[0] ?? "";

/** What a statement filters by, so a projection's columns are not mistaken for it. */
const whereOf = (statement: string): string =>
  statement.split(WHERE_CLAUSE)[1] ?? "";

/** Every failure the rejection carries, primary first, composed ones after. */
const composed = (failure: unknown): unknown[] => [
  failure,
  ...(failure instanceof AggregateError ? failure.errors : []),
];

const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const outcomeOf = async <T>(
  work: PromiseLike<T>
): Promise<{ failure: unknown; value: T | undefined }> =>
  await Promise.resolve(work).then(
    (value) => ({ failure: undefined, value: value as T | undefined }),
    (failure: unknown) => ({ failure, value: undefined })
  );

/**
 * The sentence a lost CONJOINED premise raises (repair prompt 2 §2).
 *
 * Two matched conditions are ONE premise of one consumption, proved by ONE
 * confirmation (G1), so what a miss loses is that premise and not a term of
 * it: the sentence names the operation and the conditions as a SET. On the
 * reviewed source it was `targetWhere`'s own sentence whichever condition had
 * actually changed — a diagnosis the single statement never made.
 */
const CONJOINED_PREMISE =
  "query-engine-v2 top-level upsert matched premise (targetWhere, setWhere) changed before the atomic batch.";

/** The dual-condition shape: both conditions match `t1` as it stands. */
const conjoinedUpsert = async (subject: FoundClient) =>
  await subject.tag.upsert({
    where: { id: "t1" },
    targetWhere: { name: "chosen" },
    setWhere: { count: 7 },
    create: { id: "t1", name: "chosen", slug: "chosen", count: 0 },
    update: { count: 42 },
  });

/**
 * The ONE window this repair closes, expressed so that the same hook names it
 * on both trees: plant exactly once, immediately before the first statement
 * this operation sends after its unlocked plan-time read of `table` that is not
 * itself another unlocked read of it. On the reviewed source that statement is
 * the EFFECT; with the shared rule it is the CONFIRMATION. Nothing here waits
 * for a write the repair blocks, because the plant lands before the lock is
 * taken — which is what the review's own README asked a positive-confirmation
 * repair's witnesses to do.
 */
function plantAfterUnlockedRead(table: RegExp, plant: () => Promise<void>) {
  let observed = false;
  const state = { planted: false };
  const hook: StatementHook = async (statement: string) => {
    if (state.planted) return;
    const unlockedRead =
      statement.startsWith("SELECT") &&
      table.test(statement) &&
      !FOR_UPDATE.test(statement);
    if (!observed) {
      observed = unlockedRead;
      return;
    }
    if (unlockedRead) return;
    state.planted = true;
    await plant();
  };
  return { hook, state };
}

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

describeIf("the shared FOUND-consumption rule on native MySQL", () => {
  let clients: FoundClient[] = [];

  function boot(driver: MySQL2Driver): FoundClient {
    const client = createClient({ schema, driver });
    clients.push(client);
    return client;
  }

  // The siblings' approved reset, and for their reason: this lane shares ONE
  // database and runs its files serially, so pushing the EMPTY schema first is
  // what makes the push that follows an addition rather than an ambiguous
  // rename of a table this schema does not declare.
  beforeEach(dropEveryLiveTable);

  beforeEach(async () => {
    clients = [];
    await syncLiveSchema(boot(new RecordingMySQL2Driver()));
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      await client.$disconnect();
    }
  });

  // === 1. The three consumptions the review measured ======================

  describe("the requirement a FOUND arm consumes", () => {
    test("a found reference is spent at its CURRENT value, never a key another row acquired", async () => {
      // Reviewed source: the holder was connected to `b2`. The probe read
      // `code = 'G'` off `b1` and the parent's own INSERT spent those bytes, so
      // the row that had since ACQUIRED `G` is the one the foreign key named.
      // Neither a valid before-B nor a valid after-B connection to `b1`
      // produces that: `ON UPDATE CASCADE` carries a holder of `b1` to `M`.
      const planter = boot(new RecordingMySQL2Driver());
      await planter.badge.create({
        data: { id: "b1", slug: "chosen", code: "G" },
      });

      const planted = plantAfterUnlockedRead(BADGE_TABLE, async () => {
        await planter.badge.update({
          where: { id: "b1" },
          data: { code: "M" },
        });
        await planter.badge.create({
          data: { id: "b2", slug: "unselected", code: "G" },
        });
      });
      const driver = new RecordingMySQL2Driver({
        beforeStatement: planted.hook,
      });
      const client = boot(driver);

      await client.holder.create({
        data: {
          id: "h1",
          badge: {
            connectOrCreate: {
              where: { slug: "chosen" },
              create: { id: "never-created", slug: "chosen", code: "N" },
            },
          },
        },
      });

      // The schedule really happened, and the probe that chose the arm still
      // took no lock: the withdrawal this file is the other half of.
      expect(planted.state.planted).toBe(true);
      expect(FOR_UPDATE.test(probeOf(driver, BADGE_TABLE))).toBe(false);

      // The connection is to the row the selector named, at the value that row
      // holds NOW — and `b2`, which merely acquired the observed key, holds
      // nothing.
      const stored = await planter.holder.findUnique({
        where: { id: "h1" },
        include: { badge: true },
      });
      expect(stored?.badge?.id).toBe("b1");
      expect(stored?.badgeCode).toBe("M");
      expect(
        await planter.holder.findMany({ where: { badgeCode: "G" } })
      ).toEqual([]);
      // Nothing was created instead of connecting.
      expect(
        (await planter.badge.findMany({})).map((row) => row.id).sort()
      ).toEqual(["b1", "b2"]);

      // And the value was re-read, not recomputed from a rerun selector: ONE
      // locked confirmation, addressed by the located identity.
      const confirmations = confirmationsOf(driver, BADGE_TABLE);
      expect(confirmations).toHaveLength(1);
      expect(whereOf(confirmations[0] ?? "")).toContain("`id`");
    });

    test("a found conditional upsert refuses when the condition it matched has changed", async () => {
      // Reviewed source: `42` was written although the `count: 7` the operation
      // matched had become `8`. A matched condition is a continuing requirement
      // of the arm it selected, not a fact about the moment of observation.
      const planter = boot(new RecordingMySQL2Driver());
      await planter.tag.create({
        data: { id: "t1", name: "chosen", slug: "chosen", count: 7 },
      });

      const planted = plantAfterUnlockedRead(TAG_TABLE, async () => {
        await planter.tag.update({ where: { id: "t1" }, data: { count: 8 } });
      });
      const driver = new RecordingMySQL2Driver({
        beforeStatement: planted.hook,
      });
      const client = boot(driver);

      const outcome = await outcomeOf(
        client.tag.upsert({
          where: { id: "t1" },
          setWhere: { count: 7 },
          create: { id: "t1", name: "chosen", slug: "chosen", count: 0 },
          update: { count: 42 },
        })
      );

      expect(planted.state.planted).toBe(true);
      // The premise's OWN failure, the one the atomic route already raises for
      // exactly this loss — not a race the create arm may adopt, not a
      // deadlock, and not a silent skip.
      expect(outcome.value).toBeUndefined();
      expect(outcome.failure).toBeInstanceOf(TransactionError);
      expect((outcome.failure as Error).message).toBe(
        "query-engine-v2 top-level upsert setWhere match premise changed before the atomic batch."
      );
      expect(
        composed(outcome.failure).some(
          (error) => error instanceof UniqueConstraintError
        )
      ).toBe(false);
      expect(
        composed(outcome.failure).some(
          (error) =>
            error instanceof TransactionError &&
            error.code === VibORMErrorCode.DEADLOCK
        )
      ).toBe(false);

      // The other transaction's value stands and nothing of this one committed:
      // no update, and no second row under the create arm's key.
      const rows = await planter.tag.findMany({});
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: "t1", count: 8 });
      expect(matching(driver, "UPDATE", TAG_TABLE)).toEqual([]);
      expect(matching(driver, "INSERT", TAG_TABLE)).toEqual([]);
    });

    test("two matched conditions lost at the FIRST refuse as one premise", async () => {
      // Repair prompt 2 §2. Both conditions MATCHED, so the confirmation
      // carries their CONJUNCTION and a miss is the loss of that one premise.
      // The reviewed source named `targetWhere` here — and named it in the two
      // cells below as well, where it had not changed at all.
      const planter = boot(new RecordingMySQL2Driver());
      await planter.tag.create({
        data: { id: "t1", name: "chosen", slug: "chosen", count: 7 },
      });

      const planted = plantAfterUnlockedRead(TAG_TABLE, async () => {
        await planter.tag.update({
          where: { id: "t1" },
          data: { name: "renamed" },
        });
      });
      const driver = new RecordingMySQL2Driver({
        beforeStatement: planted.hook,
      });

      const outcome = await outcomeOf(conjoinedUpsert(boot(driver)));

      expect(planted.state.planted).toBe(true);
      expect(outcome.value).toBeUndefined();
      expect(outcome.failure).toBeInstanceOf(TransactionError);
      expect((outcome.failure as TransactionError).code).toBe(
        VibORMErrorCode.TRANSACTION_FAILED
      );
      expect((outcome.failure as Error).message).toBe(CONJOINED_PREMISE);
      // A lost MATCH premise is not a race another arm may adopt.
      expect((outcome.failure as TransactionError).meta.raceable).not.toBe(
        true
      );
      // ONE locked confirmation carried the pair: the truthful sentence buys no
      // round trip, here or in either cell below.
      const confirmations = confirmationsOf(driver, TAG_TABLE);
      expect(confirmations).toHaveLength(1);
      expect(whereOf(confirmations[0] ?? "")).toContain("`id`");

      const rows = await planter.tag.findMany({});
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: "t1", name: "renamed", count: 7 });
      expect(matching(driver, "UPDATE", TAG_TABLE)).toEqual([]);
      expect(matching(driver, "INSERT", TAG_TABLE)).toEqual([]);
    });

    test("two matched conditions lost at the SECOND refuse with the same sentence", async () => {
      const planter = boot(new RecordingMySQL2Driver());
      await planter.tag.create({
        data: { id: "t1", name: "chosen", slug: "chosen", count: 7 },
      });

      const planted = plantAfterUnlockedRead(TAG_TABLE, async () => {
        await planter.tag.update({ where: { id: "t1" }, data: { count: 8 } });
      });
      const driver = new RecordingMySQL2Driver({
        beforeStatement: planted.hook,
      });

      const outcome = await outcomeOf(conjoinedUpsert(boot(driver)));

      expect(planted.state.planted).toBe(true);
      expect(outcome.value).toBeUndefined();
      expect(outcome.failure).toBeInstanceOf(TransactionError);
      expect((outcome.failure as Error).message).toBe(CONJOINED_PREMISE);
      expect(confirmationsOf(driver, TAG_TABLE)).toHaveLength(1);

      const rows = await planter.tag.findMany({});
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: "t1", name: "chosen", count: 8 });
      expect(matching(driver, "UPDATE", TAG_TABLE)).toEqual([]);
      expect(matching(driver, "INSERT", TAG_TABLE)).toEqual([]);
    });

    test("two matched conditions lost TOGETHER refuse with the same sentence", async () => {
      const planter = boot(new RecordingMySQL2Driver());
      await planter.tag.create({
        data: { id: "t1", name: "chosen", slug: "chosen", count: 7 },
      });

      const planted = plantAfterUnlockedRead(TAG_TABLE, async () => {
        await planter.tag.update({
          where: { id: "t1" },
          data: { name: "renamed", count: 8 },
        });
      });
      const driver = new RecordingMySQL2Driver({
        beforeStatement: planted.hook,
      });

      const outcome = await outcomeOf(conjoinedUpsert(boot(driver)));

      expect(planted.state.planted).toBe(true);
      expect(outcome.value).toBeUndefined();
      expect(outcome.failure).toBeInstanceOf(TransactionError);
      expect((outcome.failure as Error).message).toBe(CONJOINED_PREMISE);
      expect(confirmationsOf(driver, TAG_TABLE)).toHaveLength(1);

      const rows = await planter.tag.findMany({});
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: "t1", name: "renamed", count: 8 });
      expect(matching(driver, "UPDATE", TAG_TABLE)).toEqual([]);
      expect(matching(driver, "INSERT", TAG_TABLE)).toEqual([]);
    });

    test("a found nested to-ONE upsert refuses a member reparented out of its membership", async () => {
      // Reviewed source: `bio` was written on a profile that had moved to `o2`,
      // as `o1`'s profile. The membership the probe read the row through is a
      // continuing requirement of the arm that writes it.
      const planter = boot(new RecordingMySQL2Driver());
      await planter.owner.create({
        data: {
          id: "o1",
          name: "one",
          profile: { create: { id: "pr1", bio: "original" } },
        },
      });
      await planter.owner.create({ data: { id: "o2", name: "two" } });

      const planted = plantAfterUnlockedRead(PROFILE_TABLE, async () => {
        await planter.profile.update({
          where: { id: "pr1" },
          data: { owner: { connect: { id: "o2" } } },
        });
      });
      const driver = new RecordingMySQL2Driver({
        beforeStatement: planted.hook,
      });
      const client = boot(driver);

      const outcome = await outcomeOf(
        client.owner.update({
          where: { id: "o1" },
          data: {
            name: "renamed",
            profile: {
              upsert: {
                create: { id: "pr-new", bio: "created" },
                update: { bio: "written-by-o1" },
              },
            },
          },
        })
      );

      expect(planted.state.planted).toBe(true);
      expect(outcome.value).toBeUndefined();
      expect(outcome.failure).toBeInstanceOf(NotFoundError);
      expect((outcome.failure as Error).message).toBe(
        "No profile record found for update"
      );

      // The member is untouched where it now belongs, the create arm was NOT
      // taken as a recovery from a member that left, and the parent's own
      // rename in the same operation is rolled back with it.
      expect(
        await planter.profile.findUnique({ where: { id: "pr1" } })
      ).toMatchObject({ ownerId: "o2", bio: "original" });
      expect(matching(driver, "INSERT", PROFILE_TABLE)).toEqual([]);
      expect(matching(driver, "UPDATE", PROFILE_TABLE)).toEqual([]);
      expect(
        await planter.owner.findUnique({ where: { id: "o1" } })
      ).toMatchObject({ name: "one" });
    });
  });

  // === 2. The lock, proved by a schedule that waits on it =================

  describe("the confirmation's lock", () => {
    test("holds the FOUND row through the consuming effect", async () => {
      // The cells above prove the window between the observation and the
      // confirmation is closed. This one proves the window AFTER it is closed
      // too, which only a lock can do: the conflicting write is started once
      // the confirmation has answered and is observed STILL WAITING when the
      // effect goes out, then completes as soon as this operation commits.
      const planter = boot(new RecordingMySQL2Driver());
      await planter.badge.create({
        data: { id: "b1", slug: "chosen", code: "G" },
      });

      let contender: Promise<unknown> | undefined;
      let contenderState = "pending";
      let stateWhenEffectWentOut = "not-observed";
      const driver = new RecordingMySQL2Driver({
        beforeStatement: async (statement) => {
          if (
            contender ||
            !statement.startsWith("INSERT") ||
            !HOLDER_TABLE.test(statement)
          )
            return;
          // The confirmation has answered; its lock is this transaction's.
          contender = planter.badge
            .update({ where: { id: "b1" }, data: { code: "M" } })
            .then(
              () => {
                contenderState = "committed";
              },
              () => {
                contenderState = "failed";
              }
            );
          // Long enough for an UNCONTENDED single-row update on an idle pool
          // to have finished many times over.
          await delay(1000);
          stateWhenEffectWentOut = contenderState;
        },
      });
      const client = boot(driver);

      await client.holder.create({
        data: {
          id: "h1",
          badge: {
            connectOrCreate: {
              where: { slug: "chosen" },
              create: { id: "never-created", slug: "chosen", code: "N" },
            },
          },
        },
      });

      expect(confirmationsOf(driver, BADGE_TABLE)).toHaveLength(1);
      // HELD: the writer was blocked by this operation's lock while the effect
      // that spends the row went out.
      expect(stateWhenEffectWentOut).toBe("pending");

      await contender;
      expect(contenderState).toBe("committed");

      // The serialized outcome: the holder was connected to `b1` at `G`, and
      // the cascade then carried it to `M` with the row it points at.
      const stored = await planter.holder.findUnique({
        where: { id: "h1" },
        include: { badge: true },
      });
      expect(stored?.badge?.id).toBe("b1");
      expect(stored?.badgeCode).toBe("M");
    });
  });

  // === 3. The other placements and key shapes =============================

  describe("the rule across placements and key shapes", () => {
    test("a CHILD-HELD found connectOrCreate refuses a target replaced under its selector", async () => {
      // The child holds the reference, so the connection is an UPDATE of the
      // row the probe found rather than a value in the parent's own statement.
      // The requirement is the same one, and so is the sentence this arm
      // already owns for losing it.
      const planter = boot(new RecordingMySQL2Driver());
      await planter.note.create({
        data: { id: "n1", slug: "wanted", body: "original" },
      });

      const planted = plantAfterUnlockedRead(NOTE_TABLE, async () => {
        await planter.note.update({
          where: { id: "n1" },
          data: { slug: "taken-elsewhere" },
        });
      });
      const driver = new RecordingMySQL2Driver({
        beforeStatement: planted.hook,
      });
      const client = boot(driver);

      const outcome = await outcomeOf(
        client.owner.create({
          data: {
            id: "o1",
            name: "connector",
            notes: {
              connectOrCreate: {
                where: { slug: "wanted" },
                create: { id: "n-new", slug: "wanted", body: "created" },
              },
            },
          },
        })
      );

      expect(planted.state.planted).toBe(true);
      expect(outcome.value).toBeUndefined();
      expect((outcome.failure as Error).message).toBe(
        "Record was replaced by another transaction during nested connectOrCreate"
      );

      // Nothing connected, nothing created, and the owner's own INSERT is
      // rolled back with it.
      expect(
        await planter.note.findUnique({ where: { id: "n1" } })
      ).toMatchObject({ slug: "taken-elsewhere", ownerId: null });
      expect(await planter.owner.findMany({})).toEqual([]);
      expect(matching(driver, "INSERT", NOTE_TABLE)).toEqual([]);
    });

    test("a correlated to-MANY nested upsert refuses a member moved to another parent", async () => {
      // The arm that carries its OWN `where` is the one that already built a
      // found membership confirmation. The shared rule is where that read now
      // lives, so this placement keeps its existing sentence exactly.
      const planter = boot(new RecordingMySQL2Driver());
      await planter.owner.create({
        data: {
          id: "o1",
          name: "one",
          notes: { create: { id: "n1", slug: "kept", body: "original" } },
        },
      });
      await planter.owner.create({ data: { id: "o2", name: "two" } });

      const planted = plantAfterUnlockedRead(NOTE_TABLE, async () => {
        await planter.note.update({
          where: { id: "n1" },
          data: { owner: { connect: { id: "o2" } } },
        });
      });
      const driver = new RecordingMySQL2Driver({
        beforeStatement: planted.hook,
      });
      const client = boot(driver);

      const outcome = await outcomeOf(
        client.owner.update({
          where: { id: "o1" },
          data: {
            notes: {
              upsert: {
                where: { id: "n1" },
                create: { id: "n-new", slug: "new", body: "created" },
                update: { body: "written-by-o1" },
              },
            },
          },
        })
      );

      expect(planted.state.planted).toBe(true);
      expect(outcome.value).toBeUndefined();
      expect((outcome.failure as Error).message).toBe(
        "Cannot upsert relation 'notes': target record was not found for this parent."
      );
      expect(
        await planter.note.findUnique({ where: { id: "n1" } })
      ).toMatchObject({ ownerId: "o2", body: "original" });
      expect(matching(driver, "INSERT", NOTE_TABLE)).toEqual([]);
    });

    test("a COMPOUND, column-mapped reference is confirmed and spent at its current pair", async () => {
      // Every fact the rule needs is per-model, not per-column-name: the
      // selector is a mapped unique, the identity is a mapped key, and the
      // reference is two mapped columns. A decoy that acquires the observed
      // pair must not receive the crate.
      const planter = boot(new RecordingMySQL2Driver());
      await planter.depot.create({
        data: { id: "d1", region: "eu", serial: "1", pass: "gold" },
      });

      const planted = plantAfterUnlockedRead(DEPOT_TABLE, async () => {
        await planter.depot.update({
          where: { id: "d1" },
          data: { serial: "9" },
        });
        await planter.depot.create({
          data: { id: "d2", region: "eu", serial: "1", pass: "silver" },
        });
      });
      const driver = new RecordingMySQL2Driver({
        beforeStatement: planted.hook,
      });
      const client = boot(driver);

      await client.crate.create({
        data: {
          id: "c1",
          depot: {
            connectOrCreate: {
              where: { pass: "gold" },
              create: {
                id: "never-created",
                region: "eu",
                serial: "0",
                pass: "gold",
              },
            },
          },
        },
      });

      expect(planted.state.planted).toBe(true);
      const stored = await planter.crate.findUnique({
        where: { id: "c1" },
        include: { depot: true },
      });
      expect(stored?.depot?.id).toBe("d1");
      expect(stored).toMatchObject({ depotRegion: "eu", depotSerial: "9" });
      // The decoy holds nothing.
      expect(
        await planter.crate.findMany({ where: { depotSerial: "1" } })
      ).toEqual([]);
    });

    test("a found arm that writes no column of its own spends the CURRENT reference through its child", async () => {
      // The unique coverage of the confirmation's re-binding of the LOCATED
      // selection (`CommandExecution.confirmFound` → `CommandAttempt.materialize`,
      // repair prompt §1.3). This arm's payload is a RELATION only, so its own
      // `OperationContext.update` writes no column and returns before it reads
      // anything back: every value the child then spends is answered through
      // `Assignments.captured` — the located selection's binding — and the
      // confirmed row is what that binding has to hold. Remove the re-binding
      // and this cell goes red with `h9` carrying `G`, the key `b2` acquired
      // after the probe read it off `b1`: cell 1's defect, reached through the
      // other binding.
      const planter = boot(new RecordingMySQL2Driver());
      await planter.badge.create({
        data: { id: "b1", slug: "chosen", code: "G" },
      });

      const planted = plantAfterUnlockedRead(BADGE_TABLE, async () => {
        await planter.badge.update({
          where: { id: "b1" },
          data: { code: "M" },
        });
        await planter.badge.create({
          data: { id: "b2", slug: "unselected", code: "G" },
        });
      });
      const driver = new RecordingMySQL2Driver({
        beforeStatement: planted.hook,
      });
      const client = boot(driver);

      await client.badge.upsert({
        where: { slug: "chosen" },
        create: { id: "never-created", slug: "chosen", code: "N" },
        update: { holders: { create: { id: "h9" } } },
      });

      expect(planted.state.planted).toBe(true);
      const stored = await planter.holder.findUnique({ where: { id: "h9" } });
      expect(stored).toMatchObject({ badgeCode: "M" });
      expect(
        await planter.holder.findMany({ where: { badgeCode: "G" } })
      ).toEqual([]);
    });

    test("inside a borrowed transaction the confirmation is the caller's own lock", async () => {
      // The engine opens no region here, so the confirmation is taken on the
      // caller's connection and its lock is the caller's to release. The
      // operation still succeeds against the current value, every statement
      // rides the ONE pooled connection the caller's transaction holds, and
      // the caller decides what happens next.
      const planter = boot(new RecordingMySQL2Driver());
      await planter.badge.create({
        data: { id: "b1", slug: "chosen", code: "G" },
      });

      const planted = plantAfterUnlockedRead(BADGE_TABLE, async () => {
        await planter.badge.update({
          where: { id: "b1" },
          data: { code: "M" },
        });
        await planter.badge.create({
          data: { id: "b2", slug: "unselected", code: "G" },
        });
      });
      const borrowedDriver = new RecordingMySQL2Driver({
        beforeStatement: planted.hook,
      });
      const borrower = boot(borrowedDriver);

      await borrower.$transaction(async (tx) => {
        await tx.holder.create({
          data: {
            id: "h1",
            badge: {
              connectOrCreate: {
                where: { slug: "chosen" },
                create: { id: "never-created", slug: "chosen", code: "N" },
              },
            },
          },
        });
        // The caller keeps going and COMMITS: nothing was taken over.
        await tx.tag.create({
          data: { id: "callers-own", name: "own", slug: "own" },
        });
      });

      expect(planted.state.planted).toBe(true);
      const borrowedClients = new Set(borrowedDriver.providerClients);
      expect(borrowedClients.size).toBe(1);
      const stored = await planter.holder.findUnique({
        where: { id: "h1" },
        include: { badge: true },
      });
      expect(stored?.badge?.id).toBe("b1");
      expect(await planter.tag.findMany({})).toHaveLength(1);
    });
  });

  // === 4. The controls ====================================================

  describe("what the rule must not change", () => {
    test("an uncontended found consumption commits its ordinary result", async () => {
      const planter = boot(new RecordingMySQL2Driver());
      await planter.badge.create({
        data: { id: "b1", slug: "chosen", code: "G" },
      });
      await planter.tag.create({
        data: { id: "t1", name: "chosen", slug: "chosen", count: 7 },
      });
      await planter.owner.create({
        data: {
          id: "o1",
          name: "one",
          profile: { create: { id: "pr1", bio: "original" } },
        },
      });
      const driver = new RecordingMySQL2Driver();
      const client = boot(driver);

      await client.holder.create({
        data: {
          id: "h1",
          badge: {
            connectOrCreate: {
              where: { slug: "chosen" },
              create: { id: "never-created", slug: "chosen", code: "N" },
            },
          },
        },
      });
      const upserted = await client.tag.upsert({
        where: { id: "t1" },
        setWhere: { count: 7 },
        create: { id: "t1", name: "chosen", slug: "chosen", count: 0 },
        update: { count: 42 },
      });
      await client.owner.update({
        where: { id: "o1" },
        data: {
          profile: {
            upsert: {
              create: { id: "pr-new", bio: "created" },
              update: { bio: "written-by-o1" },
            },
          },
        },
      });

      // Every found arm did its ordinary work: no new refusal, nothing skipped.
      expect(upserted).toMatchObject({ id: "t1", count: 42 });
      expect(
        await planter.holder.findUnique({ where: { id: "h1" } })
      ).toMatchObject({ badgeCode: "G" });
      expect(
        await planter.profile.findUnique({ where: { id: "pr1" } })
      ).toMatchObject({ ownerId: "o1", bio: "written-by-o1" });
      expect(matching(driver, "INSERT", TAG_TABLE)).toEqual([]);
    });

    test("the missing arm still reads unlocked, and the confirmation is the only locked read", async () => {
      // The withdrawal is unchanged where it was taken: a probe that may answer
      // "absent" locks nothing, in EITHER outcome. The confirmation exists only
      // once that probe has found a row, and it addresses that row's identity.
      const driver = new RecordingMySQL2Driver();
      const client = boot(driver);

      const created = await client.tag.upsert({
        where: { id: "t1" },
        setWhere: { count: 7 },
        create: { id: "t1", name: "chosen", slug: "chosen", count: 1 },
        update: { count: 42 },
      });
      expect(created).toMatchObject({ id: "t1", count: 1 });
      // The key was missing: the create arm ran and NOTHING locked the absence
      // it filled — the statement whose gap lock manufactured a deadlock.
      expect(confirmationsOf(driver, TAG_TABLE)).toEqual([]);
      expect(matching(driver, "INSERT", TAG_TABLE)).toHaveLength(1);

      const foundDriver = new RecordingMySQL2Driver();
      const foundClient = boot(foundDriver);
      await foundClient.tag.upsert({
        where: { id: "t1" },
        setWhere: { count: 1 },
        create: { id: "t1", name: "chosen", slug: "chosen", count: 0 },
        update: { count: 42 },
      });
      // FOUND: the probe still took no lock, and exactly one confirmation did.
      expect(FOR_UPDATE.test(probeOf(foundDriver, TAG_TABLE))).toBe(false);
      const confirmations = confirmationsOf(foundDriver, TAG_TABLE);
      expect(confirmations).toHaveLength(1);
      expect(whereOf(confirmations[0] ?? "")).toContain("`id`");
      expect(matching(foundDriver, "INSERT", TAG_TABLE)).toEqual([]);
    });

    test("a PARENT-HELD found target deleted in the same window fails with its own sentence", async () => {
      // The deleted-target witness for the consumer that spends a VALUE rather
      // than writing the found row: the loss is reported where it is
      // discovered, the create arm is NOT taken as a recovery from a row that
      // vanished, and nothing of the operation commits. Its siblings for the
      // root upsert, the child-held binding and the nested to-one arm live
      // where that price is owned (`mysql2-concurrency-policy.test.ts` §4).
      const planter = boot(new RecordingMySQL2Driver());
      await planter.badge.create({
        data: { id: "b1", slug: "chosen", code: "G" },
      });

      const planted = plantAfterUnlockedRead(BADGE_TABLE, async () => {
        await planter.badge.delete({ where: { id: "b1" } });
      });
      const driver = new RecordingMySQL2Driver({
        beforeStatement: planted.hook,
      });
      const client = boot(driver);

      const outcome = await outcomeOf(
        client.holder.create({
          data: {
            id: "h1",
            badge: {
              connectOrCreate: {
                where: { slug: "chosen" },
                create: { id: "never-created", slug: "chosen", code: "N" },
              },
            },
          },
        })
      );

      expect(planted.state.planted).toBe(true);
      expect(outcome.value).toBeUndefined();
      expect((outcome.failure as Error).message).toBe(
        "Record was replaced by another transaction during nested connectOrCreate"
      );
      expect(
        composed(outcome.failure).some(
          (error) =>
            error instanceof TransactionError &&
            error.code === VibORMErrorCode.DEADLOCK
        )
      ).toBe(false);
      expect(await planter.badge.findMany({})).toEqual([]);
      expect(await planter.holder.findMany({})).toEqual([]);
      expect(matching(driver, "INSERT", BADGE_TABLE)).toEqual([]);
    });
  });
});
