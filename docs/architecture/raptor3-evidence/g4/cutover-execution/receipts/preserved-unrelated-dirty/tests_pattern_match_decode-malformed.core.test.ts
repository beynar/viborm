/**
 * M3 — malformed provider rows and the container policy
 * (pattern-engine-ideal-state.md §9.2, §13.5 M3).
 *
 * The read fuzz decodes rows a well-behaved provider returns. This decodes the
 * rows a MISBEHAVING one returns — every way a row can be wrong that the result
 * boundary has an opinion about — and pins that today's parser and `decodeRows`
 * refuse identically: the same class, the same sentence, naming the same row
 * and column. A refusal is a contract, so a difference in its wording is a
 * difference in behaviour.
 *
 * It also pins the CONTAINER POLICY, the other half M3 counts: which row
 * objects a decode returns. Today's boundary may return a natively valid row
 * unchanged (`identity`), write decoded values into a same-key row it owns
 * (`reusable`), or always build a fresh one (`copy`), and the executors choose
 * between borrowed and consumable rows per call. Both paths are decoded twice
 * here and compared on the OBJECT GRAPH, not just the values: which returned
 * row is the input row, which nested row is the carrier's row, and whether the
 * outer array is fresh.
 *
 * Dashboard contract, as the other differentials: always completes, prints its
 * counts and the first difference per class, `PATTERN_M3_STRICT=1` gates.
 */
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
import type { Pattern } from "@query-engine/pattern/pattern";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import {
  parsePreparedResult,
  prepareResultRows,
  ResultParser,
} from "@query-engine/result/ResultParser";
import { classifyResultColumn } from "@query-engine/result/result-column";
import { buildExpectedResultShape } from "@query-engine/result/result-shape";
import type { ExpectedResultShape, Operation } from "@query-engine/types";
import { validate } from "@query-engine/validator";
import type { Model } from "@schema/model";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { type SchemaName, schemas } from "@tests/pattern/corpus/schemas";
import {
  generateCorpus,
  type RootOperation,
} from "@tests/pattern/generator/generate";
import { synthesizeRows } from "@tests/pattern/match/synthesize-rows";
import { createSchemaRegistry } from "@validation";
import { isRecord } from "@validation/value-guards";
import { describe, expect, test } from "vitest";

// =============================================================================
// HARNESS
// =============================================================================

interface DialectPin {
  readonly dialect: Dialect;
  readonly createAdapter: () => DatabaseAdapter;
  /** JSON carriers arrive as TEXT on this provider. */
  readonly textCarriers: boolean;
}

const DIALECTS: readonly DialectPin[] = [
  {
    dialect: "postgresql",
    createAdapter: () => new PostgresAdapter(),
    textCarriers: false,
  },
  {
    dialect: "sqlite",
    createAdapter: () => new SQLiteAdapter(),
    textCarriers: true,
  },
  {
    dialect: "mysql",
    createAdapter: () => new MySQLAdapter(),
    textCarriers: true,
  },
];

const SEED = Number(process.env.PATTERN_FUZZ_SEED ?? 20_240_902);
const COUNT = Number(process.env.PATTERN_MALFORMED_COUNT ?? 60);

