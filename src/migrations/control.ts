import { normalizeType } from "./push-fingerprint";
/**
 * Marker and ledger control tables. Two tables, one validated base name.
 * Read-only commands never bootstrap. Parsers in v1-parse own row truth.
 */

import type { AnyDriver } from "../drivers/driver";
import { errorCause } from "../drivers/shared/driver-options";
import { isRetryableError, MigrationError, VibORMErrorCode } from "../errors";
import { isRecord } from "../validation/value-guards";
import { canonicalizeJsonText } from "./canonical-json";
import { boundNamespace, tableExistsProbe } from "./catalog-probes";
import type { BoundMigrationDriver } from "./drivers";
import { throwIfCatalogRefusal } from "./drivers/postgres/catalog-refusal";
import { isSha256, type Sha256 } from "./identity";
import type { SchemaSnapshot, TableDef } from "./types";
import { encodePathHash, eventIdFor, parseLedgerEvent } from "./v1-parse";
import { parseMarkerPayload } from "./v1-parse-control";
import { readFlag } from "./v1-parse-shared";
import type {
  LedgerEventV1,
  MarkerIndexPredicateV1,
  MigrationMarkerV1,
} from "./v1-types";

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

const STATE_CONTROL_DEFINITION = `(
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      payload TEXT NOT NULL
    )`;

/** Exact writer-owned state definition; the control owner authenticates its contents separately. */
export function isSqliteStateControlDefinition(
  name: string,
  sql: string | null
): boolean {
  return (
    name === controlTableNames(DEFAULT_CONTROL_BASE).state &&
    sql !== null &&
    sqliteDefinitionBody(sql) === sqliteDefinitionBody(STATE_CONTROL_DEFINITION)
  );
}

