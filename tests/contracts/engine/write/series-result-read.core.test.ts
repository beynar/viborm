import type { DriverResultParser } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { TransactionError } from "@errors";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { StepScope } from "@src/query-engine/write-engine/StepScope";
import {
  buildSeriesResultReads,
  parseSeriesResultReads,
  parseSeriesRowKeys,
  type SeriesResultReadInput,
} from "@src/query-engine/write-engine/series-result-read";
import { sortCapturedRowKeys } from "@src/query-engine/write-engine/target-projection";
import { createSchemaRegistry } from "@validation";
import Decimal from "decimal.js";
import { describe, expect, test } from "vitest";

/** Read one public decimal leaf as the Decimal the result type promises. */
function toDecimalValue(value: unknown): Decimal {
  if (value instanceof Decimal) return value;
  throw new Error(`expected a public Decimal leaf, received ${typeof value}`);
}

const schema = (() => {
  const entry = s
    .model({
      tenantId: s.string(),
      slot: s.string(),
      label: s.string(),
      notes: s.toMany(() => note),
    })
    .id(["tenantId", "slot"])
    .map("series_result_entries");
  const note = s
    .model({
      id: s.string().id(),
      tenantId: s.string(),
      slot: s.string(),
      entry: s
        .toOne(() => entry)
        .fields("tenantId", "slot")
        .references("tenantId", "slot"),
    })
    .map("series_result_notes");
  const bigintEntry = s
    .model({ id: s.bigInt().id(), label: s.string() })
    .map("series_result_bigint_entries");
  const decimalEntry = s
    .model({
      id: s.decimal({ precision: 20, scale: 1 }).id(),
      label: s.string(),
    })
    .map("series_result_decimal_entries");
  return { entry, note, bigintEntry, decimalEntry };
})();

hydrateSchemaNames(schema);

class CapacityDriver extends PGliteDriver {
  override readonly maxBindParametersPerStatement: number | undefined;

  constructor(capacity: number | undefined) {
    super();
    this.maxBindParametersPerStatement = capacity;
  }
}

interface MiddlewareCounts {
  adapterFields: number;
  adapterRelations: number;
  adapterResults: number;
  driverFields: number;
  driverRelations: number;
  driverResults: number;
}

class MiddlewareCountingDriver extends CapacityDriver {
  override readonly result: DriverResultParser;

  constructor(counts: MiddlewareCounts) {
    super(20);
    const adapterResult = this.adapter.result;
    this.adapter.result = {
      ...adapterResult,
      parseResult: (raw, operation, next) => {
        counts.adapterResults += 1;
        return adapterResult.parseResult(raw, operation, next);
      },
      parseField: (value, scalarType, next) => {
        counts.adapterFields += 1;
        return adapterResult.parseField(value, scalarType, next);
      },
      // TWO parameters since D: the declared relation-type argument is gone
      // from both hooks, and from the driver callback below.
      parseRelation: (value, next) => {
        counts.adapterRelations += 1;
        return adapterResult.parseRelation(value, next);
      },
    };
    this.result = {
      parseResult: (raw, operation, next) => {
        counts.driverResults += 1;
        return next(raw, operation);
      },
      parseField: (value, scalarType, next) => {
        counts.driverFields += 1;
        return next(value, scalarType);
      },
      parseRelation: (value, next) => {
        counts.driverRelations += 1;
        return next(value);
      },
    };
  }
}

function engine(capacity: number | undefined): QueryEngine {
  return engineFromDriver(new CapacityDriver(capacity));
}

function engineFromDriver(driver: PGliteDriver): QueryEngine {
  const schemas = createSchemaRegistry(schema);
  return new QueryEngine(driver, createModelRegistry(schema, schemas));
}

function input(
  capacity: number | undefined,
  expectedRowKeys: readonly Readonly<Record<string, unknown>>[],
  select: Readonly<Record<string, unknown>> = { label: true },
  model: Model<any> = schema.entry,
  queryEngine: QueryEngine = engine(capacity)
): SeriesResultReadInput {
  return {
    engine: queryEngine,
    model,
    args: { data: [], select },
    select,
    expectedRowKeys,
    operation: "createManyAndReturn",
    scope: new StepScope(),
    stepLabel: "entry.series.read",
    missingRowMessage: "the exact missing-row failure",
  };
}

function readStatements(reads: ReturnType<typeof buildSeriesResultReads>) {
  return reads.map((read) => {
    const fragment = read.compile({});
    const step = fragment.steps[0];
    if (!step || step.kind !== "read") {
      throw new Error("expected one ordinary grouped read");
    }
    return step.statement;
  });
}

function parseReadResults(
  config: SeriesResultReadInput,
  rawResults: readonly unknown[]
): readonly unknown[] {
  return buildSeriesResultReads(config).map((read, index) =>
    read.parse({ result: rawResults[index] })
  );
}

