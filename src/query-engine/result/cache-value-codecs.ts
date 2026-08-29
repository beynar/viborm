import type { Scalar } from "@schema/scalars";
import {
  canonicalizeMaterializedDecimal,
  type DecimalDescriptor,
  decodeFieldScalar,
  decodeWidenedSum,
  toDecimal,
} from "@validation/primitives/decimal-codec";
import { validateGeoPoint } from "@validation/primitives/geo-point-codec";
import { materializeJsonValue, snapshotJsonValue } from "./cache-json-codec";
import {
  decodeSnapshotCount,
  decodeSnapshotNumber,
  defineSnapshotProperty,
  encodeSnapshotCount,
  encodeSnapshotNumber,
  failCacheSnapshot,
  readSnapshotArray,
  readSnapshotRecord,
  withSnapshotObject,
} from "./cache-snapshot-structure";

const NORMALIZED_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?$/;

export interface ValueCodec {
  snapshot(value: unknown, active: WeakSet<object>): unknown;
  materialize(snapshot: unknown, active: WeakSet<object>): unknown;
}

export function compileScalarCodec(
  scalar: Scalar,
  useDeclaredNullability = true
): ValueCodec {
  let item: ValueCodec;
  if ("enumValues" in scalar) {
    item = enumCodec(new Set(scalar.enumValues));
  } else {
    const state = scalar["~"].state;
    switch (state.type) {
      case "string":
        item = stringCodec();
        break;
      case "time":
        item = timeCodec();
        break;
      case "int":
        item = integerCodec();
        break;
      case "number":
        item = numberCodec();
        break;
      case "decimal":
        item = decimalCodec(state.decimal);
        break;
      case "boolean":
        item = booleanCodec();
        break;
      case "bigint":
        item = bigintCodec();
        break;
      case "datetime":
        item = dateCodec(false);
        break;
      case "date":
        item = dateCodec(true);
        break;
      case "json":
        item = jsonCodec();
        break;
      case "vector":
        item = vectorCodec(state.dimension);
        break;
      case "blob":
        item = bytesCodec();
        break;
      case "point":
        item = pointCodec();
        break;
      default: {
        const exhaustive: never = state;
        return exhaustive;
      }
    }
  }
  const state = scalar["~"].state;
  const value = state.array ? arrayCodec(item) : item;
  return useDeclaredNullability && state.nullable
    ? nullableCodec(value)
    : value;
}

export function taggedRelationCodec(
  variants: ReadonlyMap<string, ValueCodec>
): ValueCodec {
  return {
    snapshot(value, active) {
      if (typeof value !== "object" || value === null) {
        return failCacheSnapshot();
      }
      return withSnapshotObject(active, value, () => {
        const entries = readSnapshotRecord(value);
        if (entries.length !== 2) return failCacheSnapshot();
        let type: string | undefined;
        let data: unknown;
        for (const [key, item] of entries) {
          if (key === "type" && typeof item === "string") type = item;
          else if (key === "data") data = item;
          else return failCacheSnapshot();
        }
        const target = type === undefined ? undefined : variants.get(type);
        if (!target || data === undefined) return failCacheSnapshot();
        return entries.map(([key, item]) => [
          key,
          key === "type" ? type : target.snapshot(item, active),
        ]);
      });
    },
    materialize(snapshot, active) {
      return materializeArray(snapshot, active, (entries) => {
        if (entries.length !== 2) return failCacheSnapshot();
        const decoded = readEncodedEntries(entries, active);
        let type: string | undefined;
        let dataSnapshot: unknown;
        for (const [key, item] of decoded) {
          if (key === "type" && typeof item === "string") type = item;
          else if (key === "data") dataSnapshot = item;
          else return failCacheSnapshot();
        }
        const target = type === undefined ? undefined : variants.get(type);
        if (!target || dataSnapshot === undefined) return failCacheSnapshot();
        const result: Record<string, unknown> = {};
        for (const [key] of decoded) {
          defineSnapshotProperty(
            result,
            key,
            key === "type" ? type : target.materialize(dataSnapshot, active)
          );
        }
        return result;
      });
    },
  };
}

export function recordCodec(
  fields: ReadonlyMap<string, ValueCodec>
): ValueCodec {
  return {
    snapshot(value, active) {
      if (typeof value !== "object" || value === null) {
        return failCacheSnapshot();
      }
      return withSnapshotObject(active, value, () => {
        const entries = readSnapshotRecord(value);
        if (entries.length !== fields.size) return failCacheSnapshot();
        const seen = new Set<string>();
        return entries.map(([key, item]) => {
          const field = fields.get(key);
          if (!field || seen.has(key)) return failCacheSnapshot();
          seen.add(key);
          return [key, field.snapshot(item, active)];
        });
      });
    },
    materialize(snapshot, active) {
      return materializeArray(snapshot, active, (entries) => {
        if (entries.length !== fields.size) return failCacheSnapshot();
        const decoded = readEncodedEntries(entries, active);
        const seen = new Set<string>();
        const result: Record<string, unknown> = {};
        for (const [key, item] of decoded) {
          const field = fields.get(key);
          if (!field || seen.has(key)) return failCacheSnapshot();
          seen.add(key);
          defineSnapshotProperty(result, key, field.materialize(item, active));
        }
        return result;
      });
    },
  };
}

