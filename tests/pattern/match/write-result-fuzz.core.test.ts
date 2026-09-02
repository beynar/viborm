/**
 * M3 over every WRITE that answers with a projection
 * (pattern-engine-ideal-state.md §8, §13.5).
 *
 * A write answers with a read of the asserted rows, and today's engine spells
 * that read in three per-dialect forms. The golden test pins six payloads; this
 * pins the WHOLE corpus — every hand-written payload that carries a `select` or
 * an `include`, plus a seeded corpus of generated writes — on three dialects and
 * both substrates, including the result reads a record series compiles for its
 * members.
 *
 * For each terminal step today's engine publishes as the operation's result:
 *
 * - the STATEMENT is compared with `matchWriteResult`'s. The mutation half
 *   belongs to the packer, so it rides as a marker: the statement is split on
 *   the markers and today's must contain the remaining segments — the whole
 *   projection, its wrapper and its aliases — in order, anchored at both ends.
 *   A `reselect` carries no mutation and is compared from its first byte.
 * - the ROWS are synthesized for that projection and decoded twice: through
 *   today's `ResultParser` and through `decodeRows` on the same pattern.
 *
 * Dashboard contract, as the read fuzz: the test always completes, prints class
 * counts and the first difference per payload (shrunk), `PATTERN_M3_STRICT=1`
 * gates, `PATTERN_M3_REPORT` writes `<path>.write-result-fuzz.json`,
 * `PATTERN_FUZZ_SEED` / `PATTERN_WRITE_FUZZ_COUNT` size the generated corpus.
 */
import { writeFileSync } from "node:fs";
import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createQueryScope } from "@query-engine/context";
import { constructRead } from "@query-engine/pattern/construct-read";
import { decodeRows } from "@query-engine/pattern/decode";
import type { WriteResultForm } from "@query-engine/pattern/match";
import { matchWriteResult } from "@query-engine/pattern/match";
import type { Pattern } from "@query-engine/pattern/pattern";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { ResultParser } from "@query-engine/result/ResultParser";
import { buildExpectedResultShape } from "@query-engine/result/result-shape";
import type { Operation } from "@query-engine/types";
import { parseValidated } from "@query-engine/write-engine/parse-boundary";
import { isRecordSeries } from "@query-engine/write-engine/record-series";
import { constructRoutedOperation } from "@query-engine/write-engine/routing";
import { buildTargetProjection } from "@query-engine/write-engine/target-projection";
import type { Model } from "@schema/model";
import { type Sql, sql } from "@sql";
import type { PlanningDialect } from "@tests/fixtures/drivers/planning";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import {
  type CorpusPayload,
  isInvalidPayload,
  payloads,
} from "@tests/pattern/corpus/payloads";
import { type SchemaName, schemas } from "@tests/pattern/corpus/schemas";
import {
  generateCorpus,
  type RootOperation,
} from "@tests/pattern/generator/generate";
import { shrinkValue } from "@tests/pattern/generator/shrink";
import {
  type DumpExecutable,
  type DumpOptions,
  type DumpStep,
  dumpOperation,
  oracleFor,
  type Substrate,
  synthesizeKnown,
} from "@tests/pattern/harness/dump";
import { synthesizeRows } from "@tests/pattern/match/synthesize-rows";
import { createSchemaRegistry } from "@validation";
import { isRecord } from "@validation/value-guards";
import { describe, expect, test } from "vitest";

// =============================================================================
// HARNESS
// =============================================================================

interface DialectPin {
  readonly dialect: PlanningDialect;
  readonly placeholder: "$n" | "?";
  readonly createAdapter: () => DatabaseAdapter;
  /** JSON carriers arrive as TEXT on this provider. */
  readonly textCarriers: boolean;
}

const DIALECTS: readonly DialectPin[] = [
  {
    dialect: "postgresql",
    placeholder: "$n",
    createAdapter: () => new PostgresAdapter(),
    textCarriers: false,
  },
  {
    dialect: "sqlite",
    placeholder: "?",
    createAdapter: () => new SQLiteAdapter(),
    textCarriers: true,
  },
  {
    dialect: "mysql",
    placeholder: "?",
    createAdapter: () => new MySQLAdapter(),
    textCarriers: true,
  },
];

