/**
 * MySQL's ONE commit model, on every command that changes live state (§3.5,
 * §6.2).
 *
 * MySQL commits DDL as each statement runs. Two consequences, both falsified
 * here:
 *
 * 1. No transaction is opened around it. PostgreSQL keeps its real transaction,
 *    which is the control.
 * 2. A failure part-way through cannot be undone. Push wraps that program in
 *    `runSequentialProgram`. Apply/reset keep recording-driver lock and
 *    containment proofs without a journal.
 */

import type { QueryResult } from "@drivers/types";
import { QueryError, VibORMErrorCode } from "@errors";
import {
  apply,
  push as applyPush,
  generate,
  previewPush,
  reset,
} from "@migrations";
import { canonicalizeJsonText } from "@migrations/canonical-json";
import { markerFromPath } from "@migrations/control";
import {
  decimalConversionConstraintName,
  mysqlDecimalFitsCatalogCheck,
} from "@migrations/decimal";
import { getMigrationDriver } from "@migrations/drivers";
import { emptyManagedSnapshot } from "@migrations/empty-snapshot";
import { planLiveNamespaceReset } from "@migrations/live-reset";
import { downV1, resolveV1 } from "@migrations/operators";
import {
  runSequentialProgram,
  withLockedMigrationProducer,
} from "@migrations/pinned-session";
import type { MigrationClient } from "@migrations/push/planner";
import { resetV1 } from "@migrations/reset-v1";
import { composeSqlBlob } from "@migrations/sql-blob";
import {
  encodeDispatchIdentity,
  encodeEstateDescriptor,
  encodeSnapshot,
  encodeStateManifest,
  encodeTransitionHash,
  eventIdFor,
} from "@migrations/v1-parse";
import type {
  LedgerEventV1,
  MigrationDispatchV1,
  MigrationMarkerV1,
  MigrationParentTransitionV1,
} from "@migrations/v1-types";
import { s } from "@schema";
import { describe, expect, it } from "vitest";
import {
  controlCatalogAnswer,
  MemoryStorage,
  mysqlEstateDriver,
  pgEstateDriver,
  RecordingDriver,
} from "./_estate";

const schema = {
  org: s.model({ id: s.string().id() }).map("ns_orgs"),
  post: s.model({ id: s.string().id() }).map("ns_posts"),
};

function clientFor(driver: RecordingDriver): MigrationClient {
  return { $driver: driver, $schema: schema };
}

interface ServerOptions {
  readonly tables?: readonly string[];
  readonly foreignKeys?: readonly Record<string, unknown>[];
  readonly fails?: (sql: string) => boolean;
  readonly decimalConstraints?: readonly Record<string, unknown>[];
  readonly decimalColumns?: readonly Record<string, unknown>[];
  readonly marker?: MigrationMarkerV1;
  readonly ledger?: readonly LedgerEventV1[];
}