export function arrayCodec(item: ValueCodec): ValueCodec {
  return {
    snapshot(value, active) {
      if (!Array.isArray(value)) return failCacheSnapshot();
      return withSnapshotObject(active, value, () =>
        readSnapshotArray(value).map((entry) => item.snapshot(entry, active))
      );
    },
    materialize(snapshot, active) {
      return materializeArray(snapshot, active, (entries) =>
        entries.map((entry) => item.materialize(entry, active))
      );
    },
  };
}

export function nullableCodec(value: ValueCodec): ValueCodec {
  return {
    snapshot(input, active) {
      return input === null ? null : value.snapshot(input, active);
    },
    materialize(snapshot, active) {
      return snapshot === null ? null : value.materialize(snapshot, active);
    },
  };
}

export function booleanCodec(): ValueCodec {
  return primitiveCodec(
    (value) => (typeof value === "boolean" ? value : failCacheSnapshot()),
    (snapshot) =>
      typeof snapshot === "boolean" ? snapshot : failCacheSnapshot()
  );
}

export function numberCodec(): ValueCodec {
  return primitiveCodec(encodeSnapshotNumber, decodeSnapshotNumber);
}

export function countCodec(): ValueCodec {
  return primitiveCodec(encodeSnapshotCount, decodeSnapshotCount);
}

function readEncodedEntries(
  entries: readonly unknown[],
  active: WeakSet<object>
): readonly (readonly [string, unknown])[] {
  const decoded: (readonly [string, unknown])[] = new Array(entries.length);
  for (let index = 0; index < entries.length; index += 1) {
    decoded[index] = materializeArray(entries[index], active, (pair) => {
      if (pair.length !== 2 || typeof pair[0] !== "string") {
        return failCacheSnapshot();
      }
      return [pair[0], pair[1]];
    });
  }
  return decoded;
}

function stringCodec(): ValueCodec {
  return primitiveCodec(
    (value) => (typeof value === "string" ? value : failCacheSnapshot()),
    (snapshot) =>
      typeof snapshot === "string" ? snapshot : failCacheSnapshot()
  );
}

function timeCodec(): ValueCodec {
  return primitiveCodec(
    (value) =>
      typeof value === "string" && NORMALIZED_TIME.test(value)
        ? value
        : failCacheSnapshot(),
    (snapshot) =>
      typeof snapshot === "string" && NORMALIZED_TIME.test(snapshot)
        ? snapshot
        : failCacheSnapshot()
  );
}

function enumCodec(values: ReadonlySet<string>): ValueCodec {
  return primitiveCodec(
    (value) =>
      typeof value === "string" && values.has(value)
        ? value
        : failCacheSnapshot(),
    (snapshot) =>
      typeof snapshot === "string" && values.has(snapshot)
        ? snapshot
        : failCacheSnapshot()
  );
}

function integerCodec(): ValueCodec {
  return primitiveCodec(
    (value) => {
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        return failCacheSnapshot();
      }
      return encodeSnapshotNumber(value);
    },
    (snapshot) => {
      const value = decodeSnapshotNumber(snapshot);
      return Number.isSafeInteger(value) ? value : failCacheSnapshot();
    }
  );
}

/**
 * The cache's two directions across the decimal boundary.
 *
 * A snapshot is DETACHED: the memory backend keeps it by reference and the KV
 * backend puts it through `JSON.stringify`, so a `Decimal` that reached a
 * snapshot would survive in one store and arrive as `{"s":1,"e":0,"d":[12]}` in
 * the other. It is therefore stored as canonical text and rebuilt as a FRESH
 * instance on every hit, which is also what keeps a caller who mutates a
 * returned value from poisoning the next one.
 *
 * BOTH directions are held to the field's domain, for two different reasons.
 * Reading, because a stored entry outlives the schema that wrote it and nothing
 * in the cache key says which precision and scale were in force when it was
 * written. Writing, because a value outside the domain is an incoherent parsed
 * result — and refusing it at the WRITE is what makes that visible when it
 * happens, instead of storing an entry every subsequent hit refuses for the rest
 * of its TTL.
 */
function decimalCodec(descriptor: DecimalDescriptor | undefined): ValueCodec {
  return primitiveCodec(
    (value) => {
      if (!descriptor) return failCacheSnapshot();
      return (
        decodeFieldScalar(canonicalizeMaterializedDecimal(value), descriptor) ??
        failCacheSnapshot()
      );
    },
    (snapshot) => {
      if (!descriptor) return failCacheSnapshot();
      const canonical = decodeFieldScalar(snapshot, descriptor);
      return canonical !== undefined && canonical === snapshot
        ? toDecimal(canonical)
        : failCacheSnapshot();
    }
  );
}

/**
 * The SUM leaf's cache boundary: the field's scale, deliberately not the
 * field's precision, so a cached sum materializes exactly like a fresh one. The
 * write is held to the same scale for the same reason the scalar write is.
 */
