import { s } from "@schema";
import { VibORMErrorCode } from "@src/errors";
import {
  canonicalizeJson,
  canonicalizeJsonText,
} from "@src/migrations/canonical-json";
import { markerFromPath } from "@src/migrations/control";
import { getMigrationDriver } from "@src/migrations/drivers";
import { emptyManagedSnapshot } from "@src/migrations/empty-snapshot";
import { generateV1 } from "@src/migrations/generate-v1";
import { domainHash, HASH_DOMAIN } from "@src/migrations/identity";
import { planLiveNamespaceReset } from "@src/migrations/live-reset";
import { baselineV1, downV1, resolveV1 } from "@src/migrations/operators";
import { resetV1 } from "@src/migrations/reset-v1";
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
  MigrationDispatchV1,
  MigrationMarkerV1,
  MigrationOperationV1,
  MigrationParentTransitionV1,
} from "@src/migrations/v1-types";
import { describe, expect, test } from "vitest";
import {
  controlCatalogAnswer,
  mysqlEstateDriver,
  type RecordingDriver,
} from "./_estate";

/**
 * The MySQL arms of `down()`, `resolve()`, and `reset()`.
 *
 * MySQL commits DDL as it runs, so every command that changes live state hands
 * its program to `runSequentialProgram` instead of opening a transaction. The
 * SQLite suites prove what these commands DECIDE; what is only true here is
 * that the same decisions reach the same end through the sequential program,
 * with no transaction around them — and that the one clear MySQL cannot make
 * safe is refused before anything runs.
 *
 * Everything is answered from a recording MySQL server: catalogs, control
 * tables, marker, and ledger. No provider is involved.
 */