const SUBSTRATES: readonly Substrate[] = ["transaction", "batch"];
const SEED = Number(process.env.PATTERN_FUZZ_SEED ?? 20_240_902);
const COUNT = Number(process.env.PATTERN_WRITE_FUZZ_COUNT ?? 200);
/** Shrinking a failure costs a full re-compile per candidate; bound the report. */
const SHRINK_BUDGET = 200;
const SHRUNK_PAYLOADS = 5;
/** How many aliases the caller's scope may have spent before the projection. */
const MAX_SPENT_ALIASES = 32;

const PROBES = /__viborm_probe_\d+/g;
const RETURNING_CLAUSE = / RETURNING /;
const probe = (index: number): Sql => sql.raw([`__viborm_probe_${index}`]);

type Schema = Record<string, Model<any>>;

const engines = new Map<string, QueryEngine>();
function engineFor(schema: Schema, pin: DialectPin): QueryEngine {
  const key = `${Object.keys(schema).join(",")}:${pin.dialect}`;
  let engine = engines.get(key);
  if (!engine) {
    engine = new QueryEngine(
      new SqlOnlyDriver(pin.createAdapter(), pin.dialect),
      createModelRegistry(schema, createSchemaRegistry(schema))
    );
    engines.set(key, engine);
  }
  return engine;
}

const errorOf = (error: unknown): { name: string; message: string } =>
  error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "unknown", message: String(error) };

/** The dump canonicalizes provider-native parameters; compare in that spelling. */
function canonicalParam(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalParam);
  if (value instanceof Date) return { date: value.toISOString() };
  if (typeof value === "bigint") return { bigint: value.toString() };
  if (value instanceof Uint8Array) {
    return { bytes: Buffer.from(value).toString("base64") };
  }
  if (!(value && typeof value === "object")) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, member]) => [key, canonicalParam(member)])
  );
}

// =============================================================================
// THE PAYLOADS THAT ANSWER WITH A PROJECTION
// =============================================================================

interface WritePayload {
  readonly name: string;
  readonly schema: SchemaName;
  readonly model: string;
  readonly operation: string;
  readonly args: Record<string, unknown>;
  readonly options?: DumpOptions;
}

const hasProjection = (args: Record<string, unknown>): boolean =>
  isRecord(args.select) || isRecord(args.include);

/** Reads are another unit's; a refusal payload has no result to project. */
const WRITE_WEIGHTS: Readonly<Record<RootOperation, number>> = {
  findMany: 0,
  findFirst: 0,
  findUnique: 0,
  count: 0,
  aggregate: 0,
  groupBy: 0,
  create: 3,
  update: 3,
  upsert: 2,
  delete: 1,
  createMany: 2,
  updateMany: 2,
  deleteMany: 1,
};

function corpusPayloads(): WritePayload[] {
  return (payloads as readonly CorpusPayload[])
    .filter(
      (payload) => !isInvalidPayload(payload) && hasProjection(payload.args)
    )
    .map((payload) => ({
      name: payload.name,
      schema: payload.schema,
      model: payload.model,
      operation: payload.operation,
      args: payload.args,
      ...(payload.options ? { options: payload.options } : {}),
    }));
}

function generatedPayloads(): WritePayload[] {
  const out: WritePayload[] = [];
  for (const name of Object.keys(schemas) as SchemaName[]) {
    const schema = schemas[name] as Schema;
    const registry = createSchemaRegistry(schema);
    for (const payload of generateCorpus(schema, registry, SEED, COUNT, {
      weights: WRITE_WEIGHTS,
    })) {
      if (!hasProjection(payload.args)) continue;
      out.push({
        name: `fuzz:${name}:${payload.seed}:${payload.model}.${payload.operation}`,
        schema: name,
        model: payload.model,
        operation: payload.operation,
        args: payload.args,
      });
    }
  }
  return out;
}

// =============================================================================
// ONE CELL
// =============================================================================

/**
 * Difference classes:
 * - `statement`: the projection, its wrapper or its aliases differ;
 * - `params`: the statement matches, the bound parameters do not;
 * - `decode`: the same rows decode differently (or one side refuses);
 * - `construct`: the pattern or the statement could not be built at all;
 * - `no-terminal`: today publishes a result step this test cannot classify.
 */
type OutcomeKind =
  | "equal"
  /** A difference this engine keeps deliberately; the detail says why. */
  | "allowed"
  | "statement"
  | "params"
  | "decode"
  | "construct"
  | "no-terminal";