const MIGRATION_STATE_WRITE =
  /^(?:INSERT INTO|UPDATE) (?:`[^`]+`\.)?`_viborm_migration_state`/i;
const CREATED_TABLE =
  /^CREATE TABLE(?: IF NOT EXISTS)? (?:`[^`]+`\.)?`([^`]+)`/i;
const DROPPED_TABLE = /^DROP TABLE(?: IF EXISTS)? (?:`[^`]+`\.)?`([^`]+)`/i;

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
    if (sql.includes("CHECK_CONSTRAINTS")) {
      return [...(options.decimalConstraints ?? [])];
    }
    if (
      sql.includes("information_schema.COLUMNS") &&
      !sql.includes("COLUMN_TYPE")
    ) {
      return [...(options.decimalColumns ?? [])];
    }
    if (options.fails?.(sql)) {
      return new Error("lost connection to the server during query");
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
    if (sql.includes("TABLE_NAME AS name")) {
      return [...tables].map((name) => ({ name }));
    }
    if (sql.includes("information_schema.COLUMNS")) {
      return [...tables]
        .filter((table) => !table.startsWith("_viborm_migration_"))
        .map((TABLE_NAME) => ({
          TABLE_NAME,
          COLUMN_NAME: "id",
          DATA_TYPE: "varchar",
          COLUMN_TYPE: "varchar(191)",
          IS_NULLABLE: "NO",
          COLUMN_DEFAULT: null,
          CHARACTER_MAXIMUM_LENGTH: 191,
          NUMERIC_PRECISION: null,
          NUMERIC_SCALE: null,
          EXTRA: "",
          COLUMN_COMMENT: "",
        }));
    }
    if (sql.includes("CONSTRAINT_TYPE = 'PRIMARY KEY'")) {
      return [...tables]
        .filter((table) => !table.startsWith("_viborm_migration_"))
        .map((TABLE_NAME) => ({
          TABLE_NAME,
          CONSTRAINT_NAME: "PRIMARY",
          COLUMN_NAME: "id",
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

const TRANSACTION_MARKERS = new Set(["<begin>", "BEGIN", "COMMIT"]);

function transactionMarkersIn(driver: RecordingDriver): string[] {
  return driver.statements.filter((sql) => TRANSACTION_MARKERS.has(sql));
}

const CREATE_TABLE = /^CREATE TABLE/;
const NO_ROLLBACK = "NOTHING was rolled back";
const NO_CLAIM =
  "makes no claim about whether the statement that failed took effect";
const PARTIAL_COMMIT = "failed partway through";

function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

const MUTATION =
  /^\s*(?:CREATE|DROP|ALTER|DELETE|INSERT|UPDATE|TRUNCATE|RENAME)\b/i;

function mutationsIn(driver: RecordingDriver): string[] {
  return driver.statements.filter((sql) => MUTATION.test(sql));
}

function foreignKeyRow(fk: {
  table: string;
  constraint: string;
  referencedTable: string;
  referencedSchema?: string;
}): Record<string, unknown> {
  return {
    TABLE_SCHEMA: "alpha",
    TABLE_NAME: fk.table,
    CONSTRAINT_NAME: fk.constraint,
    COLUMN_NAME: "ref_id",
    REFERENCED_TABLE_SCHEMA: fk.referencedSchema ?? "alpha",
    REFERENCED_TABLE_NAME: fk.referencedTable,
    REFERENCED_COLUMN_NAME: "id",
    DELETE_RULE: "NO ACTION",
    UPDATE_RULE: "NO ACTION",
    ORDINAL_POSITION: 1,
  };
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

async function publishSequentialProgram() {
  const storage = new MemoryStorage();
  const estate = encodeEstateDescriptor({ dialect: "mysql" });
  const snapshot = encodeSnapshot(emptyManagedSnapshot());
  const forwardSql = "SELECT 'forward-v1-program'";
  const rollbackSql = "SELECT 'rollback-v1-program'";
  const blob = composeSqlBlob([forwardSql, rollbackSql]);
  const parent: Omit<MigrationParentTransitionV1, "transitionHash"> = {
    fromState: null,
    originChecks: [],
    requestedForwardBoundary: null,
    operations: [
      {
        id: "forward:0",
        label: "forward",
        origin: "generated",
        risk: "safe",
        steps: [{ retry: "opaque", execute: dispatchAt(blob, 0) }],
      },
    ],
    rollback: {
      kind: "schema",
      operations: [
        {
          id: "rollback:0",
          label: "rollback",
          origin: "generated",
          risk: "destructive",
          steps: [{ retry: "opaque", execute: dispatchAt(blob, 1) }],
        },
      ],
    },
  };
  const transitionHash = encodeTransitionHash(parent);
  const state = encodeStateManifest({
    format: "1",
    estateHash: estate.estateHash,
    name: "sequential",
    snapshotHash: snapshot.snapshotHash,
    sqlHash: blob.sqlHash,
    destinationChecks: [],
    parents: [{ ...parent, transitionHash }],
  });
  await storage.publishEstate(estate.bytes);
  await storage.publishSnapshot(snapshot.snapshotHash, snapshot.bytes);
  await storage.publishSql(blob.sqlHash, blob.bytes);
  await storage.publishState(state.stateId, state.bytes);
  const marker = markerFromPath(
    estate.estateHash,
    snapshot.snapshotHash,
    [{ stateId: state.stateId, transitionHash, baselineBoundary: false }],
    1
  );
  return {
    storage,
    estateHash: estate.estateHash,
    snapshotHash: snapshot.snapshotHash,
    stateId: state.stateId,
    marker,
    forwardSql,
    rollbackSql,
  };
}

function startedEvent(
  program: Awaited<ReturnType<typeof publishSequentialProgram>>
): LedgerEventV1 {
  const event = {
    format: "1" as const,
    attemptId: "a".repeat(64),
    kind: "started" as const,
    estateHash: program.estateHash,
    snapshotHash: program.snapshotHash,
    sqlHash: null,
    fromState: null,
    toState: program.stateId,
    transitionHash: null,
    direction: "forward" as const,
    operationId: null,
    dispatchId: null,
    effectState: "none" as const,
    startedAt: "2026-08-29T00:00:00.000Z",
    finishedAt: null,
    toolVersion: "v1",
    failure: null,
  };
  return { ...event, eventId: eventIdFor(event) };
}

function interruptedDecimal(
  options: Omit<ServerOptions, "decimalConstraints" | "decimalColumns"> = {}
): ServerOptions & { readonly cleanup: string } {
  const descriptor = { precision: 10, scale: 2 };
  const constraint = decimalConversionConstraintName("scalar", descriptor);
  return {
    ...options,
    decimalConstraints: [
      {
        TABLE_NAME: "ledger",
        CONSTRAINT_NAME: constraint,
        ENFORCED: "YES",
        CHECK_CLAUSE: mysqlDecimalFitsCatalogCheck("`amount`", "DECIMAL(10,2)"),
      },
    ],
    decimalColumns: [
      {
        TABLE_NAME: "ledger",
        COLUMN_NAME: "amount",
        DATA_TYPE: "decimal",
        COLUMN_COMMENT: "",
      },
    ],
    cleanup: `ALTER TABLE \`alpha\`.\`ledger\` DROP CHECK \`${constraint}\``,
  };
}

