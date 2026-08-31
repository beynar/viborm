import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { VibORMErrorCode } from "@src/errors";
import { canonicalizeJsonText } from "@src/migrations/canonical-json";
import { markerFromPath } from "@src/migrations/control";
import { emptyManagedSnapshot } from "@src/migrations/empty-snapshot";
import { downV1, resolveV1 } from "@src/migrations/operators";
import { composeSqlBlob } from "@src/migrations/sql-blob";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import {
  encodeDispatchIdentity,
  encodeEstateDescriptor,
  encodeSnapshot,
  encodeStateManifest,
  encodeTransitionHash,
  eventIdFor,
} from "@src/migrations/v1-parse";
import type {
  LedgerEventV1,
  MarkerPathEdgeV1,
  MigrationBooleanCheckV1,
  MigrationDispatchV1,
  MigrationMarkerV1,
  MigrationOperationV1,
  MigrationParentTransitionV1,
} from "@src/migrations/v1-types";
import { describe, expect, test } from "vitest";
import {
  controlCatalogAnswer,
  RecordingDriver,
  sqliteControlDefinitionAnswer,
  sqliteEstateDriver,
} from "./_estate";

/**
 * Estate-command closure for `down()` and `resolve()`.
 *
 * Everything here is a stored-artifact or stored-control refusal: the estate is
 * authenticated bytes, the marker and the ledger are rows the command did not
 * write, and the live schema is whatever the recording driver reports. That is
 * the only way to reach these arms, because a healthy database never produces
 * them — the marker that disagrees with its own arrival path, the unfinished
 * rollback that names a different edge, the retry whose destination never
 * arrives.
 */

const EMPTY_SNAPSHOT = encodeSnapshot(emptyManagedSnapshot());
const LEFTOVER_TABLE = "leftover";
const LEFTOVER_DDL = `CREATE TABLE "${LEFTOVER_TABLE}" ("id" TEXT)`;
const FALSE_ROW = [{ matches: 0 }];
const OK_ROW = [{ ok: 1 }];

/**
 * A consumer-supplied SQLite driver that reports no transaction support.
 *
 * `viborm/driver` exports the `Driver` base class, so this is a shape a
 * consumer can ship, and it is the only way to reach the untransacted arms of
 * `resolve()`. The estate fixture's own D1 substrate cannot stand in: SQLite
 * live-capability admission refuses every effectful command on a driver named
 * `d1` or `libsql`, and it judges the EXECUTION driver's name — so an unlisted
 * name is admitted and resolves its migration driver through the registry's
 * dialect default, exactly as any custom driver does.
 */
class UntransactedSqliteDriver extends RecordingDriver {
  override readonly supportsTransactions = false;
}

function untransactedEstateDriver(): RecordingDriver {
  return new UntransactedSqliteDriver(
    "sqlite",
    "custom-sqlite",
    new SQLiteAdapter()
  );
}

function clientFor(driver: RecordingDriver) {
  return { $driver: driver, $schema: {} };
}

function dispatchAt(
  blob: ReturnType<typeof composeSqlBlob>,
  index: number
): MigrationDispatchV1 {
  const range = blob.ranges[index]!;
  return {
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
  };
}

function opaqueOperation(
  id: string,
  origin: "generated" | "manual",
  execute: MigrationDispatchV1
): MigrationOperationV1 {
  return {
    id,
    label: id,
    origin,
    risk: origin === "manual" ? "opaque" : "safe",
    steps: [{ retry: "opaque", execute }],
  };
}

function trustedCheck(
  id: string,
  query: MigrationDispatchV1
): MigrationBooleanCheckV1 {
  return { kind: "trusted-read", id, query, equals: true };
}

interface StateSpec {
  readonly name: string;
  /** Forward dispatch texts. Omitted means a transition with no operations. */
  readonly forward?: readonly string[];
  readonly forwardOrigin?: "generated" | "manual";
  /** Rollback dispatch texts. Omitted means an irreversible arrival. */
  readonly rollback?: readonly string[];
  readonly originCheck?: boolean;
  readonly destinationCheck?: boolean;
}

interface PublishedState {
  readonly stateId: string;
  readonly transitionHash: string;
  readonly sqlHash: string;
  readonly edge: MarkerPathEdgeV1;
  readonly rollbackDispatches: readonly MigrationDispatchV1[];
  readonly originCheckSql: string | null;
  readonly destinationCheckSql: string | null;
}