interface Outcome {
  readonly kind: OutcomeKind;
  readonly detail: string;
}

const EQUAL: Outcome = { kind: "equal", detail: "" };

interface CellResult {
  readonly payload: string;
  readonly dialect: PlanningDialect;
  readonly substrate: Substrate;
  readonly step: string;
  readonly outcome: Outcome;
}

/** The step ids one executable publishes as its result. */
function resultSteps(outputs: unknown): string[] {
  const result = isRecord(outputs) ? outputs.result : undefined;
  const refs = Array.isArray(result) ? result : [result];
  return refs.flatMap((ref) =>
    isRecord(ref) && typeof ref.ref === "string"
      ? [ref.ref.slice(0, ref.ref.lastIndexOf("."))]
      : []
  );
}

function terminalSteps(
  executable: Pick<DumpExecutable, "planning" | "final" | "outputs">
): DumpStep[] {
  const ids = new Set(resultSteps(executable.outputs));
  return [...executable.planning, ...executable.final].filter((step) =>
    ids.has(step.id)
  );
}

/** Which form today attached the projection with. */
function formOf(step: DumpStep): WriteResultForm | undefined {
  if (step.kind === "read") return "reselect";
  const text = step.sql;
  if (!text) return undefined;
  if (text.includes("__viborm_mutation")) return "fold";
  return RETURNING_CLAUSE.test(text) ? "returning" : undefined;
}

const LIMIT_ONE = / LIMIT 1$/;
const SIBLING_ARM = /__viborm_write_\d+/g;

interface Built {
  readonly sql: string;
  readonly params: unknown[];
}

/**
 * The projection the packer hands the terminal read.
 *
 * A record series' result read addresses its rows by their ROW KEY, so it
 * projects the public select PLUS that key and drops the injected fields from
 * the public result (`seriesResultSelect`). The injection is the series' —
 * upstream of this unit — so the test performs the same one rather than
 * pretending the payload asked for it.
 */
function projectionArgs(
  model: Model<any>,
  args: Record<string, unknown>,
  seriesResultRead: boolean
): Record<string, unknown> {
  const select = isRecord(args.select) ? { ...args.select } : undefined;
  if (select && seriesResultRead) {
    for (const field of buildTargetProjection(model).identityFields) {
      select[field] = true;
    }
  }
  return {
    ...(select ? { select } : {}),
    ...(isRecord(args.include) ? { include: args.include } : {}),
  };
}

function buildMine(
  engine: QueryEngine,
  model: Model<any>,
  args: Record<string, unknown>,
  step: DumpStep,
  form: WriteResultForm,
  pin: DialectPin,
  seriesResultRead: boolean,
  spentAliases: number
): Built {
  const ctx = createQueryScope(engine, model);
  // A relation filter in the mutation's `where` spends aliases on the SAME
  // scope before the projection is built, so today's projection can start at
  // any `tN`. That base is the caller's, not this function's: spend it here and
  // the statements are byte-identical.
  for (let spent = 0; spent < spentAliases; spent++) ctx.nextAlias();
  const projection = projectionArgs(model, args, seriesResultRead);
  // The row's CARDINALITY is the packer's fact — it is what puts the literal
  // `LIMIT 1` on a unique terminal read — so it is read off today's statement
  // rather than guessed: this unit is the assembly and the projection, not the
  // decision.
  const single = form === "reselect" && LIMIT_ONE.test(step.sql ?? "");
  const pattern = constructRead(
    model,
    single ? "findFirst" : "findMany",
    projection,
    engine.relations
  );
  const siblings = (step.sql?.match(SIBLING_ARM) ?? []).length;
  const built = matchWriteResult(ctx, {
    pattern,
    form,
    ...(form === "reselect" ? { selector: probe(0) } : { mutation: probe(0) }),
    ...(form === "fold"
      ? {
          siblings: Array.from({ length: siblings }, (_, index) =>
            probe(index + 1)
          ),
        }
      : {}),
  });
  return {
    sql: built.toStatement(pin.placeholder),
    params: built.values.map(canonicalParam),
  };
}

const PLACEHOLDER = /\$\d+/g;

