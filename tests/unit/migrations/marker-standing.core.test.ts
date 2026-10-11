import { VibORMErrorCode } from "@src/errors";
import { applyV1 } from "@src/migrations/apply-v1";
import { canonicalizeJsonText } from "@src/migrations/canonical-json";
import { markerFromPath } from "@src/migrations/control";
import { emptyManagedSnapshot } from "@src/migrations/empty-snapshot";
import type { Sha256 } from "@src/migrations/identity";
import { statusV1, verifyV1 } from "@src/migrations/operators";
import { composeSqlBlob } from "@src/migrations/sql-blob";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import {
  encodeDispatchIdentity,
  encodeEstateDescriptor,
  encodeSnapshot,
  encodeStateManifest,
  encodeTransitionHash,
} from "@src/migrations/v1-parse";
import type {
  MigrationMarkerV1,
  MigrationParentTransitionV1,
} from "@src/migrations/v1-types";
import { describe, expect, test } from "vitest";
import {
  controlCatalogAnswer,
  type RecordingDriver,
  sqliteControlDefinitionAnswer,
  sqliteEstateDriver,
} from "./_estate";

/**
 * Plan S8 at the layer the migration coverage gate measures: old code meeting
 * a marker its history does not hold.
 *
 * `marker-ahead.test.ts` proves the same classification on live PostgreSQL;
 * here the estate is real authenticated storage and the marker is the one row
 * a recording driver answers, so every command's decision is visible as the
 * statements it did, or did not, send. The estate holds one root state; a
 * marker is `ahead` when its arrival path passes through that state and then
 * leaves the history, and `unknown` when nothing on it belongs here.
 */

const EMPTY = encodeSnapshot(emptyManagedSnapshot());
const FORWARD_SQL = "SELECT 'standing-forward'";
/** A state newer code applied after the root: no estate here holds it. */
const NEWER_STATE = "a".repeat(64) as Sha256;
const NEWER_TRANSITION = "b".repeat(64) as Sha256;
const AHEAD = /ahead of this migration history/;
const UNKNOWN = /unknown to this migration estate/;
const LEDGER_READ = /^SELECT payload FROM "_viborm_migration_log"/;

async function publishRoot() {
  const storage = new MemoryEstateStorage();
  const estate = encodeEstateDescriptor({ dialect: "sqlite" });
  const blob = composeSqlBlob([FORWARD_SQL]);
  const range = blob.ranges[0]!;
  await storage.publishEstate(estate.bytes);
  await storage.publishSnapshot(EMPTY.snapshotHash, EMPTY.bytes);
  await storage.publishSql(blob.sqlHash, blob.bytes);
  const parent: Omit<MigrationParentTransitionV1, "transitionHash"> = {
    fromState: null,
    originChecks: [],
    requestedForwardBoundary: null,
    operations: [
      {
        id: "root:forward:0",
        label: "root forward",
        origin: "generated",
        risk: "safe",
        steps: [
          {
            retry: "opaque",
            execute: {
              dispatchId: encodeDispatchIdentity(
                blob.sqlHash,
                range.offset,
                range.length,
                []
              ),
              sqlHash: blob.sqlHash,
              offset: range.offset,
              length: range.length,
              parameters: [],
            },
          },
        ],
      },
    ],
    rollback: { kind: "irreversible", reason: "standing fixture" },
  };
  const transitionHash = encodeTransitionHash(parent);
  const state = encodeStateManifest({
    format: "1",
    estateHash: estate.estateHash,
    name: "root",
    snapshotHash: EMPTY.snapshotHash,
    sqlHash: blob.sqlHash,
    destinationChecks: [],
    parents: [{ ...parent, transitionHash }],
  });
  await storage.publishState(state.stateId, state.bytes);
  return {
    storage,
    estateHash: estate.estateHash,
    rootEdge: {
      stateId: state.stateId,
      transitionHash,
      baselineBoundary: false,
    },
  };
}

type Published = Awaited<ReturnType<typeof publishRoot>>;

/** Newer code applied the root, then a state this estate never saw. */
function aheadMarker(published: Published): MigrationMarkerV1 {
  return markerFromPath(
    published.estateHash,
    EMPTY.snapshotHash,
    [
      published.rootEdge,
      {
        stateId: NEWER_STATE,
        transitionHash: NEWER_TRANSITION,
        baselineBoundary: false,
      },
    ],
    2
  );
}

/** Another history's marker: nothing on its arrival path belongs here. */
function strangerMarker(published: Published): MigrationMarkerV1 {
  return markerFromPath(
    published.estateHash,
    EMPTY.snapshotHash,
    [
      {
        stateId: NEWER_STATE,
        transitionHash: NEWER_TRANSITION,
        baselineBoundary: false,
      },
    ],
    1
  );
}

