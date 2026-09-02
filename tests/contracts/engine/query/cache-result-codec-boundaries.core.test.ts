import {
  materializeJsonValue,
  snapshotJsonValue,
} from "@query-engine/result/cache-json-codec";
import {
  CacheSnapshotFailure,
  decodeSnapshotCount,
  decodeSnapshotNumber,
  encodeSnapshotCount,
  encodeSnapshotNumber,
  readSnapshotArray,
  readSnapshotRecord,
  withSnapshotObject,
} from "@query-engine/result/cache-snapshot-structure";
import {
  arrayCodec,
  booleanCodec,
  compileScalarCodec,
  countCodec,
  nullableCodec,
  numberCodec,
  recordCodec,
  taggedRelationCodec,
  type ValueCodec,
} from "@query-engine/result/cache-value-codecs";
import { s } from "@schema";
import { describe, expect, test } from "vitest";

function activeObjects(): WeakSet<object> {
  return new WeakSet<object>();
}

function snapshot(codec: ValueCodec, value: unknown): unknown {
  return codec.snapshot(value, activeObjects());
}

function materialize(codec: ValueCodec, value: unknown): unknown {
  return codec.materialize(value, activeObjects());
}

function expectSnapshotFailure(run: () => unknown): void {
  // biome-ignore lint/suspicious/noMisplacedAssertion: This shared helper is invoked only from registered tests.
  expect(run).toThrow(CacheSnapshotFailure);
}

describe("cache result codec structural contracts", () => {
  test("round-trips nested records, arrays, nullability, and tagged relations", () => {
    const text = compileScalarCodec(s.string());
    const target = recordCodec(new Map<string, ValueCodec>([["title", text]]));
    const codec = recordCodec(
      new Map<string, ValueCodec>([
        ["name", text],
        ["aliases", arrayCodec(text)],
        [
          "subject",
          nullableCodec(
            taggedRelationCodec(new Map<string, ValueCodec>([["post", target]]))
          ),
        ],
      ])
    );
    const value = {
      name: "Ada",
      aliases: ["A", "Analyst"],
      subject: { type: "post", data: { title: "Notes" } },
    };

    const stored = snapshot(codec, value);
    const first = materialize(codec, stored);
    const second = materialize(codec, stored);

    expect(first).toEqual(value);
    expect(second).toEqual(value);
    expect(first).not.toBe(value);
    expect(second).not.toBe(first);
  });

  test("preserves every finite numeric spelling used by detached snapshots", () => {
    for (const value of [-0, 0, 1.5, Number.MAX_SAFE_INTEGER]) {
      const encoded = encodeSnapshotNumber(value);
      expect(Object.is(decodeSnapshotNumber(encoded), value)).toBe(true);
    }
    expect(decodeSnapshotCount(encodeSnapshotCount(42))).toBe(42);
  });

  test("round-trips JSON without invoking inherited or special-key behavior", () => {
    const value: Record<string, unknown> = Object.create(null);
    Object.defineProperty(value, "__proto__", {
      enumerable: true,
      value: { safe: true },
    });
    Object.defineProperty(value, "items", {
      enumerable: true,
      value: [null, "text", true, -0, { nested: 1 }],
    });

    const stored = snapshotJsonValue(value, activeObjects());
    const restored = materializeJsonValue(stored, activeObjects());

    if (typeof restored !== "object" || restored === null) {
      throw new Error("Expected a materialized JSON record.");
    }
    expect(Reflect.get(restored, "__proto__")).toEqual({ safe: true });
    expect(Reflect.get(restored, "items")).toEqual([
      null,
      "text",
      true,
      -0,
      { nested: 1 },
    ]);
    expect(Object.hasOwn(restored, "__proto__")).toBe(true);
  });
});

