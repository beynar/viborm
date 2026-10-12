/**
 * Whether the live database is what the durable record says (plan D5, S5):
 * the marker's standing in a history, drift against an authenticated
 * snapshot, and the lock not let go since a decision. One function per proof;
 * nothing here knows a command or a transport.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import {
  type appendLedger,
  controlTableNames,
  DEFAULT_CONTROL_BASE,
  readControlState,
  unfinishedAttempts,
} from "./control";
import { diff } from "./differ";
import type { BoundMigrationDriver } from "./drivers";
import { postgresCatalogDigest } from "./drivers/postgres/catalog-digest";
import type { MigrationGraph } from "./graph";
import type { Sha256 } from "./identity";
import { lockedSinceDecision } from "./pinned-session";
import { fingerprintLive } from "./push-fingerprint";
import { introspectManaged } from "./push-plan";
import type { MarkerIndexPredicateV1, MigrationMarkerV1 } from "./v1-types";

/**
 * Where the live marker stands relative to this history. A marker naming a
 * state the graph holds — or no state — is `known`, and `assertNoDrift` proves
 * the rest. Otherwise its arrival path tells version skew from a stranger: the
 * marker is `ahead` when that path passes through a state of this estate
 * before leaving it (newer code applied the rest), and `unknown` when nothing
 * on it belongs here.
 */
export function markerStanding(
  graph: MigrationGraph,
  marker: MigrationMarkerV1 | null
): "known" | "ahead" | "unknown" {
  if (!marker?.stateId || graph.states.has(marker.stateId)) return "known";
  return marker.estateHash === graph.estateHash &&
    marker.path.some((edge) => graph.states.has(edge.stateId))
    ? "ahead"
    : "unknown";
}

/**
 * Refuses a group whose decision was taken under a lock the command has since
 * let go (plans D1, S5): an earlier group committed, or SQLite committed the
 * decision's transaction to switch foreign keys. Read as the group's first
 * statements, under its own lock: if another command moved the marker in
 * between, nothing of this group runs. Apply never leaves an attempt of its own
 * open between two groups, so an unfinished one is another command's; `down`
 * and `reset` carry theirs across groups and pass `ownAttempt`.
 */
export async function assertLockedSinceDecision(
  pinned: Parameters<typeof appendLedger>[0],
  producer: Parameters<typeof appendLedger>[0],
  command: BoundMigrationDriver,
  expected: MigrationMarkerV1 | null,
  ownAttempt = false
): Promise<void> {
  if (lockedSinceDecision(pinned)) return;
  const { marker, ledger } = await readControlState(
    producer,
    command,
    DEFAULT_CONTROL_BASE,
    { ledger: "open" }
  );
  if (
    marker?.revision === expected?.revision &&
    marker?.pathHash === expected?.pathHash &&
    (ownAttempt || unfinishedAttempts(ledger).length === 0)
  ) {
    return;
  }
  throw new MigrationError(
    "Another migration command moved the marker between two of this command's transactions. Nothing of the remaining path ran; running the command again re-reads the marker.",
    VibORMErrorCode.MIGRATION_MARKER_CONFLICT
  );
}

export async function assertNoDrift(
  producer: Parameters<typeof introspectManaged>[0],
  command: BoundMigrationDriver,
  graph: MigrationGraph,
  marker: MigrationMarkerV1
): Promise<void> {
  await proveLive(producer, command, graph, markedSnapshotHash(graph, marker));
}

