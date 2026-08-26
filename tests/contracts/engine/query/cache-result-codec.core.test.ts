import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { D1Driver } from "@drivers/d1";
import { CacheConfigurationError } from "@errors";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import {
  type CacheResultCodec,
  compileCacheResultCodec,
} from "@query-engine/result/cache-result-codec";
import { parseResult } from "@query-engine/result/ResultParser";
import { buildExpectedResultShape } from "@query-engine/result/result-shape";
import type { Operation } from "@query-engine/types";
import { ReadOperation } from "@query-engine/write-engine/ReadOperation";
import { s } from "@schema";
import type { Model } from "@schema/model";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  indexFor,
  parserFor,
  prepareSchema,
} from "@tests/fixtures/query-scope";
import type { JsonValue } from "@validation";
import { createSchemaRegistry } from "@validation";
import { validateJson } from "@validation/primitives/json";
import { isRecord } from "@validation/value-guards";
import { describe, expect, test } from "vitest";

let jsonValidationCalls = 0;
const countingJsonSchema: StandardSchemaV1<JsonValue, JsonValue> = {
  "~standard": {
    version: 1,
    vendor: "cache-result-codec-test",
    validate: (value) => {
      jsonValidationCalls += 1;
      return validateJson(value);
    },
  },
};

const scalarModel = s.model({
  id: s.string().id(),
  text: s.string(),
  nullableText: s.string().nullable(),
  integer: s.int(),
  float: s.float(),
  decimal: s.decimal(),
  large: s.bigInt(),
  flag: s.boolean(),
  happenedAt: s.dateTime(),
  bornOn: s.date(),
  wakeAt: s.time(),
  status: s.enum(["open", "closed"]),
  texts: s.string().array(),
  integers: s.int().array(),
  jsonValue: s.json(),
  vector: s.vector().dimension(3),
  bytes: s.blob(),
  point: s.point(),
  customJson: s.json().schema(countingJsonSchema),
});

const author = s.model({
  id: s.string().id(),
  posts: s.toMany(() => post),
});
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string().nullable(),
  author: s
    .toOne(() => author)
    .fields("authorId")
    .references("id"),
});
const video = s.model({ id: s.string().id(), duration: s.int() });
const feed = s.model({
  id: s.string().id(),
  subject: s
    .toOne(
      { post: () => post, video: () => video },
      {
        values: {
          post: "codec.subject.post.v1",
          video: "codec.subject.video.v1",
        },
      }
    )
    .optional(),
  items: s.toMany(
    { post: () => post, video: () => video },
    {
      values: {
        post: "codec.items.post.v1",
        video: "codec.items.video.v1",
      },
    }
  ),
});

const models = { scalarModel, author, post, video, feed };
prepareSchema(models);

function codecFor(
  model: Model<any>,
  operation: Operation,
  args: Record<string, unknown>,
  requestedOperation: string = operation,
  decimalDecode: "string" | "number" = "string"
): CacheResultCodec {
  const shape = buildExpectedResultShape(
    model,
    operation,
    args,
    indexFor(model)
  );
  if (!shape) throw new Error("The test read has no expected result shape.");
  return compileCacheResultCodec(
    model,
    operation,
    requestedOperation,
    shape,
    decimalDecode
  );
}

function portableSnapshot(snapshot: unknown): unknown {
  return JSON.parse(JSON.stringify(snapshot));
}

function expectBoundary(
  run: () => unknown,
  method: "snapshot" | "materialize"
): CacheConfigurationError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof CacheConfigurationError)) {
    throw new Error(`Expected a CacheConfigurationError from ${method}.`);
  }
  if (caught.meta.method !== method) {
    throw new Error(`Expected cache method ${method}.`);
  }
  return caught;
}

function requireRows(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected a row array.");
  return value;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected a result record.");
  return value;
}