/**
 * A numbered placeholder counts the parameters BEFORE it, and the marker
 * standing in for the packer's mutation carries none where the real statement
 * carries several. The numbering is therefore an offset, not a difference —
 * and the parameters themselves are compared as values, in order, so nothing
 * about the binding is lost by erasing it here.
 */
const erasePlaceholders = (text: string): string =>
  text.replace(PLACEHOLDER, "$?");

/**
 * Today's statement must carry every segment this function produced, in order,
 * anchored at both ends — the markers stand where the packer's own statements
 * go, and nothing else may differ.
 */
/** Where two strings first differ, with the surrounding bytes of each. */
function firstDivergence(mine: string, theirs: string): string {
  let at = 0;
  while (at < mine.length && at < theirs.length && mine[at] === theirs[at]) {
    at++;
  }
  const from = Math.max(0, at - 60);
  return `@${at} mine …${mine.slice(from, at + 120)}… vs theirs …${theirs.slice(from, at + 120)}…`;
}

function segmentsMatch(mine: string, theirs: string): string | undefined {
  const segments = mine.split(PROBES);
  const first = segments[0] ?? "";
  if (!theirs.startsWith(first)) {
    return `head: ${firstDivergence(first, theirs)}`;
  }
  let cursor = first.length;
  for (const segment of segments.slice(1, -1)) {
    const at = theirs.indexOf(segment, cursor);
    if (at < 0) {
      return `middle: mine ${JSON.stringify(segment.slice(0, 160))} not found after ${cursor}`;
    }
    cursor = at + segment.length;
  }
  const last = segments.at(-1) ?? "";
  if (segments.length > 1 && !theirs.endsWith(last)) {
    return `tail: ${firstDivergence(
      [...last].reverse().join(""),
      [...theirs].reverse().join("")
    )}`;
  }
  if (theirs.length - last.length < cursor) {
    return `overlap: the segments do not fit ${JSON.stringify(theirs.slice(0, 160))}`;
  }
  return undefined;
}

/**
 * A `reselect`'s projection params come FIRST (the select list precedes the
 * `WHERE` the packer supplies); a `returning` or `fold` puts them LAST, after
 * the mutation's own. Either way this function's parameters are one contiguous
 * end of today's list.
 */
function paramsMatch(
  mine: readonly unknown[],
  theirs: readonly unknown[],
  form: WriteResultForm
): string | undefined {
  const slice =
    form === "reselect"
      ? theirs.slice(0, mine.length)
      : theirs.slice(theirs.length - mine.length);
  const a = JSON.stringify(mine);
  const b = JSON.stringify(slice);
  return a === b ? undefined : `mine ${a} vs theirs ${b}`;
}

function compareStep(
  engine: QueryEngine,
  model: Model<any>,
  args: Record<string, unknown>,
  step: DumpStep,
  pin: DialectPin,
  seriesResultRead: boolean
): Outcome {
  const form = formOf(step);
  if (!form) {
    return step.sql
      ? { kind: "no-terminal", detail: `unclassified result step: ${step.id}` }
      : EQUAL;
  }
  const theirs = step.sql ?? "";
  let first: Outcome | undefined;
  for (let spent = 0; spent <= MAX_SPENT_ALIASES; spent++) {
    let mine: Built;
    try {
      mine = buildMine(
        engine,
        model,
        args,
        step,
        form,
        pin,
        seriesResultRead,
        spent
      );
    } catch (error) {
      const { name, message } = errorOf(error);
      return { kind: "construct", detail: `${form}: ${name}: ${message}` };
    }
    const statement = segmentsMatch(
      erasePlaceholders(mine.sql),
      erasePlaceholders(theirs)
    );
    if (statement) {
      first ??= { kind: "statement", detail: `${form} ${statement}` };
      continue;
    }
    const params = paramsMatch(
      mine.params,
      (step.params ?? []) as unknown[],
      form
    );
    return params ? { kind: "params", detail: `${form} ${params}` } : EQUAL;
  }
  return first ?? EQUAL;
}

// =============================================================================
// DECODE
// =============================================================================

/**
 * The operation a write's RESULT is parsed under. The public bulk names carry
 * a `select` into their row-returning arm, which is the internal name today's
 * result shape and parser are keyed by.
 */
