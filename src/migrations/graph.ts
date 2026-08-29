/**
 * One immutable estate graph. Commands consume this instance; they do not
 * rescan storage or invent apply order from names.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import { emptyManagedSnapshot } from "./empty-snapshot";
import type { Sha256 } from "./identity";
import { sliceDispatch, validateSqlRanges } from "./sql-blob";
import { assertArtifactExecutionSafe } from "./statement-safety";
import type { MigrationStorageReader } from "./storage/contract";
import type { SchemaSnapshot } from "./types";
import {
  encodeSnapshot,
  encodeSqlBlob,
  parseEstateDescriptor,
  parseSnapshotDocument,
  parseStateManifest,
} from "./v1-parse";
import type {
  MigrationBooleanCheckV1,
  MigrationDispatchV1,
  MigrationEstateDescriptorV1,
  MigrationOperationV1,
  MigrationParentTransitionV1,
  MigrationStateManifestV1,
  PathWitness,
  StateSelector,
} from "./v1-types";

export interface MigrationGraph {
  readonly estateHash: Sha256;
  readonly descriptor: MigrationEstateDescriptorV1;
  readonly states: ReadonlyMap<Sha256, MigrationStateManifestV1>;
  readonly snapshots: ReadonlyMap<Sha256, SchemaSnapshot>;
  readonly sql: ReadonlyMap<Sha256, Uint8Array>;
  readonly roots: readonly Sha256[];
  readonly leaves: readonly Sha256[];
  readonly emptySnapshotHash: Sha256;
}

/** Resolve one authenticated graph state to its already-parsed snapshot. */
export function requireStateSnapshot(
  graph: MigrationGraph,
  stateId: Sha256 | null
): SchemaSnapshot {
  const snapshotHash =
    stateId === null
      ? graph.emptySnapshotHash
      : graph.states.get(stateId)?.snapshotHash;
  const snapshot = snapshotHash ? graph.snapshots.get(snapshotHash) : undefined;
  if (!snapshot) {
    throw new MigrationError(
      "A selected state is missing its authenticated snapshot",
      VibORMErrorCode.MIGRATION_CORRUPTION
    );
  }
  return snapshot;
}