interface PublishedChain {
  readonly storage: MemoryEstateStorage;
  readonly estateHash: string;
  readonly snapshotHash: string;
  readonly states: readonly PublishedState[];
}

/**
 * Publishes a linear estate whose every state carries the empty managed
 * snapshot, so the live schema a recording driver reports (nothing) is the
 * authenticated one and each test can move exactly one fact away from it.
 */
async function publishChain(
  specs: readonly StateSpec[]
): Promise<PublishedChain> {
  const storage = new MemoryEstateStorage();
  const estate = encodeEstateDescriptor({ dialect: "sqlite" });
  await storage.publishEstate(estate.bytes);
  await storage.publishSnapshot(
    EMPTY_SNAPSHOT.snapshotHash,
    EMPTY_SNAPSHOT.bytes
  );
  const states: PublishedState[] = [];
  let fromState: string | null = null;
  for (const spec of specs) {
    const forwardSql = spec.forward ?? [];
    const rollbackSql = spec.rollback ?? [];
    const originCheckSql = spec.originCheck
      ? `SELECT '${spec.name}-origin'`
      : null;
    const destinationCheckSql = spec.destinationCheck
      ? `SELECT '${spec.name}-destination'`
      : null;
    const blob = composeSqlBlob([
      ...forwardSql,
      ...rollbackSql,
      ...(originCheckSql ? [originCheckSql] : []),
      ...(destinationCheckSql ? [destinationCheckSql] : []),
    ]);
    const rollbackDispatches = rollbackSql.map((_text, index) =>
      dispatchAt(blob, forwardSql.length + index)
    );
    const checkBase = forwardSql.length + rollbackSql.length;
    const originChecks = originCheckSql
      ? [trustedCheck(`${spec.name}:origin`, dispatchAt(blob, checkBase))]
      : [];
    const destinationChecks = destinationCheckSql
      ? [
          trustedCheck(
            `${spec.name}:destination`,
            dispatchAt(blob, checkBase + (originCheckSql ? 1 : 0))
          ),
        ]
      : [];
    const parentBody: Omit<MigrationParentTransitionV1, "transitionHash"> = {
      fromState,
      originChecks,
      requestedForwardBoundary: null,
      operations: forwardSql.map((_text, index) =>
        opaqueOperation(
          `${spec.name}:forward:${index}`,
          spec.forwardOrigin ?? "generated",
          dispatchAt(blob, index)
        )
      ),
      rollback: spec.rollback
        ? {
            kind: "manual",
            requestedBoundary: "transactional",
            operations: rollbackDispatches.map((execute, index) =>
              opaqueOperation(
                `${spec.name}:rollback:${index}`,
                "manual",
                execute
              )
            ),
          }
        : { kind: "irreversible", reason: `${spec.name} cannot roll back` },
    };
    const transitionHash = encodeTransitionHash(parentBody);
    const encoded = encodeStateManifest({
      format: "1",
      estateHash: estate.estateHash,
      name: spec.name,
      snapshotHash: EMPTY_SNAPSHOT.snapshotHash,
      sqlHash: blob.sqlHash,
      destinationChecks,
      parents: [{ ...parentBody, transitionHash }],
    });
    await storage.publishSql(blob.sqlHash, blob.bytes);
    await storage.publishState(encoded.stateId, encoded.bytes);
    states.push({
      stateId: encoded.stateId,
      transitionHash,
      sqlHash: blob.sqlHash,
      edge: {
        stateId: encoded.stateId,
        transitionHash,
        baselineBoundary: false,
      },
      rollbackDispatches,
      originCheckSql,
      destinationCheckSql,
    });
    fromState = encoded.stateId;
  }
  return {
    storage,
    estateHash: estate.estateHash,
    snapshotHash: EMPTY_SNAPSHOT.snapshotHash,
    states,
  };
}

function markerAt(chain: PublishedChain, count: number): MigrationMarkerV1 {
  return markerFromPath(
    chain.estateHash,
    chain.snapshotHash,
    chain.states.slice(0, count).map((state) => state.edge),
    count
  );
}