/** The authenticated snapshot a marker names, once its identity is proven. */
export function markedSnapshotHash(
  graph: MigrationGraph,
  marker: MigrationMarkerV1
): Sha256 {
  if (marker.estateHash !== graph.estateHash) {
    throw new MigrationError(
      "Live marker estate does not match storage",
      VibORMErrorCode.MIGRATION_DRIFT,
      { meta: { estateHash: marker.estateHash } }
    );
  }
  if (marker.stateId) {
    const state = graph.states.get(marker.stateId);
    if (!state) {
      throw new MigrationError(
        "Marker state is missing from the estate",
        VibORMErrorCode.MIGRATION_CORRUPTION
      );
    }
    if (state.snapshotHash !== marker.snapshotHash) {
      throw new MigrationError(
        "Marker snapshot does not match the authenticated state",
        VibORMErrorCode.MIGRATION_DRIFT
      );
    }
  } else if (marker.snapshotHash !== graph.emptySnapshotHash) {
    throw new MigrationError(
      "An empty-path marker must name the empty managed snapshot",
      VibORMErrorCode.MIGRATION_DRIFT
    );
  }
  if (marker.path.length === 0) {
    if (marker.stateId !== null) {
      throw new MigrationError(
        "Marker path does not end at the marked state",
        VibORMErrorCode.MIGRATION_CORRUPTION
      );
    }
  } else {
    if (marker.path.at(-1)!.stateId !== marker.stateId) {
      throw new MigrationError(
        "Marker path does not end at the marked state",
        VibORMErrorCode.MIGRATION_CORRUPTION
      );
    }
    let from: Sha256 | null = null;
    for (const edge of marker.path) {
      const state = graph.states.get(edge.stateId);
      const parent = state?.parents.find(
        (item) =>
          item.transitionHash === edge.transitionHash && item.fromState === from
      );
      if (!(state && parent)) {
        throw new MigrationError(
          "Marker path is not an authenticated arrival route",
          VibORMErrorCode.MIGRATION_CORRUPTION
        );
      }
      from = edge.stateId;
    }
  }
  const snapshotHash = marker.stateId
    ? graph.states.get(marker.stateId)!.snapshotHash
    : graph.emptySnapshotHash;
  if (!graph.snapshots.get(snapshotHash)) {
    throw new MigrationError(
      "Marker snapshot is missing from the estate",
      VibORMErrorCode.MIGRATION_CORRUPTION
    );
  }
  return snapshotHash;
}

/**
 * Proves the live managed schema is the snapshot: on PostgreSQL in one
 * statement (plan D5, `catalog-digest.ts`), else, and where that digest
 * abstains, through an introspection, read once. On PostgreSQL it returns each
 * partial-index predicate that introspection read, the server's own deparse
 * (`pg_get_expr`), which a forward apply records beside the marker
 * (`casMarker`) for the no-op; the digest abstains on any partial index, so
 * a proof without introspection has none to record. `refusal` words the
 * drift; `differences` describes it on demand.
 */
export async function proveLive(
  producer: Parameters<typeof introspectManaged>[0],
  command: BoundMigrationDriver,
  graph: MigrationGraph,
  snapshotHash: Sha256,
  refusal: (
    differences: () => Promise<string>
  ) => Promise<string> | string = async (differences) =>
    `Live managed schema drifted from the authenticated snapshot. Differences: ${await differences()}`
): Promise<readonly MarkerIndexPredicateV1[]> {
  // `loadMigrationGraph` loads every state's snapshot and seeds the empty one.
  const expected = graph.snapshots.get(snapshotHash)!;
  const fingerprint = await fingerprintLive(expected, command, producer);
  const postgres = command.target.dialect === "postgresql";
  const digest = postgres
    ? await postgresCatalogDigest(
        producer,
        command,
        controlTableNames(DEFAULT_CONTROL_BASE)
      )
    : undefined;
  if (digest !== undefined && digest === fingerprint) return [];
  const live = await introspectManaged(producer, command);
  if ((await fingerprintLive(live, command, producer)) !== fingerprint) {
    throw new MigrationError(
      await refusal(async () => JSON.stringify(await diff(live, expected))),
      VibORMErrorCode.MIGRATION_DRIFT
    );
  }
  if (digest !== undefined) {
    throw new MigrationError(
      "The PostgreSQL catalog digest disagrees with the introspected schema, which matches the authenticated snapshot. This is a VibORM defect in the digest (drivers/postgres/catalog-digest.ts), not drift: nothing ran. Please report it with the snapshot.",
      VibORMErrorCode.INTERNAL_ERROR
    );
  }
  if (!postgres) return [];
  return live.tables.flatMap((table) =>
    table.indexes.flatMap((index) =>
      index.where
        ? [{ table: table.name, index: index.name, deparsed: index.where }]
        : []
    )
  );
}

export async function assertEmptyManaged(
  producer: Parameters<typeof introspectManaged>[0],
  command: BoundMigrationDriver
): Promise<void> {
  const live = await introspectManaged(producer, command);
  if (live.tables.length > 0 || (live.enums?.length ?? 0) > 0) {
    throw new MigrationError(
      "Ordinary apply requires an empty managed target; use baseline to adopt an existing schema",
      VibORMErrorCode.MIGRATION_INVALID_STATE
    );
  }
}
