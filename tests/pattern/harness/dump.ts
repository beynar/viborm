/**
 * K4 — the fragment-dump format and the oracle harness
 * (pattern-engine-ideal-state.md §13.2, unit A).
 *
 * One canonical JSON form for a compiled operation, emitted by today's engine
 * (through `routing.ts` → `planning()` on the planning driver → `compile(known)`)
 * and, later, by the pattern engine. The differential is a byte comparison of
 * two dumps. Keys are sorted, references are rendered as `{ref: "step.output"}`,
 * SQL is the adapter's prepared text with its parameter list.
 */
import type { AnyDriver } from "@drivers";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Model } from "@schema/model";
import type { ResolvedRelationIndex } from "@schema/validation/relation-resolution";
import { getPrimaryKeyFields } from "@src/query-engine/context";
import type { ExecutableOperation } from "@src/query-engine/write-engine/OperationExecutor";
import {
  isOperationValueReference,
  type OperationFragment,
  type OperationStep,
  type PlanningFragment,
  type StatementStep,
} from "@src/query-engine/write-engine/OperationFragment";
import {
  isRecordSeries,
  type RecordSeriesOperation,
} from "@src/query-engine/write-engine/record-series";
import { constructRoutedOperation } from "@src/query-engine/write-engine/routing";
import {
  type PlanningDialect,
  PlanningDriver,
} from "@tests/fixtures/drivers/planning";
import { publishedOutputs } from "@tests/fixtures/planning-published";
import { createSchemaRegistry } from "@validation";

export type Substrate = "transaction" | "batch";

/**
 * The world the planning reads observe. Compile-level dumps are taken in both:
 * every decision read finds its row (`found`) or none does (`missing`). Both
 * engines receive the identical synthesized `known`, so the differential
 * compares the arm each one selects and the statements it packs for it.
 */
export type KnownWorld = "found" | "missing";

// ---------------------------------------------------------------------------
// The oracle context
// ---------------------------------------------------------------------------

/**
 * What a returned column decodes as. A model scalar is typed by its declared
 * scalar; a polymorphic carrier's private identity column by the storage
 * column's own scalar; its private discriminator by the FIRST declared
 * variant's stored value — the one deterministic choice the harness can make
 * without knowing which variant a payload names. Columns the table does not
 * know (junction columns) receive the untyped tag sentinel.
 */
type ColumnType =
  | { readonly kind: "scalar"; readonly type: string | undefined }
  | { readonly kind: "discriminator"; readonly value: string };

type ColumnTypes = ReadonlyMap<string, ReadonlyMap<string, ColumnType>>;

function scalarType(scalar: unknown): string | undefined {
  return (scalar as { "~"?: { state?: { type?: string } } } | undefined)?.["~"]
    ?.state?.type;
}

function columnTypes(
  schema: Record<string, Model<any>>,
  relations: ResolvedRelationIndex
): ColumnTypes {
  const table = new Map<string, Map<string, ColumnType>>();
  for (const [modelName, model] of Object.entries(schema)) {
    const columns = new Map<string, ColumnType>();
    for (const [field, scalar] of Object.entries(model["~"].state.scalars)) {
      columns.set(field, { kind: "scalar", type: scalarType(scalar) });
    }
    for (const slot of relations.get(model)?.values() ?? []) {
      // Only the carrier slot itself owns the private columns; an inverse
      // view of the same edge lives on another model.
      if (slot.edge.kind !== "variantRowCarrier" || slot.member) continue;
      const { storage, members } = slot.edge;
      columns.set(storage.typeColumn.name, {
        kind: "discriminator",
        value: members[0].entry.storedValue,
      });
      columns.set(storage.idColumn.name, {
        kind: "scalar",
        type: scalarType(storage.idColumn.scalar),
      });
    }
    table.set(modelName, columns);
  }
  return table;
}

/** Everything a dump needs to plan, synthesize and compile one operation. */
export interface Oracle {
  readonly schema: Record<string, Model<any>>;
  readonly driver: PlanningDriver;
  readonly engine: QueryEngine;
  readonly columns: ColumnTypes;
}

export function planningDriver(
  dialect: PlanningDialect,
  substrate: Substrate
): PlanningDriver {
  return substrate === "transaction"
    ? new PlanningDriver(dialect)
    : new PlanningDriver(dialect, {
        supportsTransactions: false,
        supportsBatch: true,
      });
}

export function engineFor(
  schema: Record<string, Model<any>>,
  driver: AnyDriver
): QueryEngine {
  return new QueryEngine(
    driver,
    createModelRegistry(schema, createSchemaRegistry(schema))
  );
}