export async function loadMigrationGraph(
  storage: MigrationStorageReader
): Promise<MigrationGraph> {
  const estateBytes = await storage.readEstate();
  if (!estateBytes) {
    throw new MigrationError(
      "Estate descriptor is missing",
      VibORMErrorCode.MIGRATION_INVALID_ESTATE
    );
  }
  const { descriptor, estateHash } = parseEstateDescriptor(estateBytes);
  const emptySnapshotHash = encodeSnapshot(emptyManagedSnapshot()).snapshotHash;
  const stateIds = await storage.listStates();
  const states = new Map<Sha256, MigrationStateManifestV1>();
  const neededSnapshots = new Set<Sha256>([emptySnapshotHash]);
  const neededSql = new Set<Sha256>();

  for (const id of stateIds) {
    const bytes = await storage.readState(id);
    if (!bytes) {
      throw new MigrationError(
        `State ${id} is listed but unreadable`,
        VibORMErrorCode.MIGRATION_CORRUPTION
      );
    }
    if (states.has(id)) {
      throw new MigrationError(
        `State ${id} is listed more than once`,
        VibORMErrorCode.MIGRATION_CORRUPTION
      );
    }
    const manifest = parseStateManifest(bytes, id);
    if (manifest.estateHash !== estateHash) {
      throw new MigrationError(
        `State ${id} belongs to a different estate`,
        VibORMErrorCode.MIGRATION_INVALID_ESTATE
      );
    }
    states.set(id, manifest);
    neededSnapshots.add(manifest.snapshotHash);
    neededSql.add(manifest.sqlHash);
  }

  const snapshots = new Map<Sha256, SchemaSnapshot>();
  snapshots.set(emptySnapshotHash, emptyManagedSnapshot());
  for (const hash of neededSnapshots) {
    if (hash === emptySnapshotHash) continue;
    const bytes = await storage.readSnapshot(hash);
    if (!bytes) {
      throw new MigrationError(
        `Snapshot ${hash} is referenced but missing`,
        VibORMErrorCode.MIGRATION_CORRUPTION
      );
    }
    snapshots.set(hash, parseSnapshotDocument(bytes, hash));
  }

  const sql = new Map<Sha256, Uint8Array>();
  for (const hash of neededSql) {
    const bytes = await storage.readSql(hash);
    if (!bytes) {
      throw new MigrationError(
        `SQL blob ${hash} is referenced but missing`,
        VibORMErrorCode.MIGRATION_CORRUPTION
      );
    }
    if (encodeSqlBlob(bytes) !== hash) {
      throw new MigrationError(
        `SQL blob ${hash} does not match its bytes`,
        VibORMErrorCode.MIGRATION_CORRUPTION
      );
    }
    sql.set(hash, bytes);
  }

  for (const manifest of states.values()) {
    const blob = sql.get(manifest.sqlHash);
    if (!blob) continue;
    const dispatches: MigrationDispatchV1[] = [];
    for (const parent of manifest.parents) {
      collectDispatches(parent, dispatches);
    }
    collectChecks(manifest.destinationChecks, dispatches);
    validateSqlRanges(blob, dispatches);
    assertStoredParameterDialect(
      dispatches,
      descriptor.target.dialect,
      manifest.name
    );
    assertArtifactExecutionSafe(
      dispatches.map((dispatch) => sliceDispatch(blob, dispatch)),
      descriptor.target.dialect,
      manifest.name
    );
  }

  const outgoing = new Map<Sha256, Sha256[]>();
  for (const id of states.keys()) {
    outgoing.set(id, []);
  }

  for (const [id, manifest] of states) {
    for (const parent of manifest.parents) {
      if (parent.fromState === null) continue;
      if (!states.has(parent.fromState)) {
        throw new MigrationError(
          `State ${id} has a dangling parent`,
          VibORMErrorCode.MIGRATION_INVALID_ESTATE
        );
      }
      outgoing.get(parent.fromState)!.push(id);
    }
  }

  const roots = [...states.keys()].filter((id) =>
    states.get(id)!.parents.some((parent) => parent.fromState === null)
  );
  const leaves = [...states.keys()].filter(
    (id) => (outgoing.get(id) ?? []).length === 0
  );
  assertNoCycle(states, outgoing);

  if (states.size > 0 && roots.length === 0) {
    throw new MigrationError(
      "Estate has states but no virtual-root transition",
      VibORMErrorCode.MIGRATION_INVALID_ESTATE
    );
  }
  assertReachableFromEmpty(states, outgoing, roots);

  return {
    estateHash,
    descriptor,
    states,
    snapshots,
    sql,
    roots,
    leaves,
    emptySnapshotHash,
  };
}

/**
 * The symbolic namespace is one portable MySQL artifact value. PostgreSQL
 * stores its schema in the estate target and SQLite has no namespace, so the
 * tag in either estate is corruption rather than an executable parameter.
 */
function assertStoredParameterDialect(
  dispatches: readonly MigrationDispatchV1[],
  dialect: MigrationEstateDescriptorV1["target"]["dialect"],
  artifact: string
): void {
  if (dialect === "mysql") {
    return;
  }
  for (const dispatch of dispatches) {
    if (
      dispatch.parameters.some(
        (parameter) => parameter.kind === "target-namespace"
      )
    ) {
      throw new MigrationError(
        `Migration "${artifact}" contains a target-namespace parameter outside a MySQL estate`,
        VibORMErrorCode.MIGRATION_INVALID_STATE,
        { meta: { migrationName: artifact } }
      );
    }
  }
}

function collectDispatches(
  parent: MigrationParentTransitionV1,
  into: MigrationDispatchV1[]
): void {
  collectChecks(parent.originChecks, into);
  collectOperations(parent.operations, into);
  if (parent.rollback.kind !== "irreversible") {
    collectOperations(parent.rollback.operations, into);
  }
}

