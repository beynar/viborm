import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";

import { s } from "@schema";
import { describe, expect, test } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

import { openTestPGlite as openBorrowedPGlite } from "@tests/fixtures/pglite-lifecycle";


/**
 * M1 — a literal FK rebind beside a DELEGATED parent-held to-one update correlates on
 * the FINAL FK value, not the stale located one.
 *
 * The in-place family-A fold has always done this: `parentHeldCorrelation` builds a
 * per-field override from the root's own scalar writes, so
 * `update({ where: { id: 'u1' }, data: { profileId: 'pB', profile: { update: { tag } } } })`
 * touches `pB` — "the parent's FK value is its FINAL value" is that fold's pinned
 * semantics. The X1c DELEGATED twin — the same payload whose profile data additionally
 * carries a parent-held to-one, which forces `targetNeedsFullUpdate` and hands the whole
 * target to an `UpdateOperation` sub-op — had no such channel: its locate read
 * `WHERE id = <located parent.profileId>`, i.e. the PRE-rebind value, and silently
 * mutated the OLD target row while the parent moved to the new one. The batch presence
 * guard could not catch it: it was built from the same stale correlation, so it
 * confirmed the wrong row.
 *
 * These witnesses pin the state (which profile row the write landed on), the agreement
 * between the delegated and in-place paths, the PROVENANCE of the correlation value on
 * both sides of the override (payload literal vs located row), and the literal the batch
 * presence guard carries on the wire.
 */

const rebindSchema = (() => {
  // Explicit string primary keys everywhere so a witness can name the row it expects
  // and seed DECOYS whose ids a wrong-row write would visibly land on.
  const user = s
    .model({
      id: s.string().id(),
      name: s.string(),
      profileId: s.string().nullable(),
      profile: s
        .toOne(() => profile)
        .fields("profileId")
        .references("id"),
    })
    .map("m1_user");
  const profile = s
    .model({
      id: s.string().id(),
      tag: s.string(),
      // `profile` holds this FK, so a nested `avatar` write under a profile update is a
      // PARENT-HELD to-one from the profile's seat — the mechanism `targetNeedsFullUpdate`
      // names, and therefore the trigger that delegates the whole profile update.
      avatarId: s.string().nullable(),
      avatar: s
        .toOne(() => avatar)
        .fields("avatarId")
        .references("id"),
      users: s.toMany(() => user),
    })
    .map("m1_profile");
  const avatar = s
    .model({
      id: s.string().id(),
      url: s.string(),
      profiles: s.toMany(() => profile),
    })
    .map("m1_avatar");
  return { user, profile, avatar };
})();

/** Records every statement AND its parameters, in order — the batch guard witness needs
 *  the literal on the wire, not just the statement shape. Hooks the protected
 *  `execute`/`executeRaw` seam so one recorder sees both substrates. */
class RecordingBatchPGliteDriver extends BatchOnlyPGliteDriver {
  readonly traffic: { sql: string; params: unknown[] }[] = [];
  recording = false;

  protected override execute<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.traffic.push({ sql, params });
    return super.execute<T>(client, sql, params, context);
  }

  protected override executeRaw<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.traffic.push({ sql, params: params ?? [] });
    return super.executeRaw<T>(client, sql, params, context);
  }
}

/**
 * Rewrites one column of the rows ONE locate read returns, after the database answered
 * and before the engine consumes it (the `located-parent-ref` corruption harness, aimed
 * at this operation's root locate). `wrongValue` is another LIVE row's key, so nothing
 * downstream can reject it on a constraint — only the assertion can tell.
 */
class CorruptLocatePGliteDriver extends PGliteDriver {
  private readonly table: string;
  private readonly column: string;
  private readonly wrongValue: unknown;
  private armed = true;

  constructor(
    options: ConstructorParameters<typeof PGliteDriver>[0],
    config: { table: string; column: string; wrongValue: unknown }
  ) {
    super(options);
    this.table = config.table;
    this.column = config.column;
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
      rows: result.rows.map((row) => ({
        ...(row as Record<string, unknown>),
        [this.column]: this.wrongValue,
      })) as T[],
    };
  }
}

function makeClient(driver: PGliteDriver) {
  return createClient({ schema: rebindSchema, driver });
}
type AnyClient = any;

