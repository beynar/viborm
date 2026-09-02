import { VibORMErrorCode } from "@src/errors";
import { assertNoDrift } from "@src/migrations/apply-v1";
import { markerFromPath } from "@src/migrations/control";
import { getMigrationDriver } from "@src/migrations/drivers";
import { emptyManagedSnapshot } from "@src/migrations/empty-snapshot";
import type { MigrationGraph } from "@src/migrations/graph";
import type {
  MigrationMarkerV1,
  MigrationParentTransitionV1,
  MigrationStateManifestV1,
} from "@src/migrations/v1-types";
import { describe, expect, test } from "vitest";
import { sqliteEstateDriver } from "./_estate";

const ESTATE_HASH = "a".repeat(64);
const OTHER_ESTATE_HASH = "b".repeat(64);
const EMPTY_SNAPSHOT_HASH = "c".repeat(64);
const STATE_SNAPSHOT_HASH = "d".repeat(64);
const OTHER_SNAPSHOT_HASH = "e".repeat(64);
const STATE_A = "1".repeat(64);
const STATE_B = "2".repeat(64);
const TRANSITION_A = "3".repeat(64);
const TRANSITION_B = "4".repeat(64);
const SQL_HASH = "f".repeat(64);

function transition(
  fromState: string | null,
  transitionHash: string
): MigrationParentTransitionV1 {
  return {
    fromState,
    transitionHash,
    originChecks: [],
    requestedForwardBoundary: null,
    operations: [],
    rollback: { kind: "irreversible", reason: "drift fixture" },
  };
}

function state(
  stateId: string,
  parent: MigrationParentTransitionV1
): MigrationStateManifestV1 {
  return {
    format: "1",
    estateHash: ESTATE_HASH,
    name: stateId === STATE_A ? "a" : "b",
    stateId,
    snapshotHash: STATE_SNAPSHOT_HASH,
    sqlHash: SQL_HASH,
    destinationChecks: [],
    parents: [parent],
  };
}

function graph(): MigrationGraph {
  const first = state(STATE_A, transition(null, TRANSITION_A));
  const second = state(STATE_B, transition(STATE_A, TRANSITION_B));
  return {
    estateHash: ESTATE_HASH,
    descriptor: {
      format: "1",
      target: { dialect: "sqlite" },
      hash: "sha256",
    },
    states: new Map([
      [STATE_A, first],
      [STATE_B, second],
    ]),
    snapshots: new Map([
      [EMPTY_SNAPSHOT_HASH, emptyManagedSnapshot()],
      [STATE_SNAPSHOT_HASH, emptyManagedSnapshot()],
    ]),
    sql: new Map([[SQL_HASH, new Uint8Array()]]),
    roots: [STATE_A],
    leaves: [STATE_B],
    emptySnapshotHash: EMPTY_SNAPSHOT_HASH,
  };
}

function goodMarker(): MigrationMarkerV1 {
  return markerFromPath(
    ESTATE_HASH,
    STATE_SNAPSHOT_HASH,
    [
      {
        stateId: STATE_A,
        transitionHash: TRANSITION_A,
        baselineBoundary: false,
      },
    ],
    1
  );
}

async function expectDriftRefusal(
  migrationGraph: MigrationGraph,
  marker: MigrationMarkerV1
): Promise<{
  readonly failure: unknown;
  readonly statements: readonly string[];
}> {
  const producer = sqliteEstateDriver();
  const failure = await assertNoDrift(
    producer,
    getMigrationDriver(producer),
    migrationGraph,
    marker
  ).catch((error: unknown) => error);
  return { failure, statements: producer.statements };
}

describe("apply drift boundaries", () => {
  test("rejects a marker from another estate before introspection", async () => {
    expect(
      await expectDriftRefusal(graph(), {
        ...goodMarker(),
        estateHash: OTHER_ESTATE_HASH,
      })
    ).toMatchObject({
      failure: { code: VibORMErrorCode.MIGRATION_DRIFT },
      statements: [],
    });
  });

  test("rejects a marker whose state is absent", async () => {
    expect(
      await expectDriftRefusal(graph(), {
        ...goodMarker(),
        stateId: "0".repeat(64),
      })
    ).toMatchObject({
      failure: { code: VibORMErrorCode.MIGRATION_CORRUPTION },
      statements: [],
    });
  });

  test("rejects a state marker whose snapshot identity changed", async () => {
    expect(
      await expectDriftRefusal(graph(), {
        ...goodMarker(),
        snapshotHash: OTHER_SNAPSHOT_HASH,
      })
    ).toMatchObject({
      failure: { code: VibORMErrorCode.MIGRATION_DRIFT },
      statements: [],
    });
  });

  test("rejects an empty-state marker that names a non-empty snapshot", async () => {
    const marker = markerFromPath(ESTATE_HASH, OTHER_SNAPSHOT_HASH, [], 1);
    expect(await expectDriftRefusal(graph(), marker)).toMatchObject({
      failure: { code: VibORMErrorCode.MIGRATION_DRIFT },
      statements: [],
    });
  });

  test("rejects a non-empty state with an empty arrival path", async () => {
    const empty = markerFromPath(ESTATE_HASH, STATE_SNAPSHOT_HASH, [], 1);
    expect(
      await expectDriftRefusal(graph(), { ...empty, stateId: STATE_A })
    ).toMatchObject({
      failure: { code: VibORMErrorCode.MIGRATION_CORRUPTION },
      statements: [],
    });
  });

  test("rejects an arrival path that ends at another state", async () => {
    expect(
      await expectDriftRefusal(graph(), { ...goodMarker(), stateId: STATE_B })
    ).toMatchObject({
      failure: { code: VibORMErrorCode.MIGRATION_CORRUPTION },
      statements: [],
    });
  });

  test("rejects an arrival edge with an unauthenticated transition hash", async () => {
    const marker = markerFromPath(
      ESTATE_HASH,
      STATE_SNAPSHOT_HASH,
      [
        {
          stateId: STATE_A,
          transitionHash: "0".repeat(64),
          baselineBoundary: false,
        },
      ],
      1
    );
    expect(await expectDriftRefusal(graph(), marker)).toMatchObject({
      failure: { code: VibORMErrorCode.MIGRATION_CORRUPTION },
      statements: [],
    });
  });

  test("rejects a marker whose authenticated snapshot bytes are absent", async () => {
    const withoutStateSnapshot: MigrationGraph = {
      ...graph(),
      snapshots: new Map([[EMPTY_SNAPSHOT_HASH, emptyManagedSnapshot()]]),
    };
    expect(
      await expectDriftRefusal(withoutStateSnapshot, goodMarker())
    ).toMatchObject({
      failure: { code: VibORMErrorCode.MIGRATION_CORRUPTION },
      statements: [],
    });
  });
});

describe("coverage low value", () => {
  test("an empty path still rejects a non-null state before provider work", async () => {
    const marker = markerFromPath(ESTATE_HASH, STATE_SNAPSHOT_HASH, [], 2);
    expect(
      await expectDriftRefusal(graph(), { ...marker, stateId: STATE_A })
    ).toMatchObject({
      failure: { code: VibORMErrorCode.MIGRATION_CORRUPTION },
      statements: [],
    });
  });
});
