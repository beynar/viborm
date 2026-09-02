import { VibORMErrorCode } from "@src/errors";
import {
  canonicalizeJson,
  canonicalizeJsonText,
} from "@src/migrations/canonical-json";
import { markerFromPath } from "@src/migrations/control";
import { emptyManagedSnapshot } from "@src/migrations/empty-snapshot";
import { domainHash, HASH_DOMAIN } from "@src/migrations/identity";
import { resetV1 } from "@src/migrations/reset-v1";
import { composeSqlBlob } from "@src/migrations/sql-blob";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import {
  encodeDispatchIdentity,
  encodeEstateDescriptor,
  encodeSnapshot,
  encodeSqlBlob,
  encodeStateManifest,
  encodeTransitionHash,
  eventIdFor,
} from "@src/migrations/v1-parse";
import type {
  LedgerEffectStateV1,
  LedgerEventV1,
  MigrationDispatchV1,
  MigrationParentTransitionV1,
  ResetPlanV1,
} from "@src/migrations/v1-types";
import { describe, expect, test } from "vitest";
import {
  controlCatalogAnswer,
  type RecordingDriver,
  sqliteControlDefinitionAnswer,
  sqliteEstateDriver,
} from "./_estate";

/**
 * `reset()` replay and clear closure.
 *
 * Reset is the one command that reads its own unfinished work back out of the
 * ledger and decides what is left to do, so almost everything here is a stored
 * `reset-started` plan plus stored progress rows: the evidence a crashed reset
 * would have left, and the shapes a corrupted or concurrently-edited ledger
 * would leave instead. The live clear arm is driven from the recording driver's
 * catalog answers, because what a clear drops is exactly what the inventory
 * named.
 */

const EMPTY_SNAPSHOT = encodeSnapshot(emptyManagedSnapshot());
const CONTROL_TABLES = ["_viborm_migration_state", "_viborm_migration_log"];
const LEFTOVER_TABLE = "leftover";
const LEFTOVER_DDL = `CREATE TABLE "${LEFTOVER_TABLE}" ("id" TEXT)`;
const UNKNOWN_DISPATCH = "b".repeat(64);
const OK_ROW = [{ ok: 1 }];

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

/** The dispatch identity `reset()` mints for one rendered clear statement. */
function clearDispatchFor(text: string): MigrationDispatchV1 {
  const bytes = new TextEncoder().encode(text);
  const sqlHash = encodeSqlBlob(bytes);
  return {
    dispatchId: encodeDispatchIdentity(sqlHash, 0, bytes.length, []),
    sqlHash,
    offset: 0,
    length: bytes.length,
    parameters: [],
  };
}

interface ResetStateSpec {
  readonly name: string;
  readonly forward: readonly string[];
  readonly boundary?: "transactional" | "stepwise";
}

interface PublishedResetState {
  readonly name: string;
  readonly stateId: string;
  readonly transitionHash: string;
  readonly sqlHash: string;
  readonly fromState: string | null;
  readonly forwardDispatches: readonly MigrationDispatchV1[];
}

interface PublishedResetChain {
  readonly storage: MemoryEstateStorage;
  readonly estateHash: string;
  readonly snapshotHash: string;
  readonly states: readonly PublishedResetState[];
}

/**
 * Publishes a linear replay estate. Every state carries the empty managed
 * snapshot, so a recording driver that reports no managed table is already at
 * the authenticated destination and a test only has to move the one fact it is
 * about.
 */
