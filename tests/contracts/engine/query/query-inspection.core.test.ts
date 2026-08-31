import { snapshotQueryInput } from "@query-engine/query-inspection";
import { Sql, sql } from "@sql";
import { describe, expect, test } from "vitest";

function inspectedKind(value: unknown): unknown {
  return value && typeof value === "object"
    ? Reflect.get(value, "opaque")
    : undefined;
}

function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected an inspected array.");
  return value;
}

function requireBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new Error("Expected inspected bytes.");
  }
  return value;
}

function requireMap(value: unknown): Map<unknown, unknown> {
  if (!(value instanceof Map)) throw new Error("Expected an inspected map.");
  return value;
}

function requireSet(value: unknown): Set<unknown> {
  if (!(value instanceof Set)) throw new Error("Expected an inspected set.");
  return value;
}

function requireSql(value: unknown): Sql {
  if (!(value instanceof Sql)) throw new Error("Expected inspected SQL.");
  return value;
}

describe("query inspection snapshots", () => {
  test("detaches the full supported value graph while preserving aliases and cycles", () => {
    const shared = { label: "before" };
    const bytes = new Uint8Array([1, 2, 3]);
    const buffer = new Uint8Array([4, 5]).buffer;
    const view = new DataView(new Uint8Array([6, 7]).buffer);
    const map = new Map<unknown, unknown>([[shared, bytes]]);
    const set = new Set<unknown>([shared]);
    const input: Record<string, unknown> = {
      shared,
      alias: shared,
      date: new Date("2026-08-30T12:00:00.000Z"),
      bytes,
      buffer,
      view,
      map,
      set,
    };
    input.self = input;

    const snapshot = snapshotQueryInput(input);
    shared.label = "after";
    bytes[0] = 9;

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.shared).toBe(snapshot.alias);
    expect(snapshot.self).toBe(snapshot);
    expect(snapshot.shared).toEqual({ label: "before" });
    expect(snapshot.date).toEqual(new Date("2026-08-30T12:00:00.000Z"));
    expect(snapshot.date).not.toBe(input.date);
    expect(Array.from(requireBytes(snapshot.bytes))).toEqual([1, 2, 3]);
    expect(snapshot.buffer).not.toBe(buffer);
    expect(snapshot.view).not.toBe(view);

    const snapshotMap = requireMap(snapshot.map);
    const snapshotSet = requireSet(snapshot.set);
    const [snapshotKey] = snapshotMap.keys();
    expect(snapshotKey).toBe(snapshot.shared);
    expect(
      Array.from(snapshotMap.values()).map((value) =>
        Array.from(requireBytes(value))
      )
    ).toEqual([[1, 2, 3]]);
    expect([...snapshotSet]).toEqual([snapshot.shared]);
  });

  test("copies sparse arrays by descriptor without invoking accessors", () => {
    let reads = 0;
    const values: unknown[] = [];
    values.length = 4;
    values[2] = { stable: true };
    Object.defineProperty(values, "secret", {
      enumerable: true,
      get() {
        reads += 1;
        return "private";
      },
    });

    const snapshot = snapshotQueryInput({ values });
    const copied = requireArray(snapshot.values);

    expect(reads).toBe(0);
    expect(Object.isFrozen(copied)).toBe(true);
    expect(copied).toHaveLength(4);
    expect(0 in copied).toBe(false);
    expect(copied[2]).toEqual({ stable: true });
    expect(inspectedKind(Reflect.get(copied, "secret"))).toBe("accessor");
  });

  test("copies Sql through its stable projection and detaches nested values", () => {
    const parameter = { label: "before" };
    const statement = sql`SELECT ${parameter}, ${new Date(
      "2026-08-30T12:00:00.000Z"
    )}`;

    const snapshot = snapshotQueryInput({ statement });
    parameter.label = "after";
    const copied = requireSql(snapshot.statement);

    expect(copied).not.toBe(statement);
    expect(copied.toStatement("$n")).toBe("SELECT $1, $2");
    expect(copied.values[0]).toEqual({ label: "before" });
    expect(copied.values[1]).toEqual(new Date("2026-08-30T12:00:00.000Z"));
    expect(Object.isFrozen(copied)).toBe(true);
  });

  test("discloses executable and custom-prototype values only as opaque facts", () => {
    class ProviderValue {
      constructor(readonly value: string) {}
    }

    const snapshot = snapshotQueryInput({
      callback: () => "private",
      provider: new ProviderValue("private"),
    });

    expect(inspectedKind(snapshot.callback)).toBe("function");
    expect(inspectedKind(snapshot.provider)).toBe("unsupported");
    expect(JSON.stringify(snapshot)).not.toContain("private");
  });

  test("contains hostile reflection at the inspection boundary", () => {
    const ownKeysFailure = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("private ownKeys failure");
        },
      }
    );
    const descriptorFailure = new Proxy(
      {},
      {
        ownKeys: () => ["value"],
        getOwnPropertyDescriptor() {
          throw new Error("private descriptor failure");
        },
      }
    );
    const prototypeFailure = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("private prototype failure");
        },
      }
    );

    const rootOwnKeys = snapshotQueryInput(ownKeysFailure);
    const rootDescriptor = snapshotQueryInput(descriptorFailure);
    const nestedPrototype = snapshotQueryInput({ value: prototypeFailure });

    expect(inspectedKind(rootOwnKeys)).toBe("unsupported");
    expect(inspectedKind(rootDescriptor)).toBe("unsupported");
    expect(inspectedKind(nestedPrototype.value)).toBe("unsupported");
    expect(
      JSON.stringify({ rootOwnKeys, rootDescriptor, nestedPrototype })
    ).not.toContain("private");
  });

  test("contains hostile array reflection without reading array members", () => {
    const ownKeysFailure = new Proxy([], {
      ownKeys() {
        throw new Error("array ownKeys failure");
      },
    });
    const descriptorFailure = new Proxy(["private"], {
      getOwnPropertyDescriptor(_target, key) {
        if (key === "0") throw new Error("array descriptor failure");
        return Reflect.getOwnPropertyDescriptor(_target, key);
      },
    });

    const snapshot = snapshotQueryInput({ ownKeysFailure, descriptorFailure });

    expect(inspectedKind(snapshot.ownKeysFailure)).toBe("unsupported");
    expect(inspectedKind(snapshot.descriptorFailure)).toBe("unsupported");
    expect(JSON.stringify(snapshot)).not.toContain("private");
  });

  test("fails closed when mutable Sql projections no longer contain plain data", () => {
    const invalidString = sql`SELECT ${1}`;
    Reflect.set(invalidString.strings, 0, 42);

    const accessorValue = sql`SELECT ${1}`;
    Object.defineProperty(accessorValue.values, 0, {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error("parameter getter must not run");
      },
    });

    const snapshot = snapshotQueryInput({ invalidString, accessorValue });
    expect(inspectedKind(snapshot.invalidString)).toBe("unsupported");
    const inspectedSql = requireSql(snapshot.accessorValue);
    expect(inspectedKind(inspectedSql.values[0])).toBe("accessor");
  });

  test("contains built-in proxies that cannot be invoked as their claimed receiver", () => {
    const date = new Proxy(new Date("2026-08-30T12:00:00.000Z"), {});
    const map = new Proxy(new Map([["private", "value"]]), {});
    const set = new Proxy(new Set(["private"]), {});

    const snapshot = snapshotQueryInput({ date, map, set });

    expect(inspectedKind(snapshot.date)).toBe("unsupported");
    expect(inspectedKind(snapshot.map)).toBe("unsupported");
    expect(inspectedKind(snapshot.set)).toBe("unsupported");
    expect(JSON.stringify(snapshot)).not.toContain("private");
  });
});
