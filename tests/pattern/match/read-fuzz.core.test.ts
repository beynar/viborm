/**
 * M3 over GENERATED read payloads (pattern-engine-ideal-state.md §13.5 M3):
 * a seeded corpus of reads per corpus schema is compiled through today's
 * read compiler and through the pattern (`constructRead` → `buildMatch`),
 * byte-compared (SQL text and bound parameters), and — when both compile —
 * decoded over a synthesized provider row set through today's `ResultParser`
 * and through `decodeRows`, value-compared.
 *
 * Same dashboard contract as tests/pattern/differential: the test always
 * completes, prints class counts and the first difference per payload (after
 * shrinking it), `PATTERN_M3_STRICT=1` gates, `PATTERN_M3_REPORT` writes
 * `<path>.read-fuzz.json`, `PATTERN_FUZZ_SEED` / `PATTERN_FUZZ_COUNT` size the
 * corpus (default 20240902 / 300 per schema).
 */
import { writeFileSync } from "node:fs";
import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import type { Dialect } from "@drivers";
import {
  constructRead,
  type ReadOperation,
} from "@query-engine/pattern/construct-read";
import { decodeRows } from "@query-engine/pattern/decode";
import { buildMatch } from "@query-engine/pattern/match";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { ResultParser } from "@query-engine/result/ResultParser";
import { buildExpectedResultShape } from "@query-engine/result/result-shape";
import type { Operation } from "@query-engine/types";
import { validate } from "@query-engine/validator";
import type { Model } from "@schema/model";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { type SchemaName, schemas } from "@tests/pattern/corpus/schemas";
import {
  type GeneratedPayload,
  generateCorpus,
  type RootOperation,
} from "@tests/pattern/generator/generate";
import { shrinkPayload } from "@tests/pattern/generator/shrink";
import { synthesizeRows } from "@tests/pattern/match/synthesize-rows";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

// =============================================================================
// CORPUS
// =============================================================================

const SEED = Number(process.env.PATTERN_FUZZ_SEED ?? 20_240_902);
const COUNT = Number(process.env.PATTERN_FUZZ_COUNT ?? 300);

/** Reads only: every write weight is zero; the generator models all six reads. */
const READ_WEIGHTS: Readonly<Record<RootOperation, number>> = {
  findMany: 3,
  findFirst: 2,
  findUnique: 2,
  count: 1,
  aggregate: 1,
  groupBy: 1,
  create: 0,
  update: 0,
  upsert: 0,
  delete: 0,
  createMany: 0,
  updateMany: 0,
  deleteMany: 0,
};

type DialectPin = {
  readonly dialect: Dialect;
  readonly placeholder: "$n" | "?";
  readonly createAdapter: () => DatabaseAdapter;
  /** JSON carriers arrive as TEXT on this provider. */
  readonly textCarriers: boolean;
};

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

type Schema = Record<string, Model<any>>;

interface ReadPayload {
  readonly name: string;
  readonly schema: SchemaName;
  readonly generated: GeneratedPayload;
}

function generated(): ReadPayload[] {
  const out: ReadPayload[] = [];
  for (const name of Object.keys(schemas) as SchemaName[]) {
    const schema = schemas[name] as Schema;
    const registry = createSchemaRegistry(schema);
    for (const payload of generateCorpus(schema, registry, SEED, COUNT, {
      weights: READ_WEIGHTS,
    })) {
      out.push({
        name: `read-fuzz:${name}:${payload.seed}:${payload.model}.${payload.operation}`,
        schema: name,
        generated: payload,
      });
    }
  }
  return out;
}

// =============================================================================
// ONE CELL
// =============================================================================

/**
 * Difference classes, in the order the dashboard reports them:
 * - `sql-alias-order`: same text once every `tN` alias is erased;
 * - `sql-structure`: different text beyond aliases;
 * - `params`: same text, different bound parameters;
 * - `error-identity`: one side refused, or both refused differently;
 * - `decode`: both compiled, the decoded values (or refusals) differ;
 * - `crash`: the cell itself threw.
 */
type Outcome =
  | { readonly kind: "equal" }
  | {
      readonly kind:
        | "sql-alias-order"
        | "sql-structure"
        | "params"
        | "error-identity"
        | "decode"
        | "crash";
      readonly detail: string;
    };

interface CellResult {
  readonly payload: string;
  readonly dialect: Dialect;
  readonly outcome: Outcome;
}

type Compiled =
  | { readonly kind: "sql"; readonly sql: string; readonly params: unknown[] }
  | { readonly kind: "error"; readonly name: string; readonly message: string };

const errorOf = (e: unknown): { name: string; message: string } =>
  e instanceof Error
    ? { name: e.name, message: e.message }
    : { name: "unknown", message: String(e) };

const compiled = (run: () => { sql: string; params: unknown[] }): Compiled => {
  try {
    return { kind: "sql", ...run() };
  } catch (e) {
    return { kind: "error", ...errorOf(e) };
  }
};

const ALIAS = /(?:"t\d+"|`t\d+`)/g;

