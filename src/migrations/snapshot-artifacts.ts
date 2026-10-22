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
import type { SnapshotChangeV1, SnapshotDeltaV1 } from "./v1-types";

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
  /** Null means the observed committed graph already authenticates this object. */
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

function parseChange(value: unknown): SnapshotChangeV1 {
  if (!isRecord(value) || (value.op !== "set" && value.op !== "remove")) {
    refuse("snapshot delta change must set or remove a path");
  }
  const keys = value.op === "set" ? ["op", "path", "value"] : ["op", "path"];
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
  return value.op === "set"
    ? { op: "set", path, value: record.value }
    : { op: "remove", path };
}

function parseDelta(
  bytes: Uint8Array,
  value: unknown,
  hash: Sha256
): SnapshotDeltaV1 {
  const keys = ["format", "baseArtifactHash", "snapshotHash", "changes"];
  const record = exactObject(value, keys, keys, "snapshot delta");
  if (record.format !== "snapshot-delta-1" || !Array.isArray(record.changes)) {
    refuse("snapshot delta format or changes is invalid");
  }
  const delta: SnapshotDeltaV1 = {
    format: "snapshot-delta-1",
    baseArtifactHash: parseSha256(
      record.baseArtifactHash,
      "snapshot delta baseArtifactHash"
    ),
    snapshotHash: parseSha256(
      record.snapshotHash,
      "snapshot delta snapshotHash"
    ),
    changes: record.changes.map(parseChange),
  };
  assertCanonicalBytes(bytes, delta, "snapshot delta");
  if (domainHash(HASH_DOMAIN.snapshotDelta, bytes) !== hash) {
    corrupt(`Snapshot delta ${hash} does not match its canonical bytes`);
  }
  return delta;
}

/** A segment's spelling is interpreted only by its actual container. */
function pathLocation(
  container: unknown,
  segment: string | number,
  append: boolean
): { container: object; key: string | number } {
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
    return { container, key: segment };
  }
  if (!isRecord(container) || typeof segment !== "string") {
    refuse("snapshot delta object path must name a string key on an object");
  }
  return { container, key: segment };
}

function applyChange(document: unknown, change: SnapshotChangeV1): void {
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
    change.op === "set"
  );
  const target = location.container;
  const key = location.key;
  if (change.op === "set") {
    // defineProperty treats __proto__ as a literal key, never a prototype setter.
    Object.defineProperty(target, key, {
      value: change.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    return;
  }
  if (!Object.hasOwn(target, key))
    refuse("snapshot delta cannot remove a missing property");
  if (Array.isArray(target)) {
    if (key !== target.length - 1)
      refuse("snapshot delta array removal must remove the final element");
    target.pop();
  } else {
    Reflect.deleteProperty(target, key);
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
    applyChange(document, change);
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

function changesBetween(
  before: unknown,
  after: unknown,
  path: readonly (string | number)[],
  changes: SnapshotChangeV1[]
): void {
  if (canonicalizeJsonText(before) === canonicalizeJsonText(after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    const shared = Math.min(before.length, after.length);
    for (let index = 0; index < shared; index++)
      changesBetween(before[index], after[index], [...path, index], changes);
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
        changesBetween(before[key], after[key], [...path, key], changes);
      else changes.push({ op: "set", path: [...path, key], value: after[key] });
    }
  } else {
    changes.push({ op: "set", path, value: after });
  }
}

/** Deterministic against the observed graph, independent of storage listing order. */
export function encodeSnapshotArtifact(
  snapshot: SchemaSnapshot,
  artifacts: ReadonlyMap<Sha256, ResolvedSnapshotArtifact>,
  parentArtifacts: Iterable<Sha256>
): EncodedSnapshotArtifact {
  const full = encodeSnapshot(snapshot);
  const bases = [...new Set(parentArtifacts)].sort();
  // Authored checkpoints must stand alone after pruning the preceding history.
  if (bases.length === 0)
    return { artifactHash: full.snapshotHash, ...full, depth: 0 };
  for (const hash of [...artifacts.keys()].sort()) {
    if (artifacts.get(hash)!.snapshotHash === full.snapshotHash) {
      // Reuse authenticated immutable bytes; publication can omit this object.
      return {
        artifactHash: hash,
        snapshotHash: full.snapshotHash,
        bytes: null,
        depth: artifacts.get(hash)!.depth,
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
    const changes: SnapshotChangeV1[] = [];
    changesBetween(
      parseJsonBytes(encodeSnapshot(base.snapshot).bytes, "snapshot base"),
      desired,
      [],
      changes
    );
    const delta: SnapshotDeltaV1 = {
      format: "snapshot-delta-1",
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
  return best;
}
