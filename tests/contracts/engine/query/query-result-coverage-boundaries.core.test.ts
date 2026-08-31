import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { CacheConfigurationError, QueryEngineError } from "@errors";
import { compileCacheResultCodec } from "@query-engine/result/cache-result-codec";
import {
  CacheSnapshotFailure,
  encodeSnapshotNumber,
} from "@query-engine/result/cache-snapshot-structure";
import {
  compileScalarCodec,
  compileWidenedSumCodec,
  recordCodec,
  taggedRelationCodec,
  type ValueCodec,
} from "@query-engine/result/cache-value-codecs";
import { decimalColumnFor } from "@query-engine/result/decimal-result-decode";
import {
  parseResult,
  prepareResultRows,
} from "@query-engine/result/ResultParser";
import { classifyAggregateLeaf } from "@query-engine/result/result-aggregate-leaf";
import { decodeRelationCarrier } from "@query-engine/result/result-parser-contract";
import { parseResultDefault } from "@query-engine/result/result-row-parser";
import { buildExpectedResultShape } from "@query-engine/result/result-shape";
import {
  parseFieldValueDefault,
  parseWidenedSumDefault,
} from "@query-engine/result/scalar-result-parser";
import {
  parseFiniteProviderNumber,
  parseJsonValueWithSchema,
} from "@query-engine/result/scalar-structured-parser";
import { EMPTY_ROW_RESULT_KEY } from "@query-engine/result-aliases";
import { s } from "@schema";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  indexFor,
  parserFor,
  prepareSchema,
} from "@tests/fixtures/query-scope";
import Decimal from "decimal.js";
import { describe, expect, test } from "vitest";

const SPARSE_RESULT_PATTERN = /sparse/i;
const EXPECTED_SHAPE_PATTERN = /expected result shape/i;
const ABSENT_ROW_PARSER_PATTERN = /row parser is absent/i;
const MALFORMED_EMPTY_ROW_PATTERN = /empty-row carrier is malformed/i;
const INCOMPLETE_SHAPE_PATTERN = /incomplete/i;
const UNKNOWN_RESULT_COLUMN_PATTERN = /not part of the active result shape/i;
const COLLIDING_OUTPUT_PATTERN = /colliding output columns/i;

function activeObjects(): WeakSet<object> {
  return new WeakSet<object>();
}

function materialize(codec: ValueCodec, snapshot: unknown): unknown {
  return codec.materialize(snapshot, activeObjects());
}

function snapshot(codec: ValueCodec, value: unknown): unknown {
  return codec.snapshot(value, activeObjects());
}

const resultBoundaryModel = s.model({
  id: s.string().id(),
  exact: s.decimal({ precision: 4, scale: 2 }),
});

const emptyResultBoundaryModel = s
  .model({ id: s.string().id() })
  .omit({ id: true });

const polymorphicArticle = s.model({ id: s.string().id() });
const polymorphicVideo = s.model({ id: s.string().id() });
const polymorphicFeed = s.model({
  id: s.string().id(),
  subject: s
    .toOne({
      article: () => polymorphicArticle,
      video: () => polymorphicVideo,
    })
    .optional(),
  items: s.toMany({
    article: () => polymorphicArticle,
    video: () => polymorphicVideo,
  }),
});

prepareSchema({
  resultBoundaryModel,
  emptyResultBoundaryModel,
  polymorphicArticle,
  polymorphicVideo,
  polymorphicFeed,
});

function shapeFor(
  model: Parameters<typeof buildExpectedResultShape>[0],
  operation: Parameters<typeof buildExpectedResultShape>[1],
  args: Record<string, unknown>
) {
  const shape = buildExpectedResultShape(
    model,
    operation,
    args,
    indexFor(model)
  );
  if (!shape) throw new Error("Expected the read to define a result shape.");
  return shape;
}