describe("compiled detached cache result codec", () => {
  test("lets ReadOperation reuse one exact shape and one lazily compiled codec", () => {
    const engine = new QueryEngine(
      new D1Driver({ database: Object.create(null) }),
      createModelRegistry(models, createSchemaRegistry(models))
    );
    const operation = new ReadOperation(engine, scalarModel, "findMany", {
      select: { id: true },
    });

    expect(operation.createExpectedResultShape()).toBe(
      operation.createExpectedResultShape()
    );
    expect(operation.createCacheResultCodec()).toBe(
      operation.createCacheResultCodec()
    );
  });

  test("round-trips every scalar through memory and JSON transport with fresh graphs", () => {
    const jsonValue: Record<string, unknown> = {
      type: ["number", "-0"],
      negativeZero: -0,
      nested: [{ flag: true }],
    };
    Object.defineProperty(jsonValue, "__proto__", {
      configurable: true,
      enumerable: true,
      value: { safe: "data" },
      writable: true,
    });
    const row = {
      float: -0,
      id: "scalar-1",
      text: "Albert",
      nullableText: null,
      integer: -42,
      decimal: "1234567890.000000000000000001",
      large: 9_007_199_254_740_993n,
      flag: true,
      happenedAt: new Date("2026-08-25T10:11:12.345Z"),
      bornOn: new Date("2024-02-29T00:00:00.000Z"),
      wakeAt: "07:08:09.12",
      status: "open",
      texts: ["a", "b"],
      integers: [1, -2],
      jsonValue,
      vector: [1, -0, 3.5],
      bytes: new Uint8Array([0, 128, 255]),
      point: { x: -0, y: 2.5 },
      customJson: { accepted: true },
    };
    const order = Object.keys(row);
    const codec = codecFor(scalarModel, "findMany", {});
    const snapshot = codec.snapshot([row]);

    row.text = "mutated after snapshot";
    row.bytes[0] = 99;
    jsonValue.negativeZero = 1;

    const memory = codec.materialize(snapshot);
    const kv = codec.materialize(portableSnapshot(snapshot));
    const second = codec.materialize(portableSnapshot(snapshot));
    expect(memory).toEqual(kv);
    expect(kv).toEqual(second);

    const kvRow = requireRecord(requireRows(kv)[0]);
    const secondRow = requireRecord(requireRows(second)[0]);
    expect(Object.keys(kvRow)).toEqual(order);
    expect(Object.getPrototypeOf(kvRow)).toBe(Object.prototype);
    expect(kvRow.text).toBe("Albert");
    expect(Object.is(kvRow.float, -0)).toBe(true);
    expect(kvRow.large).toBe(9_007_199_254_740_993n);
    expect(kvRow.happenedAt).toEqual(new Date("2026-08-25T10:11:12.345Z"));
    expect(kvRow.bytes).toEqual(new Uint8Array([0, 128, 255]));
    expect(kvRow.bytes).not.toBe(row.bytes);
    expect(kvRow.bytes).not.toBe(secondRow.bytes);
    expect(kvRow.jsonValue).not.toBe(jsonValue);
    expect(kvRow.jsonValue).not.toBe(secondRow.jsonValue);

    const materializedJson = requireRecord(kvRow.jsonValue);
    expect(Object.is(materializedJson.negativeZero, -0)).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(materializedJson, "__proto__")
    ).toMatchObject({
      configurable: true,
      enumerable: true,
      value: { safe: "data" },
      writable: true,
    });
    expect(Object.getPrototypeOf(materializedJson)).toBe(Object.prototype);
  });

  test("uses the requested decimal presentation without losing number edge cases", () => {
    const codec = codecFor(
      scalarModel,
      "findMany",
      { select: { decimal: true, float: true } },
      "findMany",
      "number"
    );
    const materialized = codec.materialize(
      portableSnapshot(codec.snapshot([{ decimal: -0, float: 1.5 }]))
    );
    const row = requireRecord(requireRows(materialized)[0]);
    expect(Object.is(row.decimal, -0)).toBe(true);
    expect(row.float).toBe(1.5);
  });

  test("round-trips ordinary and tagged singular/collection relations", () => {
    const ordinary = codecFor(author, "findMany", {
      include: { posts: { include: { author: true } } },
    });
    const ordinaryValue = [
      {
        id: "author-1",
        posts: [
          {
            id: "post-1",
            title: "First",
            authorId: null,
            author: null,
          },
        ],
      },
    ];
    expect(
      ordinary.materialize(portableSnapshot(ordinary.snapshot(ordinaryValue)))
    ).toEqual(ordinaryValue);

    const relationCount = codecFor(author, "findMany", {
      select: { id: true, _count: { select: { posts: true } } },
    });
    expect(
      relationCount.materialize(
        portableSnapshot(
          relationCount.snapshot([{ _count: { posts: 2 }, id: "author-1" }])
        )
      )
    ).toEqual([{ _count: { posts: 2 }, id: "author-1" }]);

    const projection = {
      select: {
        id: true,
        subject: {
          post: { select: { id: true, title: true } },
          video: { select: { id: true, duration: true } },
        },
        items: {
          variants: {
            post: { select: { id: true, title: true } },
            video: { select: { id: true, duration: true } },
          },
        },
      },
    };
    const tagged = codecFor(feed, "findMany", projection);
    const taggedValue = [
      {
        id: "feed-1",
        subject: {
          type: "post",
          data: { id: "post-1", title: "First" },
        },
        items: [
          {
            type: "video",
            data: { id: "video-1", duration: 42 },
          },
          {
            type: "post",
            data: { id: "post-2", title: "Second" },
          },
        ],
      },
      { id: "feed-2", subject: null, items: [] },
    ];
    const first = tagged.materialize(
      portableSnapshot(tagged.snapshot(taggedValue))
    );
    const second = tagged.materialize(
      portableSnapshot(tagged.snapshot(taggedValue))
    );
    expect(first).toEqual(taggedValue);
    expect(first).not.toBe(second);
    expect(requireRows(first)[0]).not.toBe(requireRows(second)[0]);
  });

  test("excludes hidden collection variants while singular carriers retain every arm", () => {
    const collection = codecFor(feed, "findMany", {
      select: {
        id: true,
        items: {
          only: ["post"],
          variants: {
            post: { select: { id: true, title: true } },
            video: { select: { id: true, duration: true } },
          },
        },
      },
    });
    const visibleValue = [
      {
        id: "feed-1",
        items: [{ type: "post", data: { id: "post-1", title: "Visible" } }],
      },
    ];
    const snapshot = portableSnapshot(collection.snapshot(visibleValue));
    expect(collection.materialize(snapshot)).toEqual(visibleValue);
    expectBoundary(
      () =>
        collection.snapshot([
          {
            id: "feed-1",
            items: [
              {
                type: "video",
                data: { id: "video-1", duration: 42 },
              },
            ],
          },
        ]),
      "snapshot"
    );

    const rowEntries = requireRows(requireRows(snapshot)[0]);
    const itemsPair = rowEntries.find(
      (entry) => requireRows(entry)[0] === "items"
    );
    if (!itemsPair) throw new Error("Expected the encoded items field.");
    const encodedItems = requireRows(requireRows(itemsPair)[1]);
    const taggedEntries = requireRows(encodedItems[0]);
    const typePair = taggedEntries.find(
      (entry) => requireRows(entry)[0] === "type"
    );
    if (!typePair) throw new Error("Expected the encoded variant type.");
    requireRows(typePair)[1] = "video";
    expectBoundary(() => collection.materialize(snapshot), "materialize");

    const singular = codecFor(feed, "findMany", {
      select: {
        id: true,
        subject: {
          post: { select: { id: true, title: true } },
          video: { select: { id: true, duration: true } },
        },
      },
    });
    const singularVideo = [
      {
        id: "feed-2",
        subject: {
          type: "video",
          data: { id: "video-2", duration: 12 },
        },
      },
    ];
    expect(
      singular.materialize(portableSnapshot(singular.snapshot(singularVideo)))
    ).toEqual(singularVideo);
  });

  test("owns every read top-level cardinality and aggregate leaf family", () => {
    const nullable = codecFor(
      scalarModel,
      "findUnique",
      { select: { id: true } },
      "findUnique"
    );
    expect(
      nullable.materialize(portableSnapshot(nullable.snapshot(null)))
    ).toBeNull();

    const required = codecFor(
      scalarModel,
      "findUnique",
      { select: { id: true } },
      "findUniqueOrThrow"
    );
    expectBoundary(() => required.snapshot(null), "snapshot");
    expectBoundary(() => required.materialize(null), "materialize");

    const count = codecFor(scalarModel, "count", {});
    expect(count.materialize(portableSnapshot(count.snapshot(7)))).toBe(7);
    const selectedCount = codecFor(scalarModel, "count", {
      select: { text: true, _all: true },
    });
    expect(
      selectedCount.materialize(
        portableSnapshot(selectedCount.snapshot({ _all: 4, text: 3 }))
      )
    ).toEqual({ _all: 4, text: 3 });

    const existence = codecFor(scalarModel, "exist", {});
    expect(
      existence.materialize(portableSnapshot(existence.snapshot(false)))
    ).toBe(false);

    const distance = codecFor(scalarModel, "findMany", {
      select: { vector: { _distance: { from: [1, 2, 3] } } },
    });
    const distanceResult = distance.materialize(
      portableSnapshot(distance.snapshot([{ _distance: -0 }]))
    );
    expect(
      Object.is(requireRecord(requireRows(distanceResult)[0])._distance, -0)
    ).toBe(true);

    const aggregate = codecFor(scalarModel, "aggregate", {
      _count: { _all: true },
      _avg: { float: true, decimal: true },
      _sum: { large: true, decimal: true },
      _min: { happenedAt: true },
    });
    const aggregateValue = {
      _min: { happenedAt: new Date("2026-01-01T00:00:00.000Z") },
      _sum: { large: 9_007_199_254_740_993n, decimal: "3.5" },
      _avg: { float: -0, decimal: "1.75" },
      _count: { _all: 2 },
    };
    const aggregateResult = aggregate.materialize(
      portableSnapshot(aggregate.snapshot(aggregateValue))
    );
    expect(aggregateResult).toEqual(aggregateValue);
    const aggregateRow = requireRecord(aggregateResult);
    expect(Object.is(requireRecord(aggregateRow._avg).float, -0)).toBe(true);

    const grouped = codecFor(scalarModel, "groupBy", {
      by: "status",
      _count: true,
    });
    expect(
      grouped.materialize(
        portableSnapshot(grouped.snapshot([{ _count: 2, status: "open" }]))
      )
    ).toEqual([{ _count: 2, status: "open" }]);
  });

  test("does not rerun a custom JSON result schema during snapshot or materialization", () => {
    jsonValidationCalls = 0;
    const parsed = parseResult(
      parserFor(new PostgresAdapter(), scalarModel),
      "findMany",
      [{ customJson: { allowed: true } }],
      { select: { customJson: true } }
    );
    expect(jsonValidationCalls).toBe(1);

    const codec = codecFor(scalarModel, "findMany", {
      select: { customJson: true },
    });
    const snapshot = codec.snapshot(parsed);
    codec.materialize(snapshot);
    codec.materialize(portableSnapshot(snapshot));
    expect(jsonValidationCalls).toBe(1);
  });

  test("rejects hostile or non-canonical application result graphs without invoking accessors", () => {
    const codec = codecFor(scalarModel, "findMany", {
      select: { id: true, text: true },
    });
    let getterCalls = 0;
    const accessor = { id: "one" };
    Object.defineProperty(accessor, "text", {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "hidden";
      },
    });

    const inherited = Object.create({ inherited: true });
    Object.defineProperty(inherited, "id", {
      configurable: true,
      enumerable: true,
      value: "one",
      writable: true,
    });
    Object.defineProperty(inherited, "text", {
      configurable: true,
      enumerable: true,
      value: "text",
      writable: true,
    });
    const symbol = { id: "one", text: "text" };
    Object.defineProperty(symbol, Symbol("private"), {
      enumerable: true,
      value: true,
    });
    const nonEnumerable = { id: "one" };
    Object.defineProperty(nonEnumerable, "text", {
      configurable: true,
      enumerable: false,
      value: "text",
      writable: true,
    });
    const sparse = new Array<unknown>(1);
    const cyclicJson: Record<string, unknown> = {};
    cyclicJson.self = cyclicJson;
    const jsonCodec = codecFor(scalarModel, "findMany", {
      select: { jsonValue: true },
    });

    for (const value of [
      [accessor],
      [inherited],
      [symbol],
      [nonEnumerable],
      sparse,
      [{ id: "one", text: "text", extra: true }],
      [{ id: "one" }],
      [{ id: "one", text: () => "callable" }],
    ]) {
      expectBoundary(() => codec.snapshot(value), "snapshot");
    }
    expectBoundary(
      () => jsonCodec.snapshot([{ jsonValue: cyclicJson }]),
      "snapshot"
    );
    expect(getterCalls).toBe(0);
  });

  test("preserves a sanitized boundary cause without disclosing hostile values", () => {
    const codec = codecFor(scalarModel, "findMany", {
      select: { id: true },
    });
    const secret = "cache-codec-secret-canary";
    const hostileResult = new Proxy(
      { id: "one" },
      {
        getPrototypeOf() {
          throw new Error(secret);
        },
      }
    );
    const snapshotError = expectBoundary(
      () => codec.snapshot([hostileResult]),
      "snapshot"
    );
    expect(snapshotError.originalCause).toBeInstanceOf(Error);
    expect(snapshotError.message).not.toContain(secret);
    expect(snapshotError.originalCause?.message).not.toContain(secret);

    const hostileSnapshot = new Proxy([], {
      getPrototypeOf() {
        throw new Error(secret);
      },
    });
    const materializeError = expectBoundary(
      () => codec.materialize(hostileSnapshot),
      "materialize"
    );
    expect(materializeError.originalCause).toBeInstanceOf(Error);
    expect(materializeError.message).not.toContain(secret);
    expect(materializeError.originalCause?.message).not.toContain(secret);
  });

  test("rejects malformed and cyclic snapshots at the cache materialization boundary", () => {
    const codec = codecFor(scalarModel, "findMany", {
      select: { id: true, integer: true },
    });
    const good = codec.snapshot([{ id: "one", integer: 1 }]);

    const extra = portableSnapshot(good);
    const extraRows = requireRows(extra);
    requireRows(extraRows[0]).push(["extra", "value"]);

    const missing = portableSnapshot(good);
    requireRows(requireRows(missing)[0]).pop();

    const duplicate = portableSnapshot(good);
    const duplicateEntries = requireRows(requireRows(duplicate)[0]);
    duplicateEntries[1] = ["id", "two"];

    const wrongNumber = portableSnapshot(good);
    const wrongNumberEntries = requireRows(requireRows(wrongNumber)[0]);
    const encodedInteger = requireRows(wrongNumberEntries[1]);
    encodedInteger[1] = "01";

    const sparse = new Array<unknown>(1);
    const cycle: unknown[] = [];
    cycle.push(cycle);
    const accessor = portableSnapshot(good);
    Object.defineProperty(requireRows(accessor), "0", {
      configurable: true,
      enumerable: true,
      get: () => requireRows(good)[0],
    });

    for (const snapshot of [
      extra,
      missing,
      duplicate,
      wrongNumber,
      sparse,
      cycle,
      accessor,
    ]) {
      expectBoundary(() => codec.materialize(snapshot), "materialize");
    }
  });
});