function collectOperations(
  operations: readonly MigrationOperationV1[],
  into: MigrationDispatchV1[]
): void {
  for (const operation of operations) {
    for (const step of operation.steps) {
      if (step.retry === "proven") {
        into.push(step.precheck.query);
      }
      into.push(step.execute);
      if (step.retry === "proven") {
        into.push(step.postcheck.query);
      }
    }
  }
}

function collectChecks(
  checks: readonly MigrationBooleanCheckV1[],
  into: MigrationDispatchV1[]
): void {
  for (const check of checks) {
    into.push(check.query);
  }
}

function assertNoCycle(
  states: ReadonlyMap<Sha256, MigrationStateManifestV1>,
  outgoing: ReadonlyMap<Sha256, readonly Sha256[]>
): void {
  const color = new Map<Sha256, 0 | 1 | 2>();
  for (const id of states.keys()) color.set(id, 0);
  for (const start of states.keys()) {
    if (color.get(start) !== 0) continue;
    const stack: Array<{ id: Sha256; next: number }> = [{ id: start, next: 0 }];
    color.set(start, 1);
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      const edges = outgoing.get(frame.id) ?? [];
      if (frame.next < edges.length) {
        const next = edges[frame.next++]!;
        const seen = color.get(next) ?? 0;
        if (seen === 1) {
          throw new MigrationError(
            "Estate graph contains a cycle",
            VibORMErrorCode.MIGRATION_INVALID_ESTATE
          );
        }
        if (seen === 0) {
          color.set(next, 1);
          stack.push({ id: next, next: 0 });
        }
        continue;
      }
      color.set(frame.id, 2);
      stack.pop();
    }
  }
}

function assertReachableFromEmpty(
  states: ReadonlyMap<Sha256, MigrationStateManifestV1>,
  outgoing: ReadonlyMap<Sha256, readonly Sha256[]>,
  roots: readonly Sha256[]
): void {
  const reachable = new Set<Sha256>();
  const pending = [...roots];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const child of outgoing.get(id) ?? []) {
      pending.push(child);
    }
  }
  for (const id of states.keys()) {
    if (!reachable.has(id)) {
      throw new MigrationError(
        `State ${id} is not reachable from the empty state`,
        VibORMErrorCode.MIGRATION_INVALID_ESTATE
      );
    }
  }
}

export function resolveStateSelector(
  graph: MigrationGraph,
  selector: StateSelector | undefined
): Sha256 {
  if (!selector) {
    if (graph.leaves.length === 1) return graph.leaves[0]!;
    if (graph.leaves.length === 0) {
      throw new MigrationError(
        "Estate has no states to target",
        VibORMErrorCode.MIGRATION_NOT_FOUND
      );
    }
    throw pathRequired(graph.leaves.map((leaf) => [leaf]));
  }
  if ("id" in selector) {
    if (!graph.states.has(selector.id)) {
      throw new MigrationError(
        `Unknown state ${selector.id}`,
        VibORMErrorCode.MIGRATION_NOT_FOUND
      );
    }
    return selector.id;
  }
  if ("prefix" in selector) {
    const matches = [...graph.states.keys()].filter((id) =>
      id.startsWith(selector.prefix)
    );
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) {
      throw new MigrationError(
        `No state has prefix ${selector.prefix}`,
        VibORMErrorCode.MIGRATION_NOT_FOUND
      );
    }
    throw pathRequired(matches.map((id) => [id]));
  }
  const matches = [...graph.states.values()]
    .filter((state) => state.name === selector.name)
    .map((state) => state.stateId);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new MigrationError(
      `No state is named ${selector.name}`,
      VibORMErrorCode.MIGRATION_NOT_FOUND
    );
  }
  throw pathRequired(matches.map((id) => [id]));
}

