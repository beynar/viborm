/**
 * Stored snapshot representation. Logical identity remains the canonical full
 * schema hash; deltas have their own exact-byte address. No DDL meaning lives
 * here. Every consumer receives the existing strictly admitted full schema.
 */
import { MigrationError, VibORMErrorCode } from "../errors";
import { isRecord } from "../validation/value-guards";
import {
  assertCanonicalBytes,
  canonicalizeJson,
  canonicalizeJsonText,
  parseJsonBytes,
} from "./canonical-json";
import { domainHash, HASH_DOMAIN, parseSha256, type Sha256 } from "./identity";
import type { MigrationStorageReader } from "./storage/contract";
import type { SchemaSnapshot } from "./types";
import { exactObject, refuse } from "./v1-parse-shared";
import { encodeSnapshot, parseSnapshotDocument } from "./v1-parse-snapshot";
import type {
  SnapshotChangeV1,
  SnapshotDeltaFormat,
  SnapshotDeltaV1,
} from "./v1-types";

export const MAX_SNAPSHOT_DELTA_DEPTH = 32;

export interface ResolvedSnapshotArtifact {
  readonly snapshot: SchemaSnapshot;
  readonly snapshotHash: Sha256;
  readonly depth: number;
  readonly baseArtifactHash?: Sha256;
  /** Detached exact bytes admitted for this command, used by history copying. */
  readonly bytes: Uint8Array;
}

export interface EncodedSnapshotArtifact {
  readonly artifactHash: Sha256;
  readonly snapshotHash: Sha256;
  /** Null means an authenticated or candidate-owned object can be reused. */
  readonly bytes: Uint8Array | null;
  readonly depth: number;
  readonly baseArtifactHash?: Sha256;
}

export type ParsedSnapshotArtifact =
  | { readonly kind: "full"; readonly snapshot: SchemaSnapshot }
  | {
      readonly kind: "delta";
      readonly delta: SnapshotDeltaV1;
      readonly snapshot?: SchemaSnapshot;
    };

export interface SnapshotArtifactCache {
  storedSnapshot(bytes: Uint8Array, hash: Sha256): ParsedSnapshotArtifact;
  rememberSnapshot(
    hash: Sha256,
    bytes: Uint8Array,
    snapshot: SchemaSnapshot
  ): void;
}

export function parseSnapshotArtifact(
  bytes: Uint8Array,
  hash: Sha256
): ParsedSnapshotArtifact {
  const value = parseJsonBytes(bytes, `snapshots/${hash}.json`);
  return isRecord(value) && "format" in value
    ? { kind: "delta", delta: parseDelta(bytes, value, hash) }
    : { kind: "full", snapshot: parseSnapshotDocument(bytes, hash) };
}

function corrupt(message: string): never {
  throw new MigrationError(message, VibORMErrorCode.MIGRATION_CORRUPTION);
}

function parseChange(
  value: unknown,
  format: SnapshotDeltaFormat
): SnapshotChangeV1 {
  const inserts = format === "snapshot-delta-2";
  if (
    !isRecord(value) ||
    (value.op !== "set" &&
      value.op !== "remove" &&
      !(inserts && value.op === "insert"))
  ) {
    refuse(
      inserts
        ? "snapshot delta change must set, insert or remove a path"
        : "snapshot delta change must set or remove a path"
    );
  }
  const keys = value.op === "remove" ? ["op", "path"] : ["op", "path", "value"];
  const record = exactObject(value, keys, keys, "snapshot delta change");
  if (!Array.isArray(record.path) || record.path.length === 0) {
    refuse("snapshot delta path must be a non-empty array");
  }
  const path = record.path.map((segment) => {
    if (typeof segment === "string") return segment;
    if (
      typeof segment === "number" &&
      Number.isSafeInteger(segment) &&
      segment >= 0
    )
      return segment;
    return refuse(
      "snapshot delta path segments must be strings or nonnegative safe integers"
    );
  });
  return value.op === "remove"
    ? { op: "remove", path }
    : { op: value.op, path, value: record.value };
}