export function oracleFor(
  schema: Record<string, Model<any>>,
  dialect: PlanningDialect,
  substrate: Substrate
): Oracle {
  const driver = planningDriver(dialect, substrate);
  const engine = engineFor(schema, driver);
  return {
    schema,
    driver,
    engine,
    columns: columnTypes(schema, engine.relations),
  };
}

// ---------------------------------------------------------------------------
// Synthesizing the world
// ---------------------------------------------------------------------------

/**
 * One deterministic value per (step, column, ordinal). Ordinal 0 is the value
 * every single-row read observes; higher ordinals exist only for a read that
 * observes several rows (an `IN` list, or `DumpOptions.capturedRoots`), and
 * they differ per row so a series sorts and addresses distinct members.
 */
export function sentinelFor(
  oracle: Oracle,
  modelName: string | undefined,
  column: string,
  stepId: string,
  ordinal = 0
): unknown {
  const columnType =
    modelName === undefined
      ? undefined
      : oracle.columns.get(modelName)?.get(column);
  if (columnType?.kind === "discriminator") return columnType.value;
  const tag =
    ordinal === 0 ? `${stepId}.${column}` : `${stepId}.${column}#${ordinal}`;
  switch (columnType?.type) {
    case "int":
    case "number":
      return 1 + ordinal;
    case "bigint":
      return BigInt(1 + ordinal);
    case "boolean":
      return true;
    case "dateTime":
    case "date":
    case "time":
      return new Date(Date.UTC(2026, 0, 1 + ordinal));
    case "decimal":
      return `${1 + ordinal}.00`;
    case "json":
      return { tag };
    case "blob":
      return new Uint8Array([1 + ordinal]);
    default:
      return tag;
  }
}

const ALIASED_ITEM =
  /\sAS\s+(?:"([^"]+)"|`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))\s*$/;
const LAST_IDENTIFIER = /(?:"([^"]+)"|`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))\s*$/;

/** Split a select list on its top-level commas (parentheses nest). */
function splitSelectList(list: string): readonly string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < list.length; index += 1) {
    const char = list[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      items.push(list.slice(start, index));
      start = index + 1;
    }
  }
  items.push(list.slice(start));
  return items.map((item) => item.trim()).filter((item) => item.length > 0);
}

/**
 * The columns a flat planning probe requests, read from its prepared select
 * list: the alias of an `… AS "alias"` item, else the item's last identifier
 * (a bare `"column"` or `"t0"."column"`). Harness-only: planning reads are
 * flat probes, so the first FROM closes the select list. Anything more
 * elaborate would need the compiler to publish its projection, which is
 * exactly what K1's `Projection` does in the pattern engine.
 */
export function selectAliases(sql: string): readonly string[] {
  const upper = sql.toUpperCase();
  const start = upper.indexOf("SELECT");
  const end = upper.indexOf(" FROM ");
  if (start < 0 || end < 0) return [];
  const list = sql.slice(start + 6, end);
  const aliases: string[] = [];
  for (const item of splitSelectList(list)) {
    const match = ALIASED_ITEM.exec(item) ?? LAST_IDENTIFIER.exec(item);
    if (!match) continue;
    aliases.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return aliases;
}

// A column may carry a `COLLATE <name>` before its comparison (SQLite spells
// `"t0"."id" COLLATE BINARY IN (?, ?)`).
const EQUALITY =
  /(?:"([^"]+)"|`([^`]+)`)(?:\s+COLLATE\s+\w+)?\s*=\s*\(*\s*(?:CAST\(\s*)?(\$\d+|\?)/g;
const IN_LIST =
  /(?:"([^"]+)"|`([^`]+)`)(?:\s+COLLATE\s+\w+)?\s+IN\s*\(([^()]*)\)/gi;
const PLACEHOLDER = /\$\d+|\?/g;

/** The bound value a placeholder names: `$n` by position, `?` by ordinal. */
function placeholderValue(
  sql: string,
  params: readonly unknown[],
  placeholder: string,
  at: number
): unknown {
  if (placeholder.startsWith("$")) {
    return params[Number(placeholder.slice(1)) - 1];
  }
  const ordinal = (sql.slice(0, at).match(/\?/g) ?? []).length;
  return params[ordinal];
}

/**
 * The values a flat probe's predicate binds to the columns it compares by
 * equality or `IN`: the row that satisfies the predicate carries them, which
 * is what "the read finds its row" means for an engine that matches returned
 * rows to selectors by value (`findBulkTarget`) or counts them against the
 * distinct keys it named (`RelationLinkPart`). A placeholder bound to a
 * planning reference resolves through `known` when that output is already
 * synthesized; otherwise the column keeps its sentinel.
 */
