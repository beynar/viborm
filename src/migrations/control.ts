/**
 * Marker and ledger control tables. Two tables, one validated base name.
 * Read-only commands never bootstrap. Parsers in v1-parse own row truth.
 */

import type { AnyDriver } from "../drivers/driver";
import { errorCause } from "../drivers/shared/driver-options";
import { MigrationError, VibORMErrorCode } from "../errors";
import { canonicalizeJsonText } from "./canonical-json";
import { tableExistsProbe } from "./catalog-probes";
import type { BoundMigrationDriver } from "./drivers";
import type { Sha256 } from "./identity";
import type { SchemaSnapshot, TableDef } from "./types";
import { encodePathHash, parseLedgerEvent, parseMarkerRow } from "./v1-parse";
import type { LedgerEventV1, MigrationMarkerV1 } from "./v1-types";

export const DEFAULT_CONTROL_BASE = "_viborm_migration";

const CONTROL_BASE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CHECK_PREFIX = /^\s*check\s*/i;
const CHECK_FORMATTING = /[\s()"`]/g;

export type ControlPresence =
  | { readonly kind: "missing-table"; readonly table: "state" | "log" | "both" }
  | { readonly kind: "recoverable-state-only" }
  | { readonly kind: "present" };

export function controlTableNames(base: string): {
  state: string;
  log: string;
} {
  if (!CONTROL_BASE_NAME.test(base)) {
    throw new MigrationError(
      "Control table base name is not a safe identifier",
      VibORMErrorCode.INVALID_INPUT
    );
  }
  return { state: `${base}_state`, log: `${base}_log` };
}

export function qualifyControl(
  driver: BoundMigrationDriver,
  name: string
): string {
  if (driver.target.dialect === "postgresql") {
    return `${quotePg(driver.namespace ?? driver.target.namespace)}.${quotePg(name)}`;
  }
  if (driver.target.dialect === "mysql" && driver.namespace) {
    return `${quoteMy(driver.namespace)}.${quoteMy(name)}`;
  }
  return quoteIdent(driver.target.dialect, name);
}

function quotePg(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteMy(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

function quoteIdent(
  dialect: "postgresql" | "mysql" | "sqlite",
  value: string
): string {
  return dialect === "mysql" ? quoteMy(value) : quotePg(value);
}

function placeholder(
  dialect: BoundMigrationDriver["target"]["dialect"],
  index: number
): string {
  return dialect === "postgresql" ? `$${index}` : "?";
}

export function createControlTableSQL(
  driver: BoundMigrationDriver,
  base: string
): { state: string; log: string } {
  const names = controlTableNames(base);
  const state = qualifyControl(driver, names.state);
  const log = qualifyControl(driver, names.log);
  return {
    state: `CREATE TABLE IF NOT EXISTS ${state} (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      payload TEXT NOT NULL
    )`,
    log:
      driver.target.dialect === "mysql"
        ? `CREATE TABLE IF NOT EXISTS ${log} (
      event_id VARCHAR(64) PRIMARY KEY,
      attempt_id VARCHAR(64) NOT NULL,
      kind VARCHAR(32) NOT NULL,
      payload TEXT NOT NULL
    )`
        : `CREATE TABLE IF NOT EXISTS ${log} (
      event_id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL
    )`,
  };
}

export function refusePartialControl(presence: ControlPresence): void {
  if (presence.kind === "recoverable-state-only") {
    throw new MigrationError(
      "Migration control tables are inconsistent: log is missing after interrupted bootstrap",
      VibORMErrorCode.MIGRATION_INVALID_STATE
    );
  }
  if (presence.kind === "missing-table" && presence.table !== "both") {
    throw new MigrationError(
      `Migration control tables are inconsistent: ${presence.table} is missing`,
      VibORMErrorCode.MIGRATION_INVALID_STATE
    );
  }
}

export function refuseIncompatibleHistory(
  marker: MigrationMarkerV1 | null,
  ledger: readonly LedgerEventV1[]
): void {
  if (marker !== null || ledger.length === 0) return;
  if (unfinishedAttempts(ledger).length > 0) return;
  throw new MigrationError(
    "Migration ledger history exists without a current marker",
    VibORMErrorCode.MIGRATION_INVALID_STATE
  );
}

export async function inspectControlPresence(
  producer: AnyDriver,
  driver: BoundMigrationDriver,
  base: string
): Promise<ControlPresence> {
  const names = controlTableNames(base);
  const stateMissing = await isTableMissing(producer, driver, names.state);
  const logMissing = await isTableMissing(producer, driver, names.log);
  if (stateMissing && logMissing)
    return { kind: "missing-table", table: "both" };
  if (stateMissing) return { kind: "missing-table", table: "state" };
  if (logMissing) {
    // Bootstrap creates state before log. If the second CREATE failed, the
    // empty state table is the one recognizable partial state that can be
    // completed idempotently. A marker row means this is real history with a
    // missing ledger and must remain a hard refusal.
    await assertExpectedStateControlTable(producer, driver, names);
    if (await isStateControlEmpty(producer, driver, names.state)) {
      return { kind: "recoverable-state-only" };
    }
    return { kind: "missing-table", table: "log" };
  }
  return { kind: "present" };
}

/** Proves that both reserved control tables still have VibORM's exact shape. */
export async function assertControlTablesAuthentic(
  producer: AnyDriver,
  driver: BoundMigrationDriver,
  base: string
): Promise<void> {
  const names = controlTableNames(base);
  let snapshot: SchemaSnapshot;
  try {
    snapshot = await driver.introspect((sql, params) =>
      producer._executeRaw(sql, params)
    );
  } catch (failure) {
    if (failure instanceof MigrationError) throw failure;
    throw new MigrationError(
      "Migration control tables cannot be authenticated",
      VibORMErrorCode.MIGRATION_INVALID_STATE,
      { cause: errorCause(failure) }
    );
  }
  const stateMatches = snapshot.tables.filter(
    (table) => table.name === names.state
  );
  const logMatches = snapshot.tables.filter(
    (table) => table.name === names.log
  );
  if (
    stateMatches.length !== 1 ||
    logMatches.length !== 1 ||
    !hasExpectedStateTableShape(stateMatches[0]!, driver, names.state) ||
    !hasExpectedLogTableShape(logMatches[0]!, driver, names.log)
  ) {
    throw new MigrationError(
      "Migration control tables have an unexpected definition",
      VibORMErrorCode.MIGRATION_INVALID_STATE
    );
  }
  let hasSingletonCheck: boolean;
  try {
    hasSingletonCheck = await hasExpectedSingletonCheck(
      producer,
      driver,
      names.state
    );
  } catch (failure) {
    throw new MigrationError(
      "Migration control tables cannot be authenticated",
      VibORMErrorCode.MIGRATION_INVALID_STATE,
      { cause: errorCause(failure) }
    );
  }
  if (!hasSingletonCheck) {
    throw new MigrationError(
      "Migration control tables have an unexpected definition",
      VibORMErrorCode.MIGRATION_INVALID_STATE
    );
  }
  let hasAttachments: boolean;
  try {
    hasAttachments = await hasControlAttachments(producer, driver, names);
  } catch (failure) {
    if (failure instanceof MigrationError) throw failure;
    throw new MigrationError(
      "Migration control tables cannot be authenticated",
      VibORMErrorCode.MIGRATION_INVALID_STATE,
      { cause: errorCause(failure) }
    );
  }
  if (hasAttachments) {
    throw new MigrationError(
      "Migration control tables have executable attachments",
      VibORMErrorCode.MIGRATION_INVALID_STATE
    );
  }
}

async function assertExpectedStateControlTable(
  producer: AnyDriver,
  driver: BoundMigrationDriver,
  names: { readonly state: string; readonly log: string }
): Promise<void> {
  const tableName = names.state;
  let snapshot: SchemaSnapshot;
  try {
    snapshot = await driver.introspect((sql, params) =>
      producer._executeRaw(sql, params)
    );
  } catch (failure) {
    throw new MigrationError(
      "A partial migration control state table cannot be authenticated",
      VibORMErrorCode.MIGRATION_INVALID_STATE,
      { cause: errorCause(failure) }
    );
  }
  const matches = snapshot.tables.filter((table) => table.name === tableName);
  const stateTable = matches[0];
  if (
    matches.length !== 1 ||
    !stateTable ||
    !hasExpectedStateTableShape(stateTable, driver, tableName)
  ) {
    throw new MigrationError(
      "A partial migration control state table has an unexpected definition",
      VibORMErrorCode.MIGRATION_INVALID_STATE
    );
  }
  let hasSingletonCheck: boolean;
  try {
    hasSingletonCheck = await hasExpectedSingletonCheck(
      producer,
      driver,
      tableName
    );
  } catch (failure) {
    throw new MigrationError(
      "A partial migration control state table cannot be authenticated",
      VibORMErrorCode.MIGRATION_INVALID_STATE,
      { cause: errorCause(failure) }
    );
  }
  if (!hasSingletonCheck) {
    throw new MigrationError(
      "A partial migration control state table has an unexpected definition",
      VibORMErrorCode.MIGRATION_INVALID_STATE
    );
  }
  let hasAttachments: boolean;
  try {
    hasAttachments = await hasControlAttachments(producer, driver, names);
  } catch (failure) {
    if (failure instanceof MigrationError) throw failure;
    throw new MigrationError(
      "A partial migration control state table cannot be authenticated",
      VibORMErrorCode.MIGRATION_INVALID_STATE,
      { cause: errorCause(failure) }
    );
  }
  if (hasAttachments) {
    throw new MigrationError(
      "A partial migration control state table has executable attachments",
      VibORMErrorCode.MIGRATION_INVALID_STATE
    );
  }
}

function hasExpectedStateTableShape(
  table: TableDef,
  driver: BoundMigrationDriver,
  tableName: string
): boolean {
  const singleton = table.columns[0];
  const payload = table.columns[1];
  const singletonType =
    driver.target.dialect === "postgresql"
      ? "int4"
      : driver.target.dialect === "mysql"
        ? "INT"
        : "INTEGER";
  const payloadType = driver.target.dialect === "mysql" ? "TEXT" : "text";
  const primaryKeyName =
    driver.target.dialect === "mysql" ? "PRIMARY" : `${tableName}_pkey`;
  return (
    table.columns.length === 2 &&
    singleton?.name === "singleton" &&
    singleton.type === singletonType &&
    singleton.nullable === false &&
    singleton.default === undefined &&
    singleton.autoIncrement !== true &&
    singleton.decimal === undefined &&
    payload?.name === "payload" &&
    payload.type.toLowerCase() === payloadType.toLowerCase() &&
    payload.nullable === false &&
    payload.default === undefined &&
    payload.autoIncrement !== true &&
    payload.decimal === undefined &&
    table.primaryKey?.name === primaryKeyName &&
    table.primaryKey.columns.length === 1 &&
    table.primaryKey.columns[0] === "singleton" &&
    table.indexes.length === 0 &&
    table.foreignKeys.length === 0 &&
    table.uniqueConstraints.length === 0 &&
    table.relationStorage === undefined
  );
}

function hasExpectedLogTableShape(
  table: TableDef,
  driver: BoundMigrationDriver,
  tableName: string
): boolean {
  const expected =
    driver.target.dialect === "mysql"
      ? [
          ["event_id", "varchar(64)"],
          ["attempt_id", "varchar(64)"],
          ["kind", "varchar(32)"],
          ["payload", "text"],
        ]
      : [
          ["event_id", "text"],
          ["attempt_id", "text"],
          ["kind", "text"],
          ["payload", "text"],
        ];
  const primaryKeyName =
    driver.target.dialect === "mysql" ? "PRIMARY" : `${tableName}_pkey`;
  return (
    table.columns.length === expected.length &&
    table.columns.every((column, index) => {
      const shape = expected[index];
      return (
        shape !== undefined &&
        column.name === shape[0] &&
        column.type.toLowerCase() === shape[1] &&
        column.nullable === false &&
        column.default === undefined &&
        column.autoIncrement !== true &&
        column.decimal === undefined
      );
    }) &&
    table.primaryKey?.name === primaryKeyName &&
    table.primaryKey.columns.length === 1 &&
    table.primaryKey.columns[0] === "event_id" &&
    table.indexes.length === 0 &&
    table.foreignKeys.length === 0 &&
    table.uniqueConstraints.length === 0 &&
    table.relationStorage === undefined
  );
}

async function hasExpectedSingletonCheck(
  producer: AnyDriver,
  driver: BoundMigrationDriver,
  tableName: string
): Promise<boolean> {
  if (driver.target.dialect === "sqlite") {
    const result = await producer._executeRaw<{ sql: unknown }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      [tableName]
    );
    if (result.rows.length !== 1 || typeof result.rows[0]?.sql !== "string") {
      return false;
    }
    const expected = createControlTableSQL(driver, DEFAULT_CONTROL_BASE).state;
    return (
      sqliteDefinitionBody(result.rows[0].sql) ===
      sqliteDefinitionBody(expected)
    );
  }
  const result =
    driver.target.dialect === "postgresql"
      ? await producer._executeRaw<{ definition: unknown }>(
          `SELECT pg_get_constraintdef(c.oid, true) AS definition
FROM pg_catalog.pg_constraint c
JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = $1 AND t.relname = $2 AND c.contype = 'c'
ORDER BY c.conname`,
          [driver.namespace ?? driver.target.namespace, tableName]
        )
      : await producer._executeRaw<{ definition: unknown }>(
          `SELECT cc.CHECK_CLAUSE AS definition
FROM information_schema.TABLE_CONSTRAINTS tc
JOIN information_schema.CHECK_CONSTRAINTS cc
  ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
  AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
WHERE tc.CONSTRAINT_SCHEMA = ?
  AND tc.TABLE_NAME = ?
  AND tc.CONSTRAINT_TYPE = 'CHECK'
ORDER BY tc.CONSTRAINT_NAME`,
          [driver.namespace, tableName]
        );
  return (
    result.rows.length === 1 &&
    normalizeSingletonCheck(result.rows[0]?.definition) === "singleton=1"
  );
}

function sqliteDefinitionBody(sql: string): string {
  const body = sql.slice(sql.indexOf("("));
  return body.replace(/[\s"`]/g, "").toLowerCase();
}

function normalizeSingletonCheck(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value
    .replace(CHECK_PREFIX, "")
    .replace(CHECK_FORMATTING, "")
    .toLowerCase();
}

async function hasControlAttachments(
  producer: AnyDriver,
  driver: BoundMigrationDriver,
  names: { readonly state: string; readonly log: string }
): Promise<boolean> {
  const result =
    driver.target.dialect === "sqlite"
      ? await producer._executeRaw<Record<string, unknown>>(
          "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN (?, ?)) AS attached",
          [names.state, names.log]
        )
      : driver.target.dialect === "mysql"
        ? await producer._executeRaw<Record<string, unknown>>(
            "SELECT EXISTS (SELECT 1 FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? AND EVENT_OBJECT_TABLE IN (?, ?)) AS attached",
            [driver.namespace, names.state, names.log]
          )
        : await producer._executeRaw<Record<string, unknown>>(
            `SELECT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_trigger trigger
  JOIN pg_catalog.pg_class table_class ON table_class.oid = trigger.tgrelid
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = table_class.relnamespace
  WHERE namespace.nspname = $1
    AND table_class.relname IN ($2, $3)
    AND NOT trigger.tgisinternal
  UNION ALL
  SELECT 1
  FROM pg_catalog.pg_rewrite rule
  JOIN pg_catalog.pg_class table_class ON table_class.oid = rule.ev_class
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = table_class.relnamespace
  WHERE namespace.nspname = $1
    AND table_class.relname IN ($2, $3)
    AND rule.rulename <> '_RETURN'
  UNION ALL
  SELECT 1
  FROM pg_catalog.pg_policy policy
  JOIN pg_catalog.pg_class table_class ON table_class.oid = policy.polrelid
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = table_class.relnamespace
  WHERE namespace.nspname = $1
    AND table_class.relname IN ($2, $3)
  UNION ALL
  SELECT 1
  FROM pg_catalog.pg_class table_class
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = table_class.relnamespace
  WHERE namespace.nspname = $1
    AND table_class.relname IN ($2, $3)
    AND (table_class.relrowsecurity OR table_class.relforcerowsecurity)
) AS attached`,
            [
              driver.namespace ?? driver.target.namespace,
              names.state,
              names.log,
            ]
          );
  if (result.rows.length !== 1) {
    throw new MigrationError(
      "Migration control attachment probe must return exactly one row",
      VibORMErrorCode.MIGRATION_INVALID_STATE
    );
  }
  const value = Object.values(result.rows[0]!)[0];
  if (isPresentCatalogFlag(value)) return true;
  if (isAbsentCatalogFlag(value)) return false;
  throw new MigrationError(
    "Migration control attachment probe returned an invalid flag",
    VibORMErrorCode.MIGRATION_INVALID_STATE
  );
}

async function isStateControlEmpty(
  producer: AnyDriver,
  driver: BoundMigrationDriver,
  tableName: string
): Promise<boolean> {
  const table = qualifyControl(driver, tableName);
  try {
    const result = await producer._executeRaw(
      `SELECT payload FROM ${table} WHERE singleton = 1`
    );
    return result.rows.length === 0;
  } catch (failure) {
    throw new MigrationError(
      "A partial migration control state table cannot be proven empty",
      VibORMErrorCode.MIGRATION_INVALID_STATE,
      { cause: errorCause(failure) }
    );
  }
}

async function isTableMissing(
  producer: AnyDriver,
  driver: BoundMigrationDriver,
  tableName: string
): Promise<boolean> {
  const probe = tableExistsProbe(driver, tableName, true);
  const result = await producer._executeRaw<Record<string, unknown>>(
    probe.sql,
    probeParameters(probe.parameters)
  );
  if (result.rows.length !== 1) {
    throw new MigrationError(
      "Control catalog probe must return exactly one row",
      VibORMErrorCode.MIGRATION_INVALID_STATE
    );
  }
  return !isPresentCatalogFlag(Object.values(result.rows[0]!)[0]);
}

function probeParameters(
  parameters: ReturnType<typeof tableExistsProbe>["parameters"]
): unknown[] {
  return parameters.map((parameter) => {
    if (parameter.kind !== "string") {
      throw new MigrationError(
        "Control catalog probe parameters must be strings",
        VibORMErrorCode.INTERNAL_ERROR
      );
    }
    return parameter.value;
  });
}

function isPresentCatalogFlag(value: unknown): boolean {
  return (
    value === true ||
    value === 1 ||
    value === 1n ||
    value === "1" ||
    value === "t" ||
    value === "true"
  );
}

function isAbsentCatalogFlag(value: unknown): boolean {
  return (
    value === false ||
    value === 0 ||
    value === 0n ||
    value === "0" ||
    value === "f" ||
    value === "false"
  );
}

export interface MigrationControlRead {
  readonly presence: ControlPresence;
  readonly marker: MigrationMarkerV1 | null;
  readonly ledger: readonly LedgerEventV1[];
}

/**
 * Reads the complete control-plane view. A present pair is authenticated once
 * before either table is trusted; callers decide whether total absence or the
 * recoverable bootstrap arm is valid for their command.
 */
export async function readControlState(
  producer: AnyDriver,
  driver: BoundMigrationDriver,
  base: string
): Promise<MigrationControlRead> {
  const presence = await inspectControlPresence(producer, driver, base);
  if (presence.kind !== "present") {
    return { presence, marker: null, ledger: [] };
  }
  await assertControlTablesAuthentic(producer, driver, base);
  const names = controlTableNames(base);
  const markerResult = await producer._executeRaw<{ payload: unknown }>(
    `SELECT payload FROM ${qualifyControl(driver, names.state)} WHERE singleton = 1`
  );
  const markerRow = markerResult.rows[0];
  const marker = markerRow
    ? parseMarkerRow(parsePayload(markerRow.payload))
    : null;
  const ledgerResult = await producer._executeRaw<{ payload: unknown }>(
    `SELECT payload FROM ${qualifyControl(driver, names.log)}`
  );
  const ledger = ledgerResult.rows
    .map((row) => parseLedgerEvent(parsePayload(row.payload)))
    .sort((left, right) => {
      if (left.startedAt !== right.startedAt) {
        return left.startedAt < right.startedAt ? -1 : 1;
      }
      return left.eventId < right.eventId ? -1 : 1;
    });
  return { presence, marker, ledger };
}

export async function ensureControlTables(
  producer: AnyDriver,
  driver: BoundMigrationDriver,
  base: string
): Promise<void> {
  const presence = await inspectControlPresence(producer, driver, base);
  if (presence.kind === "present") {
    await assertControlTablesAuthentic(producer, driver, base);
    return;
  }
  if (presence.kind === "missing-table") {
    refusePartialControl(presence);
  }
  const names = controlTableNames(base);
  const stateMissing = await isTableMissing(producer, driver, names.state);
  const logMissing = await isTableMissing(producer, driver, names.log);
  if (!stateMissing && logMissing) {
    if (presence.kind !== "recoverable-state-only") {
      throw new MigrationError(
        "Migration control tables changed during bootstrap",
        VibORMErrorCode.MIGRATION_INVALID_STATE
      );
    }
    await assertExpectedStateControlTable(producer, driver, names);
    if (!(await isStateControlEmpty(producer, driver, names.state))) {
      throw new MigrationError(
        "Migration control tables are inconsistent: log is missing",
        VibORMErrorCode.MIGRATION_INVALID_STATE
      );
    }
    await producer._executeRaw(
      `DROP TABLE ${qualifyControl(driver, names.state)}`
    );
  } else if (!(stateMissing && logMissing)) {
    throw new MigrationError(
      "Migration control tables changed during bootstrap",
      VibORMErrorCode.MIGRATION_INVALID_STATE
    );
  }
  const sql = createControlTableSQL(driver, base);
  await producer._executeRaw(sql.state);
  await producer._executeRaw(sql.log);
  await assertControlTablesAuthentic(producer, driver, base);
}

export async function casMarker(
  producer: AnyDriver,
  driver: BoundMigrationDriver,
  base: string,
  expected: { revision: number; pathHash: Sha256 } | null,
  next: MigrationMarkerV1
): Promise<void> {
  const table = qualifyControl(driver, controlTableNames(base).state);
  const payload = canonicalizeJsonText(next);
  const dialect = driver.target.dialect;
  if (expected === null) {
    try {
      const result = await producer._executeRaw(
        `INSERT INTO ${table} (singleton, payload) VALUES (1, ${placeholder(dialect, 1)})`,
        [payload]
      );
      if (result.rowCount !== 1) {
        throw new MigrationError(
          "Migration marker insert did not create the singleton row",
          VibORMErrorCode.MIGRATION_MARKER_CONFLICT
        );
      }
    } catch (error) {
      if (error instanceof MigrationError) throw error;
      throw new MigrationError(
        "Migration marker compare-and-swap failed",
        VibORMErrorCode.MIGRATION_MARKER_CONFLICT,
        { cause: error instanceof Error ? error : undefined }
      );
    }
    return;
  }

  const revisionMatch =
    dialect === "postgresql"
      ? `(payload::json->>'revision')::bigint = ${placeholder(dialect, 2)}`
      : dialect === "mysql"
        ? `CAST(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.revision')) AS UNSIGNED) = ${placeholder(dialect, 2)}`
        : `CAST(json_extract(payload, '$.revision') AS INTEGER) = ${placeholder(dialect, 2)}`;
  const pathMatch =
    dialect === "postgresql"
      ? `payload::json->>'pathHash' = ${placeholder(dialect, 3)}`
      : dialect === "mysql"
        ? `JSON_UNQUOTE(JSON_EXTRACT(payload, '$.pathHash')) = ${placeholder(dialect, 3)}`
        : `json_extract(payload, '$.pathHash') = ${placeholder(dialect, 3)}`;
  const result = await producer._executeRaw(
    `UPDATE ${table} SET payload = ${placeholder(dialect, 1)} WHERE singleton = 1 AND ${revisionMatch} AND ${pathMatch}`,
    [payload, expected.revision, expected.pathHash]
  );
  if (result.rowCount !== 1) {
    throw new MigrationError(
      "Migration marker compare-and-swap failed",
      VibORMErrorCode.MIGRATION_MARKER_CONFLICT
    );
  }
}

export async function appendLedger(
  producer: AnyDriver,
  driver: BoundMigrationDriver,
  base: string,
  event: LedgerEventV1
): Promise<void> {
  const table = qualifyControl(driver, controlTableNames(base).log);
  const dialect = driver.target.dialect;
  await producer._executeRaw(
    `INSERT INTO ${table} (event_id, attempt_id, kind, payload) VALUES (${placeholder(dialect, 1)}, ${placeholder(dialect, 2)}, ${placeholder(dialect, 3)}, ${placeholder(dialect, 4)})`,
    [event.eventId, event.attemptId, event.kind, canonicalizeJsonText(event)]
  );
}

export function markerFromPath(
  estateHash: Sha256,
  snapshotHash: Sha256,
  path: MigrationMarkerV1["path"],
  revision: number
): MigrationMarkerV1 {
  const stateId = path.length === 0 ? null : path.at(-1)!.stateId;
  return {
    format: "1",
    estateHash,
    stateId,
    snapshotHash,
    path,
    pathHash: encodePathHash(path),
    revision,
    updatedAt: new Date().toISOString(),
  };
}

function parsePayload(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

export function unfinishedAttempts(
  events: readonly LedgerEventV1[]
): readonly LedgerEventV1[] {
  const started = new Map<string, LedgerEventV1>();
  const closed = new Set<string>();
  for (const event of events) {
    if (event.kind === "started" || event.kind === "reset-started") {
      started.set(event.attemptId, event);
    }
    if (
      event.kind === "applied" ||
      event.kind === "rolled-back" ||
      event.kind === "failed" ||
      event.kind === "baselined" ||
      event.kind === "resolved" ||
      event.kind === "reset-applied"
    ) {
      closed.add(event.attemptId);
    }
  }
  return [...started.values()].filter((event) => !closed.has(event.attemptId));
}