function databaseAt(marker: MigrationMarkerV1): RecordingDriver {
  const driver = sqliteEstateDriver();
  driver.respond = (sql, params) => {
    const presence = { state: true, log: true };
    const answer =
      controlCatalogAnswer(sql, params, presence) ??
      sqliteControlDefinitionAnswer(sql, presence);
    if (answer) return answer;
    if (
      sql.includes("SELECT payload FROM") &&
      sql.includes("_viborm_migration_state")
    ) {
      return [{ payload: canonicalizeJsonText(marker) }];
    }
    return [];
  };
  return driver;
}

function clientFor(driver: RecordingDriver) {
  return { $driver: driver, $schema: {} };
}

/** Anything that would move the database: the forward dispatch, a marker or ledger write. */
function wroteAnything(driver: RecordingDriver): boolean {
  return driver.statements.some(
    (statement) =>
      statement === FORWARD_SQL ||
      statement.startsWith("INSERT") ||
      statement.startsWith("UPDATE") ||
      statement.startsWith("CREATE")
  );
}

describe("apply against a marker this history does not hold", () => {
  test.each([
    ["apply()", {}],
    ["apply({ dryRun: true })", { dryRun: true }],
    ['apply({ ifAhead: "refuse" })', { ifAhead: "refuse" as const }],
  ])("%s refuses an ahead marker and writes nothing", async (_, options) => {
    const published = await publishRoot();
    const driver = databaseAt(aheadMarker(published));

    const failure = applyV1(clientFor(driver), published.storage, options);

    await expect(failure).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_NOT_FOUND,
      message: expect.stringMatching(AHEAD),
    });
    await expect(failure).rejects.toThrow(NEWER_STATE);
    expect(wroteAnything(driver)).toBe(false);
  });

  test.each([
    ["apply", {}],
    ["apply({ dryRun: true })", { dryRun: true }],
  ])('%s with ifAhead: "noop" runs against the newer schema without migrating', async (_, options) => {
    const published = await publishRoot();
    const driver = databaseAt(aheadMarker(published));

    await expect(
      applyV1(clientFor(driver), published.storage, {
        ...options,
        ifAhead: "noop",
      })
    ).resolves.toEqual({ outcome: "noop", path: [], statements: [] });
    expect(wroteAnything(driver)).toBe(false);
  });

  test('a stranger marker is refused even with ifAhead: "noop"', async () => {
    const published = await publishRoot();
    const driver = databaseAt(strangerMarker(published));

    await expect(
      applyV1(clientFor(driver), published.storage, { ifAhead: "noop" })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_NOT_FOUND,
      message: expect.stringMatching(UNKNOWN),
    });
    expect(wroteAnything(driver)).toBe(false);
  });

  test("a marker from another estate is unknown, even naming a state this one holds on its path", async () => {
    const published = await publishRoot();
    const foreign = {
      ...aheadMarker(published),
      estateHash: "c".repeat(64) as Sha256,
    };
    const driver = databaseAt(foreign);

    await expect(
      applyV1(clientFor(driver), published.storage, { ifAhead: "noop" })
    ).rejects.toMatchObject({ message: expect.stringMatching(UNKNOWN) });
  });
});

describe("read-only commands report the standing instead of failing", () => {
  test("status() names an ahead marker and plans nothing", async () => {
    const published = await publishRoot();
    const marker = aheadMarker(published);
    const driver = databaseAt(marker);

    const status = await statusV1(clientFor(driver), published.storage);

    expect(status).toMatchObject({
      control: "present",
      pending: [],
      unfinished: false,
      markerState: "ahead",
    });
    expect(status.marker?.stateId).toBe(NEWER_STATE);
  });

  test("status() of a stranger marker says unknown", async () => {
    const published = await publishRoot();
    const driver = databaseAt(strangerMarker(published));

    await expect(
      statusV1(clientFor(driver), published.storage)
    ).resolves.toMatchObject({ pending: [], markerState: "unknown" });
  });

  test.each([
    ["ahead", aheadMarker],
    ["unknown", strangerMarker],
  ] as const)("verify() reports a %s marker as not ok without proving a schema", async (standing, markerOf) => {
    const published = await publishRoot();
    const driver = databaseAt(markerOf(published));

    await expect(
      verifyV1(clientFor(driver), published.storage)
    ).resolves.toEqual({ ok: false, markerState: standing });
    // The decision is the marker read: after it, only the open-ledger read
    // and the lock's COMMIT. No live schema is introspected or fingerprinted,
    // since there is no snapshot to compare it with.
    const markerRead = driver.statements.findIndex((statement) =>
      statement.startsWith('SELECT payload FROM "_viborm_migration_state"')
    );
    const after = driver.statements.slice(markerRead + 1);
    expect(after).toHaveLength(2);
    expect(after[0]).toMatch(LEDGER_READ);
    expect(after[1]).toBe("COMMIT");
  });
});