async function publishResetChain(
  specs: readonly ResetStateSpec[]
): Promise<PublishedResetChain> {
  const storage = new MemoryEstateStorage();
  const estate = encodeEstateDescriptor({ dialect: "sqlite" });
  await storage.publishEstate(estate.bytes);
  await storage.publishSnapshot(
    EMPTY_SNAPSHOT.snapshotHash,
    EMPTY_SNAPSHOT.bytes
  );
  const states: PublishedResetState[] = [];
  let fromState: string | null = null;
  for (const spec of specs) {
    const blob = composeSqlBlob(spec.forward);
    const forwardDispatches = spec.forward.map((_text, index) =>
      dispatchAt(blob, index)
    );
    const parentBody: Omit<MigrationParentTransitionV1, "transitionHash"> = {
      fromState,
      originChecks: [],
      requestedForwardBoundary: spec.boundary ?? null,
      operations: forwardDispatches.map((execute, index) => ({
        id: `${spec.name}:forward:${index}`,
        label: `${spec.name} forward ${index}`,
        origin: "manual" as const,
        risk: "opaque" as const,
        steps: [{ retry: "opaque" as const, execute }],
      })),
      rollback: {
        kind: "irreversible",
        reason: `${spec.name} is forward only`,
      },
    };
    const transitionHash = encodeTransitionHash(parentBody);
    const encoded = encodeStateManifest({
      format: "1",
      estateHash: estate.estateHash,
      name: spec.name,
      snapshotHash: EMPTY_SNAPSHOT.snapshotHash,
      sqlHash: blob.sqlHash,
      destinationChecks: [],
      parents: [{ ...parentBody, transitionHash }],
    });
    await storage.publishSql(blob.sqlHash, blob.bytes);
    await storage.publishState(encoded.stateId, encoded.bytes);
    states.push({
      name: spec.name,
      stateId: encoded.stateId,
      transitionHash,
      sqlHash: blob.sqlHash,
      fromState,
      forwardDispatches,
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

function resetPlanFor(
  chain: PublishedResetChain,
  clearDispatches: readonly MigrationDispatchV1[] = []
): ResetPlanV1 {
  const replayPath = chain.states.map((state) => state.stateId);
  const body = {
    estateHash: chain.estateHash,
    targetIdentity: "sqlite:",
    sourceRevision: 0,
    sourceFingerprint: chain.snapshotHash,
    replayPath,
    clearDispatches,
    referencedStates: replayPath,
  };
  return {
    ...body,
    resetPlanHash: domainHash(HASH_DOMAIN.resetPlan, canonicalizeJson(body)),
  };
}

function resetStartedEvent(
  chain: PublishedResetChain,
  plan: ResetPlanV1
): LedgerEventV1 {
  const event = {
    format: "1" as const,
    attemptId: plan.resetPlanHash,
    kind: "reset-started" as const,
    estateHash: chain.estateHash,
    snapshotHash: chain.snapshotHash,
    sqlHash: null,
    fromState: null,
    toState: chain.states.at(-1)!.stateId,
    transitionHash: null,
    direction: "reset" as const,
    operationId: null,
    dispatchId: null,
    effectState: "none" as const,
    startedAt: "2026-08-30T08:00:00.000Z",
    finishedAt: null,
    toolVersion: "v1",
    resetPlan: plan,
    failure: null,
  };
  return { ...event, eventId: eventIdFor(event) };
}

interface ResetStepFields {
  readonly sqlHash: string | null;
  readonly fromState: string | null;
  readonly toState: string | null;
  readonly transitionHash: string | null;
  readonly operationId: string | null;
  readonly dispatchId: string | null;
  readonly effectState?: LedgerEffectStateV1;
  readonly direction?: LedgerEventV1["direction"];
}

function resetStepEvent(
  chain: PublishedResetChain,
  attemptId: string,
  fields: ResetStepFields
): LedgerEventV1 {
  const event = {
    format: "1" as const,
    attemptId,
    kind: "reset-step-confirmed" as const,
    estateHash: chain.estateHash,
    snapshotHash: chain.snapshotHash,
    sqlHash: fields.sqlHash,
    fromState: fields.fromState,
    toState: fields.toState,
    transitionHash: fields.transitionHash,
    direction: fields.direction ?? "reset",
    operationId: fields.operationId,
    dispatchId: fields.dispatchId,
    effectState: fields.effectState ?? "committed",
    startedAt: "2026-08-30T08:00:01.000Z",
    finishedAt: "2026-08-30T08:00:01.000Z",
    toolVersion: "v1",
    failure: null,
  };
  return { ...event, eventId: eventIdFor(event) };
}

/** Progress for one real replay dispatch of the estate. */
function replayStepEvent(
  chain: PublishedResetChain,
  attemptId: string,
  stateIndex: number,
  stepIndex: number,
  overrides: Partial<ResetStepFields> = {}
): LedgerEventV1 {
  const state = chain.states[stateIndex]!;
  return resetStepEvent(chain, attemptId, {
    sqlHash: state.sqlHash,
    fromState: state.fromState,
    toState: state.stateId,
    transitionHash: state.transitionHash,
    operationId: `${state.name}:forward:${stepIndex}`,
    dispatchId: state.forwardDispatches[stepIndex]!.dispatchId,
    ...overrides,
  });
}

/** Progress for one clear dispatch of the stored plan. */
function clearStepEvent(
  chain: PublishedResetChain,
  attemptId: string,
  dispatch: MigrationDispatchV1,
  effectState: LedgerEffectStateV1 = "committed"
): LedgerEventV1 {
  return resetStepEvent(chain, attemptId, {
    sqlHash: dispatch.sqlHash,
    fromState: null,
    toState: null,
    transitionHash: null,
    operationId: null,
    dispatchId: dispatch.dispatchId,
    effectState,
  });
}

interface ControlOptions {
  readonly ledger?: readonly LedgerEventV1[];
  readonly answer?: (
    sql: string,
    params: unknown[]
  ) => unknown[] | Error | undefined;
  readonly liveTables?: () => readonly string[];
}

function controlRespond(options: ControlOptions = {}) {
  const ledger = options.ledger ?? [];
  return (sql: string, params: unknown[]): unknown[] | Error => {
    const custom = options.answer?.(sql, params);
    if (custom !== undefined) return custom;
    if (sql.startsWith("SELECT name FROM sqlite_master")) {
      return CONTROL_TABLES.map((name) => ({ name }));
    }
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
      return [];
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

function isLeftoverProbe(sql: string, params: unknown[]): boolean {
  return (
    sql.startsWith("SELECT EXISTS") &&
    sql.includes("sqlite_master") &&
    params.at(-1) === LEFTOVER_TABLE
  );
}

function inventoryRows(present: boolean): unknown[] {
  return [
    ...CONTROL_TABLES.map((name) => ({ name })),
    ...(present ? [{ name: LEFTOVER_TABLE }] : []),
  ];
}

function droppedLeftover(driver: RecordingDriver): boolean {
  return driver.statements.some(
    (statement) =>
      statement.startsWith("DROP TABLE") && statement.includes(LEFTOVER_TABLE)
  );
}

/**
 * Progress rows that are neither a clear (all four edge fields null) nor a
 * replay step, which is what an interleaved or hand-edited ledger produces.
 */
const HALF_CLEAR_SHAPES: readonly {
  readonly shape: string;
  readonly fields: Pick<ResetStepFields, "transitionHash" | "operationId">;
}[] = [
  {
    shape: "a transition hash",
    fields: { transitionHash: "c".repeat(64), operationId: null },
  },
  {
    shape: "an operation id",
    fields: { transitionHash: null, operationId: "root:forward:0" },
  },
];

describe("reset replay evidence", () => {
  test("refuses reset progress whose direction is not a reset", async () => {
    const chain = await publishResetChain([
      { name: "root", forward: ["SELECT 'root-forward-0'"] },
    ]);
    const plan = resetPlanFor(chain);
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [
        resetStartedEvent(chain, plan),
        replayStepEvent(chain, plan.resetPlanHash, 0, 0, {
          direction: "forward",
        }),
      ],
    });

    await expect(
      resetV1(clientFor(driver), chain.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
      message: "Reset progress does not match its authenticated plan",
    });
    expect(driver.statements).not.toContain("SELECT 'root-forward-0'");
  });

  test.each(
    HALF_CLEAR_SHAPES
  )("refuses half-clear progress carrying $shape", async ({ fields }) => {
    const chain = await publishResetChain([
      { name: "root", forward: ["SELECT 'root-forward-0'"] },
    ]);
    const plan = resetPlanFor(chain);
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [
        resetStartedEvent(chain, plan),
        resetStepEvent(chain, plan.resetPlanHash, {
          sqlHash: null,
          fromState: null,
          toState: null,
          dispatchId: UNKNOWN_DISPATCH,
          ...fields,
        }),
      ],
    });

    await expect(
      resetV1(clientFor(driver), chain.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
      message: "Reset replay progress names an unknown dispatch",
    });
    expect(driver.statements).not.toContain("SELECT 'root-forward-0'");
  });

  test("refuses replay progress that names a foreign operation", async () => {
    const chain = await publishResetChain([
      { name: "root", forward: ["SELECT 'root-forward-0'"] },
    ]);
    const plan = resetPlanFor(chain);
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [
        resetStartedEvent(chain, plan),
        replayStepEvent(chain, plan.resetPlanHash, 0, 0, {
          operationId: "root:forward:9",
        }),
      ],
    });

    await expect(
      resetV1(clientFor(driver), chain.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
      message: "Reset replay progress names an unknown dispatch",
    });
  });

  test("refuses replay progress with an unreadable effect state", async () => {
    const chain = await publishResetChain([
      { name: "root", forward: ["SELECT 'root-forward-0'"] },
    ]);
    const plan = resetPlanFor(chain);
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [
        resetStartedEvent(chain, plan),
        replayStepEvent(chain, plan.resetPlanHash, 0, 0, {
          effectState: "partial",
        }),
      ],
    });

    await expect(
      resetV1(clientFor(driver), chain.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT,
      message: "Reset replay progress has an ambiguous commit outcome",
    });
  });

  test("refuses an announced dispatch that is not the next one", async () => {
    const chain = await publishResetChain([
      {
        name: "root",
        forward: [
          "SELECT 'root-forward-0'",
          "SELECT 'root-forward-1'",
          "SELECT 'root-forward-2'",
        ],
      },
    ]);
    const plan = resetPlanFor(chain);
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [
        resetStartedEvent(chain, plan),
        replayStepEvent(chain, plan.resetPlanHash, 0, 0),
        replayStepEvent(chain, plan.resetPlanHash, 0, 2, {
          effectState: "none",
        }),
      ],
    });

    await expect(
      resetV1(clientFor(driver), chain.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
      message: "Reset replay progress is not contiguous",
    });
  });

  test("resumes inside a partly replayed transition", async () => {
    const chain = await publishResetChain([
      {
        name: "root",
        forward: ["SELECT 'root-forward-0'", "SELECT 'root-forward-1'"],
      },
    ]);
    const plan = resetPlanFor(chain);
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [
        resetStartedEvent(chain, plan),
        replayStepEvent(chain, plan.resetPlanHash, 0, 0),
      ],
    });

    await expect(resetV1(clientFor(driver), chain.storage)).resolves.toEqual({
      preview: false,
      path: [chain.states[0]!.stateId],
    });
    expect(driver.statements).not.toContain("SELECT 'root-forward-0'");
    expect(driver.statements).toContain("SELECT 'root-forward-1'");
  });

  test("replays nothing when every stored dispatch already committed", async () => {
    const chain = await publishResetChain([
      { name: "root", forward: ["SELECT 'root-forward-0'"] },
      { name: "child", forward: ["SELECT 'child-forward-0'"] },
    ]);
    const plan = resetPlanFor(chain);
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [
        resetStartedEvent(chain, plan),
        replayStepEvent(chain, plan.resetPlanHash, 0, 0),
        replayStepEvent(chain, plan.resetPlanHash, 1, 0),
      ],
    });

    await expect(resetV1(clientFor(driver), chain.storage)).resolves.toEqual({
      preview: false,
      path: chain.states.map((state) => state.stateId),
    });
    expect(driver.statements).not.toContain("SELECT 'root-forward-0'");
    expect(driver.statements).not.toContain("SELECT 'child-forward-0'");
  });

  test("refuses a replay that does not reach the target snapshot", async () => {
    const chain = await publishResetChain([
      { name: "root", forward: [LEFTOVER_DDL] },
    ]);
    let appeared = false;
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      answer: (sql) => {
        if (sql !== LEFTOVER_DDL) return;
        appeared = true;
        return OK_ROW;
      },
      liveTables: () => (appeared ? [LEFTOVER_TABLE] : []),
    });

    await expect(
      resetV1(clientFor(driver), chain.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DRIFT,
      message: "Reset replay did not reach the target snapshot",
    });
  });
});

