/**
 * V1 generation: one new state from parent leaves, published atomically.
 * Snapshot and SQL are published before the state manifest.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import {
  assertManualStepwiseProof,
  type CompiledTransition,
  compileGeneratedTransition,
  compileManualTransition,
  compileTrustedCheck,
  compileValidationTransition,
  hashParent,
  type LowLockState,
  lowLockStates,
  lowLockSteps,
  rebindChecks,
  rebindDispatches,
  rebindRollback,
  sealParent,
} from "./compile";
import { type DiffOptions, diff } from "./differ";
import { emptyManagedSnapshot } from "./empty-snapshot";
import { normalizeGenerateOptions } from "./generate-input";
import {
  loadMigrationGraph,
  type MigrationGraph,
  requireStateSnapshot,
} from "./graph";
import type { Sha256 } from "./identity";
import { renderMigrationReview } from "./public-view";
import {
  applyResolvedEnumMappings,
  detectEnumValueRemovals,
  resolveEnumValueRemovalMappings,
} from "./push/enum-removals";
import type { getPushMigrationDriver, MigrationClient } from "./push/planner";
import { prepareSchema } from "./push-v1";
import {
  approveDestructiveOperations,
  callbackAsResolver,
  refuseUnusedDecisions,
  rejectAllResolver,
  resolveAmbiguousChanges,
  strictResolver,
} from "./resolver";
import { serializeResolvedModels } from "./serializer";
import {
  type EncodedSnapshotArtifact,
  encodeSnapshotArtifact,
} from "./snapshot-artifacts";
import { SqlAssembly } from "./sql-assembly";
import { sliceDispatch } from "./sql-blob";
import { assertArtifactExecutionSafe } from "./statement-safety";
import type { MigrationStorageWriter } from "./storage/contract";
import { assertEstateTargetMatches } from "./target";
import type { DiffOperation, ResolveCallback, SchemaSnapshot } from "./types";
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
  MigrationApprovalV1,
  MigrationBooleanCheckV1,
  MigrationParentTransitionV1,
} from "./v1-types";

export interface GenerateV1Result {
  readonly outcome: "published" | "preview" | "noop";
  readonly stateId: Sha256 | null;
  readonly name: string | null;
  readonly estateHash: Sha256 | null;
  readonly snapshotHash: Sha256 | null;
  readonly sqlHash: Sha256 | null;
  readonly operations: readonly DiffOperation[];
  readonly warnings: readonly string[];
  readonly operationsByParent: readonly {
    readonly fromState: string | null;
    readonly operations: readonly DiffOperation[];
  }[];
  readonly sql: string;
  readonly reviewSql: string;
}

const AUTHENTICATED_SNAPSHOT_DIFF_OPTIONS: DiffOptions = {
  compareDateTimeDeclarations: true,
};

/**
 * A dry run without a resolver previews the state as an approval would publish
 * it, as push's preview does; publishing still needs the resolver's answer.
 */
const previewApproval: ResolveCallback = (change) =>
  change.type === "destructive" ? change.proceed() : undefined;