function rollbackStarted(
  chain: PublishedChain,
  state: PublishedState,
  toState: string | null,
  attemptId = "c".repeat(64)
): LedgerEventV1 {
  const event = {
    format: "1" as const,
    attemptId,
    kind: "started" as const,
    estateHash: chain.estateHash,
    snapshotHash: chain.snapshotHash,
    sqlHash: state.sqlHash,
    fromState: state.stateId,
    toState,
    transitionHash: state.transitionHash,
    direction: "rollback" as const,
    operationId: null,
    dispatchId: null,
    effectState: "none" as const,
    startedAt: "2026-08-30T10:00:00.000Z",
    finishedAt: null,
    toolVersion: "v1",
    failure: null,
  };
  return { ...event, eventId: eventIdFor(event) };
}

function forwardStarted(
  chain: PublishedChain,
  options: {
    readonly fromState?: string | null;
    readonly toState: string | null;
    readonly transitionHash?: string | null;
  }
): LedgerEventV1 {
  const event = {
    format: "1" as const,
    attemptId: "a".repeat(64),
    kind: "started" as const,
    estateHash: chain.estateHash,
    snapshotHash: chain.snapshotHash,
    sqlHash: null,
    fromState: options.fromState ?? null,
    toState: options.toState,
    transitionHash: options.transitionHash ?? null,
    direction: "forward" as const,
    operationId: null,
    dispatchId: null,
    effectState: "none" as const,
    startedAt: "2026-08-30T09:00:00.000Z",
    finishedAt: null,
    toolVersion: "v1",
    failure: null,
  };
  return { ...event, eventId: eventIdFor(event) };
}

function stepConfirmed(
  started: LedgerEventV1,
  overrides: Partial<Omit<LedgerEventV1, "eventId">>
): LedgerEventV1 {
  const { eventId: _ignored, ...body } = started;
  const event = {
    ...body,
    kind: "step-confirmed" as const,
    effectState: "committed" as const,
    finishedAt: "2026-08-30T10:00:01.000Z",
    ...overrides,
  };
  return { ...event, eventId: eventIdFor(event) };
}

interface ControlOptions {
  readonly marker?: MigrationMarkerV1;
  readonly ledger?: readonly LedgerEventV1[];
  /** Exact answers that must win over the shared control fixtures. */
  readonly answer?: (
    sql: string,
    params: unknown[]
  ) => unknown[] | Error | undefined;
  /** Managed tables the live catalog reports, read at every introspection. */
  readonly liveTables?: () => readonly string[];
}

function controlRespond(options: ControlOptions = {}) {
  const ledger = options.ledger ?? [];
  return (sql: string, params: unknown[]): unknown[] | Error => {
    const custom = options.answer?.(sql, params);
    if (custom !== undefined) return custom;
    const catalog = controlCatalogAnswer(sql, params, {
      state: true,
      log: true,
    });
    if (catalog) return catalog;
    const definition = sqliteControlDefinitionAnswer(sql, {
      state: true,
      log: true,
    });
    if (definition) {
      if (sql.includes("SELECT name, sql") && sql.includes("type = 'table'")) {
        return [
          ...definition,
          ...(options.liveTables?.() ?? []).map((name) => ({
            name,
            sql: `CREATE TABLE "${name}" ("id" TEXT)`,
          })),
        ];
      }
      return definition;
    }
    if (
      sql.includes("SELECT payload FROM") &&
      sql.includes("_viborm_migration_state")
    ) {
      return options.marker
        ? [{ payload: canonicalizeJsonText(options.marker) }]
        : [];
    }
    if (
      sql.includes("SELECT payload FROM") &&
      sql.includes("_viborm_migration_log")
    ) {
      return ledger.map((event) => ({ payload: canonicalizeJsonText(event) }));
    }
    if (
      sql.startsWith("INSERT INTO") ||
      sql.startsWith("UPDATE") ||
      sql.startsWith("CREATE TABLE")
    ) {
      return OK_ROW;
    }
    return [];
  };
}

/** Reports one extra managed table from the moment `trigger` has executed. */
function tableAppearsAfter(trigger: string) {
  let appeared = false;
  return {
    answer: (sql: string): unknown[] | undefined => {
      if (sql !== trigger) return;
      appeared = true;
      return OK_ROW;
    },
    liveTables: () => (appeared ? [LEFTOVER_TABLE] : []),
  };
}

function wroteMarker(driver: RecordingDriver): boolean {
  return driver.statements.some(
    (statement) =>
      statement.startsWith("UPDATE") ||
      (statement.startsWith("INSERT INTO") &&
        statement.includes("_viborm_migration_state"))
  );
}