function resultOperation(
  operation: string,
  args: Record<string, unknown>
): Operation {
  if (!hasProjection(args)) return operation as Operation;
  if (operation === "createMany") return "createManyAndReturn";
  if (operation === "updateMany") return "updateManyAndReturn";
  if (operation === "deleteMany") return "deleteManyAndReturn";
  return operation as Operation;
}

type Attempt =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "error"; readonly name: string; readonly message: string };

const attempt = (run: () => unknown): Attempt => {
  try {
    return { kind: "value", value: run() };
  } catch (error) {
    return { kind: "error", ...errorOf(error) };
  }
};

const replacer = (_key: string, value: unknown) =>
  typeof value === "bigint" ? `${value}n` : value;

function compareDecode(
  engine: QueryEngine,
  model: Model<any>,
  operation: string,
  validated: Record<string, unknown>,
  pin: DialectPin
): Outcome {
  const parsedAs = resultOperation(operation, validated);
  const projection = {
    ...(isRecord(validated.select) ? { select: validated.select } : {}),
    ...(isRecord(validated.include) ? { include: validated.include } : {}),
  };
  // The shape and the rows are TODAY's — one input, decoded twice. A
  // projection today refuses (an all-false `select`) must be refused
  // identically, which is why the shape is built inside the attempt.
  let rows: unknown[] | undefined;
  const theirs = attempt(() => {
    const shape = buildExpectedResultShape(
      model,
      parsedAs,
      validated,
      engine.relations
    );
    if (!shape) return undefined;
    rows = synthesizeRows(model, parsedAs, shape, pin.textCarriers);
    return new ResultParser(engine, model, engine.driver).parse(
      parsedAs,
      rows,
      validated,
      shape
    );
  });
  const mine = attempt(() => {
    // The terminal pattern of a write carries the WRITE's operation: it is
    // what decides whether the result is one row or an array. Construction
    // (stream C) stamps it; here the projection is built as a read and the
    // operation put back on it.
    const pattern: Pattern = {
      ...constructRead(model, "findMany", projection, engine.relations),
      operation: parsedAs,
    };
    // `decodeRows` derives its own shape from that pattern; the rows are the
    // ones today's shape produced, or none when today had no shape at all.
    if (!rows) return undefined;
    return decodeRows(pattern, rows, {
      adapter: engine.adapter,
      relations: engine.relations,
      driver: engine.driver,
    });
  });
  const a = JSON.stringify(theirs, replacer);
  const b = JSON.stringify(mine, replacer);
  if (a === b) return EQUAL;
  if (theirs.kind === "error" && mine.kind === "error") {
    // Two refusals with different sentences are a difference; the same
    // sentence is agreement and already compared equal above.
    return {
      kind: "decode",
      detail: `refusals differ: theirs ${theirs.message} vs mine ${mine.message}`,
    };
  }
  return {
    kind: "decode",
    detail: `theirs ${a?.slice(0, 200)} vs mine ${b?.slice(0, 200)}`,
  };
}

// =============================================================================
// THE COUNT ARM — a bulk without a projection answers with `{ count }`
// =============================================================================

const BULK_OPERATIONS: ReadonlySet<string> = new Set([
  "createMany",
  "updateMany",
  "deleteMany",
]);

/** Every published value a program can hand the count arm, valid and not. */
const COUNT_VALUES: readonly unknown[] = [3, 0, 2n, "3", null, { rowCount: 3 }];

function countPayloads(): WritePayload[] {
  return (payloads as readonly CorpusPayload[])
    .filter(
      (payload) =>
        !isInvalidPayload(payload) &&
        BULK_OPERATIONS.has(payload.operation) &&
        !hasProjection(payload.args)
    )
    .map((payload) => ({
      name: payload.name,
      schema: payload.schema,
      model: payload.model,
      operation: payload.operation,
      args: payload.args,
      ...(payload.options ? { options: payload.options } : {}),
    }));
}

/**
 * The bulk count arm, decoded twice: today's operation consumes the published
 * number in its own `parse`, and `decodeRows` decodes the same number through
 * the pattern. Every published value is compared — a count, a zero, a bigint,
 * the malformed ones, and the `undefined` a program with no write publishes.
 */
