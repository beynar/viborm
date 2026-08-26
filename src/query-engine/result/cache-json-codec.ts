import {
  decodeSnapshotNumber,
  defineSnapshotProperty,
  encodeSnapshotNumber,
  failCacheSnapshot,
  readSnapshotArray,
  readSnapshotRecord,
  withSnapshotObject,
} from "./cache-snapshot-structure";

const JSON_NULL = "null";
const JSON_STRING = "string";
const JSON_BOOLEAN = "boolean";
const JSON_NUMBER = "number";
const JSON_ARRAY = "array";
const JSON_OBJECT = "object";

export function snapshotJsonValue(
  value: unknown,
  active: WeakSet<object>
): unknown {
  if (value === null) return [JSON_NULL];
  if (typeof value === "string") return [JSON_STRING, value];
  if (typeof value === "boolean") return [JSON_BOOLEAN, value];
  if (typeof value === "number") {
    return [JSON_NUMBER, encodeSnapshotNumber(value)];
  }
  if (Array.isArray(value)) {
    return withSnapshotObject(active, value, () => [
      JSON_ARRAY,
      readSnapshotArray(value).map((item) => snapshotJsonValue(item, active)),
    ]);
  }
  if (typeof value === "object" && value !== null) {
    return withSnapshotObject(active, value, () => [
      JSON_OBJECT,
      readSnapshotRecord(value, true).map(([key, item]) => [
        key,
        snapshotJsonValue(item, active),
      ]),
    ]);
  }
  return failCacheSnapshot();
}

export function materializeJsonValue(
  snapshot: unknown,
  active: WeakSet<object>
): unknown {
  if (typeof snapshot !== "object" || snapshot === null) {
    return failCacheSnapshot();
  }
  return withSnapshotObject(active, snapshot, () => {
    const node = readSnapshotArray(snapshot);
    const tag = node[0];
    if (tag === JSON_NULL && node.length === 1) return null;
    if (
      tag === JSON_STRING &&
      node.length === 2 &&
      typeof node[1] === "string"
    ) {
      return node[1];
    }
    if (
      tag === JSON_BOOLEAN &&
      node.length === 2 &&
      typeof node[1] === "boolean"
    ) {
      return node[1];
    }
    if (tag === JSON_NUMBER && node.length === 2) {
      return decodeSnapshotNumber(node[1]);
    }
    if (tag === JSON_ARRAY && node.length === 2) {
      return materializeJsonArray(node[1], active);
    }
    if (tag === JSON_OBJECT && node.length === 2) {
      return materializeJsonObject(node[1], active);
    }
    return failCacheSnapshot();
  });
}

function materializeJsonArray(
  snapshot: unknown,
  active: WeakSet<object>
): unknown[] {
  if (typeof snapshot !== "object" || snapshot === null) {
    return failCacheSnapshot();
  }
  return withSnapshotObject(active, snapshot, () =>
    readSnapshotArray(snapshot).map((item) =>
      materializeJsonValue(item, active)
    )
  );
}

function materializeJsonObject(
  snapshot: unknown,
  active: WeakSet<object>
): Record<string, unknown> {
  if (typeof snapshot !== "object" || snapshot === null) {
    return failCacheSnapshot();
  }
  return withSnapshotObject(active, snapshot, () => {
    const entries = readSnapshotArray(snapshot);
    const result: Record<string, unknown> = {};
    const seen = new Set<string>();
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) {
        return failCacheSnapshot();
      }
      const pair = withSnapshotObject(active, entry, () =>
        readSnapshotArray(entry)
      );
      const key = pair[0];
      if (pair.length !== 2 || typeof key !== "string" || seen.has(key)) {
        return failCacheSnapshot();
      }
      seen.add(key);
      defineSnapshotProperty(
        result,
        key,
        materializeJsonValue(pair[1], active)
      );
    }
    return result;
  });
}