describe("down closure", () => {
  test("refuses an effectful rollback on an unmarked database", async () => {
    const chain = await publishChain([
      { name: "root", rollback: ["SELECT 'undo-root'"] },
    ]);
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({});

    await expect(
      downV1(clientFor(driver), chain.storage, { steps: 1 })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_NOT_FOUND,
      message: "Nothing to roll back",
    });
    expect(driver.statements).not.toContain("SELECT 'undo-root'");
  });

  test("refuses a marker edge whose state left the estate", async () => {
    const chain = await publishChain([
      { name: "root", rollback: ["SELECT 'undo-root'"] },
    ]);
    const marker = markerFromPath(
      chain.estateHash,
      chain.snapshotHash,
      [
        {
          stateId: "f".repeat(64),
          transitionHash: "f".repeat(64),
          baselineBoundary: false,
        },
      ],
      1
    );
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({ marker });

    await expect(
      downV1(clientFor(driver), chain.storage, { steps: 1 })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
      message: "Rollback target is missing from the estate",
    });
  });

  test("refuses an unfinished rollback that names a different edge", async () => {
    const chain = await publishChain([
      { name: "root", rollback: ["SELECT 'undo-root'"] },
      { name: "child", rollback: ["SELECT 'undo-child'"] },
    ]);
    const root = chain.states[0]!;
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      marker: markerAt(chain, 2),
      ledger: [rollbackStarted(chain, root, null)],
    });

    await expect(
      downV1(clientFor(driver), chain.storage, { steps: 1 })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_UNFINISHED_ATTEMPT,
      message: expect.stringContaining("does not match the selected reverse"),
    });
    expect(driver.statements).not.toContain("SELECT 'undo-child'");
  });

  test("refuses to resume a rollback across an irreversible arrival", async () => {
    const chain = await publishChain([
      { name: "root", rollback: ["SELECT 'undo-root'"] },
      { name: "child" },
    ]);
    const [root, child] = chain.states;
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      marker: markerAt(chain, 1),
      ledger: [rollbackStarted(chain, child!, root!.stateId)],
    });

    await expect(
      downV1(clientFor(driver), chain.storage, { steps: 1 })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED,
      message: "child cannot roll back",
    });
  });

  test("refuses a stored marker whose state disagrees with its own path", async () => {
    const chain = await publishChain([
      { name: "root", rollback: ["SELECT 'undo-root'"] },
      { name: "child" },
    ]);
    const [root, child] = chain.states;
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      // A published state, so every snapshot lookup on the way in succeeds and
      // the refusal is about the marker naming a state its own path does not
      // arrive at.
      marker: { ...markerAt(chain, 1), stateId: child!.stateId },
      ledger: [rollbackStarted(chain, root!, null)],
    });

    await expect(
      downV1(clientFor(driver), chain.storage, { steps: 1 })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_MARKER_CONFLICT,
      message: expect.stringContaining("does not name the authenticated edge"),
    });
    expect(driver.statements).not.toContain("SELECT 'undo-root'");
  });

  test("refuses to start a rollback whose destination checks no longer hold", async () => {
    const chain = await publishChain([
      {
        name: "root",
        rollback: ["SELECT 'undo-root'"],
        destinationCheck: true,
      },
    ]);
    const root = chain.states[0]!;
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      marker: markerAt(chain, 1),
      answer: (sql) =>
        sql === root.destinationCheckSql ? FALSE_ROW : undefined,
    });

    await expect(
      downV1(clientFor(driver), chain.storage, { steps: 1 })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DRIFT,
      message: "Destination checks failed before rollback",
    });
    expect(driver.statements).not.toContain("SELECT 'undo-root'");
    expect(wroteMarker(driver)).toBe(false);
  });

  test("refuses to move the marker when origin checks fail after rollback", async () => {
    const chain = await publishChain([
      { name: "root", rollback: ["SELECT 'undo-root'"], originCheck: true },
    ]);
    const root = chain.states[0]!;
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      marker: markerAt(chain, 1),
      answer: (sql) => (sql === root.originCheckSql ? FALSE_ROW : undefined),
    });

    await expect(
      downV1(clientFor(driver), chain.storage, { steps: 1 })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DRIFT,
      message: "Origin checks failed after rollback",
    });
    expect(driver.statements).toContain("SELECT 'undo-root'");
    expect(wroteMarker(driver)).toBe(false);
  });

  test("refuses to move the marker when rollback misses the parent snapshot", async () => {
    const chain = await publishChain([
      { name: "root", rollback: [LEFTOVER_DDL] },
    ]);
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      marker: markerAt(chain, 1),
      ...tableAppearsAfter(LEFTOVER_DDL),
    });

    await expect(
      downV1(clientFor(driver), chain.storage, { steps: 1 })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DRIFT,
      message: "Rollback did not reach the parent snapshot",
    });
    expect(wroteMarker(driver)).toBe(false);
  });
});