describe("reset clear evidence", () => {
  test("accepts a committed clear dispatch from the stored plan", async () => {
    const chain = await publishResetChain([
      { name: "root", forward: ["SELECT 'root-forward-0'"] },
    ]);
    const clear = clearDispatchFor(`DROP TABLE IF EXISTS "${LEFTOVER_TABLE}"`);
    const plan = resetPlanFor(chain, [clear]);
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [
        resetStartedEvent(chain, plan),
        clearStepEvent(chain, plan.resetPlanHash, clear),
      ],
    });

    await expect(resetV1(clientFor(driver), chain.storage)).resolves.toEqual({
      preview: false,
      path: [chain.states[0]!.stateId],
    });
    expect(driver.statements).toContain("SELECT 'root-forward-0'");
  });

  test("refuses a clear dispatch that never committed", async () => {
    const chain = await publishResetChain([
      { name: "root", forward: ["SELECT 'root-forward-0'"] },
    ]);
    const clear = clearDispatchFor(`DROP TABLE IF EXISTS "${LEFTOVER_TABLE}"`);
    const plan = resetPlanFor(chain, [clear]);
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [
        resetStartedEvent(chain, plan),
        clearStepEvent(chain, plan.resetPlanHash, clear, "none"),
      ],
    });

    await expect(
      resetV1(clientFor(driver), chain.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
      message: "Reset clear progress names an unknown dispatch",
    });
  });

  test("refuses clear progress that skips an earlier clear", async () => {
    const chain = await publishResetChain([
      { name: "root", forward: ["SELECT 'root-forward-0'"] },
    ]);
    const first = clearDispatchFor('DROP TABLE IF EXISTS "first"');
    const second = clearDispatchFor('DROP TABLE IF EXISTS "second"');
    const plan = resetPlanFor(chain, [first, second]);
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [
        resetStartedEvent(chain, plan),
        clearStepEvent(chain, plan.resetPlanHash, second),
      ],
    });

    await expect(
      resetV1(clientFor(driver), chain.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
      message: "Reset clear progress is not a contiguous dispatch prefix",
    });
  });

  test("refuses a live clear the stored plan never planned", async () => {
    const chain = await publishResetChain([
      { name: "root", forward: ["SELECT 'root-forward-0'"] },
    ]);
    const plan = resetPlanFor(chain);
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [resetStartedEvent(chain, plan)],
      answer: (sql) =>
        sql.startsWith("SELECT name FROM sqlite_master")
          ? inventoryRows(true)
          : undefined,
      liveTables: () => [LEFTOVER_TABLE],
    });

    await expect(
      resetV1(clientFor(driver), chain.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: "Live remaining reset clears are not in the stored reset plan",
    });
    expect(droppedLeftover(driver)).toBe(false);
  });
});