/**
 * `pA` is where `u1` starts (the STALE correlation value); `pB` is where the rebind
 * sends it (the FINAL value); `pC` is a third live profile used only as the corrupt
 * locate's substitute, so "any profile" cannot satisfy an assertion naming `pB`.
 */
async function seed(client: AnyClient): Promise<void> {
  await client.profile.create({ data: { id: "pA", tag: "PA-ORIG" } });
  await client.profile.create({ data: { id: "pB", tag: "PB-ORIG" } });
  await client.profile.create({ data: { id: "pC", tag: "PC-ORIG" } });
  await client.user.create({
    data: { id: "u1", name: "u", profileId: "pA" },
  });
}

interface Snapshot {
  user: { profileId: string | null };
  profiles: { id: string; tag: string; avatarId: string | null }[];
  avatars: { id: string; url: string }[];
}

async function snapshot(client: AnyClient): Promise<Snapshot> {
  const [user, profiles, avatars] = await Promise.all([
    client.user.findUnique({
      where: { id: "u1" },
      select: { profileId: true },
    }),
    client.profile.findMany({
      orderBy: { id: "asc" },
      select: { id: true, tag: true, avatarId: true },
    }),
    client.avatar.findMany({ orderBy: { id: "asc" } }),
  ]);
  return { user, profiles, avatars } as Snapshot;
}

/** The delegated payload: the profile data carries `avatar` (parent-held from the
 *  profile's seat), which is what forces the X1c delegation. `rebind` is the spelling
 *  of the root's own `profileId` write. */
function delegatedPayload(rebind: unknown) {
  return {
    where: { id: "u1" },
    data: {
      profileId: rebind,
      profile: {
        update: {
          tag: "TOUCHED",
          avatar: { create: { id: "av1", url: "https://x/av1" } },
        },
      },
    },
    select: { id: true },
  };
}

/** The IN-PLACE twin: the same rebind, the same target, scalar-only target data — so
 *  `targetNeedsFullUpdate` is false and the family-A fold handles it in place. */
const inPlacePayload = {
  where: { id: "u1" },
  data: {
    profileId: "pB",
    profile: { update: { tag: "TOUCHED" } },
  },
  select: { id: true },
} as const;

const SUBSTRATES = [
  {
    name: "transaction",
    createDriver: (db: PGlite) => new PGliteDriver({ client: db }),
  },
  {
    name: "atomic batch",
    createDriver: (db: PGlite) => new BatchOnlyPGliteDriver({ client: db }),
  },
] as const;

const SPELLINGS = [
  { name: "bare literal", rebind: "pB" as unknown },
  { name: "{ set: literal }", rebind: { set: "pB" } as unknown },
] as const;