/**
 * ONE deliberate difference, on ONE input this engine cannot produce.
 *
 * Today reads "no count published" as a REFUSAL when its operation compiled a
 * write, and answers `{ count: 0 }` only when it compiled none — a decision it
 * makes from `writes.length`, a COMPILE fact, inside `parse`. In the pattern
 * engine that fact belongs to the packer: a program that compiled a write
 * always publishes its `rowCount`, so `undefined` means "no write" and nothing
 * else, and the count arm answers zero for it. The refused input is therefore
 * unreachable — an executed write that published no count — and reproducing
 * the refusal would mean giving `decodeRows` a compile fact it does not hold.
 */
function countOutcome(value: unknown, theirs: string, mine: string): Outcome {
  if (theirs === mine) return EQUAL;
  if (value === undefined && mine.includes('"count":0')) {
    return {
      kind: "allowed",
      detail:
        "no published count: today refuses it for a compiled write, the pattern engine reads it as the no-write zero",
    };
  }
  return { kind: "decode", detail: `theirs ${theirs} vs mine ${mine}` };
}

function runCountPayload(payload: WritePayload, pin: DialectPin): CellResult[] {
  const schema = schemas[payload.schema] as Schema;
  const model = schema[payload.model] as Model<any>;
  const engine = engineFor(schema, pin);
  const results: CellResult[] = [];
  const routed = constructRoutedOperation(
    engine,
    model,
    payload.operation as Operation,
    payload.args
  );
  // A relation-bearing bulk routes to a record series, whose own `parse` folds
  // its members' counts: another owner, another unit.
  if (!routed || isRecordSeries(routed)) return results;
  // An operation answers from the state its own compile built (`CreateMany`
  // holds its writes there), so the oracle is driven exactly as the executor
  // drives it: planning, a synthesized world, compile — then parse.
  try {
    const planning = routed.planning();
    routed.compile(
      synthesizeKnown(
        oracleFor(schema, pin.dialect, "transaction"),
        planning,
        "found",
        payload.options?.capturedRoots ?? 1
      )
    );
  } catch {
    // A payload that refuses at compile has no count to answer with.
    return results;
  }

  const pattern: Pattern = {
    ...constructRead(model, "findMany", {}, engine.relations),
    operation: payload.operation as Operation,
  };
  for (const value of [...COUNT_VALUES, undefined]) {
    const theirs = attempt(() => routed.parse({ count: value }));
    const mine = attempt(() =>
      decodeRows(pattern, value, {
        adapter: engine.adapter,
        relations: engine.relations,
        driver: engine.driver,
      })
    );
    const a = JSON.stringify(theirs, replacer);
    const b = JSON.stringify(mine, replacer);
    results.push({
      payload: payload.name,
      dialect: pin.dialect,
      substrate: "transaction",
      step: `count:${String(value)}`,
      outcome: countOutcome(value, a, b),
    });
  }
  return results;
}

// =============================================================================
// THE RUN
// =============================================================================

function runPayload(payload: WritePayload, pin: DialectPin): CellResult[] {
  const schema = schemas[payload.schema] as Schema;
  const model = schema[payload.model] as Model<any>;
  const engine = engineFor(schema, pin);
  const results: CellResult[] = [];

  let validated: Record<string, unknown>;
  try {
    validated = parseValidated(
      Reflect.get(
        createSchemaRegistry(schema).getModelSchemas(model).args,
        payload.operation
      ),
      payload.args,
      payload.operation as never,
      ""
    ) as Record<string, unknown>;
  } catch {
    // An invalid payload is the validator's business, not this test's.
    return results;
  }

  for (const substrate of SUBSTRATES) {
    const dump = dumpOperation(
      schema,
      model,
      payload.model,
      payload.operation,
      payload.args,
      pin.dialect,
      substrate,
      "found",
      payload.options
    );
    // A payload today refuses on this cell has no terminal projection to
    // compare; the compile differential owns refusals.
    if (dump.error) continue;
    // The operation's own result, and the result READS a record series
    // compiles for its members (ATOM §17). A series MEMBER's own result is its
    // row-key capture — an internal projection, not the caller's.
    const executables = [
      {
        seriesResultRead: false,
        executable: {
          planning: dump.planning,
          final: dump.final,
          outputs: dump.outputs,
        },
      },
      ...(dump.resultReads ?? []).map((executable) => ({
        seriesResultRead: true,
        executable,
      })),
    ];
    for (const { executable, seriesResultRead } of executables) {
      if ("error" in executable && executable.error) continue;
      for (const step of terminalSteps(executable)) {
        results.push({
          payload: payload.name,
          dialect: pin.dialect,
          substrate,
          step: step.id,
          outcome: compareStep(
            engine,
            model,
            validated,
            step,
            pin,
            seriesResultRead
          ),
        });
      }
    }
  }

  results.push({
    payload: payload.name,
    dialect: pin.dialect,
    substrate: "transaction",
    step: "decode",
    outcome: compareDecode(engine, model, payload.operation, validated, pin),
  });
  return results;
}

