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
import Decimal from "decimal.js";
import { describe, expect, test } from "vitest";

const INCOMPLETE_CODEC_PATTERN = /incomplete/i;

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
  ratio: s.number(),
  decimal: s.decimal({ precision: 40, scale: 30 }),
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
const pointDistanceModel = s.model({
  id: s.string().id(),
  location: s.point(),
  optionalLocation: s.point().nullable(),
});

const pointTrip = s.model({
  id: s.string().id(),
  stops: s.toMany(() => pointStop),
});
const pointStop = s.model({
  id: s.string().id(),
  tripId: s.string(),
  location: s.point(),
  optionalLocation: s.point().nullable(),
  trip: s
    .toOne(() => pointTrip)
    .fields("tripId")
    .references("id"),
});
const pointArticle = s.model({
  id: s.string().id(),
  location: s.point(),
  markers: s.toMany(() => pointMarker).name("cacheDistanceTarget"),
});
const pointVideo = s.model({
  id: s.string().id(),
  location: s.point(),
  markers: s.toMany(() => pointMarker).name("cacheDistanceTarget"),
});
const pointMarker = s.model({
  id: s.string().id(),
  target: s
    .toOne({ article: () => pointArticle, video: () => pointVideo })
    .name("cacheDistanceTarget"),
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

const models = {
  scalarModel,
  pointDistanceModel,
  pointArticle,
  pointMarker,
  pointStop,
  pointTrip,
  pointVideo,
  author,
  post,
  video,
  feed,
};
prepareSchema(models);

function codecFor(
  model: Model<any>,
  operation: Operation,
  args: Record<string, unknown>,
  requestedOperation: string = operation
): CacheResultCodec {
  const shape = buildExpectedResultShape(
    model,
    operation,
    args,
    indexFor(model)
  );
  if (!shape) throw new Error("The test read has no expected result shape.");
  return compileCacheResultCodec(model, operation, requestedOperation, shape);
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

function requireDecimal(value: unknown): Decimal {
  if (value instanceof Decimal) return value;
  throw new Error(`Expected a Decimal, received ${typeof value}.`);
}

/**
 * How many Decimals `run` CONSTRUCTS through the one exported constructor.
 *
 * A constructed value receives its coefficient by ordinary assignment, so one
 * accessor on the captured Decimal prototype observes each construction. The
 * setter installs the ordinary own property it replaced, so the counted
 * instance is byte-identical to an uncounted one.
 */
function countDecimalConstructions(run: () => void): number {
  let count = 0;
  const previous = Object.getOwnPropertyDescriptor(Decimal.prototype, "d");
  Object.defineProperty(Decimal.prototype, "d", {
    configurable: true,
    set(this: object, value: unknown) {
      count += 1;
      Object.defineProperty(this, "d", {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    },
  });
  try {
    run();
  } finally {
    if (previous) Object.defineProperty(Decimal.prototype, "d", previous);
    else Reflect.deleteProperty(Decimal.prototype, "d");
  }
  return count;
}

/** Overwrite one stored aggregate leaf, as a hostile store would hold it. */
function setAggregateLeaf(snapshot: unknown, name: string, value: unknown) {
  for (const entry of requireRows(snapshot)) {
    const pair = requireRows(entry);
    if (pair[0] !== name) continue;
    requireRows(requireRows(pair[1])[0])[1] = value;
    return;
  }
  throw new Error(`Expected the encoded ${name} aggregate.`);
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
      ratio: -0,
      id: "scalar-1",
      text: "Albert",
      nullableText: null,
      integer: -42,
      decimal: new Decimal("1234567890.000000000000000001"),
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
      point: { longitude: -180, latitude: -0 },
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
    expect(Object.is(kvRow.ratio, -0)).toBe(true);
    expect(kvRow.large).toBe(9_007_199_254_740_993n);
    expect(kvRow.happenedAt).toEqual(new Date("2026-08-25T10:11:12.345Z"));
    expect(kvRow.bytes).toEqual(new Uint8Array([0, 128, 255]));
    expect(kvRow.bytes).not.toBe(row.bytes);
    expect(kvRow.bytes).not.toBe(secondRow.bytes);
    expect(kvRow.point).toEqual({ longitude: 180, latitude: 0 });
    expect(kvRow.point).not.toBe(row.point);
    expect(kvRow.point).not.toBe(secondRow.point);
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

  test("stores a decimal as canonical text and rebuilds a fresh value per hit", () => {
    const codec = codecFor(scalarModel, "findMany", {
      select: { decimal: true, ratio: true },
    });
    const parsed = [{ decimal: new Decimal("1.20"), ratio: 1.5 }];
    const snapshot = portableSnapshot(codec.snapshot(parsed));

    // What crosses the KV boundary is TEXT. A `Decimal` reaching a snapshot
    // would survive in the memory backend by reference and arrive from KV as
    // `{"s":1,"e":0,"d":[12]}`, which nothing can materialize.
    expect(JSON.stringify(snapshot)).toContain('"1.2"');
    expect(JSON.stringify(snapshot)).not.toContain('"d"');

    const first = requireRecord(requireRows(codec.materialize(snapshot))[0]);
    const second = requireRecord(requireRows(codec.materialize(snapshot))[0]);
    const firstDecimal = requireDecimal(first.decimal);
    const secondDecimal = requireDecimal(second.decimal);
    expect(firstDecimal.eq("1.2")).toBe(true);
    expect(firstDecimal.eq(secondDecimal)).toBe(true);
    expect(firstDecimal).not.toBe(secondDecimal);
    expect(first.ratio).toBe(1.5);
  });

  test("snapshots from trusted internals, not mutable Decimal renderers", () => {
    const codec = codecFor(scalarModel, "findMany", {
      select: { decimal: true },
    });
    const toFixedDescriptor = Object.getOwnPropertyDescriptor(
      Decimal.prototype,
      "toFixed"
    );
    const isNegDescriptor = Object.getOwnPropertyDescriptor(
      Decimal.prototype,
      "isNeg"
    );
    const isZeroDescriptor = Object.getOwnPropertyDescriptor(
      Decimal.prototype,
      "isZero"
    );
    try {
      Decimal.prototype.toFixed = () => "2";
      Decimal.prototype.isNeg = () => true;
      Decimal.prototype.isZero = () => false;
      const snapshot = portableSnapshot(
        codec.snapshot([{ decimal: new Decimal("1.20") }])
      );
      expect(JSON.stringify(snapshot)).toContain('"1.2"');
      expect(JSON.stringify(snapshot)).not.toContain('"2"');
    } finally {
      if (toFixedDescriptor) {
        Object.defineProperty(Decimal.prototype, "toFixed", toFixedDescriptor);
      }
      if (isNegDescriptor) {
        Object.defineProperty(Decimal.prototype, "isNeg", isNegDescriptor);
      }
      if (isZeroDescriptor) {
        Object.defineProperty(Decimal.prototype, "isZero", isZeroDescriptor);
      }
    }
  });

  test("a caller who mutates a materialized decimal cannot poison the next hit", () => {
    const codec = codecFor(scalarModel, "findMany", {
      select: { decimal: true },
    });
    const snapshot = portableSnapshot(
      codec.snapshot([{ decimal: new Decimal("7.5") }])
    );
    const hit = requireRecord(requireRows(codec.materialize(snapshot))[0]);
    // decimal.js values are conventionally immutable, not frozen: a caller can
    // still write the internals of the instance it was handed. The next hit
    // reads the stored TEXT, so nothing it did survives.
    Object.assign(requireDecimal(hit.decimal), { d: [9], e: 0 });

    const next = requireRecord(requireRows(codec.materialize(snapshot))[0]);
    expect(requireDecimal(next.decimal).eq("7.5")).toBe(true);
  });

  test("refuses a snapshot value that is not the canonical text it wrote", () => {
    const codec = codecFor(scalarModel, "findMany", {
      select: { decimal: true },
    });
    // A parsed result carries the value object; a string, a number and a
    // decimal-shaped document are all incoherent results, not values to accept.
    for (const value of [
      "1.2",
      1.2,
      { s: 1, e: 0, d: [12] },
      { toStringTag: "[object Decimal]", s: 1, e: 0, d: [12] },
    ]) {
      expectBoundary(() => codec.snapshot([{ decimal: value }]), "snapshot");
    }

    const good = portableSnapshot(
      codec.snapshot([{ decimal: new Decimal("1.2") }])
    );
    for (const stored of ["1.20", "+1.2", 1.2, { s: 1, e: 0, d: [12] }]) {
      const corrupt = portableSnapshot(good);
      const entry = requireRows(requireRows(requireRows(corrupt)[0])[0]);
      entry[1] = stored;
      expectBoundary(() => codec.materialize(corrupt), "materialize");
    }
  });

  test("a value outside the field's domain is refused on the way IN", () => {
    // The WRITE direction is held to the same domain as the read, and that is
    // what keeps an incoherent result from becoming a poison pill: a snapshot
    // that only checked the Decimal family would store the value happily and
    // then throw on every hit for the rest of the entry's TTL, blaming the
    // store for what the parsed result carried.
    const purse = s.model({
      id: s.string().id(),
      amount: s.decimal({ precision: 10, scale: 2 }),
    });
    prepareSchema({ purse });
    const codec = codecFor(purse, "findMany", { select: { amount: true } });

    // Excess scale, and excess precision — both are genuine finite Decimals.
    expectBoundary(
      () => codec.snapshot([{ amount: new Decimal("1.0000002") }]),
      "snapshot"
    );
    expectBoundary(
      () => codec.snapshot([{ amount: new Decimal("12345678901.00") }]),
      "snapshot"
    );
    // Falsification: the in-domain neighbour still stores and reads back.
    const stored = portableSnapshot(
      codec.snapshot([{ amount: new Decimal("1.02") }])
    );
    expect(
      requireDecimal(
        requireRecord(requireRows(codec.materialize(stored))[0]).amount
      ).eq("1.02")
    ).toBe(true);

    // The widened SUM leaf keeps the field's scale on the way in as well; it is
    // the PRECISION it is deliberately not held to.
    const sum = codecFor(purse, "aggregate", { _sum: { amount: true } });
    expectBoundary(
      () => sum.snapshot({ _sum: { amount: new Decimal("1.002") } }),
      "snapshot"
    );
    const wide = sum.snapshot({
      _sum: { amount: new Decimal("999999999999.99") },
    });
    expect(
      requireDecimal(
        requireRecord(
          requireRecord(sum.materialize(portableSnapshot(wide)))._sum
        ).amount
      ).eq("999999999999.99")
    ).toBe(true);
  });

  test("a snapshot renders the engine's own decimal without constructing another", () => {
    // Plan §8/§10: ONE Decimal construction per selected decimal leaf, end to
    // end. The value reaching `snapshot` is the instance the result parser just
    // built. The shared snapshot renderer reads it directly without a second
    // construction on the cache-write path.
    const wallet = s.model({
      id: s.string().id(),
      amount: s.decimal({ precision: 10, scale: 2 }),
      fee: s.decimal({ precision: 10, scale: 2 }).nullable(),
    });
    prepareSchema({ wallet });
    const parser = parserFor(new PostgresAdapter(), wallet);
    const codec = codecFor(wallet, "findMany", {
      select: { amount: true, fee: true },
    });

    let rows: unknown;
    const parsed = countDecimalConstructions(() => {
      rows = parser.parse<unknown>(
        "findMany",
        [
          { amount: "1.20", fee: "0.30" },
          { amount: "2.50", fee: null },
        ],
        { select: { amount: true, fee: true } }
      );
    });
    // Three decimal leaves across two rows (the fourth is null), one
    // construction each — the public value, at the leaf.
    expect(parsed).toBe(3);

    let snapshot: unknown;
    const written = countDecimalConstructions(() => {
      snapshot = codec.snapshot(rows);
    });
    expect(written).toBe(0);

    // Falsification: the READ direction does construct — one fresh instance per
    // stored leaf — so a zero above cannot be a spy that counts nothing.
    let hit: unknown;
    const read = countDecimalConstructions(() => {
      hit = codec.materialize(portableSnapshot(snapshot));
    });
    expect(read).toBe(3);
    expect(
      requireDecimal(requireRecord(requireRows(hit)[0]).amount).eq("1.2")
    ).toBe(true);
  });

  test("a stored value outside the field's domain is refused on the way out", () => {
    // The cache namespace partitions on dialect, schema namespace and snapshot
    // revision — not on the field's descriptor. An entry written before the
    // column narrowed is still sitting in the store, and it is refused rather
    // than served outside the domain every fresh read guarantees.
    const money = s.model({
      id: s.string().id(),
      amount: s.decimal({ precision: 6, scale: 2 }),
    });
    prepareSchema({ money });
    const codec = codecFor(money, "findMany", { select: { amount: true } });
    const snapshot = portableSnapshot(
      codec.snapshot([{ amount: new Decimal("1.23") }])
    );
    const entry = requireRows(requireRows(requireRows(snapshot)[0])[0]);
    entry[1] = "1.234";
    expectBoundary(() => codec.materialize(snapshot), "materialize");
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

    const nullablePointDistance = codecFor(pointDistanceModel, "findMany", {
      select: {
        optionalLocation: {
          _distance: { to: { longitude: 2.3522, latitude: 48.8566 } },
        },
      },
    });
    expect(
      nullablePointDistance.materialize(
        portableSnapshot(
          nullablePointDistance.snapshot([
            { _distance: null },
            { _distance: 12.5 },
          ])
        )
      )
    ).toEqual([{ _distance: null }, { _distance: 12.5 }]);

    const requiredPointDistance = codecFor(pointDistanceModel, "findMany", {
      select: {
        location: {
          _distance: { to: { longitude: 2.3522, latitude: 48.8566 } },
        },
      },
    });
    expectBoundary(
      () => requiredPointDistance.snapshot([{ _distance: null }]),
      "snapshot"
    );

    const nestedPointDistance = codecFor(pointTrip, "findMany", {
      select: {
        stops: {
          select: {
            optionalLocation: {
              _distance: { to: { longitude: 2.3522, latitude: 48.8566 } },
            },
          },
        },
      },
    });
    const nestedPointValue = [{ stops: [{ _distance: null }] }];
    expect(
      nestedPointDistance.materialize(
        portableSnapshot(nestedPointDistance.snapshot(nestedPointValue))
      )
    ).toEqual(nestedPointValue);

    const variantPointDistance = codecFor(pointMarker, "findMany", {
      select: {
        target: {
          article: {
            select: {
              location: {
                _distance: { to: { longitude: 2.3522, latitude: 48.8566 } },
              },
            },
          },
          video: {
            select: {
              location: {
                _distance: { to: { longitude: 2.3522, latitude: 48.8566 } },
              },
            },
          },
        },
      },
    });
    const variantPointValue = [
      {
        target: {
          type: "article",
          data: { _distance: 4.5 },
        },
      },
    ];
    expect(
      variantPointDistance.materialize(
        portableSnapshot(variantPointDistance.snapshot(variantPointValue))
      )
    ).toEqual(variantPointValue);

    const aggregate = codecFor(scalarModel, "aggregate", {
      _count: { _all: true },
      _avg: { ratio: true, decimal: true },
      _sum: { large: true, decimal: true },
      _min: { happenedAt: true },
    });
    const aggregateValue = {
      _min: { happenedAt: new Date("2026-01-01T00:00:00.000Z") },
      _sum: { large: 9_007_199_254_740_993n, decimal: new Decimal("3.5") },
      _avg: { ratio: -0, decimal: new Decimal("1.75") },
      _count: { _all: 2 },
    };
    const aggregateResult = aggregate.materialize(
      portableSnapshot(aggregate.snapshot(aggregateValue))
    );
    const aggregateRow = requireRecord(aggregateResult);
    // Decimals compare semantically through `.eq()`. Cache materialization
    // creates fresh values through the one exported constructor.
    expect(
      requireDecimal(requireRecord(aggregateRow._sum).decimal).eq("3.5")
    ).toBe(true);
    expect(
      requireDecimal(requireRecord(aggregateRow._avg).decimal).eq("1.75")
    ).toBe(true);
    expect(requireRecord(aggregateRow._sum).large).toBe(9_007_199_254_740_993n);
    expect(requireRecord(aggregateRow._min).happenedAt).toEqual(
      new Date("2026-01-01T00:00:00.000Z")
    );
    expect(requireRecord(aggregateRow._count)._all).toBe(2);
    expect(Object.is(requireRecord(aggregateRow._avg).ratio, -0)).toBe(true);

    // `_sum` is the one aggregate that leaves the column's domain, and the
    // cache has to agree with the parser about which leaf does: a cached sum
    // that materialized through the field codec would be refused for having
    // more digits than any single row could hold.
    const ledger = s.model({
      id: s.string().id(),
      money: s.decimal({ precision: 6, scale: 2 }),
    });
    prepareSchema({ ledger });
    const sums = codecFor(ledger, "aggregate", {
      _sum: { money: true },
      _avg: { money: true },
    });
    const widened = new Decimal("12345678.90");
    const sumResult = requireRecord(
      sums.materialize(
        portableSnapshot(
          sums.snapshot({
            _sum: { money: widened },
            _avg: { money: new Decimal("1.25") },
          })
        )
      )
    );
    expect(
      requireDecimal(requireRecord(sumResult._sum).money).eq(widened)
    ).toBe(true);
    expect(requireDecimal(requireRecord(sumResult._avg).money).eq("1.25")).toBe(
      true
    );
    // The stored bytes are the hostile side, and the two leaves are held to
    // two different domains there: an AVERAGE outside the field's precision is
    // refused, while the same digits are a legitimate sum.
    const widenedAvg = portableSnapshot(
      sums.snapshot({
        _sum: { money: widened },
        _avg: { money: new Decimal("1.25") },
      })
    );
    setAggregateLeaf(widenedAvg, "_avg", "12345678.9");
    expectBoundary(() => sums.materialize(widenedAvg), "materialize");
    // Widening drops the precision bound, never the SCALE.
    const overScaledSum = portableSnapshot(
      sums.snapshot({
        _sum: { money: widened },
        _avg: { money: new Decimal("1.25") },
      })
    );
    setAggregateLeaf(overScaledSum, "_sum", "1.234");
    expectBoundary(() => sums.materialize(overScaledSum), "materialize");

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

  test("keeps a required to-one relation non-null through cache transport", () => {
    const codec = codecFor(pointStop, "findMany", {
      select: { id: true, tripId: true, trip: true },
    });
    const value = [{ id: "stop-1", tripId: "trip-1", trip: { id: "trip-1" } }];

    expect(codec.materialize(codec.snapshot(value))).toEqual(value);
  });
});

describe("coverage low value", () => {
  function shapeFor(
    model: Parameters<typeof buildExpectedResultShape>[0],
    operation: Operation,
    args: Record<string, unknown>
  ) {
    const shape = buildExpectedResultShape(
      model,
      operation,
      args,
      indexFor(model)
    );
    if (!shape) throw new Error("The coverage witness needs a result shape.");
    return shape;
  }

  test("refuses incoherent trusted result shapes during cache compilation", () => {
    const missingRelation = shapeFor(author, "findMany", {
      include: { posts: true },
    });
    missingRelation.relations = new Map();

    const missingPolymorphic = shapeFor(feed, "findMany", {
      select: { id: true, subject: true },
    });
    missingPolymorphic.polymorphic = new Map();

    const missingAggregate = shapeFor(scalarModel, "aggregate", {
      _avg: { ratio: true },
    });
    missingAggregate.aggregates = new Map();

    const unknownColumn = shapeFor(scalarModel, "findMany", {
      select: { text: true },
    });

    const duplicateColumn = shapeFor(scalarModel, "findMany", {
      select: { id: true },
    });
    duplicateColumn.rawKeys = ["id", "id"];

    for (const [model, operation, shape] of [
      [author, "findMany", missingRelation],
      [feed, "findMany", missingPolymorphic],
      [scalarModel, "aggregate", missingAggregate],
      [author, "findMany", unknownColumn],
      [scalarModel, "findMany", duplicateColumn],
    ] as const) {
      expect(() =>
        compileCacheResultCodec(model, operation, operation, shape)
      ).toThrow(INCOMPLETE_CODEC_PATTERN);
    }
  });

  test("refuses a cache codec for a non-read operation token", () => {
    const shape = shapeFor(scalarModel, "findMany", {
      select: { id: true },
    });

    expect(() =>
      compileCacheResultCodec(scalarModel, "create", "create", shape)
    ).toThrow(INCOMPLETE_CODEC_PATTERN);
  });

  test("normalizes a non-Error cache codec failure cause", () => {
    const codec = codecFor(scalarModel, "findMany", {
      select: { id: true },
    });
    const hostileRow = new Proxy(
      { id: "one" },
      {
        getPrototypeOf() {
          // biome-ignore lint/style/useThrowOnlyError: This fixture throws a non-Error on purpose; the test asserts the codec normalizes it.
          throw "non-error failure";
        },
      }
    );

    const error = expectBoundary(
      () => codec.snapshot([hostileRow]),
      "snapshot"
    );
    expect(error.originalCause).toBeInstanceOf(Error);
  });
});