export function selectRoute(
  graph: MigrationGraph,
  origin: Sha256 | null,
  target: Sha256,
  via?: readonly Sha256[]
): readonly Sha256[] {
  if (via && via.length > 0) {
    if (via.at(-1) !== target) {
      throw new MigrationError(
        "via must end at the resolved target",
        VibORMErrorCode.MIGRATION_PATH_REQUIRED
      );
    }
    const seen = new Set<string>();
    let previous = origin;
    for (const step of via) {
      if (seen.has(step)) {
        throw new MigrationError(
          "via repeats a state",
          VibORMErrorCode.MIGRATION_PATH_REQUIRED
        );
      }
      seen.add(step);
      if (!hasEdge(graph, previous, step)) {
        throw new MigrationError(
          "via is not a real estate edge",
          VibORMErrorCode.MIGRATION_PATH_REQUIRED
        );
      }
      previous = step;
    }
    return via;
  }

  const routes = enumerateRoutes(graph, origin, target, 2);
  if (routes.length === 1) return routes[0]!;
  if (routes.length === 0) {
    throw new MigrationError(
      "No path exists from the current marker to the target",
      VibORMErrorCode.MIGRATION_NOT_FOUND
    );
  }
  throw pathRequired(routes);
}

function hasEdge(
  graph: MigrationGraph,
  from: Sha256 | null,
  to: Sha256
): boolean {
  const state = graph.states.get(to);
  if (!state) return false;
  return state.parents.some((parent) => parent.fromState === from);
}

function childrenIndex(graph: MigrationGraph): Map<string, Sha256[]> {
  const index = new Map<string, Sha256[]>();
  index.set("null", []);
  for (const id of graph.states.keys()) {
    index.set(id, []);
  }
  for (const [id, state] of graph.states) {
    for (const parent of state.parents) {
      const key = parent.fromState ?? "null";
      const list = index.get(key) ?? [];
      list.push(id);
      index.set(key, list);
    }
  }
  return index;
}

function enumerateRoutes(
  graph: MigrationGraph,
  origin: Sha256 | null,
  target: Sha256,
  limit: number
): Sha256[][] {
  const children = childrenIndex(graph);
  const found: Sha256[][] = [];
  const stack: Array<{ from: Sha256 | null; path: Sha256[] }> = [
    { from: origin, path: [] },
  ];
  while (stack.length > 0 && found.length < limit) {
    const frame = stack.pop()!;
    for (const child of children.get(frame.from ?? "null") ?? []) {
      if (frame.path.includes(child)) continue;
      const next = [...frame.path, child];
      if (child === target) {
        found.push(next);
        if (found.length >= limit) break;
        continue;
      }
      stack.push({ from: child, path: next });
    }
  }
  return found;
}

function pathRequired(routes: readonly (readonly Sha256[])[]): never {
  const witness: PathWitness = {
    routes: routes.slice(0, 2),
    frontier: firstFrontier(routes),
    more: routes.length > 2,
  };
  throw new MigrationError(
    `Multiple migration paths exist; pass via. Candidates: ${witness.routes
      .map((route) => route.join(" -> "))
      .join(" | ")}`,
    VibORMErrorCode.MIGRATION_PATH_REQUIRED,
    { meta: { pathWitness: witness } }
  );
}

function firstFrontier(routes: readonly (readonly Sha256[])[]): Sha256[] {
  if (routes.length < 2) return [];
  const first = routes[0]!;
  const second = routes[1]!;
  const frontier: Sha256[] = [];
  const max = Math.min(first.length, second.length);
  for (let i = 0; i < max; i++) {
    if (first[i] !== second[i]) {
      frontier.push(first[i]!, second[i]!);
      return frontier;
    }
  }
  return frontier;
}

export function parentTransition(
  graph: MigrationGraph,
  from: Sha256 | null,
  to: Sha256
): MigrationParentTransitionV1 {
  const state = graph.states.get(to);
  if (!state) {
    throw new MigrationError(
      `Unknown state ${to}`,
      VibORMErrorCode.MIGRATION_NOT_FOUND
    );
  }
  const found = state.parents.find((parent) => parent.fromState === from);
  if (!found) {
    throw new MigrationError(
      "Selected edge has no parent transition",
      VibORMErrorCode.MIGRATION_INVALID_ESTATE
    );
  }
  return found;
}