describe("reset live clear", () => {
  test("drops a live table the estate does not own and proves it gone", async () => {
    const chain = await publishResetChain([
      { name: "root", forward: ["SELECT 'root-forward-0'"] },
    ]);
    let present = true;
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      answer: (sql, params) => {
        if (sql.startsWith("SELECT name FROM sqlite_master")) {
          return inventoryRows(present);
        }
        if (isLeftoverProbe(sql, params)) {
          return [{ exists: present ? 1 : 0 }];
        }
        if (sql.startsWith("DROP TABLE")) {
          present = false;
          return OK_ROW;
        }
        return;
      },
      liveTables: () => (present ? [LEFTOVER_TABLE] : []),
    });

    await expect(resetV1(clientFor(driver), chain.storage)).resolves.toEqual({
      preview: false,
      path: [chain.states[0]!.stateId],
    });
    expect(droppedLeftover(driver)).toBe(true);
  });

  test("records a planned clear whose table is already gone", async () => {
    const chain = await publishResetChain([
      { name: "root", forward: ["SELECT 'root-forward-0'"] },
    ]);
    let present = true;
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      answer: (sql, params) => {
        if (sql.startsWith("SELECT name FROM sqlite_master")) {
          return inventoryRows(present);
        }
        if (isLeftoverProbe(sql, params)) {
          present = false;
          return [{ exists: 0 }];
        }
        return;
      },
      liveTables: () => (present ? [LEFTOVER_TABLE] : []),
    });

    await expect(resetV1(clientFor(driver), chain.storage)).resolves.toEqual({
      preview: false,
      path: [chain.states[0]!.stateId],
    });
    expect(droppedLeftover(driver)).toBe(false);
  });

  test("refuses a clear whose drop left the table in place", async () => {
    const chain = await publishResetChain([
      { name: "root", forward: ["SELECT 'root-forward-0'"] },
    ]);
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      answer: (sql, params) => {
        if (sql.startsWith("SELECT name FROM sqlite_master")) {
          return inventoryRows(true);
        }
        if (isLeftoverProbe(sql, params)) return [{ exists: 1 }];
        if (sql.startsWith("DROP TABLE")) return OK_ROW;
        return;
      },
      liveTables: () => [LEFTOVER_TABLE],
    });

    await expect(
      resetV1(clientFor(driver), chain.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_PARTIAL_EFFECT,
      message: `Reset clear did not drop table ${LEFTOVER_TABLE}`,
    });
    expect(driver.statements).not.toContain("SELECT 'root-forward-0'");
  });

  test("clears inside its own transaction before a stepwise replay group", async () => {
    const chain = await publishResetChain([
      {
        name: "root",
        forward: ["SELECT 'root-forward-0'"],
        boundary: "stepwise",
      },
    ]);
    let present = true;
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      answer: (sql, params) => {
        if (sql.startsWith("SELECT name FROM sqlite_master")) {
          return inventoryRows(present);
        }
        if (isLeftoverProbe(sql, params)) {
          return [{ exists: present ? 1 : 0 }];
        }
        if (sql.startsWith("DROP TABLE")) {
          present = false;
          return OK_ROW;
        }
        return;
      },
      liveTables: () => (present ? [LEFTOVER_TABLE] : []),
    });

    await expect(resetV1(clientFor(driver), chain.storage)).resolves.toEqual({
      preview: false,
      path: [chain.states[0]!.stateId],
    });
    const dropIndex = driver.statements.findIndex((statement) =>
      statement.startsWith("DROP TABLE")
    );
    const replayIndex = driver.statements.indexOf("SELECT 'root-forward-0'");
    expect(dropIndex).toBeGreaterThanOrEqual(0);
    expect(replayIndex).toBeGreaterThan(dropIndex);
    expect(driver.statements.filter((sql) => sql === "<begin>")).toHaveLength(
      1
    );
  });
});