describe("MySQL live DDL runs in no transaction at all", () => {
  it("cleans an authenticated interrupted decimal proof before apply", async () => {
    const descriptor = { precision: 10, scale: 2 };
    const constraint = decimalConversionConstraintName("scalar", descriptor);
    const driver = mysqlEstate({
      decimalConstraints: [
        {
          TABLE_NAME: "ledger",
          CONSTRAINT_NAME: constraint,
          ENFORCED: "YES",
          CHECK_CLAUSE: mysqlDecimalFitsCatalogCheck(
            "`amount`",
            "DECIMAL(10,2)"
          ),
        },
      ],
      decimalColumns: [
        {
          TABLE_NAME: "ledger",
          COLUMN_NAME: "amount",
          DATA_TYPE: "decimal",
          COLUMN_COMMENT: "",
        },
      ],
    });
    const storage = new MemoryStorage();
    await generate(clientFor(driver), storage, { name: "init" });

    await apply(clientFor(driver), storage);

    const cleanup = driver.statements.indexOf(
      `ALTER TABLE \`alpha\`.\`ledger\` DROP CHECK \`${constraint}\``
    );
    const firstCreate = driver.statements.findIndex((statement) =>
      statement.startsWith("CREATE TABLE")
    );
    expect(cleanup).toBeGreaterThanOrEqual(0);
    expect(firstCreate).toBeGreaterThan(cleanup);
    expect(transactionMarkersIn(driver)).toEqual([]);
  });

  it("plans interrupted decimal recovery once per locked command", async () => {
    const driver = mysqlEstate();

    await withLockedMigrationProducer(
      driver,
      getMigrationDriver(driver),
      async (pinned, command) => {
        await runSequentialProgram(pinned, command, () => Promise.resolve());
        await runSequentialProgram(pinned, command, () => Promise.resolve());
      }
    );

    expect(
      driver.statements.filter((statement) =>
        statement.includes("CHECK_CONSTRAINTS")
      )
    ).toHaveLength(1);
  });

  it("keeps a decimal-proof collision before the first effect", async () => {
    const descriptor = { precision: 10, scale: 2 };
    const constraint = decimalConversionConstraintName("scalar", descriptor);
    const driver = mysqlEstate({
      decimalConstraints: [
        {
          TABLE_NAME: "ledger",
          CONSTRAINT_NAME: constraint,
          ENFORCED: "YES",
          CHECK_CLAUSE: mysqlDecimalFitsCatalogCheck(
            "`amount`",
            "DECIMAL(9,2)"
          ),
        },
      ],
      decimalColumns: [
        {
          TABLE_NAME: "ledger",
          COLUMN_NAME: "amount",
          DATA_TYPE: "decimal",
          COLUMN_COMMENT: "",
        },
      ],
    });
    const storage = new MemoryStorage();
    await generate(clientFor(driver), storage, { name: "init" });

    const failure = await apply(clientFor(driver), storage).catch(
      (error: unknown) => error
    );

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: {
        type: "decimal-conversion-constraint-collision",
        constraint,
      },
    });
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("reports an uncertain interrupted-proof drop at the sequential boundary", async () => {
    const descriptor = { precision: 10, scale: 2 };
    const constraint = decimalConversionConstraintName("scalar", descriptor);
    const cleanup = `ALTER TABLE \`alpha\`.\`ledger\` DROP CHECK \`${constraint}\``;
    const driver = mysqlEstate({
      decimalConstraints: [
        {
          TABLE_NAME: "ledger",
          CONSTRAINT_NAME: constraint,
          ENFORCED: "YES",
          CHECK_CLAUSE: mysqlDecimalFitsCatalogCheck(
            "`amount`",
            "DECIMAL(10,2)"
          ),
        },
      ],
      decimalColumns: [
        {
          TABLE_NAME: "ledger",
          COLUMN_NAME: "amount",
          DATA_TYPE: "decimal",
          COLUMN_COMMENT: "",
        },
      ],
      fails: (statement) => statement === cleanup,
    });
    const storage = new MemoryStorage();
    await generate(clientFor(driver), storage, { name: "init" });

    const failure = await apply(clientFor(driver), storage).catch(
      (error: unknown) => error
    );

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_PARTIAL_EFFECT,
    });
    expect(messageOf(failure)).toContain(PARTIAL_COMMIT);
    expect(messageOf(failure)).toContain(
      "The last statement that completed was: (none"
    );
    expect(driver.statements).toContain(cleanup);
  });

  it("ordinary push executes sequentially on the pinned producer", async () => {
    const driver = mysqlEstate();

    const result = await applyPush(clientFor(driver)).then(
      (value): typeof value | Error => value,
      (error: unknown): Error =>
        error instanceof Error ? error : new Error(String(error))
    );

    expect(transactionMarkersIn(driver)).toEqual([]);
    expect(
      driver.statements.filter((sql) => sql.startsWith("CREATE TABLE"))
    ).toHaveLength(2);
    if (result instanceof Error) {
      expect(result).toMatchObject({ code: VibORMErrorCode.MIGRATION_DRIFT });
    } else {
      expect(result.outcome).toBe("applied");
    }
  });

  it("force-reset clears and rebuilds sequentially", async () => {
    const driver = mysqlEstate({ tables: ["ns_orgs"] });
    const preview = await previewPush(clientFor(driver), { forceReset: true });

    const result = await applyPush(clientFor(driver), {
      consent: preview.consent,
    }).then(
      (value): typeof value | Error => value,
      (error: unknown): Error =>
        error instanceof Error ? error : new Error(String(error))
    );

    expect(transactionMarkersIn(driver)).toEqual([]);
    expect(driver.statements).toContain(
      "DROP TABLE IF EXISTS `alpha`.`ns_orgs`"
    );
    if (result instanceof Error) {
      expect(result).toMatchObject({ code: VibORMErrorCode.MIGRATION_DRIFT });
    } else {
      expect(result.outcome).toBe("applied");
    }
  });

  it("apply does not open a transaction around generated MySQL DDL", async () => {
    const driver = mysqlEstate();
    const storage = new MemoryStorage();
    await generate(clientFor(driver), storage, { name: "init" });
    storage.writes.length = 0;

    await apply(clientFor(driver), storage).catch(() => undefined);

    expect(transactionMarkersIn(driver)).toEqual([]);
    expect(driver.statements).not.toContain("<begin>");
  });
});