describe("result boundary normalization", () => {
  test("decodes safe provider JSON integers and refuses numeric overflow", () => {
    expect(
      parseJsonValueWithSchema(7n, undefined, "postgres", "findMany")
    ).toBe(7);
    expect(parseFiniteProviderNumber("1e999")).toBeUndefined();
  });

  test("contains synchronous Standard Schema failures", () => {
    const schema: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "result-boundary-test",
        validate() {
          throw new Error("private validator detail");
        },
      },
    };

    expect(() =>
      parseJsonValueWithSchema(
        { visible: true },
        schema,
        "postgres",
        "findMany"
      )
    ).toThrow(QueryEngineError);
  });

  test("refuses sparse provider JSON arrays", () => {
    const sparse = new Array<unknown>(2);
    sparse[1] = "present";

    expect(() =>
      parseJsonValueWithSchema(sparse, undefined, "postgres", "findMany")
    ).toThrow(SPARSE_RESULT_PATTERN);
  });

  test("keeps malformed relation text opaque and classifies non-decimal columns", () => {
    expect(decodeRelationCarrier("not-json")).toBe("not-json");
    expect(decimalColumnFor(s.string(), new PostgresAdapter())).toBeUndefined();
    expect(classifyAggregateLeaf("_count", "missing", {})).toEqual({
      kind: "unknown",
    });
  });

  test("refuses a row result when its expected shape or parser program is absent", () => {
    const parser = parserFor(new PostgresAdapter(), resultBoundaryModel);
    const shape = shapeFor(resultBoundaryModel, "findMany", {
      select: { id: true },
    });

    expect(() =>
      parseResultDefault(
        parser,
        "findMany",
        [{ id: "entry-1" }],
        undefined,
        undefined
      )
    ).toThrow(EXPECTED_SHAPE_PATTERN);
    expect(() =>
      parseResultDefault(
        parser,
        "findMany",
        [{ id: "entry-1" }],
        shape,
        undefined
      )
    ).toThrow(ABSENT_ROW_PARSER_PATTERN);
  });

  test("refuses a malformed private empty-row provider carrier", () => {
    const parser = parserFor(new PostgresAdapter(), emptyResultBoundaryModel);

    expect(() =>
      parseResult(parser, "findMany", [{ [EMPTY_ROW_RESULT_KEY]: 0 }], {})
    ).toThrow(MALFORMED_EMPTY_ROW_PATTERN);
  });

  test("captures private row keys while a mixed row takes the scalar fast path", () => {
    const parser = parserFor(new PostgresAdapter(), resultBoundaryModel);
    const [rows, rowKeys] = parser.parseRowsWithRowKeys<
      Array<{ id: string; exact: Decimal }>
    >(
      "findMany",
      [{ id: "entry-1", exact: "1.00" }],
      { select: { id: true, exact: true } },
      ["id"]
    );

    expect(rows[0]?.exact).toBeInstanceOf(Decimal);
    expect(rowKeys).toEqual([{ id: "entry-1" }]);
  });

  test("excludes singular polymorphic slots from relation counts", () => {
    const shape = shapeFor(polymorphicFeed, "findMany", {
      select: {
        id: true,
        _count: { select: { subject: true, items: true } },
      },
    });

    expect([...shape.relationCounts]).toEqual(["items"]);
  });
});

describe("cache result boundaries", () => {
  test("round-trips an empty public row without exposing its private carrier", () => {
    const shape = shapeFor(emptyResultBoundaryModel, "findMany", {});
    const codec = compileCacheResultCodec(
      emptyResultBoundaryModel,
      "findMany",
      "findMany",
      shape
    );

    const stored = codec.snapshot([{}]);

    expect(codec.materialize(stored)).toEqual([{}]);
    expect(stored).toEqual([[]]);
  });

  test("normalizes a non-Error cache boundary failure", () => {
    const shape = shapeFor(resultBoundaryModel, "findMany", {
      select: { id: true },
    });
    const codec = compileCacheResultCodec(
      resultBoundaryModel,
      "findMany",
      "findMany",
      shape
    );
    const hostileRows = new Proxy<unknown[]>([], {
      ownKeys() {
        // biome-ignore lint/style/useThrowOnlyError: verifies non-Error provider failures.
        throw "hostile ownKeys trap";
      },
    });

    let caught: unknown;
    try {
      codec.snapshot(hostileRows);
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof CacheConfigurationError)) {
      throw new Error("Expected the cache snapshot boundary to fail.");
    }
    expect(caught.originalCause).toBeInstanceOf(Error);
  });

  test("round-trips tagged relation fields independent of provider key order", () => {
    const text = compileScalarCodec(s.string());
    const target = recordCodec(new Map<string, ValueCodec>([["name", text]]));
    const tagged = taggedRelationCodec(
      new Map<string, ValueCodec>([["article", target]])
    );
    const value = { data: { name: "first" }, type: "article" };

    expect(materialize(tagged, snapshot(tagged, value))).toEqual(value);
  });

  test("refuses out-of-domain and non-canonical detached decimals", () => {
    const exact = compileScalarCodec(s.decimal({ precision: 4, scale: 2 }));

    expect(() => snapshot(exact, new Decimal("123.45"))).toThrow(
      CacheSnapshotFailure
    );
    expect(() => materialize(exact, "1.0")).toThrow(CacheSnapshotFailure);
  });
});