const PROVEN_PRECHECK_SQL = "SELECT 'proven-precheck'";
const PROVEN_EXECUTE_SQL = "SELECT 'proven-execute'";
const PROVEN_POSTCHECK_SQL = "SELECT 'proven-postcheck'";

/**
 * A replay estate whose one forward step is PROVEN rather than opaque.
 *
 * A proven step announces `none` only when its postcheck already held, so its
 * stored progress means something different from an opaque announcement, and
 * that difference is what the resume arithmetic has to read.
 */
async function publishProvenChain(): Promise<PublishedResetChain> {
  const storage = new MemoryEstateStorage();
  const estate = encodeEstateDescriptor({ dialect: "sqlite" });
  await storage.publishEstate(estate.bytes);
  await storage.publishSnapshot(
    EMPTY_SNAPSHOT.snapshotHash,
    EMPTY_SNAPSHOT.bytes
  );
  const blob = composeSqlBlob([
    PROVEN_PRECHECK_SQL,
    PROVEN_EXECUTE_SQL,
    PROVEN_POSTCHECK_SQL,
  ]);
  const execute = dispatchAt(blob, 1);
  const parentBody: Omit<MigrationParentTransitionV1, "transitionHash"> = {
    fromState: null,
    originChecks: [],
    requestedForwardBoundary: null,
    operations: [
      {
        id: "root:forward:0",
        label: "root forward 0",
        origin: "generated",
        risk: "safe",
        steps: [
          {
            retry: "proven",
            precheck: {
              kind: "trusted-read",
              id: "root:precheck",
              query: dispatchAt(blob, 0),
              equals: true,
            },
            execute,
            postcheck: {
              kind: "trusted-read",
              id: "root:postcheck",
              query: dispatchAt(blob, 2),
              equals: true,
            },
          },
        ],
      },
    ],
    rollback: { kind: "irreversible", reason: "root is forward only" },
  };
  const transitionHash = encodeTransitionHash(parentBody);
  const encoded = encodeStateManifest({
    format: "1",
    estateHash: estate.estateHash,
    name: "root",
    snapshotHash: EMPTY_SNAPSHOT.snapshotHash,
    sqlHash: blob.sqlHash,
    destinationChecks: [],
    parents: [{ ...parentBody, transitionHash }],
  });
  await storage.publishSql(blob.sqlHash, blob.bytes);
  await storage.publishState(encoded.stateId, encoded.bytes);
  return {
    storage,
    estateHash: estate.estateHash,
    snapshotHash: EMPTY_SNAPSHOT.snapshotHash,
    states: [
      {
        name: "root",
        stateId: encoded.stateId,
        transitionHash,
        sqlHash: blob.sqlHash,
        fromState: null,
        forwardDispatches: [execute],
      },
    ],
  };
}

