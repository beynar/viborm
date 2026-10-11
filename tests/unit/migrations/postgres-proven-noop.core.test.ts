/**
 * Plan D5 at the layer the migration coverage gate measures: a PostgreSQL
 * `apply()` with nothing to do proves it in two statements, before any lock.
 *
 * The estate is the real one `generate()` publishes for a small schema, so the
 * snapshot, marker and digest are what a deployment carries. The recording
 * driver answers the control tables' definition and then the one decision
 * read (marker, open attempts, catalog digest under `lockFree`). Every way
 * that read cannot prove a no-op must send the command to the locked path,
 * which decides again; that path is visible as the transaction lock it takes.
 * `postgres-round-trips.test.ts` counts the same statements on live
 * PostgreSQL.
 */

import { createClient } from "@client/client";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient } from "@migrations";
import { canonicalizeJsonText } from "@migrations/canonical-json";
import { markerFromPath } from "@migrations/control";
import { loadMigrationGraph, parentTransition } from "@migrations/graph";
import type { Sha256 } from "@migrations/identity";
import { fingerprintLive } from "@migrations/push-fingerprint";
import { eventIdFor } from "@migrations/v1-parse";
import type {
  ApplyV1Options,
  LedgerEventV1,
  MigrationMarkerV1,
} from "@migrations/v1-types";
import { s } from "@schema";
import { getPushMigrationDriver } from "@src/migrations/push/planner";
import { describe, expect, it } from "vitest";
import {
  controlCatalogAnswer,
  MemoryStorage,
  pgEstateDriver,
  postgresControlCatalogAnswer,
  type RecordingDriver,
} from "./_estate";

const schema = {
  account: s
    .model({
      id: s.string().id(),
      email: s.string().unique(),
      country: s.string().default("FR"),
    })
    .map("accounts"),
};

