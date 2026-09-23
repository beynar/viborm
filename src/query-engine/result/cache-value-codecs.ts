import type { Scalar } from "@schema/scalars";
import {
  canonicalizeMaterializedDecimal,
  type DecimalDescriptor,
  decodeFieldScalar,
  decodeWidenedSum,
  toDecimal,
} from "@validation/primitives/decimal-codec";
import { validateGeoPoint } from "@validation/primitives/geo-point-codec";
import { carriesRepeatedKey } from "@validation/relations/recurrence";
import { materializeJsonValue, snapshotJsonValue } from "./cache-json-codec";
import {
  decodeSnapshotCount,
  decodeSnapshotNumber,
  defineSnapshotProperty,
  encodeSnapshotCount,
  encodeSnapshotNumber,
  enterSnapshotObject,
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
    // biome-ignore lint/style/useDefaultSwitchClause: the scalar state union is exhaustive; a default would be dead code.
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

/** The prepared facts of one recursive relation slot a cache entry keeps. */
interface RecursiveRelationSlot {
  /** The asking relation: the key every continued occurrence repeats. */
  readonly relation: string;
  /** An array of occurrences, or one occurrence. */
  readonly many: boolean;
  /** Whether a singular slot may end in `null`; a collection ends in `[]`. */
  readonly optional: boolean;
  /** The numeric cutoff level, or `false` for an exhaustive traversal. */
  readonly depth: number | false;
}

/**
 * One recursive relation slot, stored and restored exactly as it was published.
 *
 * The decoder already answered every traversal question — which rows, which
 * paths, which cycles to refuse or prune — so this codec asks none of them and
 * never reads an identity. The slot's own occurrences are level 1; an
 * occurrence at level `L` carries the repeated key exactly when
 * `depth === false || L < depth`, holding the level `L + 1` slot, and at the
 * numeric cutoff the key is ABSENT. Its snapshot is a tuple stating the same
 * fact — `[node]` at the cutoff, `[node, slot]` before it — and both directions
 * hold their input to it. `node` is the ORDINARY node codec: the repeated key
 * is separated from the occurrence's own fields, which keep its exact-key
 * checks, and is defined back onto the fresh node it materializes.
 *
 * Data depth is iterated, never recursed: a chain is as deep as its data, and
 * the call stack holds only the finite projection. One enter/leave discipline
 * serves both directions — an occurrence joins the SAME active set every
 * ordinary codec uses and leaves it when its own slot completes — so a cyclic
 * value or snapshot is refused at its first re-entry, while one row published
 * as two objects is two occurrences, not a cycle.
 */
export function recursiveRelationCodec(
  slot: RecursiveRelationSlot,
  node: ValueCodec
): ValueCodec {
  return {
    snapshot: (value, active) =>
      walkRecursiveSlot(value, active, slot, {
        read(occurrence) {
          const own: Record<string, unknown> = {};
          const successors: unknown[] = [];
          for (const [key, item] of readSnapshotRecord(occurrence)) {
            if (key === slot.relation) successors.push(item);
            else defineSnapshotProperty(own, key, item);
          }
          return [node.snapshot(own, active), successors];
        },
        write: (row, successors) => [row, ...successors],
      }),
    materialize: (snapshot, active) =>
      walkRecursiveSlot(snapshot, active, slot, {
        read(occurrence) {
          const [row, ...successors] = readSnapshotArray(occurrence);
          return [node.materialize(row, active), successors];
        },
        write(row, successors) {
          // `node` is the ordinary record codec, whose answer is a fresh record.
          if (successors.length > 0) {
            defineSnapshotProperty(
              row as Record<string, unknown>,
              slot.relation,
              successors[0]
            );
          }
          return row;
        },
      }),
  };
}

/** One direction of a recursive slot, over one entered occurrence. */
interface RecursiveDirection {
  /** The occurrence's node output, and the slot inputs it holds. */
  read(
    occurrence: object
  ): readonly [node: unknown, successors: readonly unknown[]];
  /** The occurrence's output: its node output, and its slot output if any. */
  write(node: unknown, successors: readonly unknown[]): unknown;
}

/**
 * One slot on the walk's current path: the occurrences it holds, the outputs
 * already written for them, and the occurrence that repeats it (none for the
 * outer slot) with that occurrence's node output.
 */
interface RecursiveFrame {
  readonly level: number;
  readonly occurrences: readonly unknown[];
  readonly outputs: unknown[];
  readonly owner: object | undefined;
  readonly node: unknown;
  next: number;
}

/**
 * Walk one recursive slot with an explicit stack of the slots on the current
 * path. An occurrence is entered when it is reached and left when its own slot
 * completes, so the active set holds exactly the occurrences on the path: every
 * cycle a slot can close passes through one of them.
 */
function walkRecursiveSlot(
  value: unknown,
  active: WeakSet<object>,
  slot: RecursiveRelationSlot,
  direction: RecursiveDirection
): unknown {
  const open = (
    input: unknown,
    level: number,
    owner?: object,
    node?: unknown
  ): RecursiveFrame => {
    let occurrences: readonly unknown[];
    if (slot.many) occurrences = readSnapshotArray(input);
    else if (input !== null) occurrences = [input];
    else occurrences = slot.optional ? [] : failCacheSnapshot();
    return { level, occurrences, outputs: [], owner, node, next: 0 };
  };
  const stack: RecursiveFrame[] = [open(value, 1)];
  let published: unknown;
  while (stack.length > 0) {
    const frame = stack.at(-1) as RecursiveFrame;
    if (frame.next < frame.occurrences.length) {
      const occurrence = frame.occurrences[frame.next];
      frame.next += 1;
      if (typeof occurrence !== "object" || occurrence === null) {
        return failCacheSnapshot();
      }
      enterSnapshotObject(active, occurrence);
      const continues = carriesRepeatedKey(slot.depth, frame.level);
      const [node, successors] = direction.read(occurrence);
      // The repeated slot exists exactly when the occurrence continues.
      if (successors.length !== (continues ? 1 : 0)) {
        return failCacheSnapshot();
      }
      if (continues) {
        stack.push(open(successors[0], frame.level + 1, occurrence, node));
        continue;
      }
      active.delete(occurrence);
      frame.outputs.push(direction.write(node, successors));
      continue;
    }
    stack.pop();
    const output = slot.many ? frame.outputs : (frame.outputs[0] ?? null);
    if (frame.owner === undefined) {
      published = output;
      continue;
    }
    // A repeated slot's owner sits in the frame beneath it.
    const parent = stack.at(-1) as RecursiveFrame;
    active.delete(frame.owner);
    parent.outputs.push(direction.write(frame.node, [output]));
  }
  return published;
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