export async function generateV1(
  client: MigrationClient,
  storage: MigrationStorageWriter,
  options: GenerateV1Options = {}
): Promise<GenerateV1Result> {
  const request = normalizeGenerateOptions(options);
  const { relations, driver } = prepareSchema(
    client,
    request.skipValidation ?? false
  );
  const publishedEstate = await storage.readEstate();
  const estateBytes =
    publishedEstate ?? encodeEstateDescriptor(driver.target).bytes;
  const { estateHash, descriptor } = parseEstateDescriptor(estateBytes);
  assertEstateTargetMatches(descriptor.target, driver.target);
  const loaded = publishedEstate
    ? await loadMigrationGraph(storage)
    : emptyGraph(estateHash, descriptor);

  const desired = serializeResolvedModels(client.$schema, driver, relations);
  const desiredEncoded = encodeSnapshot(desired);
  const parents = resolveParents(loaded, request, desired);
  refuseUnprovedMerge(loaded, parents, request.manualMigration);
  const parentState =
    parents.length === 1 && parents[0]
      ? loaded.states.get(parents[0])
      : undefined;
  const parentSnapshot =
    parentState && loaded.snapshots.get(parentState.snapshotHash);
  const unchangedSnapshot =
    parentSnapshot !== undefined && sameSchema(parentSnapshot, desired);

  const assembly = new SqlAssembly();
  const parentBodies: Omit<MigrationParentTransitionV1, "transitionHash">[] =
    [];
  const reported: DiffOperation[] = [];
  const warnings: string[] = [];
  const operationsByParent: {
    fromState: string | null;
    operations: DiffOperation[];
  }[] = [];
  const destinationPlaceholders: MigrationBooleanCheckV1[] = [];
  // Each state a low-lock split publishes before this one, parent first.
  const stepStates: SealedLowLockState[] = [];
  const snapshotArtifacts = new Map(loaded.snapshotArtifacts);
  const snapshotFor = (
    snapshot: SchemaSnapshot,
    fromStates: readonly (Sha256 | null)[]
  ) => {
    const bases = fromStates.flatMap((from) => {
      if (from === null) return [];
      const manifest =
        loaded.states.get(from) ??
        stepStates.find((step) => step.encoded.stateId === from)!.encoded
          .manifest;
      return [manifest.snapshotArtifactHash ?? manifest.snapshotHash].filter(
        (hash) => snapshotArtifacts.has(hash)
      );
    });
    const encoded = encodeSnapshotArtifact(
      snapshot,
      snapshotArtifacts,
      bases,
      fromStates.every((from) => from === null)
    );
    if (encoded.bytes) {
      snapshotArtifacts.set(encoded.artifactHash, {
        snapshot,
        snapshotHash: encoded.snapshotHash,
        depth: encoded.depth,
        bytes: encoded.bytes,
        ...(encoded.baseArtifactHash
          ? { baseArtifactHash: encoded.baseArtifactHash }
          : {}),
      });
    }
    return encoded;
  };

  if (request.manualMigration) {
    assertManualParents(loaded, request.manualMigration.transitions);
    for (const transition of request.manualMigration.transitions) {
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
      request.manualMigration.destinationChecks ?? []
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
    for (const [index, from] of parents.entries()) {
      const current = requireStateSnapshot(loaded, from);
      const diffOptions = {
        ...AUTHENTICATED_SNAPSHOT_DIFF_OPTIONS,
        projectRename: driver.projectNativeRename.bind(driver),
        refuseConstraintNameChurn:
          driver.capabilities.introspectionReadsConstraintNames,
      };
      const diffed = await diff(current, desired, diffOptions);
      const admittedDrops = new Set<string>();
      const resolved = await resolveAmbiguousChanges(
        diffed,
        current,
        desired,
        request.resolve
          ? callbackAsResolver(request.resolve, admittedDrops)
          : strictResolver,
        diffOptions
      );
      const approvals = await approveDestructiveOperations(
        resolved,
        request.resolve ?? (request.dryRun ? previewApproval : undefined),
        false,
        admittedDrops
      );
      const enumMappings = await resolveEnumValueRemovalMappings(
        detectEnumValueRemovals(resolved, current),
        request.resolve ?? rejectAllResolver,
        false
      );
      const withEnumMappings = resolved.map((operation) =>
        operation.type === "alterEnum"
          ? applyResolvedEnumMappings([operation], enumMappings)[0]!
          : operation
      );
      const staged = prepareSchemaProgram(withEnumMappings, current, driver);
      reported.push(...staged);
      operationsByParent.push({ fromState: from, operations: staged });
      // T2: the plan has asked every decision once its last parent is
      // planned, before a low-lock split publishes. A document already
      // published (a re-drive) asks none and stays a noop.
      if (index === parents.length - 1 && !unchangedSnapshot) {
        refuseUnusedDecisions(request.resolve);
      }
      // T5b, asked for with `lowLock`: one parent's PostgreSQL program gives
      // each low-lock step a commit of its own, as states published before
      // this one. Opt-in, because a step outside a transaction needs the
      // direct session a transaction pooler cannot give.
      const lowLock =
        request.lowLock === true && driver.dialect === "postgresql";
      const split =
        lowLock && parents.length === 1
          ? lowLockStates(staged, current, desired)
          : undefined;
      if (lowLock && !split && lowLockSteps(staged).size > 0) {
        warnings.push(
          "lowLock: this change keeps its blocking index builds and validating foreign keys, because it merges several parents or changes something other than an index or a foreign key after its first index build. Generate those indexes and keys in a migration of their own to get their step form."
        );
      }
      let origin = { from, current, approvals };
      const before = split?.states.slice(0, -1) ?? [];
      for (const [index, state] of before.entries()) {
        const step = sealLowLockState(
          estateHash,
          driver,
          `${request.name?.trim() || generateMigrationName(staged)} (step ${index + 1} of ${before.length + 1})`,
          origin,
          state,
          split?.steps,
          snapshotFor
        );
        warnings.push(...step.warnings);
        stepStates.push(step);
        origin = {
          from: step.encoded.stateId,
          current: state.snapshot,
          approvals: [],
        };
      }
      const last = split?.states.at(-1);
      const compiled = last?.validates
        ? compileValidationTransition(
            last.operations,
            driver,
            origin.current,
            assembly
          )
        : compileGeneratedTransition(
            last?.operations ?? staged,
            driver,
            "artifact",
            origin.current,
            desired,
            assembly,
            split?.steps
          );
      warnings.push(...transitionWarnings(compiled));
      parentBodies.push(sealParent(origin.from, compiled, origin.approvals));
    }
  }

  const named = request.name?.trim() || generateMigrationName(reported);
  const storedSnapshot = snapshotFor(
    desired,
    parentBodies.map((parent) => parent.fromState)
  );
  const { sealed, hashedParents, destinationChecks, encoded } = sealState(
    assembly,
    parentBodies,
    destinationPlaceholders,
    driver.target.dialect,
    estateHash,
    named,
    storedSnapshot
  );

  // Decision 8: field and model order is cosmetic, so a document that only
  // reorders them is a noop and publishes nothing.
  const emptyProgram = hashedParents.every((parent) =>
    parent.operations.every((operation) => operation.steps.length === 0)
  );
  if (!request.manualMigration && unchangedSnapshot && emptyProgram) {
    return {
      outcome: "noop",
      stateId: null,
      name: null,
      estateHash,
      snapshotHash: desiredEncoded.snapshotHash,
      sqlHash: null,
      operations: [],
      warnings: [],
      operationsByParent: [],
      sql: "",
      reviewSql: "",
    };
  }

  const final = { snapshot: storedSnapshot, sealed, encoded };
  const states = [...stepStates, final];
  const sqlText = states
    .map((state) => new TextDecoder().decode(state.sealed.bytes))
    .join("\n\n");
  const reviewSql = [
    ...stepStates.map(({ review }) => review),
    renderMigrationReview(
      hashedParents,
      destinationChecks,
      sealed.bytes,
      request.resolve ? undefined : "Needs approval at generate"
    ),
  ].join("\n\n");
  const candidate = {
    stateId: encoded.stateId,
    name: named,
    estateHash,
    snapshotHash: desiredEncoded.snapshotHash,
    sqlHash: sealed.sqlHash,
    operations: reported,
    warnings,
    operationsByParent,
    sql: sqlText,
    reviewSql,
  };
  if (request.dryRun) return { outcome: "preview", ...candidate };

  if (!publishedEstate) {
    await storage.publishEstate(estateBytes);
  }
  // Every state is complete before the first publishes. A low-lock split's
  // states publish parent first, each manifest after its snapshot and SQL.
  for (const { snapshot, sealed: sql, encoded: manifest } of states) {
    if (snapshot.bytes)
      await storage.publishSnapshot(snapshot.artifactHash, snapshot.bytes);
    await storage.publishSql(sql.sqlHash, sql.bytes);
    await storage.publishState(manifest.stateId, manifest.bytes);
  }
  return { outcome: "published", ...candidate };
}

/** Decision 8: two snapshots that differ only in field and model order. */
function sameSchema(a: SchemaSnapshot, b: SchemaSnapshot): boolean {
  return (
    encodeSnapshot(orderFree(a)).snapshotHash ===
    encodeSnapshot(orderFree(b)).snapshotHash
  );
}

/** A snapshot with its tables, columns, keys and enums sorted by name. */
function orderFree(snapshot: SchemaSnapshot): SchemaSnapshot {
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name < b.name ? -1 : Number(a.name > b.name);
  return {
    ...snapshot,
    tables: snapshot.tables
      .map((table) => ({
        ...table,
        columns: [...table.columns].sort(byName),
        indexes: [...table.indexes].sort(byName),
        foreignKeys: [...table.foreignKeys].sort(byName),
        uniqueConstraints: [...table.uniqueConstraints].sort(byName),
      }))
      .sort(byName),
    enums: snapshot.enums && [...snapshot.enums].sort(byName),
  };
}

/**
 * Seals one state's manifest from its compiled parents: refuses unsafe SQL,
 * binds every check and dispatch to the sealed bytes and hashes each parent.
 */
function sealState(
  assembly: SqlAssembly,
  parentBodies: readonly Omit<MigrationParentTransitionV1, "transitionHash">[],
  destinationPlaceholders: readonly MigrationBooleanCheckV1[],
  dialect: Parameters<typeof assertArtifactExecutionSafe>[1],
  estateHash: Sha256,
  name: string,
  snapshot: EncodedSnapshotArtifact
) {
  const sealed = assembly.seal();
  assertArtifactExecutionSafe(
    sealed.dispatches.map((dispatch) => sliceDispatch(sealed.bytes, dispatch)),
    dialect,
    name
  );
  const hashedParents = parentBodies.map((parent) =>
    hashParent({
      ...parent,
      originChecks: rebindChecks(parent.originChecks, sealed.dispatches),
      operations: rebindDispatches(parent.operations, sealed.dispatches),
      rollback: rebindRollback(parent.rollback, sealed.dispatches),
    })
  );
  const destinationChecks = rebindChecks(
    destinationPlaceholders,
    sealed.dispatches
  );
  const encoded = encodeStateManifest({
    format: "1",
    estateHash,
    name,
    snapshotHash: snapshot.snapshotHash,
    ...(snapshot.artifactHash === snapshot.snapshotHash
      ? {}
      : { snapshotArtifactHash: snapshot.artifactHash }),
    sqlHash: sealed.sqlHash,
    destinationChecks,
    parents: hashedParents,
  });
  return { sealed, hashedParents, destinationChecks, encoded };
}

type SealedLowLockState = ReturnType<typeof sealLowLockState>;

/**
 * Seals one state a low-lock split puts before the generated one (T5b); it
 * becomes the next state's parent. Nothing publishes until every state of the
 * candidate is sealed.
 */
function sealLowLockState(
  estateHash: Sha256,
  driver: ReturnType<typeof getPushMigrationDriver>,
  name: string,
  origin: {
    readonly from: Sha256 | null;
    readonly current: SchemaSnapshot;
    readonly approvals: readonly MigrationApprovalV1[];
  },
  state: LowLockState,
  steps: ReadonlySet<DiffOperation> | undefined,
  encode: (
    snapshot: SchemaSnapshot,
    fromStates: readonly (Sha256 | null)[]
  ) => EncodedSnapshotArtifact
) {
  const assembly = new SqlAssembly();
  const compiled = compileGeneratedTransition(
    state.operations,
    driver,
    "artifact",
    origin.current,
    state.snapshot,
    assembly,
    steps
  );
  const snapshot = encode(state.snapshot, [origin.from]);
  const sealed = sealState(
    assembly,
    [sealParent(origin.from, compiled, origin.approvals)],
    [],
    driver.target.dialect,
    estateHash,
    name,
    snapshot
  );
  return {
    ...sealed,
    snapshot,
    review: renderMigrationReview(
      sealed.hashedParents,
      [],
      sealed.sealed.bytes
    ),
    warnings: transitionWarnings(compiled),
  };
}

/** What a compiled transition warns of: its own warnings, then irreversibility. */
function transitionWarnings(compiled: CompiledTransition): string[] {
  return [
    ...(compiled.warnings ?? []),
    ...(compiled.rollback.kind === "irreversible"
      ? [compiled.rollback.reason]
      : []),
  ];
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
  options: GenerateV1Options,
  desired: SchemaSnapshot
): Array<Sha256 | null> {
  if (options.from !== undefined) {
    if (options.from === null) {
      // Plan T4 (decision 11): on a populated estate `from: null` authors a
      // checkpoint, a second root restating the single leaf's schema, which
      // reanchor() can move a marker onto once prune() dropped what precedes it.
      const [leaf, ...more] = graph.leaves;
      if (
        leaf &&
        (more.length > 0 ||
          !sameSchema(requireStateSnapshot(graph, leaf), desired))
      ) {
        throw new MigrationError(
          "A second virtual-root transition is an authored checkpoint: it must restate the schema of the estate's single leaf. Generate the change first, then the checkpoint.",
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
  // `loadMigrationGraph` refuses a cycle, so a graph with states has a leaf.
  return [...graph.leaves];
}

function emptyGraph(
  estateHash: Sha256,
  descriptor: ReturnType<typeof parseEstateDescriptor>["descriptor"]
): MigrationGraph {
  const emptySnapshotHash = encodeSnapshot(emptyManagedSnapshot()).snapshotHash;
  return {
    estateHash,
    descriptor,
    states: new Map(),
    snapshots: new Map([[emptySnapshotHash, emptyManagedSnapshot()]]),
    snapshotArtifacts: new Map(),
    sql: new Map(),
    roots: [],
    leaves: [],
    emptySnapshotHash,
  };
}

function ancestryHasCustom(
  graph: MigrationGraph,
  stateId: Sha256 | null,
  seen: Set<string> = new Set()
): boolean {
  if (stateId === null || seen.has(stateId)) return false;
  seen.add(stateId);
  // Every id here is a validated state or a validated parent edge's source.
  const state = graph.states.get(stateId)!;
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