function parseDelta(
  bytes: Uint8Array,
  value: unknown,
  hash: Sha256
): SnapshotDeltaV1 {
  const keys = ["format", "baseArtifactHash", "snapshotHash", "changes"];
  const record = exactObject(value, keys, keys, "snapshot delta");
  const format = record.format;
  if (
    typeof format === "string" &&
    format.startsWith("snapshot-delta-") &&
    format !== "snapshot-delta-1" &&
    format !== "snapshot-delta-2"
  ) {
    refuse(
      `snapshot delta format ${format} is not one this engine reads; a newer VibORM may have written it`
    );
  }
  if (
    (format !== "snapshot-delta-1" && format !== "snapshot-delta-2") ||
    !Array.isArray(record.changes)
  ) {
    refuse("snapshot delta format or changes is invalid");
  }
  const delta: SnapshotDeltaV1 = {
    format,
    baseArtifactHash: parseSha256(
      record.baseArtifactHash,
      "snapshot delta baseArtifactHash"
    ),
    snapshotHash: parseSha256(
      record.snapshotHash,
      "snapshot delta snapshotHash"
    ),
    changes: record.changes.map((change) => parseChange(change, format)),
  };
  assertCanonicalBytes(bytes, delta, "snapshot delta");
  if (domainHash(HASH_DOMAIN.snapshotDelta, bytes) !== hash) {
    corrupt(`Snapshot delta ${hash} does not match its canonical bytes`);
  }
  return delta;
}

type PathLocation =
  | {
      readonly kind: "array";
      readonly container: unknown[];
      readonly key: number;
    }
  | {
      readonly kind: "object";
      readonly container: Record<string, unknown>;
      readonly key: string;
    };

/** A segment's spelling is interpreted only by its actual container. */
function pathLocation(
  container: unknown,
  segment: string | number,
  append: boolean
): PathLocation {
  if (Array.isArray(container)) {
    if (
      typeof segment !== "number" ||
      segment > container.length ||
      (!append && segment === container.length)
    ) {
      refuse(
        "snapshot delta array path must name an existing index or append at length"
      );
    }
    return { kind: "array", container, key: segment };
  }
  if (!isRecord(container) || typeof segment !== "string") {
    refuse("snapshot delta object path must name a string key on an object");
  }
  return { kind: "object", container, key: segment };
}

