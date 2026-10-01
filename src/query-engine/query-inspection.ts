import { Sql } from "@sql";
import { isRecord } from "@validation/value-guards";

type OpaqueInspectionKind = "accessor" | "function" | "unsupported";

const opaqueInspectionValues = Object.freeze({
  accessor: opaqueInspectionValue("accessor"),
  function: opaqueInspectionValue("function"),
  unsupported: opaqueInspectionValue("unsupported"),
});

const sqlStringsGetter = Object.getOwnPropertyDescriptor(
  Sql.prototype,
  "strings"
)?.get;
const sqlValuesGetter = Object.getOwnPropertyDescriptor(
  Sql.prototype,
  "values"
)?.get;

function opaqueInspectionValue(
  kind: OpaqueInspectionKind
): Readonly<Record<string, unknown>> {
  const value: Record<string, unknown> = Object.create(null);
  value.opaque = kind;
  return Object.freeze(value);
}

/** Copy the prepared payload without exposing caller authority or core state. */
export function snapshotQueryInput(
  input: Record<string, unknown>
): Readonly<Record<string, unknown>> {
  return snapshotOwn(input, new Map(), false);
}

/**
 * One plain record or array, copied own key by own key: each enumerable data
 * member is snapshotted, an accessor is disclosed as opaque, and an array keeps
 * its `length` descriptor — array exotic-object invariants guarantee it is the
 * non-configurable data descriptor of one valid uint32 length, and a proxy that
 * lies there is rejected by `getOwnPropertyDescriptor` before this point.
 */
function snapshotOwn(
  input: object,
  seen: Map<object, unknown>,
  array: boolean
): Readonly<Record<string, unknown>> {
  const snapshot: Record<string, unknown> = array ? [] : Object.create(null);
  seen.set(input, snapshot);
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(input);
  } catch {
    seen.set(input, opaqueInspectionValues.unsupported);
    return opaqueInspectionValues.unsupported;
  }
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(input, key);
    } catch {
      seen.set(input, opaqueInspectionValues.unsupported);
      return opaqueInspectionValues.unsupported;
    }
    if (descriptor === undefined) continue;
    if (array && key === "length") {
      Object.defineProperty(snapshot, key, descriptor);
      continue;
    }
    if (!descriptor.enumerable) continue;
    Object.defineProperty(snapshot, key, {
      configurable: false,
      enumerable: true,
      value:
        "value" in descriptor
          ? snapshotValue(descriptor.value, seen)
          : opaqueInspectionValues.accessor,
      writable: false,
    });
  }
  return Object.freeze(snapshot);
}

function snapshotValue(value: unknown, seen: Map<object, unknown>): unknown {
  if (typeof value === "function") return opaqueInspectionValues.function;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  try {
    if (Array.isArray(value)) return snapshotOwn(value, seen, true);
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Sql.prototype && value instanceof Sql) {
      return snapshotSql(value, seen);
    }
    if (prototype === Date.prototype && value instanceof Date) {
      const snapshot = Object.freeze(
        new Date(Date.prototype.getTime.call(value))
      );
      seen.set(value, snapshot);
      return snapshot;
    }
    if (value instanceof Uint8Array) {
      const snapshot = new Uint8Array(value);
      seen.set(value, snapshot);
      return snapshot;
    }
    if (prototype === ArrayBuffer.prototype && value instanceof ArrayBuffer) {
      const snapshot = value.slice(0);
      seen.set(value, snapshot);
      return snapshot;
    }
    if (prototype === Map.prototype && value instanceof Map) {
      const snapshot = new Map<unknown, unknown>();
      seen.set(value, snapshot);
      Map.prototype.forEach.call(value, (member: unknown, key: unknown) => {
        snapshot.set(snapshotValue(key, seen), snapshotValue(member, seen));
      });
      return snapshot;
    }
    if (prototype === Set.prototype && value instanceof Set) {
      const snapshot = new Set<unknown>();
      seen.set(value, snapshot);
      Set.prototype.forEach.call(value, (member: unknown) => {
        snapshot.add(snapshotValue(member, seen));
      });
      return snapshot;
    }
    if (ArrayBuffer.isView(value)) {
      const snapshot = structuredClone(value);
      seen.set(value, snapshot);
      return snapshot;
    }
    if (
      (prototype === Object.prototype || prototype === null) &&
      isRecord(value)
    ) {
      return snapshotOwn(value, seen, false);
    }
  } catch {
    // A hostile proxy or malformed built-in is disclosed only as an opaque fact.
  }
  seen.set(value, opaqueInspectionValues.unsupported);
  return opaqueInspectionValues.unsupported;
}

function snapshotSql(value: Sql, seen: Map<object, unknown>): Sql {
  if (!(sqlStringsGetter && sqlValuesGetter)) {
    throw new TypeError("Sql inspection getters are unavailable");
  }
  const sourceStrings = Reflect.apply(sqlStringsGetter, value, []);
  const sourceValues = Reflect.apply(sqlValuesGetter, value, []);
  const strings = new Array<string>(sourceStrings.length);
  for (let index = 0; index < sourceStrings.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(sourceStrings, index);
    if (
      !(
        descriptor &&
        "value" in descriptor &&
        typeof descriptor.value === "string"
      )
    ) {
      throw new TypeError("Sql inspection strings are not plain data values");
    }
    strings[index] = descriptor.value;
  }
  const detachedValues = new Array<unknown>(sourceValues.length);
  const snapshot = new Sql(strings, detachedValues);
  seen.set(value, snapshot);
  for (let index = 0; index < sourceValues.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(sourceValues, index);
    detachedValues[index] =
      descriptor && "value" in descriptor
        ? snapshotValue(descriptor.value, seen)
        : opaqueInspectionValues.accessor;
  }

  snapshot.toStatement("?");
  snapshot.toStatement("$n");
  snapshot.toStatement(":n");
  for (const key of Reflect.ownKeys(snapshot)) {
    const member = Reflect.get(snapshot, key);
    if (member !== null && typeof member === "object") Object.freeze(member);
  }
  Object.freeze(snapshot);
  return snapshot;
}