describe("down resume evidence", () => {
  test("refuses rollback progress that is not from the authenticated edge", async () => {
    const chain = await publishChain([
      {
        name: "root",
        rollback: ["SELECT 'undo-root-0'", "SELECT 'undo-root-1'"],
      },
    ]);
    const root = chain.states[0]!;
    const started = rollbackStarted(chain, root, null);
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [
        started,
        stepConfirmed(started, {
          direction: "forward",
          operationId: "root:rollback:0",
          dispatchId: root.rollbackDispatches[0]!.dispatchId,
        }),
      ],
    });

    await expect(
      downV1(clientFor(driver), chain.storage, { steps: 1 })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
      message: "Rollback progress does not match its authenticated edge",
    });
  });

  test("refuses rollback progress naming a dispatch the program does not have", async () => {
    const chain = await publishChain([
      {
        name: "root",
        rollback: ["SELECT 'undo-root-0'", "SELECT 'undo-root-1'"],
      },
    ]);
    const root = chain.states[0]!;
    const started = rollbackStarted(chain, root, null);
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [
        started,
        stepConfirmed(started, {
          operationId: "root:rollback:0",
          dispatchId: "b".repeat(64),
        }),
      ],
    });

    await expect(
      downV1(clientFor(driver), chain.storage, { steps: 1 })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
      message: "Rollback progress names an unknown dispatch",
    });
  });

  test("refuses rollback progress that skips a dispatch", async () => {
    const chain = await publishChain([
      {
        name: "root",
        rollback: ["SELECT 'undo-root-0'", "SELECT 'undo-root-1'"],
      },
    ]);
    const root = chain.states[0]!;
    const started = rollbackStarted(chain, root, null);
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [
        started,
        stepConfirmed(started, {
          operationId: "root:rollback:1",
          dispatchId: root.rollbackDispatches[1]!.dispatchId,
        }),
      ],
    });

    await expect(
      downV1(clientFor(driver), chain.storage, { steps: 1 })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
      message: "Rollback progress is not a contiguous dispatch prefix",
    });
  });

  test("refuses to close a completed rollback whose origin checks fail", async () => {
    const chain = await publishChain([
      { name: "root", rollback: ["SELECT 'undo-root'"] },
      { name: "child", rollback: ["SELECT 'undo-child'"], originCheck: true },
    ]);
    const [root, child] = chain.states;
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      marker: markerAt(chain, 1),
      ledger: [rollbackStarted(chain, child!, root!.stateId)],
      answer: (sql) => (sql === child!.originCheckSql ? FALSE_ROW : undefined),
    });

    await expect(
      downV1(clientFor(driver), chain.storage, { steps: 1 })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DRIFT,
      message: "Origin checks failed after rollback",
    });
    expect(driver.statements).not.toContain("SELECT 'undo-child'");
  });

  test("refuses to close a completed rollback whose parent snapshot is absent live", async () => {
    const chain = await publishChain([
      { name: "root", rollback: ["SELECT 'undo-root'"] },
      { name: "child", rollback: ["SELECT 'undo-child'"] },
    ]);
    const [root, child] = chain.states;
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      marker: markerAt(chain, 1),
      ledger: [rollbackStarted(chain, child!, root!.stateId)],
      liveTables: () => [LEFTOVER_TABLE],
    });

    await expect(
      downV1(clientFor(driver), chain.storage, { steps: 1 })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DRIFT,
      message: "Rollback did not reach the parent snapshot",
    });
    expect(driver.statements).not.toContain("SELECT 'undo-child'");
  });
});