const EMPTY_SNAPSHOT = encodeSnapshot(emptyManagedSnapshot());
const CONTROL_TABLES = [
  "_viborm_migration_state",
  "_viborm_migration_log",
] as const;
const MIGRATION_STATE_WRITE =
  /^(?:INSERT INTO|UPDATE) (?:`[^`]+`\.)?`_viborm_migration_state`/i;
const CREATED_TABLE =
  /^CREATE TABLE(?: IF NOT EXISTS)? (?:`[^`]+`\.)?`([^`]+)`/i;
const DROPPED_TABLE = /^DROP TABLE(?: IF EXISTS)? (?:`[^`]+`\.)?`([^`]+)`/i;
const MUTATION =
  /^\s*(?:CREATE|DROP|ALTER|DELETE|INSERT|UPDATE|TRUNCATE|RENAME)\b/i;
const TRANSACTION_MARKERS = new Set(["<begin>", "BEGIN", "COMMIT"]);

/**
 * The one model shape this recording catalog reports back: a single
 * `VARCHAR(191) NOT NULL` primary key. Generated DDL and the fake inventory
 * therefore describe the same table, which is what lets a live-equality proof
 * mean something here.
 */
const org = s.model({ id: s.string().id() }).map("ns_orgs");
const post = s.model({ id: s.string().id() }).map("ns_posts");

interface ServerOptions {
  readonly tables?: readonly string[];
  readonly foreignKeys?: readonly Record<string, unknown>[];
  readonly marker?: MigrationMarkerV1;
  readonly ledger?: readonly LedgerEventV1[];
}

/**
 * A MySQL server that answers from a table set, a marker row, and a ledger.
 *
 * The column, primary-key and check answers are the exact shapes the control
 * tables and a `VARCHAR(191)` id column have, because control-table
 * authentication reads them before any command trusts a marker.
 */
function estateServer(
  options: ServerOptions = {}
): (sql: string, params: unknown[]) => unknown[] | Error {
  const tables = new Set(options.tables ?? []);
  return (sql: string, params: unknown[]): unknown[] | Error => {
    if (sql.includes("@@SESSION.sql_mode")) {
      return [
        {
          sql_mode: "STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION",
          server_version: "8.4.0",
        },
      ];
    }
    const catalog = controlCatalogAnswer(sql, params, {
      state: tables.has("_viborm_migration_state"),
      log: tables.has("_viborm_migration_log"),
    });
    if (catalog) {
      const table = String(params.at(-1) ?? "");
      return table.endsWith("_state") || table.endsWith("_log")
        ? catalog
        : [{ exists: tables.has(table) ? 1 : 0 }];
    }
    if (sql.includes("SCHEMATA")) {
      return [{ SCHEMA_NAME: "alpha" }];
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
      return (options.ledger ?? []).map((event) => ({
        payload: canonicalizeJsonText(event),
      }));
    }
    if (
      sql.includes("CHECK_CONSTRAINTS") &&
      sql.includes("tc.TABLE_NAME = ?")
    ) {
      return tables.has("_viborm_migration_state")
        ? [{ definition: "singleton = 1" }]
        : [];
    }
    if (sql.includes("CHECK_CONSTRAINTS")) {
      return [];
    }
    if (
      sql.includes("information_schema.COLUMNS") &&
      !sql.includes("COLUMN_TYPE")
    ) {
      return [];
    }
    if (MIGRATION_STATE_WRITE.test(sql)) {
      return [{}];
    }
    const created = CREATED_TABLE.exec(sql);
    if (created?.[1]) {
      tables.add(created[1]);
      return [];
    }
    const dropped = DROPPED_TABLE.exec(sql);
    if (dropped?.[1]) {
      tables.delete(dropped[1]);
      return [];
    }
    if (sql.includes("information_schema.VIEWS")) return [];
    if (sql.includes("TABLE_NAME AS name")) {
      return [...tables].map((name) => ({ name }));
    }
    if (sql.includes("information_schema.COLUMNS")) {
      return [...tables].flatMap((TABLE_NAME) => {
        const columns =
          TABLE_NAME === "_viborm_migration_state"
            ? [
                ["singleton", "int", "int", null],
                ["payload", "text", "text", null],
              ]
            : TABLE_NAME === "_viborm_migration_log"
              ? [
                  ["event_id", "varchar", "varchar(64)", 64],
                  ["attempt_id", "varchar", "varchar(64)", 64],
                  ["kind", "varchar", "varchar(32)", 32],
                  ["payload", "text", "text", null],
                ]
              : [["id", "varchar", "varchar(191)", 191]];
        return columns.map(
          ([
            COLUMN_NAME,
            DATA_TYPE,
            COLUMN_TYPE,
            CHARACTER_MAXIMUM_LENGTH,
          ]) => ({
            TABLE_NAME,
            COLUMN_NAME,
            DATA_TYPE,
            COLUMN_TYPE,
            IS_NULLABLE: "NO",
            COLUMN_DEFAULT: null,
            CHARACTER_MAXIMUM_LENGTH,
            NUMERIC_PRECISION: null,
            NUMERIC_SCALE: null,
            EXTRA: "",
            COLUMN_COMMENT: "",
          })
        );
      });
    }
    if (sql.includes("CONSTRAINT_TYPE = 'PRIMARY KEY'")) {
      return [...tables].map((TABLE_NAME) => ({
        TABLE_NAME,
        CONSTRAINT_NAME: "PRIMARY",
        COLUMN_NAME:
          TABLE_NAME === "_viborm_migration_state"
            ? "singleton"
            : TABLE_NAME === "_viborm_migration_log"
              ? "event_id"
              : "id",
        ORDINAL_POSITION: 1,
      }));
    }
    if (sql.includes("information_schema.STATISTICS")) {
      return [];
    }
    if (sql.includes("= 'FOREIGN KEY'")) {
      return [...(options.foreignKeys ?? [])];
    }
    if (sql.includes("information_schema.TABLES")) {
      return [...tables].map((TABLE_NAME) => ({ TABLE_NAME }));
    }
    return [];
  };
}

function mysqlEstate(options: ServerOptions = {}): RecordingDriver {
  const driver = mysqlEstateDriver({ namespace: "alpha", attested: true });
  driver.respond = estateServer(options);
  return driver;
}

function foreignKeyRow(fk: {
  table: string;
  constraint: string;
  referencedTable: string;
}): Record<string, unknown> {
  return {
    TABLE_SCHEMA: "alpha",
    TABLE_NAME: fk.table,
    CONSTRAINT_NAME: fk.constraint,
    COLUMN_NAME: "ref_id",
    REFERENCED_TABLE_SCHEMA: "alpha",
    REFERENCED_TABLE_NAME: fk.referencedTable,
    REFERENCED_COLUMN_NAME: "id",
    DELETE_RULE: "NO ACTION",
    UPDATE_RULE: "NO ACTION",
    ORDINAL_POSITION: 1,
  };
}

function clientFor(driver: RecordingDriver) {
  return { $driver: driver, $schema: {} };
}

function transactionMarkersIn(driver: RecordingDriver): string[] {
  return driver.statements.filter((sql) => TRANSACTION_MARKERS.has(sql));
}

function mutationsIn(driver: RecordingDriver): string[] {
  return driver.statements.filter((sql) => MUTATION.test(sql));
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

function generatedOperation(
  id: string,
  execute: MigrationDispatchV1
): MigrationOperationV1 {
  return {
    id,
    label: id,
    origin: "generated",
    risk: "safe",
    steps: [{ retry: "opaque", execute }],
  };
}

interface MysqlStateSpec {
  readonly name: string;
  readonly forward: readonly string[];
  /** Reverse dispatch texts. Omitted means an irreversible arrival. */
  readonly rollback?: readonly string[];
}

interface PublishedMysqlState {
  readonly name: string;
  readonly stateId: string;
  readonly fromState: string | null;
  readonly transitionHash: string;
  readonly sqlHash: string;
  readonly edge: MarkerPathEdgeV1;
  /** Forward dispatches, then rollback dispatches, as the blob holds them. */
  readonly dispatches: readonly MigrationDispatchV1[];
}

interface PublishedMysqlChain {
  readonly storage: MemoryEstateStorage;
  readonly estateHash: string;
  readonly snapshotHash: string;
  readonly states: readonly PublishedMysqlState[];
}

/**
 * A linear MySQL estate whose every state carries the empty managed snapshot.
 *
 * Rollback programs are `schema` (generated) rather than manual, because a
 * manual transactional boundary is exactly what a MySQL provider refuses to
 * honor — that refusal has its own owner and is not what these tests are about.
 */
async function publishMysqlChain(
  specs: readonly MysqlStateSpec[]
): Promise<PublishedMysqlChain> {
  const storage = new MemoryEstateStorage();
  const estate = encodeEstateDescriptor({ dialect: "mysql" });
  await storage.publishEstate(estate.bytes);
  await storage.publishSnapshot(
    EMPTY_SNAPSHOT.snapshotHash,
    EMPTY_SNAPSHOT.bytes
  );
  const states: PublishedMysqlState[] = [];
  let fromState: string | null = null;
  for (const spec of specs) {
    const rollbackSql = spec.rollback ?? [];
    const blob = composeSqlBlob([...spec.forward, ...rollbackSql]);
    const parentBody: Omit<MigrationParentTransitionV1, "transitionHash"> = {
      fromState,
      originChecks: [],
      requestedForwardBoundary: null,
      operations: spec.forward.map((_text, index) =>
        generatedOperation(
          `${spec.name}:forward:${index}`,
          dispatchAt(blob, index)
        )
      ),
      rollback: spec.rollback
        ? {
            kind: "schema",
            operations: rollbackSql.map((_text, index) =>
              generatedOperation(
                `${spec.name}:rollback:${index}`,
                dispatchAt(blob, spec.forward.length + index)
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
      destinationChecks: [],
      parents: [{ ...parentBody, transitionHash }],
    });
    await storage.publishSql(blob.sqlHash, blob.bytes);
    await storage.publishState(encoded.stateId, encoded.bytes);
    states.push({
      name: spec.name,
      stateId: encoded.stateId,
      fromState,
      transitionHash,
      sqlHash: blob.sqlHash,
      dispatches: blob.ranges.map((_range, index) => dispatchAt(blob, index)),
      edge: {
        stateId: encoded.stateId,
        transitionHash,
        baselineBoundary: false,
      },
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

function markerAt(
  chain: PublishedMysqlChain,
  count: number
): MigrationMarkerV1 {
  return markerFromPath(
    chain.estateHash,
    chain.snapshotHash,
    chain.states.slice(0, count).map((state) => state.edge),
    count
  );
}

function rollbackStarted(
  chain: PublishedMysqlChain,
  state: PublishedMysqlState,
  toState: string | null
): LedgerEventV1 {
  const event = {
    format: "1" as const,
    attemptId: "c".repeat(64),
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
  chain: PublishedMysqlChain,
  state: PublishedMysqlState
): LedgerEventV1 {
  const event = {
    format: "1" as const,
    attemptId: "a".repeat(64),
    kind: "started" as const,
    estateHash: chain.estateHash,
    snapshotHash: chain.snapshotHash,
    sqlHash: null,
    fromState: null,
    toState: state.stateId,
    transitionHash: null,
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

/** A step event of `started`'s attempt, as a crashed command left it. */
function stepEvent(
  started: LedgerEventV1,
  state: PublishedMysqlState,
  operationId: string,
  dispatch: MigrationDispatchV1,
  effectState: "none" | "committed"
): LedgerEventV1 {
  const { eventId: _eventId, resetPlan: _plan, ...body } = started;
  const event = {
    ...body,
    ...(started.direction === "reset"
      ? {
          kind: "reset-step-confirmed" as const,
          sqlHash: state.sqlHash,
          fromState: state.fromState,
          toState: state.stateId,
          transitionHash: state.transitionHash,
        }
      : { kind: "step-confirmed" as const }),
    operationId,
    dispatchId: dispatch.dispatchId,
    effectState,
    finishedAt: "2026-08-30T10:00:01.000Z",
  };
  return { ...event, eventId: eventIdFor(event) };
}

function resetStarted(
  chain: PublishedMysqlChain,
  clearDispatches: readonly MigrationDispatchV1[] = []
): LedgerEventV1 {
  const path = chain.states.map((state) => state.stateId);
  const planBody = {
    estateHash: chain.estateHash,
    targetIdentity: "mysql:alpha",
    sourceRevision: 0,
    sourceFingerprint: chain.snapshotHash,
    replayPath: path,
    clearDispatches,
    referencedStates: path,
  };
  const resetPlanHash = domainHash(
    HASH_DOMAIN.resetPlan,
    canonicalizeJson(planBody)
  );
  const event = {
    format: "1" as const,
    attemptId: resetPlanHash,
    kind: "reset-started" as const,
    estateHash: chain.estateHash,
    snapshotHash: chain.snapshotHash,
    sqlHash: null,
    fromState: null,
    toState: path.at(-1)!,
    transitionHash: null,
    direction: "reset" as const,
    operationId: null,
    dispatchId: null,
    effectState: "none" as const,
    startedAt: "2026-08-30T10:00:00.000Z",
    finishedAt: null,
    toolVersion: "v1",
    resetPlan: { ...planBody, resetPlanHash },
    failure: null,
  };
  return { ...event, eventId: eventIdFor(event) };
}

/**
 * What a crashed stepwise `down` or `reset` left, read back step by step. Only
 * MySQL and PostgreSQL run stepwise programs: SQLite refuses them (plan S5).
 */
describe("stepwise progress a crashed command left", () => {
  const rollbackChain = () =>
    publishMysqlChain([
      {
        name: "root",
        forward: ["SELECT 'root-forward'"],
        rollback: ["SELECT 'undo-first'", "SELECT 'undo-second'"],
      },
    ]);

  test("down resumes after the last committed rollback dispatch", async () => {
    const chain = await rollbackChain();
    const root = chain.states[0]!;
    const started = rollbackStarted(chain, root, null);
    const driver = mysqlEstate({
      tables: [...CONTROL_TABLES],
      marker: markerAt(chain, 1),
      ledger: [
        started,
        stepEvent(
          started,
          root,
          "root:rollback:0",
          root.dispatches[1]!,
          "committed"
        ),
      ],
    });

    await expect(
      downV1(clientFor(driver), chain.storage, { steps: 1 })
    ).resolves.toEqual({ path: [root.stateId], preview: false });
    expect(driver.statements).not.toContain("SELECT 'undo-first'");
    expect(driver.statements).toContain("SELECT 'undo-second'");
  });

  test("down closes the marker-CAS crash window without replaying rollback", async () => {
    const chain = await rollbackChain();
    const root = chain.states[0]!;
    const started = rollbackStarted(chain, root, null);
    const driver = mysqlEstate({
      tables: [...CONTROL_TABLES],
      marker: markerFromPath(chain.estateHash, chain.snapshotHash, [], 2),
      ledger: [
        started,
        stepEvent(
          started,
          root,
          "root:rollback:0",
          root.dispatches[1]!,
          "committed"
        ),
        stepEvent(
          started,
          root,
          "root:rollback:1",
          root.dispatches[2]!,
          "committed"
        ),
      ],
    });

    await expect(
      downV1(clientFor(driver), chain.storage, { steps: 1 })
    ).resolves.toEqual({ path: [root.stateId], preview: false });
    expect(driver.statements).not.toContain("SELECT 'undo-first'");
    expect(driver.statements).not.toContain("SELECT 'undo-second'");
  });

  test("down refuses an opaque dispatch whose durable outcome is ambiguous", async () => {
    const chain = await rollbackChain();
    const root = chain.states[0]!;
    const started = rollbackStarted(chain, root, null);
    const driver = mysqlEstate({
      tables: [...CONTROL_TABLES],
      marker: markerAt(chain, 1),
      ledger: [
        started,
        stepEvent(
          started,
          root,
          "root:rollback:0",
          root.dispatches[1]!,
          "none"
        ),
      ],
    });

    await expect(
      downV1(clientFor(driver), chain.storage, { steps: 1 })
    ).rejects.toMatchObject({
      // Read inside the sequential program, which reports what it ran.
      code: VibORMErrorCode.MIGRATION_PARTIAL_EFFECT,
      cause: { code: VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT },
    });
    expect(driver.statements).not.toContain("SELECT 'undo-first'");
  });

  test("reset resumes after the last committed replay dispatch", async () => {
    const chain = await publishMysqlChain([
      { name: "root", forward: ["SELECT 'root-forward'"] },
    ]);
    const root = chain.states[0]!;
    const started = resetStarted(chain);
    const driver = mysqlEstate({
      tables: [...CONTROL_TABLES],
      ledger: [
        started,
        stepEvent(started, root, "root:forward:0", root.dispatches[0]!, "none"),
        stepEvent(
          started,
          root,
          "root:forward:0",
          root.dispatches[0]!,
          "committed"
        ),
      ],
    });

    await expect(resetV1(clientFor(driver), chain.storage)).resolves.toEqual({
      preview: false,
      path: [root.stateId],
    });
    expect(driver.statements).not.toContain("SELECT 'root-forward'");
  });

  test("reset refuses noncontiguous replay evidence before dispatch", async () => {
    const chain = await publishMysqlChain([
      { name: "root", forward: ["SELECT 'root-forward'"] },
      { name: "child", forward: ["SELECT 'child-forward'"] },
      { name: "leaf", forward: ["SELECT 'leaf-forward'"] },
    ]);
    const child = chain.states[1]!;
    const started = resetStarted(chain);
    const driver = mysqlEstate({
      tables: [...CONTROL_TABLES],
      ledger: [
        started,
        stepEvent(
          started,
          child,
          "child:forward:0",
          child.dispatches[0]!,
          "committed"
        ),
      ],
    });

    await expect(
      resetV1(clientFor(driver), chain.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
      message: expect.stringContaining("contiguous dispatch prefix"),
    });
    expect(driver.statements.some((sql) => sql.includes("-forward"))).toBe(
      false
    );
  });

  test("reset refuses replay evidence before the stored clear prefix completes", async () => {
    const chain = await publishMysqlChain([
      { name: "root", forward: ["SELECT 'root-forward'"] },
    ]);
    const root = chain.states[0]!;
    const clear = composeSqlBlob(["DROP TABLE `leftover`"]);
    const started = resetStarted(chain, [dispatchAt(clear, 0)]);
    const driver = mysqlEstate({
      tables: [...CONTROL_TABLES],
      ledger: [
        started,
        stepEvent(
          started,
          root,
          "root:forward:0",
          root.dispatches[0]!,
          "committed"
        ),
      ],
    });

    await expect(
      resetV1(clientFor(driver), chain.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_CORRUPTION,
      message: expect.stringContaining("clear prefix"),
    });
    expect(driver.statements).not.toContain("SELECT 'root-forward'");
  });

  test("reset refuses an announced opaque replay dispatch as ambiguous", async () => {
    const chain = await publishMysqlChain([
      { name: "root", forward: ["SELECT 'root-forward'"] },
    ]);
    const root = chain.states[0]!;
    const started = resetStarted(chain);
    const driver = mysqlEstate({
      tables: [...CONTROL_TABLES],
      ledger: [
        started,
        stepEvent(started, root, "root:forward:0", root.dispatches[0]!, "none"),
      ],
    });

    await expect(
      resetV1(clientFor(driver), chain.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT,
    });
    expect(driver.statements).not.toContain("SELECT 'root-forward'");
  });
});

describe("down through the MySQL sequential program", () => {
  test("reverses an edge and moves the marker without opening a transaction", async () => {
    const chain = await publishMysqlChain([
      {
        name: "root",
        forward: ["SELECT 'root-forward'"],
        rollback: ["SELECT 'undo-root'"],
      },
    ]);
    const driver = mysqlEstate({
      tables: [...CONTROL_TABLES],
      marker: markerAt(chain, 1),
    });

    await expect(
      downV1(clientFor(driver), chain.storage, { steps: 1 })
    ).resolves.toEqual({
      path: [chain.states[0]!.stateId],
      preview: false,
    });
    expect(driver.statements).toContain("SELECT 'undo-root'");
    expect(transactionMarkersIn(driver)).toEqual([]);
  });

  test("closes an unfinished rollback that already reached the virtual root", async () => {
    const chain = await publishMysqlChain([
      {
        name: "root",
        forward: ["SELECT 'root-forward'"],
        rollback: ["SELECT 'undo-root'"],
      },
    ]);
    const driver = mysqlEstate({
      // No marker: the crashed rollback removed the last edge there was, so
      // only its ledger evidence is left to close.
      tables: [...CONTROL_TABLES],
      ledger: [rollbackStarted(chain, chain.states[0]!, null)],
    });

    await expect(
      downV1(clientFor(driver), chain.storage, { steps: 1 })
    ).resolves.toEqual({
      path: [chain.states[0]!.stateId],
      preview: false,
    });
    expect(driver.statements).not.toContain("SELECT 'undo-root'");
    expect(transactionMarkersIn(driver)).toEqual([]);
  });

  test("closes an unfinished rollback whose marker already names the parent", async () => {
    const chain = await publishMysqlChain([
      {
        name: "root",
        forward: ["SELECT 'root-forward'"],
        rollback: ["SELECT 'undo-root'"],
      },
      {
        name: "child",
        forward: ["SELECT 'child-forward'"],
        rollback: ["SELECT 'undo-child'"],
      },
    ]);
    const [root, child] = chain.states;
    const driver = mysqlEstate({
      tables: [...CONTROL_TABLES],
      marker: markerAt(chain, 1),
      ledger: [rollbackStarted(chain, child!, root!.stateId)],
    });

    await expect(
      downV1(clientFor(driver), chain.storage, { steps: 1 })
    ).resolves.toEqual({ path: [child!.stateId], preview: false });
    expect(driver.statements).not.toContain("SELECT 'undo-child'");
    expect(transactionMarkersIn(driver)).toEqual([]);
  });
});

describe("resolve through the MySQL sequential program", () => {
  test("records a rolled-back outcome from origin proof", async () => {
    const chain = await publishMysqlChain([
      { name: "root", forward: ["SELECT 'root-forward'"] },
    ]);
    const driver = mysqlEstate({
      tables: [...CONTROL_TABLES],
      ledger: [forwardStarted(chain, chain.states[0]!)],
    });

    await expect(
      resolveV1(clientFor(driver), chain.storage, { outcome: "rolled-back" })
    ).resolves.toEqual({ outcome: "rolled-back" });
    expect(driver.statements).not.toContain("SELECT 'root-forward'");
    expect(transactionMarkersIn(driver)).toEqual([]);
  });

  test("retries the transition and publishes the marker it reached", async () => {
    const chain = await publishMysqlChain([
      { name: "root", forward: ["SELECT 'root-forward'"] },
    ]);
    const driver = mysqlEstate({
      tables: [...CONTROL_TABLES],
      ledger: [forwardStarted(chain, chain.states[0]!)],
    });

    await expect(
      resolveV1(clientFor(driver), chain.storage, { outcome: "retry" })
    ).resolves.toEqual({ outcome: "retry" });
    expect(driver.statements).toContain("SELECT 'root-forward'");
    const insert = driver.statements.findIndex((statement) =>
      MIGRATION_STATE_WRITE.test(statement)
    );
    expect(insert).toBeGreaterThan(-1);
    const written: unknown = JSON.parse(String(driver.parameters[insert]![0]));
    expect(written).toMatchObject({
      stateId: chain.states[0]!.stateId,
      revision: 1,
    });
    expect(transactionMarkersIn(driver)).toEqual([]);
  });
});

describe("reset through the MySQL sequential program", () => {
  test("clears nothing, replays the path, and publishes the marker", async () => {
    const chain = await publishMysqlChain([
      { name: "root", forward: ["SELECT 'root-forward'"] },
    ]);
    // Only the two control tables exist, and a reset preserves both, so the
    // clear is empty and what is left is the replay itself.
    const driver = mysqlEstate({ tables: [...CONTROL_TABLES] });

    await expect(resetV1(clientFor(driver), chain.storage)).resolves.toEqual({
      preview: false,
      path: [chain.states[0]!.stateId],
    });
    expect(driver.statements).toContain("SELECT 'root-forward'");
    expect(driver.statements.some((sql) => sql.startsWith("DROP TABLE"))).toBe(
      false
    );
    expect(transactionMarkersIn(driver)).toEqual([]);
  });
});

describe("reset refuses a MySQL clear it cannot prove", () => {
  test("an ordinary foreign key is not the tracking refusal, and is still unprovable", async () => {
    const chain = await publishMysqlChain([
      { name: "root", forward: ["SELECT 'root-forward'"] },
    ]);
    const driver = mysqlEstate({
      tables: [...CONTROL_TABLES, "ns_orgs", "ns_posts"],
      // Points at an ordinary table, so the inbound-tracking refusal must let
      // it through; what stops the reset is that MySQL cannot prove a
      // constraint drop it commits as it runs.
      foreignKeys: [
        foreignKeyRow({
          table: "ns_posts",
          constraint: "fk_posts_orgs",
          referencedTable: "ns_orgs",
        }),
      ],
    });

    await expect(
      resetV1(clientFor(driver), chain.storage)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER,
      message: expect.stringContaining("driver-owned pre/post proof"),
    });
    expect(mutationsIn(driver)).toEqual([]);
  });
});

describe("baseline across a two-edge path", () => {
  test("adopts a live database that already matches the leaf snapshot", async () => {
    const storage = new MemoryEstateStorage();
    const driver = mysqlEstate({
      tables: [...CONTROL_TABLES, "ns_orgs", "ns_posts"],
    });
    const root = await generateV1(
      { $driver: driver, $schema: { org } },
      storage,
      { name: "init" }
    );
    const leaf = await generateV1(
      { $driver: driver, $schema: { org, post } },
      storage,
      { name: "add-post", from: root.stateId }
    );

    if (!leaf.stateId) throw new Error("expected a published leaf");

    await expect(
      // BaselineOptions types `to` as required even though baselineV1 supports
      // omitting it (resolveStateSelector defaults to the single leaf). Name
      // the leaf so the call typechecks; see the report on that mismatch.
      baselineV1({ $driver: driver, $schema: { org, post } }, storage, {
        to: { id: leaf.stateId },
      })
    ).resolves.toEqual({ stateId: leaf.stateId });

    const written = driver.statements.findIndex((statement) =>
      MIGRATION_STATE_WRITE.test(statement)
    );
    expect(written).toBeGreaterThan(-1);
    const marker: unknown = JSON.parse(String(driver.parameters[written]![0]));
    expect(marker).toMatchObject({
      stateId: leaf.stateId,
      revision: 1,
      // Adoption claims the whole route, and only its FIRST edge is the
      // boundary `down()` may not cross; the second is an ordinary arrival.
      path: [
        { stateId: root.stateId, baselineBoundary: true },
        { stateId: leaf.stateId, baselineBoundary: false },
      ],
    });
  });
});

describe("coverage low value", () => {
  test("a clear keeps the migration control pair and drops the rest", async () => {
    const driver = mysqlEstate({
      tables: [...CONTROL_TABLES, "ns_orgs"],
    });

    const plan = await planLiveNamespaceReset(
      driver,
      getMigrationDriver(driver)
    );

    const dropped = plan.dropTables.map((table) => table.name);
    expect(dropped).not.toContain("_viborm_migration_state");
    expect(dropped).not.toContain("_viborm_migration_log");
    expect(dropped).toContain("ns_orgs");
  });
});