describe("reset resume arithmetic", () => {
  test("refuses an unfinished reset whose stored replay path is not the requested one", async () => {
    const chain = await publishResetChain([
      { name: "root", forward: ["SELECT 'root-forward-0'"] },
      { name: "child", forward: ["SELECT 'child-forward-0'"] },
    ]);
    const requested = chain.states.map((state) => state.stateId);
    // Everything the plan authenticates about itself still holds; only its
    // replay path is a different length from the one this reset resolved.
    const body = {
      estateHash: chain.estateHash,
      targetIdentity: "sqlite:",
      sourceRevision: 0,
      sourceFingerprint: chain.snapshotHash,
      replayPath: [requested[0]!],
      clearDispatches: [],
      referencedStates: requested,
    };
    const plan: ResetPlanV1 = {
      ...body,
      resetPlanHash: domainHash(HASH_DOMAIN.resetPlan, canonicalizeJson(body)),
    };
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [resetStartedEvent(chain, plan)],
    });

    await expect(
      resetV1(clientFor(driver), chain.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: "The unfinished reset does not match the requested reset",
    });
    expect(driver.statements).not.toContain("SELECT 'root-forward-0'");
  });

  test("an announced transactional dispatch verifies nothing and replays its edge", async () => {
    const chain = await publishResetChain([
      {
        name: "root",
        forward: ["SELECT 'root-forward-0'", "SELECT 'root-forward-1'"],
        boundary: "transactional",
      },
    ]);
    const plan = resetPlanFor(chain);
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [
        resetStartedEvent(chain, plan),
        // Announced, never confirmed: a transactional edge took its dispatch
        // back, so no prefix of this edge is established.
        replayStepEvent(chain, plan.resetPlanHash, 0, 0, {
          effectState: "none",
        }),
      ],
    });

    await expect(resetV1(clientFor(driver), chain.storage)).resolves.toEqual({
      preview: false,
      path: [chain.states[0]!.stateId],
    });
    expect(driver.statements).toContain("SELECT 'root-forward-0'");
    expect(driver.statements).toContain("SELECT 'root-forward-1'");
  });

  test("an announced proven dispatch is progress and is not executed again", async () => {
    const chain = await publishProvenChain();
    const plan = resetPlanFor(chain);
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [
        resetStartedEvent(chain, plan),
        // A proven step reports `none` when its postcheck ALREADY held, so the
        // destination of that step is established evidence, not an ambiguity.
        replayStepEvent(chain, plan.resetPlanHash, 0, 0, {
          effectState: "none",
        }),
      ],
    });

    await expect(resetV1(clientFor(driver), chain.storage)).resolves.toEqual({
      preview: false,
      path: [chain.states[0]!.stateId],
    });
    expect(driver.statements).not.toContain(PROVEN_EXECUTE_SQL);
    expect(driver.statements).not.toContain(PROVEN_POSTCHECK_SQL);
  });
});