function applyChange(
  document: unknown,
  change: SnapshotChangeV1,
  format: SnapshotDeltaFormat
): void {
  let container = document;
  for (const segment of change.path.slice(0, -1)) {
    const location = pathLocation(container, segment, false);
    const descriptor = Object.getOwnPropertyDescriptor(
      location.container,
      location.key
    );
    if (!descriptor)
      refuse("snapshot delta path has a missing intermediate property");
    container = descriptor.value;
  }
  const location = pathLocation(
    container,
    change.path.at(-1)!,
    change.op !== "remove"
  );
  if (change.op === "insert") {
    if (location.kind !== "array")
      refuse("snapshot delta insert must name an array index");
    location.container.splice(location.key, 0, change.value);
    return;
  }
  if (change.op === "set") {
    // defineProperty treats __proto__ as a literal key, never a prototype setter.
    Object.defineProperty(location.container, location.key, {
      value: change.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    return;
  }
  if (!Object.hasOwn(location.container, location.key))
    refuse("snapshot delta cannot remove a missing property");
  if (location.kind === "array") {
    const { container: array, key: index } = location;
    if (format === "snapshot-delta-1" && index !== array.length - 1)
      refuse("snapshot delta array removal must remove the final element");
    array.splice(index, 1);
  } else {
    Reflect.deleteProperty(location.container, location.key);
  }
}

/** Mutations stay on an independently owned JSON document, including on failure. */
function reconstruct(
  base: SchemaSnapshot,
  delta: SnapshotDeltaV1
): SchemaSnapshot {
  const document = parseJsonBytes(
    encodeSnapshot(base).bytes,
    "snapshot delta base"
  );
  // Cached deltas are frozen and shared; set values belong to this document.
  for (const change of structuredClone(delta.changes))
    applyChange(document, change, delta.format);
  return parseSnapshotDocument(canonicalizeJson(document), delta.snapshotHash);
}

/**
 * Resolve by physical identity, not logical schema. Absolute depth survives
 * memoization; both a cold chain and a child of a cached chain obey one limit.
 * The same map may be extended to validate orphans, after retaining the separate
 * committed-state dependency closure.
 */
export async function resolveSnapshotArtifacts(
  storage: MigrationStorageReader,
  roots: Iterable<Sha256>,
  resolved = new Map<Sha256, ResolvedSnapshotArtifact>(),
  cache?: SnapshotArtifactCache
): Promise<Map<Sha256, ResolvedSnapshotArtifact>> {
  for (const root of roots) {
    const pending: {
      hash: Sha256;
      delta: SnapshotDeltaV1;
      bytes: Uint8Array;
      snapshot?: SchemaSnapshot;
    }[] = [];
    let hash = root;
    while (!resolved.has(hash)) {
      const bytes = await storage.readSnapshot(hash);
      if (!bytes) corrupt(`Snapshot ${hash} is referenced but missing`);
      const artifact =
        cache?.storedSnapshot(bytes, hash) ??
        parseSnapshotArtifact(bytes, hash);
      if (artifact.kind === "delta") {
        const delta = artifact.delta;
        pending.push({
          hash,
          delta,
          bytes: bytes.slice(),
          snapshot: artifact.snapshot,
        });
        if (pending.length > MAX_SNAPSHOT_DELTA_DEPTH)
          refuse("snapshot delta chain exceeds 32 links");
        hash = delta.baseArtifactHash;
      } else {
        resolved.set(hash, {
          snapshot: artifact.snapshot,
          snapshotHash: hash,
          depth: 0,
          bytes: bytes.slice(),
        });
      }
    }
    for (let index = pending.length - 1; index >= 0; index--) {
      const entry = pending[index]!;
      const base = resolved.get(entry.delta.baseArtifactHash)!;
      const depth = base.depth + 1;
      if (depth > MAX_SNAPSHOT_DELTA_DEPTH)
        refuse("snapshot delta chain exceeds 32 links");
      // A cached result is eligible only after every base has been re-read and
      // authenticated, and the absolute dependency depth has been checked.
      const snapshot =
        entry.snapshot ?? reconstruct(base.snapshot, entry.delta);
      cache?.rememberSnapshot(entry.hash, entry.bytes, snapshot);
      resolved.set(entry.hash, {
        snapshot,
        snapshotHash: entry.delta.snapshotHash,
        depth,
        baseArtifactHash: entry.delta.baseArtifactHash,
        bytes: entry.bytes,
      });
    }
  }
  return resolved;
}

/**
 * An array's element identities when every element has a distinct one: a
 * record's `name` (tables, columns, indexes, constraints, enums) or the string
 * itself (enum values, column lists). Otherwise the array diffs by position.
 */
function elementKeys(array: readonly unknown[]): string[] | undefined {
  const keys = new Set<string>();
  for (const element of array) {
    let key: string | undefined;
    if (typeof element === "string") key = `s:${element}`;
    else if (isRecord(element) && typeof element.name === "string")
      key = `n:${element.name}`;
    if (key === undefined || keys.has(key)) return undefined;
    keys.add(key);
  }
  return [...keys];
}

/**
 * The before-indexes of the most shared keys that keep their relative order:
 * with distinct keys, the longest common subsequence is the longest increasing
 * run of after-positions, found in O(n log n) by patience sorting.
 */
function keptInOrder(
  before: readonly string[],
  after: readonly string[]
): Set<number> {
  const position = new Map(after.map((key, index) => [key, index]));
  // tails[length - 1] is the before-index ending the lowest run of that length.
  const tails: number[] = [];
  const previous = new Map<number, number>();
  for (const [index, key] of before.entries()) {
    const target = position.get(key);
    if (target === undefined) continue;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (position.get(before[tails[middle]!]!)! < target) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous.set(index, tails[low - 1]!);
    tails[low] = index;
  }
  const kept = new Set<number>();
  for (
    let index = tails.at(-1);
    index !== undefined;
    index = previous.get(index)
  )
    kept.add(index);
  return kept;
}

/**
 * Keyed edits leave one element's insertion at one change however many follow
 * it: drop the elements that are not kept, last first, then insert the new and
 * moved ones at their final indexes in order, then edit the kept pairs there.
 */
function keyedChangesBetween(
  before: readonly unknown[],
  after: readonly unknown[],
  beforeKeys: readonly string[],
  afterKeys: readonly string[],
  path: readonly (string | number)[],
  changes: SnapshotChangeV1[]
): void {
  const kept = keptInOrder(beforeKeys, afterKeys);
  const keptAt = new Map([...kept].map((index) => [beforeKeys[index]!, index]));
  for (let index = before.length - 1; index >= 0; index--) {
    if (!kept.has(index))
      changes.push({ op: "remove", path: [...path, index] });
  }
  for (const [index, key] of afterKeys.entries()) {
    if (!keptAt.has(key))
      changes.push({
        op: "insert",
        path: [...path, index],
        value: after[index],
      });
  }
  for (const [index, key] of afterKeys.entries()) {
    const from = keptAt.get(key);
    if (from !== undefined)
      changesBetween(
        before[from],
        after[index],
        [...path, index],
        changes,
        true
      );
  }
}

function changesBetween(
  before: unknown,
  after: unknown,
  path: readonly (string | number)[],
  changes: SnapshotChangeV1[],
  keyed: boolean
): void {
  if (canonicalizeJsonText(before) === canonicalizeJsonText(after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    const beforeKeys = keyed ? elementKeys(before) : undefined;
    const afterKeys = beforeKeys && elementKeys(after);
    if (beforeKeys && afterKeys) {
      keyedChangesBetween(before, after, beforeKeys, afterKeys, path, changes);
      return;
    }
    const shared = Math.min(before.length, after.length);
    for (let index = 0; index < shared; index++)
      changesBetween(
        before[index],
        after[index],
        [...path, index],
        changes,
        keyed
      );
    for (let index = before.length - 1; index >= after.length; index--)
      changes.push({ op: "remove", path: [...path, index] });
    for (let index = shared; index < after.length; index++)
      changes.push({ op: "set", path: [...path, index], value: after[index] });
  } else if (isRecord(before) && isRecord(after)) {
    for (const key of Object.keys(before).sort()) {
      if (!Object.hasOwn(after, key))
        changes.push({ op: "remove", path: [...path, key] });
    }
    for (const key of Object.keys(after).sort()) {
      if (Object.hasOwn(before, key))
        changesBetween(before[key], after[key], [...path, key], changes, keyed);
      else changes.push({ op: "set", path: [...path, key], value: after[key] });
    }
  } else {
    changes.push({ op: "set", path, value: after });
  }
}

/**
 * A function of the parents' artifacts alone, independent of storage listing
 * order: a state's id hashes its artifact, so the same parents and schema give
 * the same id whatever else the history holds.
 */
export function encodeSnapshotArtifact(
  snapshot: SchemaSnapshot,
  artifacts: ReadonlyMap<Sha256, ResolvedSnapshotArtifact>,
  parentArtifacts: Iterable<Sha256>
): EncodedSnapshotArtifact {
  const full = encodeSnapshot(snapshot);
  const bases = [...new Set(parentArtifacts)].sort();
  for (const hash of bases) {
    const base = artifacts.get(hash)!;
    // A parent already stores this schema; publication can omit this object.
    if (base.snapshotHash === full.snapshotHash) {
      return {
        artifactHash: hash,
        snapshotHash: full.snapshotHash,
        bytes: null,
        depth: base.depth,
      };
    }
  }
  let best: EncodedSnapshotArtifact & { readonly bytes: Uint8Array } = {
    artifactHash: full.snapshotHash,
    ...full,
    depth: 0,
  };
  const desired = parseJsonBytes(full.bytes, "desired snapshot");
  for (const baseArtifactHash of bases) {
    const base = artifacts.get(baseArtifactHash)!;
    if (base.depth >= MAX_SNAPSHOT_DELTA_DEPTH) continue;
    const document = parseJsonBytes(
      encodeSnapshot(base.snapshot).bytes,
      "snapshot base"
    );
    // Keyed edits win on insertions; positional ones still win on an element
    // renamed in place, which a keyed diff spells as a removal and an insert.
    for (const keyed of [true, false]) {
      const changes: SnapshotChangeV1[] = [];
      // Both encoded snapshots are records, so every emitted edit is below the
      // root; the producer cannot emit the empty path that admission refuses.
      changesBetween(document, desired, [], changes, keyed);
      const delta: SnapshotDeltaV1 = {
        format: "snapshot-delta-2",
        baseArtifactHash,
        snapshotHash: full.snapshotHash,
        changes,
      };
      const bytes = canonicalizeJson(delta);
      if (bytes.length < best.bytes.length) {
        best = {
          artifactHash: domainHash(HASH_DOMAIN.snapshotDelta, bytes),
          snapshotHash: full.snapshotHash,
          bytes,
          depth: base.depth + 1,
          baseArtifactHash,
        };
      }
    }
  }
  return best;
}