export function compileWidenedSumCodec(scalar: Scalar): ValueCodec {
  const descriptor = scalar["~"].state.decimal;
  return primitiveCodec(
    (value) => {
      if (!descriptor) return failCacheSnapshot();
      return (
        decodeWidenedSum(
          canonicalizeMaterializedDecimal(value),
          descriptor.scale
        ) ?? failCacheSnapshot()
      );
    },
    (snapshot) => {
      if (!descriptor) return failCacheSnapshot();
      const canonical = decodeWidenedSum(snapshot, descriptor.scale);
      return canonical !== undefined && canonical === snapshot
        ? toDecimal(canonical)
        : failCacheSnapshot();
    }
  );
}

function bigintCodec(): ValueCodec {
  return primitiveCodec(
    (value) =>
      typeof value === "bigint" ? value.toString() : failCacheSnapshot(),
    (snapshot) => {
      if (typeof snapshot !== "string") return failCacheSnapshot();
      try {
        const value = BigInt(snapshot);
        return value.toString() === snapshot ? value : failCacheSnapshot();
      } catch {
        return failCacheSnapshot();
      }
    }
  );
}

function dateCodec(dateOnly: boolean): ValueCodec {
  return primitiveCodec(
    (value) => {
      if (
        !(value instanceof Date) ||
        Object.getPrototypeOf(value) !== Date.prototype ||
        Reflect.ownKeys(value).length !== 0
      ) {
        return failCacheSnapshot();
      }
      const time = Date.prototype.getTime.call(value);
      if (!Number.isFinite(time)) return failCacheSnapshot();
      const iso = Date.prototype.toISOString.call(value);
      if (dateOnly && !iso.endsWith("T00:00:00.000Z")) {
        return failCacheSnapshot();
      }
      return iso;
    },
    (snapshot) => {
      if (typeof snapshot !== "string") return failCacheSnapshot();
      const value = new Date(snapshot);
      if (
        !Number.isFinite(value.getTime()) ||
        value.toISOString() !== snapshot ||
        (dateOnly && !snapshot.endsWith("T00:00:00.000Z"))
      ) {
        return failCacheSnapshot();
      }
      return value;
    }
  );
}

function jsonCodec(): ValueCodec {
  return {
    snapshot: snapshotJsonValue,
    materialize: materializeJsonValue,
  };
}

function vectorCodec(dimension: number | undefined): ValueCodec {
  return {
    snapshot(value, active) {
      if (!Array.isArray(value)) return failCacheSnapshot();
      return withSnapshotObject(active, value, () => {
        const items = readSnapshotArray(value);
        if (dimension !== undefined && items.length !== dimension) {
          return failCacheSnapshot();
        }
        return items.map(encodeSnapshotNumber);
      });
    },
    materialize(snapshot, active) {
      return materializeArray(snapshot, active, (items) => {
        if (dimension !== undefined && items.length !== dimension) {
          return failCacheSnapshot();
        }
        return items.map(decodeSnapshotNumber);
      });
    },
  };
}

function bytesCodec(): ValueCodec {
  return {
    snapshot(value) {
      if (
        !(value instanceof Uint8Array) ||
        Object.getPrototypeOf(value) !== Uint8Array.prototype ||
        Reflect.ownKeys(value).length !== value.byteLength
      ) {
        return failCacheSnapshot();
      }
      const bytes = new Array<number>(value.byteLength);
      for (let index = 0; index < value.byteLength; index += 1) {
        bytes[index] = value[index]!;
      }
      return bytes;
    },
    materialize(snapshot) {
      const values = readSnapshotArray(snapshot);
      const bytes = new Uint8Array(values.length);
      for (let index = 0; index < values.length; index += 1) {
        const value = values[index];
        if (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < 0 ||
          value > 255
        ) {
          return failCacheSnapshot();
        }
        bytes[index] = value;
      }
      return bytes;
    },
  };
}

function pointCodec(): ValueCodec {
  const coordinates = recordCodec(
    new Map<string, ValueCodec>([
      ["longitude", numberCodec()],
      ["latitude", numberCodec()],
    ])
  );
  return {
    snapshot(value, active) {
      const point = validateGeoPoint(value);
      return point.issues
        ? failCacheSnapshot()
        : coordinates.snapshot(point.value, active);
    },
    materialize(snapshot, active) {
      const point = validateGeoPoint(coordinates.materialize(snapshot, active));
      return point.issues ? failCacheSnapshot() : point.value;
    },
  };
}

function primitiveCodec(
  snapshot: (value: unknown) => unknown,
  materialize: (snapshot: unknown) => unknown
): ValueCodec {
  return { snapshot, materialize };
}

function materializeArray<Value>(
  snapshot: unknown,
  active: WeakSet<object>,
  materialize: (values: readonly unknown[]) => Value
): Value {
  if (typeof snapshot !== "object" || snapshot === null) {
    return failCacheSnapshot();
  }
  return withSnapshotObject(active, snapshot, () =>
    materialize(readSnapshotArray(snapshot))
  );
}
