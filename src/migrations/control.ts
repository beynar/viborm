/**
 * Marker and ledger control tables. Two tables, one validated base name.
 * Read-only commands never bootstrap. Parsers in v1-parse own row truth.
 */

import type { AnyDriver } from "../drivers/driver";
import { MigrationError, VibORMErrorCode } from "../errors";
import { canonicalizeJsonText } from "./canonical-json";
import { tableExistsProbe } from "./catalog-probes";
import type { BoundMigrationDriver } from "./drivers";
import type { Sha256 } from "./identity";
import { encodePathHash, parseLedgerEvent, parseMarkerRow } from "./v1-parse";
import type { LedgerEventV1, MigrationMarkerV1 } from "./v1-types";

export const DEFAULT_CONTROL_BASE = "_viborm_migration";

const CONTROL_BASE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ControlPresence =
  | { readonly kind: "missing-table"; readonly table: "state" | "log" | "both" }
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
  if (logMissing) return { kind: "missing-table", table: "log" };
  return { kind: "present" };
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

export async function readMarker(
  producer: AnyDriver,
  driver: BoundMigrationDriver,
  base: string
): Promise<MigrationMarkerV1 | null> {
  const presence = await inspectControlPresence(producer, driver, base);
  if (presence.kind === "missing-table") {
    refusePartialControl(presence);
    return null;
  }
  const table = qualifyControl(driver, controlTableNames(base).state);
  const result = await producer._executeRaw<{ payload: unknown }>(
    `SELECT payload FROM ${table} WHERE singleton = 1`
  );
  const row = result.rows[0];
  if (!row) return null;
  return parseMarkerRow(parsePayload(row.payload));
}

export async function readLedger(
  producer: AnyDriver,
  driver: BoundMigrationDriver,
  base: string
): Promise<readonly LedgerEventV1[]> {
  const presence = await inspectControlPresence(producer, driver, base);
  if (presence.kind === "missing-table") {
    refusePartialControl(presence);
    return [];
  }
  const table = qualifyControl(driver, controlTableNames(base).log);
  const result = await producer._executeRaw<{ payload: unknown }>(
    `SELECT payload FROM ${table}`
  );
  return result.rows
    .map((row) => parseLedgerEvent(parsePayload(row.payload)))
    .sort((left, right) => {
      if (left.startedAt !== right.startedAt) {
        return left.startedAt < right.startedAt ? -1 : 1;
      }
      return left.eventId < right.eventId ? -1 : 1;
    });
}

export async function ensureControlTables(
  producer: AnyDriver,
  driver: BoundMigrationDriver,
  base: string
): Promise<void> {
  const sql = createControlTableSQL(driver, base);
  await producer._executeRaw(sql.state);
  await producer._executeRaw(sql.log);
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