function shrinkFailing(
  payload: WritePayload,
  pin: DialectPin,
  kind: OutcomeKind
): unknown {
  const fails = (candidate: unknown): boolean => {
    if (!isRecord(candidate)) return false;
    try {
      return runPayload(
        { ...payload, args: candidate as Record<string, unknown> },
        pin
      ).some((result) => result.outcome.kind === kind);
    } catch {
      return false;
    }
  };
  return shrinkValue(payload.args, fails, SHRINK_BUDGET).value;
}

function summarize(
  results: readonly CellResult[],
  byName: ReadonlyMap<string, WritePayload>
): string {
  const counts = new Map<string, number>();
  for (const { outcome } of results) {
    counts.set(outcome.kind, (counts.get(outcome.kind) ?? 0) + 1);
  }
  const header = [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, count]) => `${key}: ${count}`)
    .join("\n");
  const firsts = new Map<string, string>();
  for (const result of results) {
    if (
      result.outcome.kind === "equal" ||
      result.outcome.kind === "allowed" ||
      firsts.has(result.payload)
    ) {
      continue;
    }
    const payload = byName.get(result.payload);
    const pin = DIALECTS.find((entry) => entry.dialect === result.dialect);
    const shrunk =
      payload && pin && firsts.size < SHRUNK_PAYLOADS
        ? shrinkFailing(payload, pin, result.outcome.kind)
        : undefined;
    firsts.set(
      result.payload,
      `${result.dialect}/${result.substrate} ${result.step} ${result.outcome.kind}: ${result.outcome.detail.slice(0, 900)}` +
        (shrunk ? `\n    shrunk ${JSON.stringify(shrunk).slice(0, 400)}` : "")
    );
  }
  const detail = [...firsts.entries()]
    .map(([name, line]) => `${name}\n    ${line}`)
    .join("\n");
  const allowed = new Set(
    results
      .filter((result) => result.outcome.kind === "allowed")
      .map((result) => result.outcome.detail)
  );
  const reasons = [...allowed].map((line) => `  allowed: ${line}`).join("\n");
  return `${header}\n${reasons}\n\n${detail}`;
}

describe("M3 write-result differential over the corpus", () => {
  test("every write that answers with a projection, on 3 dialects × 2 substrates", () => {
    const corpus = [...corpusPayloads(), ...generatedPayloads()];
    const counts = countPayloads();
    const byName = new Map(corpus.map((payload) => [payload.name, payload]));
    const results: CellResult[] = [];
    for (const payload of counts) {
      for (const pin of DIALECTS) {
        results.push(...runCountPayload(payload, pin));
      }
    }
    for (const payload of corpus) {
      for (const pin of DIALECTS) {
        try {
          results.push(...runPayload(payload, pin));
        } catch (error) {
          results.push({
            payload: payload.name,
            dialect: pin.dialect,
            substrate: "transaction",
            step: "cell",
            outcome: { kind: "construct", detail: errorOf(error).message },
          });
        }
      }
    }
    const text = summarize(results, byName);
    // eslint-disable-next-line no-console
    console.log(
      `M3 write-result differential — ${results.length} cells over ${corpus.length} projection payloads (${corpusPayloads().length} corpus, ${generatedPayloads().length} generated) and ${counts.length} count payloads\n${text}`
    );
    if (process.env.PATTERN_M3_REPORT) {
      writeFileSync(
        `${process.env.PATTERN_M3_REPORT}.write-result-fuzz.json`,
        JSON.stringify(results, null, 2)
      );
    }
    expect(results.length).toBeGreaterThan(0);
    if (process.env.PATTERN_M3_STRICT) {
      expect(
        results.filter(
          (r) => r.outcome.kind !== "equal" && r.outcome.kind !== "allowed"
        )
      ).toEqual([]);
    }
  }, 600_000);
});