const READ_WEIGHTS: Readonly<Record<RootOperation, number>> = {
  findMany: 3,
  findFirst: 1,
  findUnique: 1,
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

/** One case: a read shape and the rows a provider returned for it. */
interface Case {
  readonly name: string;
  readonly model: Model<any>;
  readonly operation: Operation;
  readonly args: Record<string, unknown>;
  readonly shape: ExpectedResultShape;
  readonly engine: QueryEngine;
  readonly pin: DialectPin;
  readonly rows: unknown[];
  /**
   * The terminal pattern, built ONCE. A payload whose pattern cannot be built
   * never reaches decoding in production either — its statement is refused
   * first — so a construction refusal is the read differential's subject, not
   * this one's.
   */
  readonly pattern: Pattern;
}

function cases(pin: DialectPin): Case[] {
  const out: Case[] = [];
  for (const name of Object.keys(schemas) as SchemaName[]) {
    const schema = schemas[name] as Schema;
    const engine = engineFor(schema, pin);
    for (const payload of generateCorpus(
      schema,
      createSchemaRegistry(schema),
      SEED,
      COUNT,
      { weights: READ_WEIGHTS }
    )) {
      const model = schema[payload.model] as Model<any>;
      const operation = payload.operation as Operation;
      try {
        const args = validate<Record<string, unknown>>(
          engine.schemaRegistry,
          model,
          operation,
          payload.args
        );
        const shape = buildExpectedResultShape(
          model,
          operation,
          args,
          engine.relations
        );
        if (!shape) continue;
        const pattern = constructRead(
          model,
          operation as ReadOperation,
          args,
          engine.relations
        );
        out.push({
          pattern,
          name: `${name}:${payload.seed}:${payload.model}.${payload.operation}`,
          model,
          operation,
          args,
          shape,
          engine,
          pin,
          rows: synthesizeRows(model, operation, shape, pin.textCarriers),
        });
      } catch {
        // An invalid payload is the validator's business, not this test's.
      }
    }
  }
  return out;
}

/** A fresh copy per decode: the consumable path may write into its input. */
const clone = <T>(value: T): T => structuredClone(value);

// =============================================================================
// THE MUTATIONS — every way one provider row can be wrong
// =============================================================================

type Mutation =
  | "missing-column"
  | "extra-column"
  | "null-value"
  | "row-not-an-object"
  | "relation-carrier-is-scalar"
  | "unknown-discriminator"
  | "aggregate-carrier-missing-key";

const MUTATIONS: readonly Mutation[] = [
  "missing-column",
  "extra-column",
  "null-value",
  "row-not-an-object",
  "relation-carrier-is-scalar",
  "unknown-discriminator",
  "aggregate-carrier-missing-key",
];

const firstRow = (rows: unknown[]): Record<string, unknown> | undefined =>
  isRecord(rows[0]) ? (rows[0] as Record<string, unknown>) : undefined;

/** The first requested key of one classified kind, if this shape carries one. */
function keyOfKind(
  subject: Case,
  kinds: readonly string[]
): string | undefined {
  for (const key of subject.shape.rawKeys) {
    const column = classifyResultColumn(subject.model, key, subject.shape);
    if (kinds.includes(column.kind)) return key;
  }
  return undefined;
}

/** The first requested key whose value the projection promises is not null. */
function requiredKey(subject: Case): string | undefined {
  for (const key of subject.shape.rawKeys) {
    const column = classifyResultColumn(subject.model, key, subject.shape);
    if (column.kind === "scalar") {
      if (column.scalar["~"].state.nullable !== true) return key;
      continue;
    }
    if (column.kind === "relation" && !column.expected.optional) return key;
    if (column.kind === "aggregate" || column.kind === "relationCounts") {
      return key;
    }
  }
  return undefined;
}

/**
 * The mutated row set, or `undefined` when this shape has nothing to break that
 * way (no relation to blank out, no aggregate carrier to empty).
 */
function mutate(subject: Case, mutation: Mutation): unknown[] | undefined {
  const rows = clone(subject.rows);
  const row = firstRow(rows);
  if (!row) return undefined;
  switch (mutation) {
    case "missing-column": {
      const key = subject.shape.rawKeys[0];
      if (key === undefined) return undefined;
      delete row[key];
      return rows;
    }
    case "extra-column":
      row.__viborm_unrequested = 1;
      return rows;
    case "null-value": {
      // A null where the projection PROMISED a value: a nullable column's null
      // is data, not damage, so the mutation looks for a column that cannot
      // hold one and skips the shape when every column can.
      const key = requiredKey(subject);
      if (key === undefined) return undefined;
      row[key] = null;
      return rows;
    }
    case "row-not-an-object":
      rows[0] = 42;
      return rows;
    case "relation-carrier-is-scalar": {
      const key = keyOfKind(subject, ["relation", "polymorphic"]);
      if (key === undefined) return undefined;
      row[key] = 7;
      return rows;
    }
    case "unknown-discriminator": {
      const key = keyOfKind(subject, ["polymorphic"]);
      if (key === undefined) return undefined;
      const carrier = subject.pin.textCarriers
        ? JSON.parse(String(row[key]))
        : row[key];
      if (!isRecord(carrier)) return undefined;
      if (typeof carrier.type === "string") {
        carrier.type = "__viborm_no_such_variant";
      } else if (isRecord(carrier.arms)) {
        const [first] = Object.keys(carrier.arms);
        if (first === undefined) return undefined;
        carrier.arms.__viborm_no_such_variant = carrier.arms[first];
      } else {
        return undefined;
      }
      row[key] = subject.pin.textCarriers ? JSON.stringify(carrier) : carrier;
      return rows;
    }
    case "aggregate-carrier-missing-key": {
      const key = keyOfKind(subject, ["aggregate", "relationCounts"]);
      if (key === undefined) return undefined;
      const carrier = subject.pin.textCarriers
        ? JSON.parse(String(row[key]))
        : row[key];
      if (!isRecord(carrier)) return undefined;
      const [first] = Object.keys(carrier);
      if (first === undefined) return undefined;
      delete carrier[first];
      row[key] = subject.pin.textCarriers ? JSON.stringify(carrier) : carrier;
      return rows;
    }
    default:
      return undefined;
  }
}

// =============================================================================
// THE CONTAINER POLICY — which row objects come back
// =============================================================================

/**
 * The object graph of one decoded result, as identities relative to the rows it
 * was decoded from: whether the outer array is the input array, which returned
 * row IS its input row, and which nested relation value is the carrier's own
 * object. Values are compared elsewhere; this is the half a value comparison
 * cannot see.
 */
function containerSignature(result: unknown, input: unknown[]): unknown {
  const rowSignature = (
    value: unknown,
    source: unknown
  ): Record<string, unknown> => {
    if (!isRecord(value)) return { row: typeof value };
    const signature: Record<string, unknown> = { sameObject: value === source };
    if (!isRecord(source)) return signature;
    for (const key of Object.keys(value)) {
      const nested = value[key];
      const from = source[key];
      if (Array.isArray(nested)) {
        signature[key] = {
          sameArray: nested === from,
          rows: nested.map((member, index) =>
            Array.isArray(from) ? member === from[index] : false
          ),
        };
        continue;
      }
      if (isRecord(nested) && isRecord(from)) {
        signature[key] = { sameObject: nested === from };
      }
    }
    return signature;
  };

  if (Array.isArray(result)) {
    return {
      outer: result === input,
      rows: result.map((row, index) => rowSignature(row, input[index])),
    };
  }
  if (isRecord(result)) return { single: rowSignature(result, input[0]) };
  return { scalar: typeof result };
}

// =============================================================================
// THE RUN
// =============================================================================

type OutcomeKind = "equal" | "allowed" | "decoding" | "container";

interface Divergence {
  readonly kind: OutcomeKind;
  readonly subject: string;
  readonly detail: string;
}

interface Compared {
  readonly theirValues: string;
  readonly myValues: string;
  readonly theirGraph: string;
  readonly myGraph: string;
}

function compareDecode(
  subject: Case,
  rows: unknown[],
  consumable: boolean
): Compared {
  const { engine, model, operation, args, shape } = subject;
  const theirsInput = clone(rows);
  const mineInput = clone(rows);
  const parser = new ResultParser(engine, model, engine.driver);
  const compiled = consumable
    ? prepareResultRows(parser, operation, shape)
    : undefined;
  const theirs = attempt(() =>
    compiled
      ? parsePreparedResult(
          parser,
          operation,
          theirsInput,
          args,
          shape,
          compiled,
          theirsInput
        )
      : parser.parse(operation, theirsInput, args, shape)
  );
  const mine = attempt(() =>
    decodeRows(
      subject.pattern,
      mineInput,
      {
        adapter: engine.adapter,
        relations: engine.relations,
        driver: engine.driver,
      },
      consumable ? { consumable: true } : {}
    )
  );
  const graphed = theirs.kind === "value" && mine.kind === "value";
  return {
    theirValues: JSON.stringify(theirs, replacer),
    myValues: JSON.stringify(mine, replacer),
    theirGraph: graphed
      ? JSON.stringify(containerSignature(theirs.value, theirsInput))
      : "",
    myGraph: graphed
      ? JSON.stringify(containerSignature(mine.value, mineInput))
      : "",
  };
}

describe("M3 malformed rows and container policy", () => {
  test("every malformed row refuses identically, and the container policy holds", () => {
    const divergences: Divergence[] = [];
    let malformedCells = 0;
    let refusalsSeen = 0;
    // Per mutation: how many cells it produced, and how many of those today's
    // parser refused. A mutation today ACCEPTS is a finding about the
    // boundary's strictness, so it is reported rather than averaged away.
    const byMutation = new Map<Mutation, { cells: number; refused: number }>();
    let containerCells = 0;
    let identityRowsSeen = 0;

    for (const pin of DIALECTS) {
      for (const subject of cases(pin)) {
        for (const mutation of MUTATIONS) {
          const rows = mutate(subject, mutation);
          if (!rows) continue;
          malformedCells++;
          const tally = byMutation.get(mutation) ?? { cells: 0, refused: 0 };
          tally.cells++;
          const compared = compareDecode(subject, rows, false);
          if (compared.theirValues.includes('"kind":"error"')) {
            refusalsSeen++;
            tally.refused++;
          }
          byMutation.set(mutation, tally);
          if (compared.theirValues === compared.myValues) continue;
          divergences.push({
            kind: "decoding",
            subject: `${pin.dialect} ${subject.name} [${mutation}]`,
            detail: `theirs ${compared.theirValues.slice(0, 220)} vs mine ${compared.myValues.slice(0, 220)}`,
          });
        }

        for (const consumable of [false, true]) {
          containerCells++;
          const path = consumable ? "consumable" : "borrowed";
          const compared = compareDecode(subject, subject.rows, consumable);
          if (compared.theirValues !== compared.myValues) {
            divergences.push({
              kind: "decoding",
              subject: `${pin.dialect} ${subject.name} [${path}]`,
              detail: `theirs ${compared.theirValues.slice(0, 220)} vs mine ${compared.myValues.slice(0, 220)}`,
            });
            continue;
          }
          if (compared.theirGraph === "") continue;
          if (compared.theirGraph.includes('"sameObject":true')) {
            identityRowsSeen++;
          }
          if (compared.theirGraph === compared.myGraph) continue;
          divergences.push({
            kind: "container",
            subject: `${pin.dialect} ${subject.name} [${path}]`,
            detail: `theirs ${compared.theirGraph.slice(0, 260)} vs mine ${compared.myGraph.slice(0, 260)}`,
          });
        }
      }
    }

    const counts = new Map<OutcomeKind, number>();
    for (const divergence of divergences) {
      counts.set(divergence.kind, (counts.get(divergence.kind) ?? 0) + 1);
    }
    const firsts = new Map<OutcomeKind, string>();
    for (const divergence of divergences) {
      if (firsts.has(divergence.kind)) continue;
      firsts.set(
        divergence.kind,
        `${divergence.subject}\n    ${divergence.detail}`
      );
    }
    // eslint-disable-next-line no-console
    console.log(
      [
        "M3 malformed rows and container policy",
        `  malformed cells: ${malformedCells} (${refusalsSeen} refused by today's parser)`,
        `  shape/decoding divergences: ${counts.get("decoding") ?? 0}`,
        `  container cells: ${containerCells} (${identityRowsSeen} returned an input row unchanged)`,
        `  container-policy divergences: ${counts.get("container") ?? 0}`,
        `  allowed differences: ${counts.get("allowed") ?? 0}`,
        ...[...byMutation.entries()].map(
          ([mutation, tally]) =>
            `    ${mutation}: ${tally.cells} cells, ${tally.refused} refused, ${tally.cells - tally.refused} accepted`
        ),
        ...[...firsts.entries()].map(([kind, line]) => `  ${kind}: ${line}`),
      ].join("\n")
    );

    expect(malformedCells).toBeGreaterThan(0);
    expect(containerCells).toBeGreaterThan(0);
    // A corpus whose mutations break nothing is not exercising the boundary
    // it claims to, and a container test that never sees a row survive its
    // decode has not reached the identity policy at all.
    expect(refusalsSeen).toBeGreaterThan(0);
    expect(identityRowsSeen).toBeGreaterThan(0);
    if (process.env.PATTERN_M3_STRICT) {
      expect(divergences.filter((d) => d.kind !== "allowed")).toEqual([]);
    }
  }, 600_000);
});