describe("Migration V1 consumes MySQL decimal recovery before sequential effects", () => {
  const controls = [
    "_viborm_migration_state",
    "_viborm_migration_log",
  ] as const;

  it("covers down rollback with the existing partial-effect reporter", async () => {
    const program = await publishSequentialProgram();
    const recovery = interruptedDecimal({
      tables: controls,
      marker: program.marker,
      fails: (statement) => statement === program.rollbackSql,
    });
    const driver = mysqlEstate(recovery);

    const failure = await downV1(clientFor(driver), program.storage, {
      steps: 1,
    }).catch((error: unknown) => error);

    const cleanupIndex = driver.statements.indexOf(recovery.cleanup);
    const rollbackIndex = driver.statements.indexOf(program.rollbackSql);
    expect(cleanupIndex).toBeGreaterThanOrEqual(0);
    expect(rollbackIndex).toBeGreaterThan(cleanupIndex);
    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_PARTIAL_EFFECT,
    });
    expect(messageOf(failure)).toContain(PARTIAL_COMMIT);
    expect(messageOf(failure)).toContain(NO_ROLLBACK);
  });

  it("covers resolve retry with the existing partial-effect reporter", async () => {
    const program = await publishSequentialProgram();
    const recovery = interruptedDecimal({
      tables: controls,
      ledger: [startedEvent(program)],
      fails: (statement) => statement === program.forwardSql,
    });
    const driver = mysqlEstate(recovery);

    const failure = await resolveV1(clientFor(driver), program.storage, {
      outcome: "retry",
    }).catch((error: unknown) => error);

    const cleanupIndex = driver.statements.indexOf(recovery.cleanup);
    const forwardIndex = driver.statements.indexOf(program.forwardSql);
    expect(cleanupIndex).toBeGreaterThanOrEqual(0);
    expect(forwardIndex).toBeGreaterThan(cleanupIndex);
    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_PARTIAL_EFFECT,
    });
    expect(messageOf(failure)).toContain(PARTIAL_COMMIT);
    expect(messageOf(failure)).toContain(NO_ROLLBACK);
  });

  it("cleans the recovery scope before resolve closes history", async () => {
    const program = await publishSequentialProgram();
    const recovery = interruptedDecimal({
      tables: controls,
      ledger: [startedEvent(program)],
    });
    const driver = mysqlEstate(recovery);

    await expect(
      resolveV1(clientFor(driver), program.storage, { outcome: "complete" })
    ).resolves.toEqual({ outcome: "complete" });

    const cleanupIndex = driver.statements.indexOf(recovery.cleanup);
    const finishIndex = driver.statements.findIndex(
      (statement) =>
        statement.startsWith("INSERT INTO") &&
        statement.includes("_viborm_migration_log")
    );
    expect(cleanupIndex).toBeGreaterThanOrEqual(0);
    expect(finishIndex).toBeGreaterThan(cleanupIndex);
  });

  it("covers reset start, clear, and replay with one partial-effect reporter", async () => {
    const program = await publishSequentialProgram();
    const recovery = interruptedDecimal({
      tables: controls,
      fails: (statement) => statement === program.forwardSql,
    });
    const driver = mysqlEstate(recovery);

    const failure = await resetV1(clientFor(driver), program.storage).catch(
      (error: unknown) => error
    );

    const cleanupIndex = driver.statements.indexOf(recovery.cleanup);
    const startedIndex = driver.statements.findIndex(
      (statement) =>
        statement.startsWith("INSERT INTO") &&
        statement.includes("_viborm_migration_log")
    );
    const replayIndex = driver.statements.indexOf(program.forwardSql);
    expect(cleanupIndex).toBeGreaterThanOrEqual(0);
    expect(startedIndex).toBeGreaterThan(cleanupIndex);
    expect(replayIndex).toBeGreaterThan(startedIndex);
    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_PARTIAL_EFFECT,
    });
    expect(messageOf(failure)).toContain(PARTIAL_COMMIT);
    expect(messageOf(failure)).toContain(NO_ROLLBACK);
  });
});