describe("coverage low value", () => {
  test("refuses corrupted detached relation and record snapshots", () => {
    const text = compileScalarCodec(s.string());
    const target = recordCodec(new Map<string, ValueCodec>([["name", text]]));
    const tagged = taggedRelationCodec(
      new Map<string, ValueCodec>([["post", target]])
    );
    const twoFields = recordCodec(
      new Map<string, ValueCodec>([
        ["first", text],
        ["second", text],
      ])
    );

    expect(() =>
      materialize(tagged, [
        ["data", [["name", "first"]]],
        ["data", [["name", "second"]]],
      ])
    ).toThrow(CacheSnapshotFailure);
    expect(() =>
      materialize(twoFields, [
        ["first", "one"],
        ["first", "two"],
      ])
    ).toThrow(CacheSnapshotFailure);
  });

  test("refuses detached scalar snapshots in another scalar domain", () => {
    const bigint = compileScalarCodec(s.bigInt());
    const date = compileScalarCodec(s.dateTime());
    const vector = compileScalarCodec(s.vector().dimension(2));
    const point = compileScalarCodec(s.point());
    const invalidWidenedSum = compileWidenedSumCodec(s.string());

    expect(() => materialize(bigint, 1)).toThrow(CacheSnapshotFailure);
    expect(() => materialize(date, 1)).toThrow(CacheSnapshotFailure);
    expect(() => vector.snapshot({}, activeObjects())).toThrow(
      CacheSnapshotFailure
    );
    expect(() =>
      materialize(point, [
        ["longitude", encodeSnapshotNumber(181)],
        ["latitude", encodeSnapshotNumber(0)],
      ])
    ).toThrow(CacheSnapshotFailure);
    expect(() => invalidWidenedSum.snapshot("1.00", activeObjects())).toThrow(
      CacheSnapshotFailure
    );
    expect(() => materialize(invalidWidenedSum, "1.00")).toThrow(
      CacheSnapshotFailure
    );
  });

  test("refuses corrupted scalar metadata before returning provider data", () => {
    expect(() =>
      parseFieldValueDefault(
        "value",
        "unsupported",
        false,
        false,
        undefined,
        undefined,
        undefined,
        "postgres",
        "findMany"
      )
    ).toThrow(QueryEngineError);
    expect(() =>
      parseWidenedSumDefault(
        "1.00",
        undefined,
        "decimal",
        "postgres",
        "aggregate"
      )
    ).toThrow(QueryEngineError);
  });

  test("refuses corrupted trusted result-shape columns", () => {
    const unknownColumn = shapeFor(resultBoundaryModel, "findMany", {
      select: { id: true },
    });
    unknownColumn.rawKeys = ["unknown"];

    const unknownAggregate = shapeFor(resultBoundaryModel, "aggregate", {
      _avg: { exact: true },
    });
    const aggregateKey = unknownAggregate.rawKeys[0];
    if (!aggregateKey) throw new Error("Expected an aggregate result column.");
    unknownAggregate.aggregates.set(aggregateKey, {
      fields: new Set(["unknown"]),
    });

    expect(() =>
      compileCacheResultCodec(
        resultBoundaryModel,
        "findMany",
        "findMany",
        unknownColumn
      )
    ).toThrow(INCOMPLETE_SHAPE_PATTERN);
    expect(() =>
      compileCacheResultCodec(
        resultBoundaryModel,
        "aggregate",
        "aggregate",
        unknownAggregate
      )
    ).toThrow(INCOMPLETE_SHAPE_PATTERN);
    expect(() =>
      prepareResultRows(
        parserFor(new PostgresAdapter(), resultBoundaryModel),
        "findMany",
        unknownColumn
      )
    ).toThrow(UNKNOWN_RESULT_COLUMN_PATTERN);
  });

  test("refuses or ignores impossible normalized selection shapes", () => {
    expect(() =>
      shapeFor(polymorphicFeed, "findMany", {
        select: { subject: true },
        include: { subject: true },
      })
    ).toThrow(COLLIDING_OUTPUT_PATTERN);

    const nonRecordCount = shapeFor(polymorphicFeed, "findMany", {
      select: { id: true, _count: { select: true } },
    });
    const unknownCount = shapeFor(polymorphicFeed, "findMany", {
      select: { id: true, _count: { select: { unknown: true } } },
    });
    const emptyAggregate = shapeFor(resultBoundaryModel, "aggregate", {
      _avg: {},
    });

    expect(nonRecordCount.relationCounts.size).toBe(0);
    expect(unknownCount.relationCounts.size).toBe(0);
    expect(emptyAggregate.rawKeys).toEqual([]);
  });
});