function boundPredicates(
  sql: string,
  params: readonly unknown[],
  known: Readonly<Record<string, unknown>>
): ReadonlyMap<string, readonly unknown[]> {
  const bound = new Map<string, unknown[]>();
  const resolve = (value: unknown): unknown => {
    if (!isOperationValueReference(value)) return value;
    const published = known[`${value.step}.${value.output}`];
    return isOperationValueReference(published) ? undefined : published;
  };
  for (const match of sql.matchAll(EQUALITY)) {
    const column = match[1] ?? match[2] ?? "";
    const placeholder = match[3] ?? "";
    const at = (match.index ?? 0) + match[0].lastIndexOf(placeholder);
    const value = resolve(placeholderValue(sql, params, placeholder, at));
    if (value !== undefined) bound.set(column, [value]);
  }
  for (const match of sql.matchAll(IN_LIST)) {
    const column = match[1] ?? match[2] ?? "";
    const list = match[3] ?? "";
    const listAt = (match.index ?? 0) + match[0].indexOf(list);
    const values: unknown[] = [];
    for (const placeholder of list.matchAll(PLACEHOLDER)) {
      const value = resolve(
        placeholderValue(
          sql,
          params,
          placeholder[0],
          listAt + (placeholder.index ?? 0)
        )
      );
      if (value !== undefined) values.push(value);
    }
    if (values.length > 0) bound.set(column, values);
  }
  return bound;
}

/**
 * The model a step's rows belong to: the step's own `model` when it carries
 * one, else the model its id is prefixed with (`ticket.locate` → `ticket`),
 * which is how the record compilers spell a locate. A prefix that names no
 * model (a junction table read) yields `undefined`, and its columns receive
 * the untyped sentinel.
 */
function stepModelName(
  oracle: Oracle,
  step: { readonly id: string; readonly model?: string }
): string | undefined {
  if (step.model !== undefined) return step.model;
  const prefix = step.id.split(".")[0] ?? "";
  return prefix in oracle.schema ? prefix : undefined;
}

/**
 * Synthesize the planning outputs `compile` consumes. A `rows` output becomes
 * the rows the probe finds — one per distinct key its widest `IN` list names,
 * else one, or `rowsPerRead` when that is larger — each carrying every column
 * the probe requests plus every `firstRowField` it declares, with the value
 * the predicate binds to a column where it binds one and a typed sentinel
 * elsewhere; or an empty array in the `missing` world for branch reads. Other
 * output kinds are exposed as references, exactly as the executor exposes
 * them under `planningKey(step, name)`.
 */
export function synthesizeKnown(
  oracle: Oracle,
  planning: PlanningFragment,
  world: KnownWorld,
  rowsPerRead = 1
): Readonly<Record<string, unknown>> {
  const known: Record<string, unknown> = { ...publishedOutputs(planning) };
  for (const step of planning.steps) {
    const declared = Object.values(step.outputs).flatMap((source) =>
      source.kind === "firstRowField" ? [source.field] : []
    );
    const { sql, params } = oracle.driver._prepare(step.statement);
    const requested = selectAliases(sql);
    const fields = [...new Set([...requested, ...declared])];
    const modelName = stepModelName(oracle, step);
    const bound = boundPredicates(sql, params ?? [], known);
    let rowCount = rowsPerRead;
    for (const values of bound.values()) {
      if (values.length > rowCount) rowCount = values.length;
    }
    // A read with a postcondition is required (ATOM §11): it finds its row in
    // every world. Only branch reads (no postcondition) are emptied.
    const found = world === "found" || step.expects !== undefined;
    for (const [name, source] of Object.entries(step.outputs)) {
      if (source.kind !== "rows") continue;
      const rows = Array.from({ length: rowCount }, (_, ordinal) =>
        Object.fromEntries(
          fields.map((field) => {
            const values = bound.get(field);
            const value =
              values === undefined
                ? sentinelFor(oracle, modelName, field, step.id, ordinal)
                : values[Math.min(ordinal, values.length - 1)];
            return [field, value];
          })
        )
      );
      known[`${step.id}.${name}`] = found ? rows : [];
    }
  }
  return known;
}

// ---------------------------------------------------------------------------
// The dump
// ---------------------------------------------------------------------------