describe("a failed MySQL program reports the boundary it reached", () => {
  it("ordinary push names the last completed DDL statement", async () => {
    const driver = mysqlEstate({ fails: (sql) => sql.includes("ns_posts") });

    const failure = await applyPush(clientFor(driver)).catch(
      (error: unknown) => error
    );

    const failedIndex = driver.statements.findIndex((sql) =>
      sql.includes("ns_posts")
    );
    const boundary = driver.statements[failedIndex - 1];
    expect(boundary).toMatch(CREATE_TABLE);
    const message = messageOf(failure);
    expect(message).toContain(NO_ROLLBACK);
    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_PARTIAL_EFFECT,
    });
  });

  it("force-reset names the last completed drop", async () => {
    const driver = mysqlEstate({
      tables: [
        "_viborm_migration_state",
        "_viborm_migration_log",
        "ns_orgs",
        "ns_posts",
      ],
      fails: (sql) => sql.includes("ns_posts`"),
    });
    const preview = await previewPush(clientFor(driver), { forceReset: true });

    const failure = await applyPush(clientFor(driver), {
      consent: preview.consent,
    }).catch((error: unknown) => error);

    const message = messageOf(failure);
    expect(message).toContain(NO_ROLLBACK);
    expect(message).toContain(NO_CLAIM);
    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_PARTIAL_EFFECT,
    });
  });

  it("preserves the provider's own failure under the report", async () => {
    const driver = mysqlEstate({ fails: (sql) => sql.includes("ns_posts") });

    const failure = await applyPush(clientFor(driver)).catch(
      (error: unknown) => error
    );

    expect(failure).toMatchObject({
      originalCause: expect.objectContaining({
        code: VibORMErrorCode.QUERY_FAILED,
      }),
    });
  });
});