describe("reset marker proof", () => {
  test("closes an unfinished reset whose marker already proves the whole replay", async () => {
    const chain = await publishResetChain([
      { name: "root", forward: ["SELECT 'root-forward-0'"] },
      { name: "child", forward: ["SELECT 'child-forward-0'"] },
    ]);
    const plan = resetPlanFor(chain);
    // The crash landed between the marker compare-and-swap and the event that
    // records it: the marker names the target, by this reset's own revision and
    // arrival path, so the work is done and only the ledger is open.
    const marker = markerFromPath(
      chain.estateHash,
      chain.snapshotHash,
      chain.states.map((state) => ({
        stateId: state.stateId,
        transitionHash: state.transitionHash,
        baselineBoundary: false,
      })),
      plan.sourceRevision + 1
    );
    const driver = sqliteEstateDriver();
    driver.respond = controlRespond({
      ledger: [resetStartedEvent(chain, plan)],
      answer: (sql) =>
        sql.includes("SELECT payload FROM") &&
        sql.includes("_viborm_migration_state")
          ? [{ payload: canonicalizeJsonText(marker) }]
          : undefined,
    });

    await expect(resetV1(clientFor(driver), chain.storage)).resolves.toEqual({
      preview: false,
      path: chain.states.map((state) => state.stateId),
    });
    expect(driver.statements).not.toContain("SELECT 'root-forward-0'");
    expect(driver.statements).not.toContain("SELECT 'child-forward-0'");
  });
});