export function createControlTableSQL(
  driver: BoundMigrationDriver,
  base: string
): { state: string; log: string } {
  const names = controlTableNames(base);
  const state = qualifyControl(driver, names.state);
  const log = qualifyControl(driver, names.log);
  return {
    state: `CREATE TABLE IF NOT EXISTS ${state} ${STATE_CONTROL_DEFINITION}`,
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

/** The events of attempts that never reached a state. */
const CLOSED_WITHOUT_STATE: ReadonlySet<LedgerEventV1["kind"]> = new Set([
  "started",
  "step-confirmed",
  "failed",
  "rolled-back",
  "resolved",
]);

/**
 * Without a marker, history may only hold attempts closed by `failed`,
 * `rolled-back` or `resolved`, so `apply` can start again (plan S4). An
 * unfinished attempt is its caller's refusal.
 */
export function refuseIncompatibleHistory(
  marker: MigrationMarkerV1 | null,
  ledger: readonly LedgerEventV1[]
): void {
  if (marker !== null) return;
  if (unfinishedAttempts(ledger).length > 0) return;
  if (ledger.every((event) => CLOSED_WITHOUT_STATE.has(event.kind))) return;
  throw new MigrationError(
    "Migration ledger history exists without a current marker",
    VibORMErrorCode.MIGRATION_INVALID_STATE
  );
}

/**
 * Which control tables exist. PostgreSQL answers from `catalog`, the one
 * statement that also authenticates them (plan D5), read here when not given.
 */
export async function inspectControlPresence(
  producer: AnyDriver,
  driver: BoundMigrationDriver,
  base: string,
  catalog?: PostgresControlCatalog
): Promise<ControlPresence> {
  const names = controlTableNames(base);
  const read =
    catalog ?? (await postgresControlCatalog(producer, driver, base));
  const stateMissing = read
    ? !read.state
    : await isTableMissing(producer, driver, names.state);
  const logMissing = read
    ? !read.log
    : await isTableMissing(producer, driver, names.log);
  if (stateMissing && logMissing)
    return { kind: "missing-table", table: "both" };
  if (stateMissing) return { kind: "missing-table", table: "state" };
  if (logMissing) {
    // Bootstrap creates state before log. If the second CREATE failed, the
    // empty state table is the one recognizable partial state that can be
    // completed idempotently. A marker row means this is real history with a
    // missing ledger and must remain a hard refusal.
    await assertControlTablesAuthentic(producer, driver, base, "state", read);
    if (await isStateControlEmpty(producer, driver, names.state)) {
      return { kind: "recoverable-state-only" };
    }
    return { kind: "missing-table", table: "log" };
  }
  return { kind: "present" };
}

/**
 * Introspects with the managed-table scope narrowed to the two control tables.
 *
 * Every dialect's introspection already reads an unselected table without
 * interpreting it (no refusal of its indexes, types or defaults), so a managed
 * table's state — an INVALID index left by an interrupted `CREATE INDEX
 * CONCURRENTLY` among them — can no longer make the control plane unreadable
 * and take `status()` and `log()` down with it. The view restates `target`
 * only, the way every execution view in this layer restates one member.
 */
function introspectControlTables(
  producer: AnyDriver,
  driver: BoundMigrationDriver,
  names: { readonly state: string; readonly log: string }
): Promise<SchemaSnapshot> {
  const scoped: BoundMigrationDriver = Object.create(driver);
  Object.defineProperty(scoped, "target", {
    value: Object.freeze({
      ...driver.target,
      tables: [names.log, names.state],
    }),
    enumerable: true,
  });
  return Object.freeze(scoped).introspect((sql, params) =>
    producer._executeRaw(sql, params)
  );
}

/** The refusals of the pair, and of a state table left without its log. */
const UNAUTHENTIC = {
  pair: {
    unreadable: "Migration control tables cannot be authenticated",
    unexpected: "Migration control tables have an unexpected definition",
    attached: "Migration control tables have executable attachments",
  },
  state: {
    unreadable:
      "A partial migration control state table cannot be authenticated",
    unexpected:
      "A partial migration control state table has an unexpected definition",
    attached:
      "A partial migration control state table has executable attachments",
  },
} as const;

/**
 * Proves that both reserved control tables — or, with `scope` "state", the
 * state table bootstrap left without its log — still have VibORM's exact
 * shape. PostgreSQL reads `catalog` when presence already read it.
 */
export async function assertControlTablesAuthentic(
  producer: AnyDriver,
  driver: BoundMigrationDriver,
  base: string,
  scope: keyof typeof UNAUTHENTIC = "pair",
  catalog?: PostgresControlCatalog
): Promise<void> {
  const names = controlTableNames(base);
  if (driver.target.dialect === "postgresql") {
    assertPostgresControlAuthentic(
      catalog ?? (await readPostgresControlCatalog(producer, driver, names)),
      names,
      scope
    );
    return;
  }
  const refusal = UNAUTHENTIC[scope];
  let snapshot: SchemaSnapshot;
  try {
    snapshot = await introspectControlTables(producer, driver, names);
  } catch (failure) {
    // The pair keeps introspection's own refusal; the partial state wraps it.
    if (failure instanceof MigrationError && scope === "pair") throw failure;
    throw unreadable(refusal.unreadable, failure);
  }
  const matches = (name: string) =>
    snapshot.tables.filter((table) => table.name === name);
  const [state, ...otherStates] = matches(names.state);
  const [log, ...otherLogs] = matches(names.log);
  if (
    !state ||
    otherStates.length > 0 ||
    !hasExpectedStateTableShape(state, driver, names.state) ||
    (scope === "pair" &&
      !(
        log &&
        otherLogs.length === 0 &&
        hasExpectedLogTableShape(log, driver, names.log)
      ))
  ) {
    throw new MigrationError(
      refusal.unexpected,
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
    throw unreadable(refusal.unreadable, failure);
  }
  if (!hasSingletonCheck) {
    throw new MigrationError(
      refusal.unexpected,
      VibORMErrorCode.MIGRATION_INVALID_STATE
    );
  }
  let hasAttachments: boolean;
  try {
    hasAttachments = await hasControlAttachments(producer, driver, names);
  } catch (failure) {
    if (failure instanceof MigrationError) throw failure;
    throw unreadable(refusal.unreadable, failure);
  }
  if (hasAttachments) {
    throw new MigrationError(
      refusal.attached,
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
  const singletonType = driver.target.dialect === "mysql" ? "INT" : "INTEGER";
  const payloadType = driver.target.dialect === "mysql" ? "TEXT" : "text";
  const primaryKeyName =
    driver.target.dialect === "mysql" ? "PRIMARY" : `${tableName}_pkey`;
  return (
    table.columns.length === 2 &&
    singleton?.name === "singleton" &&
    normalizeType(singleton.type) === normalizeType(singletonType) &&
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
  const result = await producer._executeRaw<{ definition: unknown }>(
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
      : await producer._executeRaw<Record<string, unknown>>(
          "SELECT EXISTS (SELECT 1 FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? AND EVENT_OBJECT_TABLE IN (?, ?)) AS attached",
          [driver.namespace, names.state, names.log]
        );
  if (result.rows.length !== 1) {
    throw new MigrationError(
      "Migration control attachment probe must return exactly one row",
      VibORMErrorCode.MIGRATION_INVALID_STATE
    );
  }
  const attached = readFlag(Object.values(result.rows[0]!)[0]);
  if (attached !== undefined) return attached;
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
    throw unreadable(
      "A partial migration control state table cannot be proven empty",
      failure
    );
  }
}

/**
 * The refusal `message` for a control-table read that failed, or the failure
 * itself when it says nothing about the tables: the migration lock not taken
 * (the read may be the statement that reopens a command's locked transaction,
 * after a commit let the lock go), a lost connection or another retryable
 * failure, which the caller retries.
 */
function unreadable(message: string, failure: unknown): unknown {
  const transient =
    isRetryableError(failure) ||
    (failure instanceof MigrationError &&
      failure.code === VibORMErrorCode.MIGRATION_LOCK_FAILED);
  return transient
    ? failure
    : new MigrationError(message, VibORMErrorCode.MIGRATION_INVALID_STATE, {
        cause: errorCause(failure),
      });
}

export async function isTableMissing(
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
  return readFlag(Object.values(result.rows[0]!)[0]) !== true;
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

export interface MigrationControlRead {
  readonly presence: ControlPresence;
  readonly marker: MigrationMarkerV1 | null;
  /**
   * The ledger events, in causal order (`inCausalOrder`): every event, or
   * with `{ ledger: "open" }` those of an unfinished attempt and the latest
   * `failed` one (plan D5, new defect 6). Without a marker the history may
   * only hold attempts that never reached a state, and all of it is read so
   * `refuseIncompatibleHistory` can say so.
   */
  readonly ledger: readonly LedgerEventV1[];
}

/** The event kinds that open an attempt, and those that close one. */
const OPENING_KINDS: ReadonlySet<LedgerEventV1["kind"]> = new Set([
  "started",
  "reset-started",
]);
const CLOSING_KINDS: ReadonlySet<LedgerEventV1["kind"]> = new Set([
  "applied",
  "rolled-back",
  "failed",
  "baselined",
  "reanchored",
  "resolved",
  "reset-applied",
]);

/**
 * Reads the control-plane view. A present pair is authenticated once before
 * either table is trusted; callers decide whether total absence or the
 * recoverable bootstrap arm is valid for their command.
 */
export async function readControlState(
  producer: AnyDriver,
  driver: BoundMigrationDriver,
  base: string,
  { ledger: scope = "all" }: { readonly ledger?: "open" | "all" } = {}
): Promise<MigrationControlRead> {
  const catalog = await postgresControlCatalog(producer, driver, base);
  const presence = await inspectControlPresence(
    producer,
    driver,
    base,
    catalog
  );
  if (presence.kind !== "present") {
    return { presence, marker: null, ledger: [] };
  }
  await assertControlTablesAuthentic(producer, driver, base, "pair", catalog);
  const names = controlTableNames(base);
  const markerResult = await producer._executeRaw<{ payload: unknown }>(
    `SELECT payload FROM ${qualifyControl(driver, names.state)} WHERE singleton = 1`
  );
  // Without a marker every event is read: `refuseIncompatibleHistory` judges
  // the whole history then.
  const all = scope === "all" || markerResult.rows.length === 0;
  const ledgerResult = await producer._executeRaw<{ payload: unknown }>(
    ledgerSql(driver, names, all)
  );
  const { marker, ledger } = decodeControlRows(
    markerResult.rows,
    ledgerResult.rows
  );
  return { presence, marker, ledger };
}

/**
 * The ledger events a command reads, selected by their columns, which the
 * one writer (`appendLedger`) fills from the event it appends: every event,
 * or those of an unfinished attempt and the latest `failed` one (plan D5,
 * new defect 6).
 */
function ledgerSql(
  driver: BoundMigrationDriver,
  names: { readonly state: string; readonly log: string },
  all: boolean
): string {
  const log = qualifyControl(driver, names.log);
  if (all) return `SELECT payload FROM ${log}`;
  return `SELECT payload FROM ${log} WHERE ${openAttempt(log)}
  OR event_id = (SELECT event_id FROM ${log} WHERE kind = 'failed' ORDER BY ${jsonField(driver.target.dialect, "startedAt")} DESC, event_id DESC LIMIT 1)`;
}

/** The ledger rows of an unfinished attempt, as `unfinishedAttempts` reads them. */
function openAttempt(log: string): string {
  const list = (kinds: ReadonlySet<string>) =>
    [...kinds].map((kind) => `'${kind}'`).join(", ");
  return `(attempt_id IN (SELECT attempt_id FROM ${log} WHERE kind IN (${list(OPENING_KINDS)}))
    AND attempt_id NOT IN (SELECT attempt_id FROM ${log} WHERE kind IN (${list(CLOSING_KINDS)})))`;
}

/**
 * `assertLockedSinceDecision` as a condition one request asserts under its
 * own lock (plan D7): the marker is still `expected`, or there is none when
 * that is null, and no attempt is open.
 */
export function markerUnmovedCondition(
  driver: BoundMigrationDriver,
  base: string,
  expected: MarkerIdentity | null
): { readonly sql: string; readonly params: unknown[] } {
  const names = controlTableNames(base);
  const log = qualifyControl(driver, names.log);
  const at = expected && markerAt(driver.target.dialect, 1, expected);
  const marker = `EXISTS (SELECT 1 FROM ${qualifyControl(driver, names.state)}${at ? ` WHERE singleton = 1 AND ${at.sql}` : ""})`;
  return {
    sql: `(${at ? "" : "NOT "}${marker} AND NOT EXISTS (SELECT 1 FROM ${log} WHERE ${openAttempt(log)}))`,
    params: at ? at.params : [],
  };
}

/** What identifies a marker: `markerAt` matches it in SQL, `sameMarker` in JS. */
export type MarkerIdentity = Pick<MigrationMarkerV1, "revision" | "pathHash">;

/** The marker row is `expected`, bound from `$first` on. */
function markerAt(
  dialect: BoundMigrationDriver["target"]["dialect"],
  first: number,
  { revision, pathHash }: MarkerIdentity
): { readonly sql: string; readonly params: unknown[] } {
  const slot = placeholder(dialect, first);
  const revisionMatch =
    dialect === "postgresql"
      ? `(payload::json->>'revision')::bigint = ${slot}`
      : dialect === "mysql"
        ? `CAST(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.revision')) AS UNSIGNED) = ${slot}`
        : `CAST(json_extract(payload, '$.revision') AS INTEGER) = ${slot}`;
  return {
    sql: `${revisionMatch} AND ${jsonField(dialect, "pathHash")} = ${placeholder(dialect, first + 1)}`,
    params: [revision, pathHash],
  };
}

function decodeControlRows(
  markerRows: readonly { readonly payload: unknown }[],
  ledgerRows: readonly { readonly payload: unknown }[]
): {
  readonly marker: MigrationMarkerV1 | null;
  readonly predicates: readonly MarkerIndexPredicateV1[];
  readonly ledger: readonly LedgerEventV1[];
} {
  const markerRow = markerRows[0];
  const stored =
    markerRow && parseMarkerPayload(parsePayload(markerRow.payload));
  return {
    marker: stored ? stored.marker : null,
    predicates: stored ? stored.predicates : [],
    ledger: inCausalOrder(
      ledgerRows.map((row) => parseLedgerEvent(parsePayload(row.payload)))
    ),
  };
}

/**
 * Plan D5: what a PostgreSQL no-op decides on, in two statements: the control
 * tables' definition, then the marker, the open attempts and the catalog
 * digest, read together and so in one snapshot, provided `lockFree` (the
 * migration lock taken and released at once) holds. Without a marker there is
 * no no-op to prove, so the ledger is never read whole here. `undefined`
 * unless both control tables are present, so no statement here names a table
 * that is not there, and while another command holds the lock; a pair that is
 * not exactly VibORM's is refused. The digest hashes partial-index predicates
 * as the server deparses them, for comparison with those recorded beside the
 * marker.
 */
export async function readPostgresDecision(
  producer: AnyDriver,
  driver: BoundMigrationDriver,
  base: string,
  lockFree: string
): Promise<
  | {
      readonly marker: MigrationMarkerV1 | null;
      readonly predicates: readonly MarkerIndexPredicateV1[];
      readonly ledger: readonly LedgerEventV1[];
      readonly digest: Sha256 | undefined;
    }
  | undefined
> {
  const names = controlTableNames(base);
  const catalog = await readPostgresControlCatalog(producer, driver, names);
  if (!(catalog.state && catalog.log)) return;
  assertPostgresControlAuthentic(catalog, names, "pair");
  // Only PostgreSQL reads a decision in one statement: its driver owns this.
  const digest = driver.catalogDigestQuery!(names, true);
  const { rows } = await producer._executeRaw<{
    marker: unknown;
    ledger: unknown;
    digest: unknown;
  }>(
    `SELECT (SELECT json_agg(json_build_object('payload', marker.payload)) FROM (SELECT payload FROM ${qualifyControl(driver, names.state)} WHERE singleton = 1) marker)::text AS marker,
  (SELECT json_agg(json_build_object('payload', ledger.payload)) FROM (${ledgerSql(driver, names, false)}) ledger)::text AS ledger,
  (${digest.sql}) AS digest WHERE ${lockFree}`,
    digest.parameters
  );
  if (rows.length === 0) return;
  return {
    ...decodeControlRows(
      readPayloadRows(rows[0]?.marker),
      readPayloadRows(rows[0]?.ledger)
    ),
    digest: isSha256(rows[0]?.digest) ? rows[0].digest : undefined,
  };
}

/** The `{ payload }` rows a JSON aggregate carries; none for SQL NULL. */
function readPayloadRows(value: unknown): { readonly payload: unknown }[] {
  const rows: unknown = readCatalogJson(value);
  return Array.isArray(rows)
    ? rows.flatMap((row: unknown) =>
        isRecord(row) ? [{ payload: row.payload }] : []
      )
    : [];
}

/**
 * The ledger in causal order (new defect 6). Without a sequence column the
 * clock is the order, and it ties: one millisecond can hold a whole
 * transactional group, or one attempt's close and the next one's start. The
 * events of one instant come attempt by attempt — the one opened earliest
 * first, then along the state chain (an attempt leaving the state another one
 * arrives at follows it), then by attempt id — and inside an attempt as it
 * ran: it opens, confirms steps, then closes. Only a cycle of attempts within
 * one millisecond (up, down, up) falls back to attempt ids.
 */
function inCausalOrder(events: readonly LedgerEventV1[]): LedgerEventV1[] {
  const opened = new Map<Sha256, string>();
  for (const { attemptId, startedAt } of events) {
    const first = opened.get(attemptId);
    if (first === undefined || startedAt < first) {
      opened.set(attemptId, startedAt);
    }
  }
  const byTime = [...events].sort((left, right) =>
    compareText(left.startedAt, right.startedAt)
  );
  const ordered: LedgerEventV1[] = [];
  for (let start = 0; start < byTime.length; ) {
    const instant = byTime[start]!.startedAt;
    let end = start;
    while (byTime[end]?.startedAt === instant) end += 1;
    ordered.push(...instantInOrder(byTime.slice(start, end), opened));
    start = end;
  }
  return ordered;
}

function instantInOrder(
  events: readonly LedgerEventV1[],
  opened: ReadonlyMap<Sha256, string>
): LedgerEventV1[] {
  const pending = new Map<Sha256, LedgerEventV1[]>();
  for (const event of events) {
    const attempt = pending.get(event.attemptId);
    if (attempt) attempt.push(event);
    else pending.set(event.attemptId, [event]);
  }
  const follows = ({ attemptId, fromState }: LedgerEventV1) =>
    fromState !== null &&
    [...pending.values()].some(
      ([other]) =>
        other!.attemptId !== attemptId && other!.toState === fromState
    );
  const ordered: LedgerEventV1[] = [];
  while (pending.size > 0) {
    const [next] = [...pending.values()]
      .map(([first]) => first!)
      .sort(
        (left, right) =>
          compareText(
            opened.get(left.attemptId)!,
            opened.get(right.attemptId)!
          ) ||
          Number(follows(left)) - Number(follows(right)) ||
          compareText(left.attemptId, right.attemptId)
      );
    ordered.push(
      ...pending
        .get(next!.attemptId)!
        .sort(
          (left, right) =>
            causalRank(left) - causalRank(right) ||
            compareText(left.eventId, right.eventId)
        )
    );
    pending.delete(next!.attemptId);
  }
  return ordered;
}

function compareText(left: string, right: string): number {
  return Number(left > right) - Number(left < right);
}

function causalRank(event: LedgerEventV1): number {
  if (OPENING_KINDS.has(event.kind)) return 0;
  return CLOSING_KINDS.has(event.kind) ? 2 : 1;
}

/** The text of one top-level field of a JSON payload, per dialect. */
function jsonField(
  dialect: BoundMigrationDriver["target"]["dialect"],
  field: string
): string {
  if (dialect === "postgresql") return `payload::json->>'${field}'`;
  if (dialect === "mysql") {
    return `JSON_UNQUOTE(JSON_EXTRACT(payload, '$.${field}'))`;
  }
  return `json_extract(payload, '$.${field}')`;
}

/** One control table as the PostgreSQL catalog read reports it. */
interface PostgresControlTable {
  readonly kind: unknown;
  readonly partition: unknown;
  readonly columns: unknown;
  readonly constraints: unknown;
  readonly indexes: unknown;
  readonly executable: unknown;
}

interface PostgresControlCatalog {
  readonly state: PostgresControlTable | undefined;
  readonly log: PostgresControlTable | undefined;
}

/**
 * Both control tables' definitions in one statement (plan D5): the columns,
 * the constraints but PostgreSQL 18's catalogued NOT NULLs, how many indexes,
 * and whether a trigger, rule, policy or row security is attached. It reads
 * these two relations only, so no managed table's state — an INVALID index
 * among them (plan S7) — can make the control plane unreadable.
 */
const POSTGRES_CONTROL_CATALOG = `SELECT control.position, c.relkind::text AS kind, c.relispartition AS partition,
  (SELECT json_agg(json_build_array(a.attname::text, pg_catalog.format_type(a.atttypid, a.atttypmod), a.attnotnull, a.atthasdef, a.attidentity::text, a.attgenerated::text) ORDER BY a.attnum) FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped)::text AS columns,
  (SELECT json_agg(json_build_array(k.contype::text, k.conname::text, pg_catalog.pg_get_constraintdef(k.oid, true)) ORDER BY k.conname) FROM pg_catalog.pg_constraint k WHERE k.conrelid = c.oid AND k.contype <> 'n')::text AS constraints,
  (SELECT count(*) FROM pg_catalog.pg_index i WHERE i.indrelid = c.oid)::text AS indexes,
  (EXISTS (SELECT 1 FROM pg_catalog.pg_trigger g WHERE g.tgrelid = c.oid AND NOT g.tgisinternal)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite w WHERE w.ev_class = c.oid AND w.rulename <> '_RETURN')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid)
    OR c.relrowsecurity OR c.relforcerowsecurity) AS executable
FROM (VALUES (1, $2::text), (2, $3::text)) AS control(position, name)
LEFT JOIN pg_catalog.pg_class c ON c.relname = control.name AND c.relkind IN ('r', 'p')
  AND c.relnamespace = (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1::text)
ORDER BY control.position`;

/** {@link readPostgresControlCatalog} on PostgreSQL; nothing elsewhere. */
function postgresControlCatalog(
  producer: AnyDriver,
  driver: BoundMigrationDriver,
  base: string
): Promise<PostgresControlCatalog | undefined> {
  return driver.target.dialect === "postgresql"
    ? readPostgresControlCatalog(producer, driver, controlTableNames(base))
    : Promise.resolve(undefined);
}

async function readPostgresControlCatalog(
  producer: AnyDriver,
  driver: BoundMigrationDriver,
  names: { readonly state: string; readonly log: string }
): Promise<PostgresControlCatalog> {
  let rows: readonly Record<string, unknown>[];
  try {
    ({ rows } = await producer._executeRaw<Record<string, unknown>>(
      POSTGRES_CONTROL_CATALOG,
      [boundNamespace(driver), names.state, names.log]
    ));
  } catch (failure) {
    throwIfCatalogRefusal("control catalog", failure);
    throw unreadable(UNAUTHENTIC.pair.unreadable, failure);
  }
  if (rows.length !== 2) {
    throw new MigrationError(
      "Migration control catalog read must return one row per control table",
      VibORMErrorCode.MIGRATION_INVALID_STATE
    );
  }
  return {
    state: presentControlTable(rows[0]),
    log: presentControlTable(rows[1]),
  };
}

/** One row of the catalog read, or `undefined` when that table is absent. */
function presentControlTable(row: unknown): PostgresControlTable | undefined {
  if (!isRecord(row) || row.kind === null || row.kind === undefined) return;
  const { kind, partition, columns, constraints, indexes, executable } = row;
  return { kind, partition, columns, constraints, indexes, executable };
}

function assertPostgresControlAuthentic(
  { state, log }: PostgresControlCatalog,
  names: { readonly state: string; readonly log: string },
  scope: keyof typeof UNAUTHENTIC
): void {
  const pair = scope === "pair";
  if (
    !(
      state &&
      hasPostgresStateShape(state, names.state) &&
      (!pair ||
        (log &&
          hasPostgresShape(
            log,
            LOG_COLUMNS,
            `${names.log}_pkey`,
            "event_id",
            false
          )))
    )
  ) {
    throw new MigrationError(
      UNAUTHENTIC[scope].unexpected,
      VibORMErrorCode.MIGRATION_INVALID_STATE
    );
  }
  if (
    readFlag(state.executable) !== false ||
    (pair && readFlag(log?.executable) !== false)
  ) {
    throw new MigrationError(
      UNAUTHENTIC[scope].attached,
      VibORMErrorCode.MIGRATION_INVALID_STATE
    );
  }
}

const STATE_COLUMNS = [
  ["singleton", "integer"],
  ["payload", "text"],
] as const;
const LOG_COLUMNS = [
  ["event_id", "text"],
  ["attempt_id", "text"],
  ["kind", "text"],
  ["payload", "text"],
] as const;

function hasPostgresStateShape(
  table: PostgresControlTable,
  name: string
): boolean {
  return hasPostgresShape(
    table,
    STATE_COLUMNS,
    `${name}_pkey`,
    "singleton",
    true
  );
}

/**
 * The exact definition VibORM creates: an ordinary table of NOT NULL columns
 * with no default, identity or generation, its primary key, the state
 * table's one `singleton = 1` CHECK, and no other constraint or index.
 */
function hasPostgresShape(
  table: PostgresControlTable,
  columns: readonly (readonly [string, string])[],
  primaryKeyName: string,
  primaryKeyColumn: string,
  singletonCheck: boolean
): boolean {
  const constraints = readCatalogRows(table.constraints);
  if (constraints === undefined) return false;
  const checks = constraints.filter((constraint) => constraint[0] === "c");
  const keys = constraints.filter((constraint) => constraint[0] === "p");
  return (
    table.kind === "r" &&
    readFlag(table.partition) === false &&
    String(table.indexes) === "1" &&
    canonicalizeJsonText(readCatalogJson(table.columns)) ===
      canonicalizeJsonText(
        columns.map(([name, type]) => [name, type, true, false, "", ""])
      ) &&
    constraints.length === keys.length + checks.length &&
    keys.length === 1 &&
    keys[0]?.[1] === primaryKeyName &&
    keys[0]?.[2] === `PRIMARY KEY (${primaryKeyColumn})` &&
    checks.length === (singletonCheck ? 1 : 0) &&
    checks.every((check) => normalizeSingletonCheck(check[2]) === "singleton=1")
  );
}

/** A JSON column of the catalog read, or `null` when it is not JSON text. */
function readCatalogJson(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** A JSON array of arrays (no rows: SQL NULL), or `undefined`. */
function readCatalogRows(
  value: unknown
): readonly (readonly unknown[])[] | undefined {
  if (value === null) return [];
  const rows: unknown = readCatalogJson(value);
  if (!Array.isArray(rows)) return undefined;
  const checked: (readonly unknown[])[] = [];
  for (const row of rows) {
    const entry: unknown = row;
    if (!Array.isArray(entry)) return undefined;
    checked.push(entry);
  }
  return checked;
}

/**
 * Creates the pair, or completes the one a failed bootstrap left, under the
 * migration lock: no other command bootstraps between the presence read and
 * the CREATE, so presence is read once.
 */
export async function ensureControlTables(
  producer: AnyDriver,
  driver: BoundMigrationDriver,
  base: string
): Promise<void> {
  const catalog = await postgresControlCatalog(producer, driver, base);
  const presence = await inspectControlPresence(
    producer,
    driver,
    base,
    catalog
  );
  if (presence.kind === "present") {
    await assertControlTablesAuthentic(producer, driver, base, "pair", catalog);
    return;
  }
  if (presence.kind === "missing-table") refusePartialControl(presence);
  else {
    await producer._executeRaw(
      `DROP TABLE ${qualifyControl(driver, controlTableNames(base).state)}`
    );
  }
  const sql = createControlTableSQL(driver, base);
  await producer._executeRaw(sql.state);
  await producer._executeRaw(sql.log);
  await assertControlTablesAuthentic(producer, driver, base);
}

/**
 * Moves the marker. `predicates`, recorded beside it, are the partial-index
 * predicates of `next`'s snapshot as PostgreSQL deparsed them; a marker
 * without them proves its no-op under the lock.
 */
export async function casMarker(
  producer: AnyDriver,
  driver: BoundMigrationDriver,
  base: string,
  expected: MarkerIdentity | null,
  next: MigrationMarkerV1,
  predicates: readonly MarkerIndexPredicateV1[] = []
): Promise<void> {
  const { sql, params } = markerWrite(driver, base, expected, next, predicates);
  if (expected === null) {
    try {
      const result = await producer._executeRaw(sql, params);
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

  const result = await producer._executeRaw(sql, params);
  if (result.rowCount !== 1) {
    throw new MigrationError(
      "Migration marker compare-and-swap failed",
      VibORMErrorCode.MIGRATION_MARKER_CONFLICT
    );
  }
}

/**
 * The statement {@link casMarker} sends: the first marker's INSERT, or the
 * UPDATE that matches only the `expected` marker. One request (plan D7)
 * sends it after asserting that marker under its lock.
 */
export function markerWrite(
  driver: BoundMigrationDriver,
  base: string,
  expected: MarkerIdentity | null,
  next: MigrationMarkerV1,
  predicates: readonly MarkerIndexPredicateV1[] = []
): { readonly sql: string; readonly params: unknown[] } {
  const table = qualifyControl(driver, controlTableNames(base).state);
  const payload = canonicalizeJsonText(
    predicates.length > 0 ? { ...next, predicates } : next
  );
  const dialect = driver.target.dialect;
  const at = expected && markerAt(dialect, 2, expected);
  return at
    ? {
        sql: `UPDATE ${table} SET payload = ${placeholder(dialect, 1)} WHERE singleton = 1 AND ${at.sql}`,
        params: [payload, ...at.params],
      }
    : {
        sql: `INSERT INTO ${table} (singleton, payload) VALUES (1, ${placeholder(dialect, 1)})`,
        params: [payload],
      };
}

/** Appends events in one statement, in their order. */
export async function appendLedger(
  producer: AnyDriver,
  driver: BoundMigrationDriver,
  base: string,
  ...events: readonly LedgerEventV1[]
): Promise<void> {
  const table = qualifyControl(driver, controlTableNames(base).log);
  const dialect = driver.target.dialect;
  const rows = events.map((_, index) =>
    [1, 2, 3, 4].map((column) => placeholder(dialect, index * 4 + column))
  );
  await producer._executeRaw(
    `INSERT INTO ${table} (event_id, attempt_id, kind, payload) VALUES ${rows.map((row) => `(${row.join(", ")})`).join(", ")}`,
    events.flatMap((event) => [
      event.eventId,
      event.attemptId,
      event.kind,
      canonicalizeJsonText(event),
    ])
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

/** Every ledger event's sealed fields: format, times, tool version and id. */
export function ledgerEvent({
  open = false,
  failure = null,
  ...fields
}: Omit<
  LedgerEventV1,
  "format" | "eventId" | "toolVersion" | "startedAt" | "finishedAt" | "failure"
> & { failure?: string | null; open?: boolean }): LedgerEventV1 {
  const startedAt = new Date().toISOString();
  const event = {
    format: "1" as const,
    ...fields,
    startedAt,
    finishedAt: open ? null : startedAt,
    toolVersion: "v1",
    failure,
  };
  return { ...event, eventId: eventIdFor(event) };
}

/** An attempt's id: the id of its `started` event under the zero attempt. */
export function attemptIdFor(
  seed: Pick<
    LedgerEventV1,
    | "estateHash"
    | "snapshotHash"
    | "sqlHash"
    | "fromState"
    | "toState"
    | "transitionHash"
    | "direction"
  >
): Sha256 {
  return ledgerEvent({
    ...seed,
    attemptId: "0".repeat(64),
    kind: "started",
    operationId: null,
    dispatchId: null,
    effectState: "none",
    open: true,
  }).eventId;
}

/** Whether a read marker is the one expected; two absent markers are. */
export function sameMarker(
  marker: MarkerIdentity | null,
  expected: MarkerIdentity | null
): boolean {
  return (
    marker?.revision === expected?.revision &&
    marker?.pathHash === expected?.pathHash
  );
}

/** Compare-and-swaps the marker from `current` to the one `path` ends at. */
export async function advanceMarker(
  producer: AnyDriver,
  driver: BoundMigrationDriver,
  estateHash: Sha256,
  current: MigrationMarkerV1 | null,
  path: MigrationMarkerV1["path"],
  snapshotHash: Sha256,
  revisionStep = 1,
  predicates?: readonly MarkerIndexPredicateV1[]
): Promise<MigrationMarkerV1> {
  const next = markerFromPath(
    estateHash,
    snapshotHash,
    path,
    (current?.revision ?? 0) + revisionStep
  );
  await casMarker(
    producer,
    driver,
    DEFAULT_CONTROL_BASE,
    current,
    next,
    predicates
  );
  return next;
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
    if (OPENING_KINDS.has(event.kind)) started.set(event.attemptId, event);
    if (CLOSING_KINDS.has(event.kind)) closed.add(event.attemptId);
  }
  return [...started.values()].filter((event) => !closed.has(event.attemptId));
}