describe("a containment refusal is not a partial commit", () => {
  const INBOUND_TRACKING_FK = foreignKeyRow({
    table: "ns_orgs",
    constraint: "fk_orgs_tracking",
    referencedTable: "_viborm_migration_state",
  });
  const CROSS_DATABASE_FK = foreignKeyRow({
    table: "ns_orgs",
    constraint: "fk_orgs_events",
    referencedTable: "ns_events",
    referencedSchema: "analytics",
  });

  it("reset() preserves the inbound tracking-key refusal", async () => {
    const driver = mysqlEstate({
      tables: ["_viborm_migration_state", "_viborm_migration_log", "ns_orgs"],
      foreignKeys: [INBOUND_TRACKING_FK],
    });
    const storage = new MemoryStorage();
    await generate(clientFor(driver), storage, { name: "init" });
    storage.writes.length = 0;

    const failure = await reset(clientFor(driver), storage).catch(
      (error: unknown) => error
    );

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: {
        table: "ns_orgs",
        constraint: "fk_orgs_tracking",
        referencedTable: "_viborm_migration_state",
      },
    });
    expect(messageOf(failure)).not.toContain(PARTIAL_COMMIT);
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("reset() preserves the cross-database refusal", async () => {
    const driver = mysqlEstate({
      tables: ["_viborm_migration_state", "_viborm_migration_log", "ns_orgs"],
      foreignKeys: [CROSS_DATABASE_FK],
    });
    const storage = new MemoryStorage();
    await generate(clientFor(driver), storage, { name: "init" });
    storage.writes.length = 0;

    const failure = await reset(clientFor(driver), storage).catch(
      (error: unknown) => error
    );

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: {
        dialect: "mysql",
        type: "cross-database-foreign-key",
        constraint: "fk_orgs_events",
        namespace: "alpha",
        table: "alpha.ns_orgs",
        referencedTable: "analytics.ns_events",
      },
    });
    expect(messageOf(failure)).not.toContain(PARTIAL_COMMIT);
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("force-reset preserves the inbound tracking-key refusal", async () => {
    const driver = mysqlEstate({
      tables: ["_viborm_migration_state", "_viborm_migration_log", "ns_orgs"],
      foreignKeys: [INBOUND_TRACKING_FK],
    });

    const failure = await previewPush(clientFor(driver), {
      forceReset: true,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: {
        table: "ns_orgs",
        constraint: "fk_orgs_tracking",
        referencedTable: "_viborm_migration_state",
      },
    });
    expect(messageOf(failure)).not.toContain(PARTIAL_COMMIT);
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("force-reset preserves the cross-database refusal", async () => {
    const driver = mysqlEstate({
      tables: ["_viborm_migration_state", "_viborm_migration_log", "ns_orgs"],
      foreignKeys: [CROSS_DATABASE_FK],
    });

    const failure = await previewPush(clientFor(driver), {
      forceReset: true,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: {
        dialect: "mysql",
        type: "cross-database-foreign-key",
        constraint: "fk_orgs_events",
        namespace: "alpha",
        table: "alpha.ns_orgs",
        referencedTable: "analytics.ns_events",
      },
    });
    expect(messageOf(failure)).not.toContain(PARTIAL_COMMIT);
    expect(mutationsIn(driver)).toEqual([]);
  });
});

function mysqlEstateWithInventoryRows(
  rows: readonly Record<string, unknown>[]
): RecordingDriver {
  const driver = mysqlEstate();
  const server = driver.respond;
  driver.respond = (sql: string, params: unknown[]) =>
    sql.includes("TABLE_NAME AS name") ? [...rows] : server(sql, params);
  return driver;
}

class VerbatimInventoryDriver extends RecordingDriver {
  rows: readonly unknown[] = [];

  protected override execute<T>(
    client: unknown,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    return this.answer<T>(client, sql, params);
  }

  protected override executeRaw<T>(
    client: unknown,
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> {
    return this.answer<T>(client, sql, params ?? []);
  }

  private answer<T>(
    client: unknown,
    sql: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    this.statements.push(sql);
    this.producers.push(client);
    let answered = sql.includes("TABLE_NAME AS name")
      ? this.rows
      : this.respond(sql, params);
    if (!(answered instanceof Error) && answered.length === 0) {
      const catalog = controlCatalogAnswer(sql, params, {
        state: false,
        log: false,
      });
      if (catalog) answered = catalog;
    }
    if (answered instanceof Error) {
      return Promise.reject(answered);
    }
    const rows: T[] = [];
    for (const row of answered) {
      rows.push(row as never);
    }
    return Promise.resolve({ rows, rowCount: rows.length });
  }
}

function verbatimInventory(
  rows: readonly unknown[],
  options: ServerOptions = {}
): VerbatimInventoryDriver {
  const driver = new VerbatimInventoryDriver(
    "mysql",
    "mysql2",
    mysqlEstateDriver({ namespace: "alpha", attested: true }).adapter,
    "non-redirecting"
  );
  driver.rows = rows;
  const server = estateServer(options);
  driver.respond = (sql: string, params: unknown[]) => {
    if (sql.includes("GET_LOCK")) {
      return [{ acquired: 1 }];
    }
    if (sql.includes("RELEASE_LOCK")) {
      return [{ released: 1 }];
    }
    return server(sql, params);
  };
  return driver;
}

function planOutcome(driver: RecordingDriver): Promise<unknown> {
  return planLiveNamespaceReset(driver, getMigrationDriver(driver), {
    trackingTable: "drop",
    trackingTableName: "_viborm_migration_state",
  }).catch((error: unknown) => error);
}

describe("an untrusted reset inventory refuses before the first drop", () => {
  it("refuses a row that is not an object at all — one layer down", async () => {
    const driver = verbatimInventory([{ name: "ns_orgs" }, 42]);

    expect(await planOutcome(driver)).toMatchObject({
      code: VibORMErrorCode.QUERY_FAILED,
    });
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("refuses a row carrying no name", async () => {
    const driver = verbatimInventory([{ name: "ns_orgs" }, {}]);

    expect(await planOutcome(driver)).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "unreadable-reset-inventory", resultIndex: 1 },
    });
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("refuses a row whose name is not a string", async () => {
    const driver = verbatimInventory([{ name: "ns_orgs" }, { name: 7 }]);

    expect(await planOutcome(driver)).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "unreadable-reset-inventory", resultIndex: 1 },
    });
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("refuses a row whose name is empty", async () => {
    const driver = verbatimInventory([{ name: "ns_orgs" }, { name: "" }]);

    expect(await planOutcome(driver)).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "unreadable-reset-inventory", resultIndex: 1 },
    });
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("refuses an inventory that names one object twice", async () => {
    const driver = verbatimInventory([
      { name: "ns_orgs" },
      { name: "ns_orgs" },
    ]);

    expect(await planOutcome(driver)).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "duplicate-reset-inventory-name", resultIndex: 1 },
    });
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("normalizes a row accessor that throws, keeping its cause", async () => {
    const driver = verbatimInventory([
      { name: "ns_orgs" },
      {
        get name(): string {
          throw new QueryError("the provider row refuses to be read");
        },
      },
    ]);

    expect(await planOutcome(driver)).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "unreadable-reset-inventory", resultIndex: 1 },
      originalCause: expect.objectContaining({
        code: VibORMErrorCode.QUERY_FAILED,
      }),
    });
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("refuses a row whose name is inherited rather than a column", async () => {
    const driver = verbatimInventory([
      { name: "ns_orgs" },
      Object.create({ name: "victim" }),
    ]);

    expect(await planOutcome(driver)).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "unreadable-reset-inventory", resultIndex: 1 },
    });
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("refuses a row whose name comes from a polluted Object.prototype", async () => {
    const driver = verbatimInventory([{ name: "ns_orgs" }, {}]);
    Object.defineProperty(Object.prototype, "name", {
      value: "victim",
      configurable: true,
    });
    let outcome: unknown;
    try {
      outcome = await planOutcome(driver);
    } finally {
      Reflect.deleteProperty(Object.prototype, "name");
    }

    expect(outcome).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "unreadable-reset-inventory", resultIndex: 1 },
    });
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("normalizes a row whose ownership check throws, keeping its cause", async () => {
    const driver = verbatimInventory([
      { name: "ns_orgs" },
      new Proxy(
        { name: "victim" },
        {
          getOwnPropertyDescriptor(): PropertyDescriptor {
            throw new QueryError("the provider row refuses to be described");
          },
        }
      ),
    ]);

    expect(await planOutcome(driver)).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "unreadable-reset-inventory", resultIndex: 1 },
      originalCause: expect.objectContaining({
        code: VibORMErrorCode.QUERY_FAILED,
      }),
    });
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("keeps a Symbol thrown by a row accessor as its cause", async () => {
    const driver = verbatimInventory([
      { name: "ns_orgs" },
      {
        get name(): string {
          throw Symbol("the provider row refuses to be read");
        },
      },
    ]);

    expect(await planOutcome(driver)).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "unreadable-reset-inventory", resultIndex: 1 },
      originalCause: expect.any(Error),
    });
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("keeps an unrenderable object thrown by a row accessor as its cause", async () => {
    const driver = verbatimInventory([
      { name: "ns_orgs" },
      {
        get name(): string {
          throw Object.create(null);
        },
      },
    ]);

    expect(await planOutcome(driver)).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "unreadable-reset-inventory", resultIndex: 1 },
      originalCause: expect.any(Error),
    });
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("normalizes a thrown value whose own `instanceof` throws", async () => {
    const driver = verbatimInventory([
      { name: "ns_orgs" },
      {
        get name(): string {
          throw new Proxy(
            {},
            {
              getPrototypeOf(): object {
                throw new QueryError("the thrown value refuses to be typed");
              },
            }
          );
        },
      },
    ]);

    expect(await planOutcome(driver)).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "unreadable-reset-inventory", resultIndex: 1 },
      originalCause: expect.any(Error),
    });
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("reset() refuses a row whose name is inherited", async () => {
    const driver = verbatimInventory(
      [{ name: "ns_orgs" }, Object.create({ name: "victim" })],
      {}
    );
    const storage = new MemoryStorage();
    await generate(clientFor(driver), storage, { name: "init" });
    storage.writes.length = 0;

    const failure = await reset(clientFor(driver), storage).catch(
      (error: unknown) => error
    );

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "unreadable-reset-inventory", resultIndex: 1 },
    });
    expect(messageOf(failure)).not.toContain(PARTIAL_COMMIT);
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("force-reset refuses a row whose name is inherited", async () => {
    const driver = verbatimInventory([
      { name: "ns_orgs" },
      Object.create({ name: "victim" }),
    ]);

    const failure = await previewPush(clientFor(driver), {
      forceReset: true,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "unreadable-reset-inventory", resultIndex: 1 },
    });
    expect(messageOf(failure)).not.toContain(PARTIAL_COMMIT);
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("reset() refuses an inventory row it cannot read", async () => {
    const driver = mysqlEstateWithInventoryRows([{ name: "ns_orgs" }, {}]);
    const storage = new MemoryStorage();
    await generate(clientFor(driver), storage, { name: "init" });
    storage.writes.length = 0;

    const failure = await reset(clientFor(driver), storage).catch(
      (error: unknown) => error
    );

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "unreadable-reset-inventory", resultIndex: 1 },
    });
    expect(messageOf(failure)).not.toContain(PARTIAL_COMMIT);
    expect(mutationsIn(driver)).toEqual([]);
  });

  it("force-reset refuses an inventory that names one object twice", async () => {
    const driver = mysqlEstateWithInventoryRows([
      { name: "ns_orgs" },
      { name: "ns_orgs" },
    ]);

    const failure = await previewPush(clientFor(driver), {
      forceReset: true,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "duplicate-reset-inventory-name", resultIndex: 1 },
    });
    expect(messageOf(failure)).not.toContain(PARTIAL_COMMIT);
    expect(mutationsIn(driver)).toEqual([]);
  });
});

describe("PostgreSQL remains transactional — the control", () => {
  it("leaves a PostgreSQL push failure unwrapped", async () => {
    const driver = pgEstateDriver("alpha");
    driver.respond = (sql: string): unknown[] | Error => {
      if (sql.includes("pg_namespace") || sql.includes("AS present")) {
        return [{ present: 1 }];
      }
      if (sql.includes("ns_posts")) {
        return new Error("lost connection to the server during query");
      }
      return [];
    };

    const failure = await applyPush(clientFor(driver)).catch(
      (error: unknown) => error
    );

    expect(messageOf(failure)).not.toContain(NO_ROLLBACK);
  });
});