const DECISION = /AS digest WHERE pg_try_advisory_xact_lock\(/;
const CONTROL_CATALOG = "AS control(position, name)";
/** The locked path: its first transaction takes the bounded transaction lock. */
const LOCKED_PATH = /^WITH RECURSIVE lock_attempt AS/;
const NOOP = { outcome: "noop", path: [], statements: [] };
/** The catalog digest read on its own, as the locked drift proof sends it. */
const LOCKED_DIGEST = "END AS digest\nFROM projection";

interface Estate {
  readonly storage: MemoryStorage;
  readonly marker: MigrationMarkerV1;
  /** The fingerprint of the marked state's snapshot: the digest of a database at it. */
  readonly digest: Sha256;
}

async function generatedEstate(): Promise<Estate> {
  const storage = new MemoryStorage();
  const generator = pgEstateDriver("public");
  const client = createClient({ driver: generator, schema });
  await createMigrationClient(client, { storage }).generate({ name: "v1" });
  const graph = await loadMigrationGraph(storage);
  const [stateId] = graph.leaves;
  const state = graph.states.get(stateId!)!;
  const marker = markerFromPath(
    graph.estateHash,
    state.snapshotHash,
    [
      {
        stateId: stateId!,
        transitionHash: parentTransition(graph, null, stateId!).transitionHash,
        baselineBoundary: false,
      },
    ],
    1
  );
  const digest = await fingerprintLive(
    graph.snapshots.get(state.snapshotHash)!,
    getPushMigrationDriver(client),
    generator
  );
  return { storage, marker, digest };
}

interface Decision {
  readonly marker?: MigrationMarkerV1 | null;
  readonly ledger?: readonly LedgerEventV1[];
  readonly digest?: string | null;
  /** `false` is a lock another session holds: the statement returns no row. */
  readonly lockFree?: boolean;
  /** The decision read fails the way a statement the server rejects does. */
  readonly fails?: boolean;
  /** The decision read's connection dies under it. */
  readonly lost?: boolean;
  /** The one-statement digest the locked drift proof reads. */
  readonly lockedDigest?: string | null;
}

/** One JSON aggregate of `{ payload }` rows, or SQL NULL for none. */
function payloadAggregate(values: readonly unknown[]): string | null {
  return values.length === 0
    ? null
    : JSON.stringify(
        values.map((value) => ({ payload: canonicalizeJsonText(value) }))
      );
}

function databaseAnswering(decision: Decision): RecordingDriver {
  const driver = pgEstateDriver("public");
  driver.respond = (sql, params) => {
    // Both control tables exist, for the locked path's own presence probes.
    if (sql.startsWith("SELECT EXISTS")) {
      return (
        controlCatalogAnswer(sql, params, { state: true, log: true }) ?? []
      );
    }
    // The bound schema exists.
    if (sql.includes("pg_namespace") && !sql.includes("pg_class")) {
      return [{ present: 1 }];
    }
    if (sql.includes(CONTROL_CATALOG)) {
      return (
        postgresControlCatalogAnswer(sql, {
          state: true,
          log: true,
          check: "CHECK ((singleton = 1))",
        }) ?? []
      );
    }
    if (DECISION.test(sql)) {
      if (decision.lost) {
        return Object.assign(new Error("read ECONNRESET"), {
          code: "ECONNRESET",
        });
      }
      if (decision.fails) {
        return new Error('relation "_viborm_migration_state" is locked');
      }
      if (decision.lockFree === false) return [];
      return [
        {
          marker: payloadAggregate(decision.marker ? [decision.marker] : []),
          ledger: payloadAggregate(decision.ledger ?? []),
          digest: decision.digest ?? null,
        },
      ];
    }
    // The locked path reads the same facts one statement at a time.
    if (sql.startsWith("SELECT payload FROM") && sql.includes("_state")) {
      return decision.marker
        ? [{ payload: canonicalizeJsonText(decision.marker) }]
        : [];
    }
    if (sql.startsWith("SELECT payload FROM") && sql.includes("_log")) {
      return (decision.ledger ?? []).map((event) => ({
        payload: canonicalizeJsonText(event),
      }));
    }
    if (sql.includes(LOCKED_DIGEST)) {
      return [{ digest: decision.lockedDigest ?? null }];
    }
    return [];
  };
  return driver;
}

function applyOn(
  driver: RecordingDriver,
  storage: MemoryStorage,
  options?: ApplyV1Options
) {
  return createMigrationClient(createClient({ driver, schema }), {
    storage,
  }).apply(options);
}

function startedAttempt(marker: MigrationMarkerV1): LedgerEventV1 {
  const event = {
    format: "1" as const,
    attemptId: "d".repeat(64),
    kind: "started" as const,
    estateHash: marker.estateHash,
    snapshotHash: marker.snapshotHash,
    sqlHash: null,
    fromState: marker.stateId,
    toState: null,
    transitionHash: null,
    direction: "forward" as const,
    operationId: null,
    dispatchId: null,
    effectState: "none" as const,
    startedAt: "2026-10-11T00:00:00.000Z",
    finishedAt: null,
    toolVersion: "v1",
    failure: null,
  };
  return { ...event, eventId: eventIdFor(event) };
}

/** Statements after the reserved connection's version probe. */
function sent(driver: RecordingDriver): string[] {
  return driver.statements.filter(
    (sql) =>
      sql !== "<connect>" &&
      sql !== "SELECT current_setting('server_version_num') AS version"
  );
}

describe("a PostgreSQL apply at its target proves the no-op before any lock", () => {
  it("answers noop from the control catalog and one decision read", async () => {
    const estate = await generatedEstate();
    const driver = databaseAnswering({
      marker: estate.marker,
      digest: estate.digest,
    });

    await expect(applyOn(driver, estate.storage)).resolves.toEqual(NOOP);

    const statements = sent(driver);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain(CONTROL_CATALOG);
    expect(statements[1]).toMatch(DECISION);
    // The digest is computed for the estate's bound schema and its control pair.
    expect(
      driver.parameters[driver.statements.indexOf(statements[1]!)]
    ).toEqual(
      expect.arrayContaining([
        "public",
        "_viborm_migration_state",
        "_viborm_migration_log",
      ])
    );
  });

  it('answers an ahead marker with ifAhead: "noop" from the same read', async () => {
    const estate = await generatedEstate();
    const ahead = markerFromPath(
      estate.marker.estateHash,
      estate.marker.snapshotHash,
      [
        ...estate.marker.path,
        {
          stateId: "e".repeat(64) as Sha256,
          transitionHash: "f".repeat(64) as Sha256,
          baselineBoundary: false,
        },
      ],
      2
    );
    const driver = databaseAnswering({ marker: ahead, digest: null });

    await expect(
      applyOn(driver, estate.storage, { ifAhead: "noop" })
    ).resolves.toEqual(NOOP);
    expect(sent(driver)).toHaveLength(2);
  });
});

describe("whatever the decision read cannot prove is decided again under the lock", () => {
  it.each([
    [
      "the digest disagrees",
      (estate: Estate): Decision => ({
        marker: estate.marker,
        digest: "0".repeat(64),
      }),
    ],
    [
      "the digest abstains",
      (estate: Estate): Decision => ({
        marker: estate.marker,
        digest: null,
      }),
    ],
    [
      "another command holds the lock",
      (estate: Estate): Decision => ({
        marker: estate.marker,
        digest: estate.digest,
        lockFree: false,
      }),
    ],
    [
      "the decision read fails",
      (estate: Estate): Decision => ({
        marker: estate.marker,
        digest: estate.digest,
        fails: true,
      }),
    ],
    [
      "an attempt is open",
      (estate: Estate): Decision => ({
        marker: estate.marker,
        ledger: [startedAttempt(estate.marker)],
        digest: estate.digest,
      }),
    ],
    [
      "there is no marker",
      (estate: Estate): Decision => ({
        marker: null,
        digest: estate.digest,
      }),
    ],
  ])("%s: the command goes on to take the lock", async (_, decisionFor) => {
    const estate = await generatedEstate();
    const driver = databaseAnswering(decisionFor(estate));
    // A lock the server refuses ends the locked path at its first statement,
    // so what is observed is that the unlocked read did not answer.
    driver.lockAnswers.acquire = [{ acquired: false }];

    await expect(applyOn(driver, estate.storage)).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_LOCK_FAILED,
    });
    const statements = sent(driver);
    expect(statements[1]).toMatch(DECISION);
    expect(statements.filter((sql) => LOCKED_PATH.test(sql))).toHaveLength(1);
  });
});