export interface DumpStep {
  readonly position: number;
  readonly id: string;
  readonly kind: "read" | "write" | "guard" | "recordSeries";
  readonly sql?: string;
  readonly params?: unknown;
  readonly outputs?: unknown;
  readonly expects?: unknown;
  readonly racePin?: unknown;
  readonly onUniqueConflict?: unknown;
  readonly model?: string;
  readonly premise?: {
    readonly kind: string;
    readonly sql: string;
    readonly params: unknown;
  };
  readonly failure?: unknown;
  readonly progressive?: unknown;
}

export interface DumpError {
  readonly name: string;
  readonly message: string;
  readonly code?: unknown;
}

/** One executable the harness compiled: a series member or a series result read. */
export interface DumpExecutable {
  readonly index: number;
  readonly planning: readonly DumpStep[];
  readonly final: readonly DumpStep[];
  readonly outputs: unknown;
  readonly error?: DumpError;
}

export interface Dump {
  readonly operation: string;
  readonly model: string;
  readonly substrate: Substrate;
  readonly dialect: PlanningDialect;
  readonly world: KnownWorld;
  readonly kind: "operation" | "recordSeries";
  /** An operation's planning fragment; a series' capture fragment. */
  readonly planning: readonly DumpStep[];
  /** An operation's final fragment; empty for a series (its members carry theirs). */
  readonly final: readonly DumpStep[];
  readonly outputs: unknown;
  /**
   * Series only (ATOM §17): how many rows the synthesized capture observed,
   * the members `compileMembers` built for them (each dumped through the
   * ordinary planning → compile path), and the result reads
   * `compileResultReads` builds for a returning projection (none on the
   * `{ count }` arm).
   */
  readonly capturedRoots?: number;
  readonly memberCount?: number;
  readonly members?: readonly DumpExecutable[];
  readonly resultReads?: readonly DumpExecutable[];
  readonly error?: DumpError;
}

export interface DumpOptions {
  /**
   * How many roots a series capture observes in the `found` world (default 1).
   * A `createMany` series has no capture — its roots are the payload rows — so
   * the option is inert there.
   */
  readonly capturedRoots?: number;
}

function canonical(value: unknown): unknown {
  if (isOperationValueReference(value))
    return { ref: `${value.step}.${value.output}` };
  if (Array.isArray(value)) return value.map(canonical);
  if (value instanceof Date) return { date: value.toISOString() };
  if (typeof value === "bigint") return { bigint: value.toString() };
  if (value instanceof Uint8Array)
    return { bytes: Buffer.from(value).toString("base64") };
  if (!(value && typeof value === "object")) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, member]) => [key, canonical(member)])
  );
}

function statement(
  driver: PlanningDriver,
  step: StatementStep
): { sql: string; params: unknown } {
  const query = driver._prepare(step.statement);
  return { sql: query.sql, params: canonical(query.params) };
}

function dumpStep(
  driver: PlanningDriver,
  step: OperationStep,
  position: number
): DumpStep {
  if (step.kind === "guard") {
    const query = driver._prepare(step.premise.statement);
    return {
      position,
      id: step.id,
      kind: "guard",
      premise: {
        kind: step.premise.kind,
        sql: query.sql,
        params: canonical(query.params),
      },
      failure: canonical(step.failure),
    };
  }
  if (step.kind === "recordSeries") {
    return {
      position,
      id: step.id,
      kind: "recordSeries",
      progressive:
        step.progressive.kind === "guarded"
          ? {
              kind: "guarded",
              guard: dumpStep(driver, step.progressive.guard, -1),
            }
          : canonical(step.progressive),
    };
  }
  return {
    position,
    id: step.id,
    kind: step.kind,
    ...statement(driver, step),
    outputs: canonical(step.outputs),
    expects: canonical(step.expects ?? null),
    racePin: step.kind === "write" ? canonical(step.racePin ?? null) : null,
    onUniqueConflict:
      step.kind === "write" ? (step.onUniqueConflict ?? null) : null,
    model: step.model,
  };
}

/** Dump an arbitrary step list in the K4 format (the pattern engine's side of the differential). */
export function dumpSteps(
  driver: PlanningDriver,
  steps: readonly OperationStep[]
): readonly DumpStep[] {
  return steps.map((step, index) => dumpStep(driver, step, index));
}

function dumpFragment(
  driver: PlanningDriver,
  fragment: PlanningFragment | OperationFragment
): readonly DumpStep[] {
  return fragment.steps.map((step, index) => dumpStep(driver, step, index));
}

function dumpError(error: unknown): DumpError {
  const e = error as { name?: string; message?: string; code?: unknown };
  return {
    name: String(e?.name ?? "Error"),
    message: String(e?.message ?? error),
    code: e?.code,
  };
}

/**
 * Plan and compile one executable — a series member or a series result read —
 * against the synthesized world, through the same path a routed operation
 * takes.
 */