describe("series result reads", () => {
  test("unknown capacity fails safe to one findUnique per expected key", () => {
    const config = input(undefined, [
      { tenantId: "t1", slot: "s1" },
      { tenantId: "t2", slot: "s2" },
      { tenantId: "t3", slot: "s3" },
    ]);
    const statements = readStatements(buildSeriesResultReads(config));

    expect(statements).toHaveLength(3);
    expect(statements.map((statement) => statement.values)).toEqual([
      ["t1", "s1"],
      ["t2", "s2"],
      ["t3", "s3"],
    ]);
    expect(statements[0]?.toStatement("$n")).not.toContain(" OR ");
  });

  test("known capacity chunks by the compiled statement's actual values", () => {
    const config = input(4, [
      { tenantId: "t1", slot: "s1" },
      { tenantId: "t2", slot: "s2" },
      { tenantId: "t3", slot: "s3" },
    ]);
    const statements = readStatements(buildSeriesResultReads(config));

    expect(statements).toHaveLength(2);
    expect(statements.map((statement) => statement.values)).toEqual([
      ["t1", "s1", "t2", "s2"],
      ["t3", "s3"],
    ]);
    expect(statements[0]?.toStatement("$n")).toContain(" OR ");
    expect(statements.every((statement) => statement.values.length <= 4)).toBe(
      true
    );
  });

  test("a large input keeps exact complete-key chunks at the provider capacity", () => {
    // Chunk-construction calls are intentionally not exposed by the production
    // owner. Pin the observable boundary at a size large enough to exercise many
    // chunks: 2 binds per compound key, 64 complete keys per statement.
    const rowKeys = Array.from({ length: 4097 }, (_, index) => ({
      tenantId: `t${index}`,
      slot: `s${index}`,
    }));
    const statements = readStatements(
      buildSeriesResultReads(input(128, rowKeys))
    );

    expect(statements).toHaveLength(65);
    expect(
      statements
        .slice(0, -1)
        .every((statement) => statement.values.length === 128)
    ).toBe(true);
    expect(statements.at(-1)?.values).toEqual(["t4096", "s4096"]);
    expect(statements.flatMap((statement) => statement.values)).toEqual(
      rowKeys.flatMap(({ tenantId, slot }) => [tenantId, slot])
    );
  });

  test("a single over-budget row keeps the existing one-row behavior", () => {
    const config = input(1, [{ tenantId: "t1", slot: "s1" }]);
    const statements = readStatements(buildSeriesResultReads(config));

    expect(statements).toHaveLength(1);
    expect(statements[0]?.values).toEqual(["t1", "s1"]);
  });

  test("zero expected keys emits no read", () => {
    expect(buildSeriesResultReads(input(4, []))).toEqual([]);
  });

  test("decoded rows replay in member order, including duplicate expected keys", () => {
    const config = input(20, [
      { tenantId: "t1", slot: "s1" },
      { tenantId: "t2", slot: "s2" },
      { tenantId: "t1", slot: "s1" },
    ]);
    const parsed = parseSeriesResultReads(
      config,
      parseReadResults(config, [
        [
          { tenantId: "t2", slot: "s2", label: "second" },
          { tenantId: "t1", slot: "s1", label: "first" },
        ],
      ])
    );

    expect(parsed).toEqual([
      { label: "first" },
      { label: "second" },
      { label: "first" },
    ]);
  });

  test("provider-native bigint captures decode to one canonical sort order", () => {
    const nativeCaptures = [
      [{ id: "10" }, { id: "9" }], // node-postgres / postgres.js
      [{ id: 10 }, { id: 9 }], // PGlite safe integers
      [{ id: 10n }, { id: 9n }], // SQLite native bigint
    ];

    for (const rawRows of nativeCaptures) {
      const decoded = parseSeriesRowKeys(
        engine(20),
        schema.bigintEntry,
        "updateManyAndReturn",
        rawRows
      ).map((row) => ({ ...row }));
      expect(sortCapturedRowKeys(["id"], decoded)).toEqual([
        { id: 9n },
        { id: 10n },
      ]);
    }
  });

  test("public decimals materialize while the row key stays the canonical text", () => {
    // The two values are the SAME double, so a public presentation that went
    // through a JS number could not tell the members apart. The row key never
    // does: it is the codec's canonical private string on both sides of the
    // match, and the public column is a fresh Decimal built only at the leaf.
    const first = "9007199254740992.1";
    const second = "9007199254740992.2";
    expect(Number(first)).toBe(Number(second));

    const select = { id: true, label: true };
    const config = input(
      20,
      [{ id: first }, { id: second }],
      select,
      schema.decimalEntry
    );
    expect(readStatements(buildSeriesResultReads(config))[0]?.values).toEqual([
      first,
      second,
    ]);
    const parsed = parseSeriesResultReads(
      config,
      parseReadResults(config, [
        [
          { id: second, label: "second" },
          { id: first, label: "first" },
        ],
      ])
    );

    expect(parsed).toHaveLength(2);
    const [firstRow, secondRow] = parsed;
    expect(firstRow?.label).toBe("first");
    expect(secondRow?.label).toBe("second");
    expect(firstRow?.id).toBeInstanceOf(Decimal);
    expect(secondRow?.id).toBeInstanceOf(Decimal);
    expect(toDecimalValue(firstRow?.id).eq(first)).toBe(true);
    expect(toDecimalValue(secondRow?.id).eq(second)).toBe(true);
    // Every selected leaf is its OWN instance — never one shared value object.
    expect(firstRow?.id).not.toBe(secondRow?.id);
  });

  test("two spellings of one decimal row key resolve to the same member", () => {
    // The expected key carries the canonical private string and the provider
    // row the scale-padded native text a `NUMERIC(20,1)` column answers with.
    // The padding is not part of the identity — the codec reduces both to one
    // key — so the member matches, and "10" never collides with "9".
    const select = { id: true, label: true };
    const config = input(
      20,
      [{ id: "10" }, { id: "9" }],
      select,
      schema.decimalEntry
    );
    const parsed = parseSeriesResultReads(
      config,
      parseReadResults(config, [
        [
          { id: "9.0", label: "nine" },
          { id: "10.0", label: "ten" },
        ],
      ])
    );

    expect(parsed.map((row) => row.label)).toEqual(["ten", "nine"]);
  });

  test("a decimal row key sorts by its canonical text, deterministically", () => {
    // Canonical text is the row key's ONE representation, so the order is the
    // comparator's string rank — total and stable, and deliberately not the
    // numeric order the database would produce.
    const decoded = parseSeriesRowKeys(
      engine(20),
      schema.decimalEntry,
      "updateManyAndReturn",
      [{ id: "9.0" }, { id: "10.0" }]
    ).map((row) => ({ ...row }));

    expect(decoded).toEqual([{ id: "9" }, { id: "10" }]);
    expect(sortCapturedRowKeys(["id"], decoded)).toEqual([
      { id: "10" },
      { id: "9" },
    ]);
  });

  test("a publicly selected row-key field is preserved", () => {
    const select = { tenantId: true, label: true };
    const config = input(20, [{ tenantId: "t1", slot: "s1" }], select);
    const parsed = parseSeriesResultReads(
      config,
      parseReadResults(config, [
        [{ tenantId: "t1", slot: "s1", label: "kept" }],
      ])
    );

    expect(parsed).toEqual([{ tenantId: "t1", label: "kept" }]);
  });

  test("a missing expected key raises the caller's exact failure", () => {
    const config = input(20, [{ tenantId: "t1", slot: "s1" }]);
    let thrown: unknown;
    try {
      parseReadResults(config, [[]]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TransactionError);
    expect(thrown).toMatchObject({
      message: "the exact missing-row failure",
      meta: { model: "entry", operation: "createMany" },
    });
  });

  test("a grouped read crosses each result, field, and relation middleware once", () => {
    const counts: MiddlewareCounts = {
      adapterFields: 0,
      adapterRelations: 0,
      adapterResults: 0,
      driverFields: 0,
      driverRelations: 0,
      driverResults: 0,
    };
    const queryEngine = engineFromDriver(new MiddlewareCountingDriver(counts));
    const config = input(
      20,
      [
        { tenantId: "t1", slot: "s1" },
        { tenantId: "t2", slot: "s2" },
      ],
      { label: true, notes: { select: { id: true } } },
      schema.entry,
      queryEngine
    );
    const results = parseReadResults(config, [
      [
        {
          tenantId: "t2",
          slot: "s2",
          label: "second",
          notes: [{ id: "n2" }],
        },
        {
          tenantId: "t1",
          slot: "s1",
          label: "first",
          notes: [{ id: "n1" }],
        },
      ],
    ]);

    expect(parseSeriesResultReads(config, results)).toEqual([
      { label: "first", notes: [{ id: "n1" }] },
      { label: "second", notes: [{ id: "n2" }] },
    ]);
    expect(counts).toEqual({
      adapterFields: 8,
      adapterRelations: 2,
      adapterResults: 1,
      driverFields: 8,
      driverRelations: 2,
      driverResults: 1,
    });
  });

  test("a missing first chunk fails before the next provider read is observed", () => {
    const config = input(2, [
      { tenantId: "t1", slot: "s1" },
      { tenantId: "t2", slot: "s2" },
    ]);
    const reads = buildSeriesResultReads(config);
    let secondReadObserved = false;
    let thrown: unknown;
    try {
      const results: unknown[] = [];
      results.push(reads[0]?.parse({ result: [] }));
      secondReadObserved = true;
      throw new Error("later provider failure");
    } catch (error) {
      thrown = error;
    }

    expect(secondReadObserved).toBe(false);
    expect(thrown).toBeInstanceOf(TransactionError);
    expect(thrown).toMatchObject({
      message: "the exact missing-row failure",
      meta: { model: "entry", operation: "createMany" },
    });
  });
});