describe("M1 — delegated parent-held update beside a literal FK rebind", () => {
  for (const substrate of SUBSTRATES) {
    for (const spelling of SPELLINGS) {
      test(`${substrate.name}, ${spelling.name}: the delegated write lands on the FINAL target`, async () => {
        const db = openBorrowedPGlite();
        const stateClient = makeClient(new PGliteDriver({ client: db }));
        await syncLiveSchema(stateClient);
        await seed(stateClient);
        const opClient = makeClient(substrate.createDriver(db));
        try {
          await (opClient as AnyClient).user.update(
            delegatedPayload(spelling.rebind)
          );
          const after = await snapshot(stateClient);
          // The parent moved to pB …
          expect(after.user.profileId).toBe("pB");
          // … and the delegated sub-op acted on pB, not on the row the parent left.
          expect(after.profiles).toEqual([
            { id: "pA", tag: "PA-ORIG", avatarId: null },
            { id: "pB", tag: "TOUCHED", avatarId: "av1" },
            { id: "pC", tag: "PC-ORIG", avatarId: null },
          ]);
          expect(after.avatars).toEqual([{ id: "av1", url: "https://x/av1" }]);
        } finally {
          await stateClient.$disconnect();
        }
      });
    }
  }

  test("delegated and in-place paths agree on WHICH row they touch", async () => {
    const touched: Record<string, string[]> = {};
    for (const arm of ["delegated", "in-place"] as const) {
      const db = openBorrowedPGlite();
      const client = makeClient(new PGliteDriver({ client: db }));
      await syncLiveSchema(client);
      await seed(client);
      try {
        await (client as AnyClient).user.update(
          arm === "delegated" ? delegatedPayload("pB") : inPlacePayload
        );
        const after = await snapshot(client);
        touched[arm] = after.profiles
          .filter((profile) => profile.tag === "TOUCHED")
          .map((profile) => profile.id);
      } finally {
        await client.$disconnect();
      }
    }
    // The divergence pin: before M1 the delegated arm answered ["pA"] and the in-place
    // arm ["pB"] — one payload shape difference (a nested avatar create) silently moved
    // the row the update acted on.
    expect(touched.delegated).toEqual(["pB"]);
    expect(touched["in-place"]).toEqual(touched.delegated);
  });

  test("PROVENANCE (no rebind): the delegated correlation reads the LOCATED row", async () => {
    const db = openBorrowedPGlite();
    const stateClient = makeClient(new PGliteDriver({ client: db }));
    await syncLiveSchema(stateClient);
    await seed(stateClient);
    // No `profileId` write in this payload, so no override: the correlation must read
    // the located user row. Corrupting that row's published `profileId` to `pC` must
    // move the write to `pC` — if it did not, the value would be coming from somewhere
    // other than the row the locate acted on (a re-consulted `where`, a cached seed).
    const opClient = makeClient(
      new CorruptLocatePGliteDriver(
        { client: db },
        { table: "m1_user", column: "profileId", wrongValue: "pC" }
      )
    );
    try {
      await (opClient as AnyClient).user.update({
        where: { id: "u1" },
        data: {
          profile: {
            update: {
              tag: "TOUCHED",
              avatar: { create: { id: "av1", url: "https://x/av1" } },
            },
          },
        },
        select: { id: true },
      });
      const after = await snapshot(stateClient);
      expect(
        after.profiles.filter((profile) => profile.tag === "TOUCHED")
      ).toEqual([{ id: "pC", tag: "TOUCHED", avatarId: "av1" }]);
    } finally {
      await stateClient.$disconnect();
    }
  });

  test("PROVENANCE (rebind): the override wins over the located row", async () => {
    const db = openBorrowedPGlite();
    const stateClient = makeClient(new PGliteDriver({ client: db }));
    await syncLiveSchema(stateClient);
    await seed(stateClient);
    // Same corruption, now with the rebind present. The override's provenance is the
    // PAYLOAD, so the located row's `profileId` — corrupt or not — must not be consulted
    // for this column: the write lands on `pB` and `pC` stays untouched. Drop the
    // override and this lands on `pC`.
    const opClient = makeClient(
      new CorruptLocatePGliteDriver(
        { client: db },
        { table: "m1_user", column: "profileId", wrongValue: "pC" }
      )
    );
    try {
      await (opClient as AnyClient).user.update(delegatedPayload("pB"));
      const after = await snapshot(stateClient);
      expect(after.profiles).toEqual([
        { id: "pA", tag: "PA-ORIG", avatarId: null },
        { id: "pB", tag: "TOUCHED", avatarId: "av1" },
        { id: "pC", tag: "PC-ORIG", avatarId: null },
      ]);
    } finally {
      await stateClient.$disconnect();
    }
  });

  test("the batch presence guard pins the FINAL value", async () => {
    const db = openBorrowedPGlite();
    const stateClient = makeClient(new PGliteDriver({ client: db }));
    await syncLiveSchema(stateClient);
    await seed(stateClient);
    const driver = new RecordingBatchPGliteDriver({ client: db });
    const opClient = makeClient(driver);
    try {
      driver.recording = true;
      await (opClient as AnyClient).user.update(delegatedPayload("pB"));
      driver.recording = false;
      // Every statement addressing the profile table — the delegated locate, the batch
      // presence guard, the UPDATE — carries the FINAL id. `pA` appears nowhere on the
      // wire: the guard that "confirmed" the stale row is what made this defect silent.
      const profileTraffic = driver.traffic.filter((entry) =>
        entry.sql.includes("m1_profile")
      );
      expect(profileTraffic.length).toBeGreaterThan(0);
      const guard = profileTraffic.find(
        (entry) =>
          entry.sql.startsWith("SELECT") && !entry.sql.includes("FOR UPDATE")
      );
      expect(guard).toBeDefined();
      expect(guard?.params).toContain("pB");
      expect(
        driver.traffic.filter((entry) => entry.params.includes("pA"))
      ).toEqual([]);
    } finally {
      await stateClient.$disconnect();
    }
  });
});