function dumpExecutable(
  oracle: Oracle,
  executable: ExecutableOperation,
  world: KnownWorld,
  index: number
): DumpExecutable {
  try {
    const planning = executable.planning();
    const known = synthesizeKnown(oracle, planning, world);
    const final = executable.compile(known);
    return {
      index,
      planning: dumpFragment(oracle.driver, planning),
      final: dumpFragment(oracle.driver, final),
      outputs: canonical(publishedOutputs(final)),
    };
  } catch (error) {
    return {
      index,
      planning: [],
      final: [],
      outputs: null,
      error: dumpError(error),
    };
  }
}

/**
 * What a series member answers with, synthesized before any execution: its
 * complete row key, distinct per member so the result reads address distinct
 * rows. A duplicate-skippable member answers through the executor's exact
 * `{ kind: "inserted", value }` envelope.
 */
function syntheticMemberResult(
  oracle: Oracle,
  model: Model<any>,
  modelName: string,
  member: ExecutableOperation,
  index: number
): unknown {
  const rowKey = Object.fromEntries(
    getPrimaryKeyFields(model).map((field) => [
      field,
      sentinelFor(oracle, modelName, field, `member${index}`, index),
    ])
  );
  return member.seriesRootConflict === undefined
    ? rowKey
    : { kind: "inserted", value: rowKey };
}

type SeriesDump = Pick<
  Dump,
  | "planning"
  | "final"
  | "outputs"
  | "capturedRoots"
  | "memberCount"
  | "members"
  | "resultReads"
>;

/**
 * Dump a record series (ATOM §17): its capture fragment, every member
 * `compileMembers` constructs for the synthesized capture, and every result
 * read `compileResultReads` builds for the members' synthesized row keys. All
 * three are constructible before execution; nothing here runs. A refusal from
 * `compileMembers` (the N>1 child-held move) propagates to the caller, which
 * dumps it as the operation's error.
 */
function dumpRecordSeries(
  oracle: Oracle,
  model: Model<any>,
  modelName: string,
  series: RecordSeriesOperation,
  world: KnownWorld,
  capturedRoots: number
): SeriesDump {
  const capture = series.capture();
  const captured = synthesizeKnown(oracle, capture, world, capturedRoots);
  const members = series.compileMembers(captured);
  const memberResults = members.map((member, index) =>
    syntheticMemberResult(oracle, model, modelName, member, index)
  );
  const reads = series.compileResultReads(captured, memberResults);
  return {
    planning: dumpFragment(oracle.driver, capture),
    final: [],
    outputs: null,
    capturedRoots,
    memberCount: members.length,
    members: members.map((member, index) =>
      dumpExecutable(oracle, member, world, index)
    ),
    resultReads: reads.map((read, index) =>
      dumpExecutable(oracle, read, world, index)
    ),
  };
}

/**
 * Dump one operation on today's engine. Errors thrown before I/O (validation,
 * legality, construction, packing-time refusals) are part of the contract and
 * are dumped as such rather than propagated.
 */
export function dumpOperation(
  schema: Record<string, Model<any>>,
  model: Model<any>,
  modelName: string,
  operation: string,
  args: Record<string, unknown>,
  dialect: PlanningDialect,
  substrate: Substrate,
  world: KnownWorld = "found",
  options: DumpOptions = {}
): Dump {
  const oracle = oracleFor(schema, dialect, substrate);
  const base = {
    operation,
    model: modelName,
    substrate,
    dialect,
    world,
  } as const;
  let kind: Dump["kind"] = "operation";
  try {
    const routed = constructRoutedOperation(
      oracle.engine,
      model,
      operation,
      args
    );
    if (!routed) throw new Error(`not a routed operation: ${operation}`);
    if (isRecordSeries(routed)) {
      kind = "recordSeries";
      return {
        ...base,
        kind,
        ...dumpRecordSeries(
          oracle,
          model,
          modelName,
          routed,
          world,
          options.capturedRoots ?? 1
        ),
      };
    }
    const planning = routed.planning();
    const known = synthesizeKnown(oracle, planning, world);
    const final = routed.compile(known);
    return {
      ...base,
      kind,
      planning: dumpFragment(oracle.driver, planning),
      final: dumpFragment(oracle.driver, final),
      outputs: canonical(publishedOutputs(final)),
    };
  } catch (error) {
    return {
      ...base,
      kind,
      planning: [],
      final: [],
      outputs: null,
      error: dumpError(error),
    };
  }
}

export function serializeDump(dump: Dump): string {
  return JSON.stringify(canonical(dump), null, 2);
}
