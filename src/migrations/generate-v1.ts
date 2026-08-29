/**
 * V1 generation: one new state from parent leaves, published atomically.
 * Snapshot and SQL are published before the state manifest.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import { hydrateSchemaNames } from "../schema/hydration";
import {
  resolveSchemaOrThrow,
  validateSchemaOrThrow,
} from "../schema/validation";
import {
  assertManualStepwiseProof,
  compileGeneratedTransition,
  compileManualTransition,
  compileTrustedCheck,
  hashParent,
  rebindChecks,
  rebindDispatches,
  rebindRollback,
  sealParent,
} from "./compile";
import { diff } from "./differ";
import { emptyManagedSnapshot } from "./empty-snapshot";
import { loadMigrationGraph, type MigrationGraph } from "./graph";
import type { Sha256 } from "./identity";
import { getPushMigrationDriver, type MigrationClient } from "./push/planner";
import {
  alwaysAddDropResolver,
  callbackAsResolver,
  resolveAmbiguousChanges,
  strictResolver,
} from "./resolver";
import {
  assertMigrationDecimalDomainsFitProvider,
  serializeResolvedModels,
} from "./serializer";
import { SqlAssembly } from "./sql-assembly";
import type { MigrationStorageWriter } from "./storage/contract";
import { isMigrationStorageWriter } from "./storage/contract";
import { assertEstateTargetMatches } from "./target";
import type { DiffOperation } from "./types";
import { generateMigrationName, prepareSchemaProgram } from "./utils";
import {
  encodeEstateDescriptor,
  encodeSnapshot,
  encodeStateManifest,
  parseEstateDescriptor,
} from "./v1-parse";
import type {
  GenerateV1Options,
  ManualMigrationInput,
  ManualTransitionInput,
  MigrationBooleanCheckV1,
  MigrationParentTransitionV1,
  MigrationStateManifestV1,
} from "./v1-types";

export interface GenerateV1Result {
  readonly outcome: "published" | "preview" | "noop";
  readonly stateId: Sha256 | null;
  readonly name: string | null;
  readonly estateHash: Sha256 | null;
  readonly snapshotHash: Sha256 | null;
  readonly sqlHash: Sha256 | null;
  readonly operations: readonly DiffOperation[];
  readonly sql: string;
}

export async function generateV1(
  client: MigrationClient,
  storage: MigrationStorageWriter,
  options: GenerateV1Options = {}
): Promise<GenerateV1Result> {
  if (!isMigrationStorageWriter(storage)) {
    throw new MigrationError(
      "generate requires a storage writer",
      VibORMErrorCode.MIGRATION_STORAGE_REQUIRED
    );
  }
  hydrateSchemaNames(client.$schema);
  const relations = options.skipValidation
    ? resolveSchemaOrThrow(client.$schema)
    : validateSchemaOrThrow(client.$schema);
  const driver = getPushMigrationDriver(client);
  assertMigrationDecimalDomainsFitProvider(client.$schema, driver.dialect);
  let estateBytes = await storage.readEstate();
  if (!estateBytes) {
    const encoded = encodeEstateDescriptor(driver.target);
    if (!options.dryRun) {
      await storage.publishEstate(encoded.bytes);
    }
    estateBytes = encoded.bytes;
  }
  const { estateHash, descriptor } = parseEstateDescriptor(estateBytes);
  assertEstateTargetMatches(descriptor.target, driver.target);
  const publishedEstate = await storage.readEstate();
  const loaded = publishedEstate
    ? await loadMigrationGraph(storage)
    : emptyGraph(estateHash, descriptor);

  const desired = serializeResolvedModels(client.$schema, driver, relations);
  const desiredEncoded = encodeSnapshot(desired);
  const parents = resolveParents(loaded, options);
  refuseUnprovedMerge(loaded, parents, options.manualMigration);

  const assembly = new SqlAssembly();
  const parentBodies: Omit<MigrationParentTransitionV1, "transitionHash">[] =
    [];
  let reported: DiffOperation[] = [];
  const destinationPlaceholders: MigrationBooleanCheckV1[] = [];

  if (options.manualMigration) {
    assertManualParents(loaded, options.manualMigration.transitions);
    for (const transition of options.manualMigration.transitions) {
      const compiled = compileManualTransition(
        transition.up,
        transition.rollback,
        driver.target.dialect,
        transition.execution,
        transition.originChecks,
        assembly
      );
      parentBodies.push(sealParent(transition.from, compiled));
    }
    for (const [index, check] of (
      options.manualMigration.destinationChecks ?? []
    ).entries()) {
      destinationPlaceholders.push(
        compileTrustedCheck(
          check,
          driver.target.dialect,
          assembly,
          `destination:${index}`
        )
      );
    }
    for (const compiled of parentBodies) {
      assertManualStepwiseProof(
        {
          operations: compiled.operations,
          rollback: compiled.rollback,
          originChecks: compiled.originChecks,
          requestedForwardBoundary: compiled.requestedForwardBoundary,
          atomicity: compiled.requestedForwardBoundary ?? "transactional",
        },
        destinationPlaceholders
      );
    }
  } else {
    for (const from of parents) {
      const current =
        from === null
          ? emptyManagedSnapshot()
          : (loaded.snapshots.get(loaded.states.get(from)!.snapshotHash) ??
            emptyManagedSnapshot());
      const diffed = await diff(current, desired);
      const resolved = await resolveAmbiguousChanges(
        diffed,
        current,
        desired,
        options.resolve
          ? callbackAsResolver(options.resolve)
          : parents.length > 1
            ? alwaysAddDropResolver
            : strictResolver
      );
      const staged = prepareSchemaProgram(resolved, current, driver);
      if (from === parents[0]) reported = staged;
      const compiled = compileGeneratedTransition(
        staged,
        driver,
        "artifact",
        current,
        desired,
        assembly
      );
      parentBodies.push(sealParent(from, compiled));
    }
  }

  const sealed = assembly.seal();

  const hashedParents = parentBodies
    .map((parent) => ({
      ...parent,
      originChecks: rebindChecks(parent.originChecks, sealed.dispatches),
      operations: rebindDispatches(parent.operations, sealed.dispatches),
      rollback: rebindRollback(parent.rollback, sealed.dispatches),
    }))
    .map((parent) => hashParent(parent));

  const singleParent = parents.length === 1;
  const unchangedSnapshot =
    singleParent &&
    parents[0] !== null &&
    loaded.states.get(parents[0]!)?.snapshotHash ===
      desiredEncoded.snapshotHash;
  const emptyProgram = hashedParents.every((parent) =>
    parent.operations.every((operation) => operation.steps.length === 0)
  );
  if (!options.manualMigration && unchangedSnapshot && emptyProgram) {
    return {
      outcome: "noop",
      stateId: null,
      name: null,
      estateHash,
      snapshotHash: desiredEncoded.snapshotHash,
      sqlHash: null,
      operations: [],
      sql: "",
    };
  }

  const named = options.name?.trim() || generateMigrationName(reported);
  const withoutId: Omit<MigrationStateManifestV1, "stateId"> = {
    format: "1",
    estateHash,
    name: named,
    snapshotHash: desiredEncoded.snapshotHash,
    sqlHash: sealed.sqlHash,
    destinationChecks: rebindChecks(destinationPlaceholders, sealed.dispatches),
    parents: hashedParents,
  };
  const encoded = encodeStateManifest(withoutId);
  const sqlText = new TextDecoder().decode(sealed.bytes);
  if (options.dryRun) {
    return {
      outcome: "preview",
      stateId: encoded.stateId,
      name: named,
      estateHash,
      snapshotHash: desiredEncoded.snapshotHash,
      sqlHash: sealed.sqlHash,
      operations: reported,
      sql: sqlText,
    };
  }

  await storage.publishSnapshot(
    desiredEncoded.snapshotHash,
    desiredEncoded.bytes
  );
  await storage.publishSql(sealed.sqlHash, sealed.bytes);
  await storage.publishState(encoded.stateId, encoded.bytes);
  return {
    outcome: "published",
    stateId: encoded.stateId,
    name: named,
    estateHash,
    snapshotHash: desiredEncoded.snapshotHash,
    sqlHash: sealed.sqlHash,
    operations: reported,
    sql: sqlText,
  };
}

function assertManualParents(
  graph: MigrationGraph,
  transitions: readonly ManualTransitionInput[]
): void {
  const seen = new Set<string>();
  for (const transition of transitions) {
    if (transition.from === null) {
      if (graph.states.size > 0) {
        throw new MigrationError(
          "A second virtual-root transition is refused",
          VibORMErrorCode.MIGRATION_INVALID_ESTATE
        );
      }
    } else if (!graph.states.has(transition.from)) {
      throw new MigrationError(
        `Unknown parent state ${transition.from}`,
        VibORMErrorCode.MIGRATION_NOT_FOUND
      );
    }
    const key = transition.from ?? "null";
    if (seen.has(key)) {
      throw new MigrationError(
        "A manual migration names a parent more than once",
        VibORMErrorCode.MIGRATION_INVALID_ESTATE
      );
    }
    seen.add(key);
  }
}

function resolveParents(
  graph: MigrationGraph,
  options: GenerateV1Options
): Array<Sha256 | null> {
  if (options.from !== undefined) {
    if (options.from === null) {
      if (graph.states.size > 0) {
        throw new MigrationError(
          "A second virtual-root transition is refused",
          VibORMErrorCode.MIGRATION_INVALID_ESTATE
        );
      }
      return [null];
    }
    if (!graph.states.has(options.from)) {
      throw new MigrationError(
        `Unknown parent state ${options.from}`,
        VibORMErrorCode.MIGRATION_NOT_FOUND
      );
    }
    return [options.from];
  }
  if (graph.states.size === 0) return [null];
  if (graph.leaves.length === 1) return [graph.leaves[0]!];
  if (graph.leaves.length === 0) return [null];
  return [...graph.leaves];
}

function emptyGraph(
  estateHash: Sha256,
  descriptor: ReturnType<typeof parseEstateDescriptor>["descriptor"]
): MigrationGraph {
  return {
    estateHash,
    descriptor,
    states: new Map(),
    snapshots: new Map(),
    sql: new Map(),
    roots: [],
    leaves: [],
    emptySnapshotHash: encodeSnapshot(emptyManagedSnapshot()).snapshotHash,
  };
}

function ancestryHasCustom(
  graph: MigrationGraph,
  stateId: Sha256 | null,
  seen: Set<string> = new Set()
): boolean {
  if (stateId === null || seen.has(stateId)) return false;
  seen.add(stateId);
  const state = graph.states.get(stateId);
  if (!state) return false;
  for (const transition of state.parents) {
    if (
      transition.operations.some(
        (operation) => operation.origin === "manual"
      ) ||
      transition.requestedForwardBoundary !== null
    ) {
      return true;
    }
    if (ancestryHasCustom(graph, transition.fromState, seen)) return true;
  }
  return false;
}

function refuseUnprovedMerge(
  graph: MigrationGraph,
  parents: Array<Sha256 | null>,
  manual: ManualMigrationInput | undefined
): void {
  if (parents.length < 2 || manual) return;
  for (const parent of parents) {
    if (ancestryHasCustom(graph, parent)) {
      throw new MigrationError(
        "A custom or data transition cannot be merged structurally; supply manualMigration for every parent",
        VibORMErrorCode.MIGRATION_INVALID_ESTATE
      );
    }
  }
}