describe("resolve closure", () => {
  test("refuses an unfinished attempt that names no target state", async () => {
    const chain = await publishChain([{ name: "root" }]);
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [forwardStarted(chain, { toState: null })],
    });

    await expect(
      resolveV1(clientFor(driver), chain.storage, { outcome: "complete" })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
      message: "Unfinished attempt is missing its target state",
    });
  });

  test("refuses an unfinished attempt whose target left the estate", async () => {
    const chain = await publishChain([{ name: "root" }]);
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [forwardStarted(chain, { toState: "f".repeat(64) })],
    });

    await expect(
      resolveV1(clientFor(driver), chain.storage, { outcome: "complete" })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
      message: "Unfinished attempt target is absent from the estate",
    });
  });

  test("refuses to retry a generated structural transition away from its origin", async () => {
    const chain = await publishChain([
      { name: "root", forward: ["SELECT 'root-forward'"] },
    ]);
    const root = chain.states[0]!;
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [forwardStarted(chain, { toState: root.stateId })],
      liveTables: () => [LEFTOVER_TABLE],
    });

    await expect(
      resolveV1(clientFor(driver), chain.storage, { outcome: "retry" })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("except from the origin"),
    });
    expect(driver.statements).not.toContain("SELECT 'root-forward'");
  });

  test("refuses a retry whose destination checks still fail", async () => {
    const chain = await publishChain([
      {
        name: "root",
        forward: ["SELECT 'root-forward'"],
        destinationCheck: true,
      },
    ]);
    const root = chain.states[0]!;
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [forwardStarted(chain, { toState: root.stateId })],
      answer: (sql) =>
        sql === root.destinationCheckSql ? FALSE_ROW : undefined,
    });

    await expect(
      resolveV1(clientFor(driver), chain.storage, { outcome: "retry" })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DRIFT,
      message: "Retry did not reach the destination",
    });
    expect(driver.statements).toContain("SELECT 'root-forward'");
    expect(wroteMarker(driver)).toBe(false);
  });

  test("refuses a retry whose live schema is not the destination snapshot", async () => {
    const chain = await publishChain([
      { name: "root", forward: [LEFTOVER_DDL] },
    ]);
    const root = chain.states[0]!;
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [forwardStarted(chain, { toState: root.stateId })],
      ...tableAppearsAfter(LEFTOVER_DDL),
    });

    await expect(
      resolveV1(clientFor(driver), chain.storage, { outcome: "retry" })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DRIFT,
      message: "Retry did not reach the destination",
    });
    expect(wroteMarker(driver)).toBe(false);
  });

  test("rewinds the marker one edge when an attempt resolves rolled back", async () => {
    const chain = await publishChain([
      { name: "root", forward: ["SELECT 'root-forward'"] },
      { name: "child" },
    ]);
    const [root, child] = chain.states;
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      marker: markerAt(chain, 2),
      ledger: [
        forwardStarted(chain, {
          fromState: root!.stateId,
          toState: child!.stateId,
          transitionHash: child!.transitionHash,
        }),
      ],
    });

    await expect(
      resolveV1(clientFor(driver), chain.storage, { outcome: "rolled-back" })
    ).resolves.toEqual({ outcome: "rolled-back" });
    expect(
      driver.statements.some((statement) => statement.startsWith("UPDATE"))
    ).toBe(true);
  });
});

describe("resolve on a producer without transactions", () => {
  test.each([
    "complete",
    "rolled-back",
  ] as const)("records a %s resolution without opening a transaction", async (outcome) => {
    const chain = await publishChain([{ name: "root" }]);
    const root = chain.states[0]!;
    const driver = untransactedEstateDriver();
    driver.respond = controlRespond({
      ledger: [forwardStarted(chain, { toState: root.stateId })],
    });

    await expect(
      resolveV1(clientFor(driver), chain.storage, { outcome })
    ).resolves.toEqual({ outcome });
    expect(driver.statements).not.toContain("<begin>");
  });

  test("retries a generated structural transition without opening a transaction", async () => {
    const chain = await publishChain([
      { name: "root", forward: ["SELECT 'root-forward'"] },
    ]);
    const root = chain.states[0]!;
    const driver = untransactedEstateDriver();
    driver.respond = controlRespond({
      ledger: [forwardStarted(chain, { toState: root.stateId })],
    });

    await expect(
      resolveV1(clientFor(driver), chain.storage, { outcome: "retry" })
    ).resolves.toEqual({ outcome: "retry" });
    expect(driver.statements).toContain("SELECT 'root-forward'");
    expect(driver.statements).not.toContain("<begin>");
  });
});