function runReadCell(read: ReadPayload, pin: DialectPin): Outcome {
  const schema = schemas[read.schema] as Schema;
  const model = schema[read.generated.model] as Model<any>;
  const operation = read.generated.operation as ReadOperation;
  const args = read.generated.args;
  const engine = new QueryEngine(
    new SqlOnlyDriver(pin.createAdapter(), pin.dialect),
    createModelRegistry(schema, createSchemaRegistry(schema))
  );

  const oracle = compiled(() => {
    const statement = engine.build(model, operation as Operation, args);
    return {
      sql: statement.toStatement(pin.placeholder),
      params: statement.values,
    };
  });
  let validated: Record<string, unknown> | undefined;
  let pattern: ReturnType<typeof constructRead> | undefined;
  const mine = compiled(() => {
    validated = validate<Record<string, unknown>>(
      engine.schemaRegistry,
      model,
      operation as Operation,
      args
    );
    pattern = constructRead(model, operation, validated, engine.relations);
    const statement = buildMatch(pattern, engine);
    return {
      sql: statement.toStatement(pin.placeholder),
      params: statement.values,
    };
  });

  if (oracle.kind === "error" || mine.kind === "error") {
    const same =
      oracle.kind === "error" &&
      mine.kind === "error" &&
      oracle.name === mine.name &&
      oracle.message === mine.message;
    if (same) return { kind: "equal" };
    const spell = (c: Compiled) =>
      c.kind === "error" ? `${c.name}: ${c.message}` : "ok";
    return {
      kind: "error-identity",
      detail: `oracle ${spell(oracle)} vs mine ${spell(mine)}`,
    };
  }
  if (oracle.sql !== mine.sql) {
    const erased = (sql: string) => sql.replace(ALIAS, "t?");
    return erased(oracle.sql) === erased(mine.sql)
      ? {
          kind: "sql-alias-order",
          detail: firstDivergence(oracle.sql, mine.sql),
        }
      : {
          kind: "sql-structure",
          detail: firstDivergence(oracle.sql, mine.sql),
        };
  }
  if (JSON.stringify(oracle.params) !== JSON.stringify(mine.params)) {
    return {
      kind: "params",
      detail: `${JSON.stringify(oracle.params)} vs ${JSON.stringify(mine.params)}`,
    };
  }
  const validatedArgs = validated;
  const built = pattern;
  if (!(validatedArgs && built)) return { kind: "equal" };

  // Decode parity over a synthesized row set of the oracle's expected shape.
  const shape = buildExpectedResultShape(
    model,
    operation as Operation,
    validatedArgs,
    engine.relations
  );
  if (!shape) return { kind: "equal" };
  const rows = synthesizeRows(model, operation, shape, pin.textCarriers);
  const driver = engine.driver;
  const decodedByOracle = attempt(() =>
    new ResultParser(engine, model, driver).parse(
      operation as Operation,
      rows,
      validatedArgs,
      shape
    )
  );
  const decodedByPattern = attempt(() =>
    decodeRows(built, rows, {
      adapter: engine.adapter,
      relations: engine.relations,
      driver,
    })
  );
  const a = JSON.stringify(decodedByOracle, replacer);
  const b = JSON.stringify(decodedByPattern, replacer);
  return a === b
    ? { kind: "equal" }
    : { kind: "decode", detail: firstDivergence(a, b) };
}

const replacer = (_key: string, value: unknown) =>
  typeof value === "bigint" ? `${value}n` : value;

type Attempt =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "error"; readonly name: string; readonly message: string };

const attempt = (run: () => unknown): Attempt => {
  try {
    return { kind: "value", value: run() };
  } catch (e) {
    return { kind: "error", ...errorOf(e) };
  }
};

function firstDivergence(a: string, b: string): string {
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at++;
  const from = Math.max(0, at - 40);
  return `@${at} oracle …${a.slice(from, at + 100)}… vs mine …${b.slice(from, at + 100)}…`;
}

// =============================================================================
// DASHBOARD
// =============================================================================

function shrinkFailing(
  read: ReadPayload,
  pin: DialectPin,
  kind: Outcome["kind"]
): GeneratedPayload {
  const signature = (candidate: GeneratedPayload) =>
    runReadCell({ ...read, generated: candidate }, pin).kind === kind;
  return shrinkPayload(read.generated, signature, 2000).value;
}

function summarize(
  results: readonly CellResult[],
  reads: ReadonlyMap<string, ReadPayload>
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
    if (result.outcome.kind === "equal" || firsts.has(result.payload)) continue;
    const read = reads.get(result.payload);
    const pin = DIALECTS.find((d) => d.dialect === result.dialect);
    const shrunk =
      read && pin ? shrinkFailing(read, pin, result.outcome.kind) : undefined;
    firsts.set(
      result.payload,
      `${result.dialect} ${result.outcome.kind}: ${result.outcome.detail.slice(0, 220)}` +
        (shrunk
          ? `\n    shrunk ${shrunk.model}.${shrunk.operation} ${JSON.stringify(shrunk.args).slice(0, 400)}`
          : "")
    );
  }
  const detail = [...firsts.entries()]
    .map(([name, line]) => `${name}\n    ${line}`)
    .join("\n");
  return `${header}\n\n${detail}`;
}

describe("M3 read differential over generated payloads", () => {
  test("seeded corpus × dialect: bytes and decoding", () => {
    const reads = generated();
    const byName = new Map(reads.map((read) => [read.name, read]));
    const results: CellResult[] = [];
    for (const read of reads) {
      for (const pin of DIALECTS) {
        let outcome: Outcome;
        try {
          outcome = runReadCell(read, pin);
        } catch (e) {
          outcome = { kind: "crash", detail: errorOf(e).message };
        }
        results.push({ payload: read.name, dialect: pin.dialect, outcome });
      }
    }
    const text = summarize(results, byName);
    // eslint-disable-next-line no-console
    console.log(
      `M3 read fuzz differential — ${results.length} cells (${reads.length} payloads × ${DIALECTS.length} dialects)\n${text}`
    );
    if (process.env.PATTERN_M3_REPORT) {
      writeFileSync(
        `${process.env.PATTERN_M3_REPORT}.read-fuzz.json`,
        JSON.stringify(results, null, 2)
      );
    }
    expect(results.length).toBeGreaterThan(0);
    if (process.env.PATTERN_M3_STRICT) {
      expect(results.filter((r) => r.outcome.kind !== "equal")).toEqual([]);
    }
  }, 600_000);
});