describe("under the lock, the drift proof reads the same one-statement digest", () => {
  it("a database at the target whose digest matches is a no-op, decided without introspection", async () => {
    const estate = await generatedEstate();
    const driver = databaseAnswering({
      marker: estate.marker,
      lockFree: false,
      lockedDigest: estate.digest,
    });

    await expect(applyOn(driver, estate.storage)).resolves.toEqual(NOOP);
    const statements = sent(driver);
    expect(statements.filter((sql) => LOCKED_PATH.test(sql))).toHaveLength(1);
    // Embedded in the decision read, then read alone under the lock; the
    // locked transaction then ends with nothing else read.
    const digests = statements.flatMap((sql, index) =>
      sql.includes(LOCKED_DIGEST) ? [index] : []
    );
    expect(digests).toHaveLength(2);
    expect(statements.slice(digests[1]! + 1)).toEqual(["COMMIT"]);
  });
});

describe("a decision read whose connection dies", () => {
  it("ends the command as the retryable connection failure: nothing else is sent", async () => {
    const estate = await generatedEstate();
    const driver = databaseAnswering({
      marker: estate.marker,
      digest: estate.digest,
      lost: true,
    });

    await expect(applyOn(driver, estate.storage)).rejects.toMatchObject({
      code: VibORMErrorCode.CONNECTION_FAILED,
    });
    expect(sent(driver).at(-1)).toMatch(DECISION);
    expect(sent(driver).some((sql) => LOCKED_PATH.test(sql))).toBe(false);
  });
});