describe("coverage low value", () => {
  test("refuses malformed snapshot arrays before reading their values", () => {
    const customPrototype: unknown[] = [];
    Object.setPrototypeOf(customPrototype, null);
    const sparse = new Array<unknown>(1);
    const extraProperty = [1];
    Object.defineProperty(extraProperty, "extra", {
      enumerable: true,
      value: 2,
    });
    const accessor = [1];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get: () => 1,
    });
    const hidden = [1];
    Object.defineProperty(hidden, "0", {
      enumerable: false,
      value: 1,
    });
    const reordered = new Proxy([1, 2], {
      ownKeys: () => ["1", "0", "length"],
    });

    for (const value of [
      null,
      {},
      customPrototype,
      sparse,
      extraProperty,
      accessor,
      hidden,
      reordered,
    ]) {
      expectSnapshotFailure(() => readSnapshotArray(value));
    }
  });

  test("refuses malformed snapshot records before reading their values", () => {
    const customPrototype = Object.create({ inherited: true });
    const symbolKey = { [Symbol("hidden")]: 1 };
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => 1,
    });
    const hidden = Object.defineProperty({}, "value", {
      enumerable: false,
      value: 1,
    });

    for (const value of [
      null,
      [],
      customPrototype,
      symbolKey,
      accessor,
      hidden,
    ]) {
      expectSnapshotFailure(() => readSnapshotRecord(value));
    }
    expect(readSnapshotRecord(Object.create(null), true)).toEqual([]);
  });

  test("refuses cycles and non-canonical numeric snapshots", () => {
    const active = activeObjects();
    const value = {};
    active.add(value);
    expectSnapshotFailure(() => withSnapshotObject(active, value, () => true));

    for (const number of [
      undefined,
      "1",
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expectSnapshotFailure(() => encodeSnapshotNumber(number));
    }
    for (const encoded of [undefined, 1, "01", "NaN", "Infinity", "-1e0"]) {
      expectSnapshotFailure(() => decodeSnapshotNumber(encoded));
    }
    for (const count of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expectSnapshotFailure(() => encodeSnapshotCount(count));
    }
    for (const encoded of ["-1", "1.5", String(Number.MAX_SAFE_INTEGER + 1)]) {
      expectSnapshotFailure(() => decodeSnapshotCount(encoded));
    }
  });

  test("refuses unsupported JSON values, cycles, and malformed encoded nodes", () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    for (const value of [
      undefined,
      1n,
      Symbol("value"),
      () => undefined,
      cyclic,
    ]) {
      expectSnapshotFailure(() => snapshotJsonValue(value, activeObjects()));
    }

    const malformedNodes: unknown[] = [
      null,
      "null",
      [],
      ["null", 1],
      ["string"],
      ["string", 1],
      ["boolean", "true"],
      ["number", "NaN"],
      ["array", null],
      ["object", null],
      ["unknown"],
      ["object", [1]],
      ["object", [["key"]]],
      ["object", [[1, ["null"]]]],
      [
        "object",
        [
          ["key", ["null"]],
          ["key", ["null"]],
        ],
      ],
    ];
    for (const node of malformedNodes) {
      expectSnapshotFailure(() => materializeJsonValue(node, activeObjects()));
    }
  });

  test("refuses malformed primitive, record, array, and tagged snapshots", () => {
    const text = compileScalarCodec(s.string());
    const record = recordCodec(new Map<string, ValueCodec>([["name", text]]));
    const array = arrayCodec(text);
    const tagged = taggedRelationCodec(
      new Map<string, ValueCodec>([["post", record]])
    );

    for (const run of [
      () => snapshot(booleanCodec(), 1),
      () => materialize(booleanCodec(), 1),
      () => snapshot(numberCodec(), Number.NaN),
      () => materialize(numberCodec(), "01"),
      () => snapshot(countCodec(), -1),
      () => materialize(countCodec(), "1.5"),
      () => snapshot(array, {}),
      () => materialize(array, {}),
      () => snapshot(record, null),
      () => snapshot(record, {}),
      () => snapshot(record, { name: "Ada", extra: true }),
      () => materialize(record, []),
      () => materialize(record, [["name"]]),
      () => materialize(record, [["other", "Ada"]]),
      () =>
        materialize(record, [
          ["name", "Ada"],
          ["name", "Ada"],
        ]),
      () => snapshot(tagged, null),
      () => snapshot(tagged, { type: "post" }),
      () => snapshot(tagged, { other: "post", data: { name: "Ada" } }),
      () => snapshot(tagged, { type: 1, data: { name: "Ada" } }),
      () => snapshot(tagged, { type: "unknown", data: { name: "Ada" } }),
      () =>
        snapshot(tagged, {
          type: "post",
          data: { name: "Ada" },
          extra: true,
        }),
      () => materialize(tagged, []),
      () => materialize(tagged, [["type", "post"]]),
      () =>
        materialize(tagged, [
          ["other", "post"],
          ["data", [["name", "Ada"]]],
        ]),
      () =>
        materialize(tagged, [
          ["type", "unknown"],
          ["data", [["name", "Ada"]]],
        ]),
      () =>
        materialize(tagged, [
          ["type", "post"],
          ["other", [["name", "Ada"]]],
        ]),
    ]) {
      expectSnapshotFailure(run);
    }
  });

  test("refuses each scalar codec outside its declared cache domain", () => {
    const invalidDate = new Date(Number.NaN);
    const customDate = new Date("2026-08-30T00:00:00.000Z");
    Object.defineProperty(customDate, "extra", { value: true });
    const customBytes = new Uint8Array([1]);
    Object.setPrototypeOf(customBytes, null);

    const failures: Array<readonly [ValueCodec, unknown, unknown]> = [
      [compileScalarCodec(s.string()), 1, 1],
      [compileScalarCodec(s.time()), "25:00:00", "25:00:00"],
      [compileScalarCodec(s.enum(["open"])), "closed", "closed"],
      [compileScalarCodec(s.int()), 1.5, "1.5"],
      [compileScalarCodec(s.boolean()), 1, 1],
      [compileScalarCodec(s.bigInt()), 1, "01"],
      [compileScalarCodec(s.dateTime()), invalidDate, "not-an-iso-date"],
      [
        compileScalarCodec(s.date()),
        new Date("2026-08-30T12:00:00.000Z"),
        "2026-08-30T12:00:00.000Z",
      ],
      [compileScalarCodec(s.vector().dimension(2)), [1], ["1"]],
      [compileScalarCodec(s.blob()), customBytes, [256]],
      [compileScalarCodec(s.point()), { longitude: 0 }, []],
    ];

    for (const [codec, applicationValue, storedValue] of failures) {
      expectSnapshotFailure(() => snapshot(codec, applicationValue));
      expectSnapshotFailure(() => materialize(codec, storedValue));
    }
    expectSnapshotFailure(() =>
      snapshot(compileScalarCodec(s.dateTime()), customDate)
    );
  });
});
