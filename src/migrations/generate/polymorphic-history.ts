import { MigrationError, VibORMErrorCode } from "../../errors";
import type {
  DiffOperation,
  PolymorphicSnapshotStorage,
  PolymorphicToManySnapshot,
  PolymorphicToManySnapshotMember,
  PolymorphicToOneSnapshot,
  PolymorphicToOneSnapshotMember,
  SchemaSnapshot,
  TableDef,
} from "../types";

interface NormalizedToOneStorage {
  readonly kind: "toOne";
  readonly ownerTable: string;
  readonly relation: string;
  readonly storageRef: string;
  readonly members: readonly PolymorphicToOneSnapshotMember[];
}

interface NormalizedToManyStorage {
  readonly kind: "toMany";
  readonly ownerTable: string;
  readonly relation: string;
  readonly members: readonly PolymorphicToManySnapshotMember[];
}

type NormalizedStorage = NormalizedToOneStorage | NormalizedToManyStorage;

/**
 * The one input that can lift a data-bearing refusal: a complete caller-owned
 * migration artifact (`GenerateOptions.manualMigration`). Suppression is an
 * INPUT to classification, never an output of it — the classification itself is
 * unchanged, and `refuseIncoherent` is deliberately not suppressible (an
 * incoherent or stale snapshot is not a transition an artifact can execute).
 */
export interface PolymorphicHistoryPolicy {
  readonly manualArtifactSupplied: boolean;
}

const GENERATED_ONLY: PolymorphicHistoryPolicy = {
  manualArtifactSupplied: false,
};

/**
 * Resolves the member history that structural SQL cannot describe.
 *
 * The differ owns columns, indexes and member junction tables. This comparator
 * runs after accepted structural renames, so it can distinguish a physical
 * rename from a stored discriminator change or a genuine membership change.
 * Classification is TOTAL: every previous storage entry resolves to same,
 * renamed, kind-change or removal — an unmatched previous entry is never
 * silently ignored — and every data-bearing transition refuses outright
 * unless the caller supplied a complete manual migration artifact, which makes
 * the caller the author of the data movement.
 */
export function resolvePolymorphicMemberHistory(
  previous: SchemaSnapshot,
  desired: SchemaSnapshot,
  operations: readonly DiffOperation[],
  policy: PolymorphicHistoryPolicy = GENERATED_ONLY
): boolean {
  validatePolymorphicSnapshotCoherence(previous);
  validatePolymorphicSnapshotCoherence(desired);

  const metadataChanged = !polymorphicMetadataEqual(previous, desired);
  const previousStorages = (previous.polymorphicStorage ?? []).map((storage) =>
    normalizeStorage(storage, operations)
  );
  const desiredStorages = desired.polymorphicStorage ?? [];

  // Pass 1: logical join on (normalized ownerTable, relation).
  const desiredByRelation = new Map<string, PolymorphicSnapshotStorage>();
  for (const storage of desiredStorages) {
    desiredByRelation.set(relationKey(storage), storage);
  }

  const matchedDesired = new Set<PolymorphicSnapshotStorage>();
  const pairedStorages: Array<
    readonly [NormalizedStorage, PolymorphicSnapshotStorage]
  > = [];
  const unmatchedPrevious: NormalizedStorage[] = [];

  for (const previousStorage of previousStorages) {
    const desiredStorage = desiredByRelation.get(relationKey(previousStorage));
    if (desiredStorage && !matchedDesired.has(desiredStorage)) {
      matchedDesired.add(desiredStorage);
      pairedStorages.push([previousStorage, desiredStorage]);
    } else {
      unmatchedPrevious.push(previousStorage);
    }
  }

  // Pass 2 (leftovers, both directions): same-kind identity-anchor join —
  // a renamed relation keeps its physical identity (the toOne storage ref, a
  // toMany member junction table), so the pair classifies as a rename
  // (metadata-only) and then runs ordinary member classification.
  const unmatchedDesired = desiredStorages.filter(
    (storage) => !matchedDesired.has(storage)
  );
  const removedPrevious: NormalizedStorage[] = [];
  for (const previousStorage of unmatchedPrevious) {
    const anchored = unmatchedDesired.find((candidate) =>
      sharesIdentityAnchor(previousStorage, candidate)
    );
    if (anchored) {
      unmatchedDesired.splice(unmatchedDesired.indexOf(anchored), 1);
      pairedStorages.push([previousStorage, anchored]);
    } else {
      removedPrevious.push(previousStorage);
    }
  }

  for (const [previousStorage, desiredStorage] of pairedStorages) {
    resolveStorageHistory(previousStorage, desiredStorage, policy);
  }

  // Remaining previous entries are removals. Dropping a toOne relation is the
  // structural differ's ordinary destructive business (its columns drop; the
  // metadata entry disappears). Dropping a toMany member junction is
  // data-bearing: offline generation cannot prove the table empty, so the
  // refusal is uniform — including a member that never held a row.
  for (const previousStorage of removedPrevious) {
    if (previousStorage.kind !== "toMany") continue;
    const firstMember = previousStorage.members[0];
    if (!firstMember) continue;
    refuseDataBearing(
      policy,
      `Polymorphic member "${previousStorage.ownerTable}.${previousStorage.relation}.${firstMember.publicType}" was removed while its member junction table "${firstMember.memberJunctionTable}" may hold membership rows`
    );
  }

  // Remaining desired entries are additions: metadata-only for toOne, and for
  // toMany the structural differ already creates exactly one table per member.
  return metadataChanged;
}

// =============================================================================
// MEMBER-JUNCTION RENAME PAIRING (the generate-only op-rewrite seam)
// =============================================================================

/**
 * Pair renamed member junction tables deterministically and rewrite the
 * differ's drop+create into renameTable+renameColumn.
 *
 * A DEFAULT-named member junction embeds the public variant in its table name
 * AND its target-side column names, so a variant rename moves all of them at
 * once — and the Jaccard rename heuristic can never reach its 0.7 bar for
 * that shape. The stable stored value is the plan's own identity proof: a
 * previous and a desired member of the same relation with equal
 * `(storedType, targetTable)` are the same logical member, so when their
 * junction tables differ and the two TableDefs are rename-isomorphic
 * (identical modulo the table name and the topology-derived target-side
 * column renames), the drop+create pair is rewritten in place.
 *
 * Deliberately NOT routed through ambiguousTable/resolver: the join is
 * deterministic, `strictResolver` would spuriously throw, and the addAndDrop
 * fallback emits a broken empty-columns createTable. Non-isomorphic shapes
 * are left alone, and member history then classifies the junction move as
 * data-bearing and refuses. Push deliberately keeps add/drop-under-
 * destructive-resolution (structure-only doctrine); this seam exists only in
 * `generate`.
 */
export function pairPolymorphicMemberRenames(
  previous: SchemaSnapshot,
  desired: SchemaSnapshot,
  operations: readonly DiffOperation[]
): DiffOperation[] {
  const desiredByRelation = new Map<string, PolymorphicToManySnapshot>();
  for (const storage of desired.polymorphicStorage ?? []) {
    // A stale pre-B3 entry (no kind) fails this check and falls through to
    // the history resolver's stale-format refusal.
    if (storage.kind !== "toMany") continue;
    desiredByRelation.set(relationKey(storage), storage);
  }
  if (desiredByRelation.size === 0) return [...operations];

  const previousTables = new Map(
    previous.tables.map((table) => [table.name, table])
  );
  const desiredTables = new Map(
    desired.tables.map((table) => [table.name, table])
  );

  let result = [...operations];
  for (const rawPrevious of previous.polymorphicStorage ?? []) {
    if (rawPrevious.kind !== "toMany") continue;
    const normalized = normalizeStorage(rawPrevious, operations);
    if (normalized.kind !== "toMany") continue;
    const desiredStorage = desiredByRelation.get(relationKey(normalized));
    if (!desiredStorage) continue;

    for (const [index, previousMember] of normalized.members.entries()) {
      // Stored values are unique within a relation (P003), so this join is
      // deterministic.
      const desiredMember = desiredStorage.members.find(
        (candidate) =>
          candidate.storedType === previousMember.storedType &&
          candidate.targetTable === previousMember.targetTable
      );
      if (
        !desiredMember ||
        // An accepted rename already covers it — nothing to pair.
        desiredMember.memberJunctionTable === previousMember.memberJunctionTable
      ) {
        continue;
      }
      const rawTableName = rawPrevious.members[index]!.memberJunctionTable;
      const previousDef = previousTables.get(rawTableName);
      const desiredDef = desiredTables.get(desiredMember.memberJunctionTable);
      if (!(previousDef && desiredDef)) continue;

      const rewritten = rewriteMemberRename(
        result,
        previousDef,
        desiredDef,
        operations
      );
      if (rewritten) result = rewritten;
    }
  }
  return result;
}

/**
 * Verify rename-isomorphism and rewrite the operations; returns undefined
 * (leaving the operations alone) when the pair cannot be proven isomorphic or
 * the expected drop+create pair is not present.
 */
function rewriteMemberRename(
  operations: readonly DiffOperation[],
  previousDef: TableDef,
  desiredDef: TableDef,
  normalizationOperations: readonly DiffOperation[]
): DiffOperation[] | undefined {
  const dropIndex = operations.findIndex(
    (operation) =>
      operation.type === "dropTable" && operation.tableName === previousDef.name
  );
  const createIndex = operations.findIndex(
    (operation) =>
      operation.type === "createTable" &&
      operation.table.name === desiredDef.name
  );
  if (dropIndex === -1 || createIndex === -1) return undefined;

  const columnMapping = deriveMemberRenameMapping(
    previousDef,
    desiredDef,
    normalizationOperations
  );
  if (!columnMapping) return undefined;
  if (!isRenameIsomorphic(previousDef, desiredDef, columnMapping)) {
    return undefined;
  }

  const renames: DiffOperation[] = [
    { type: "renameTable", from: previousDef.name, to: desiredDef.name },
  ];
  for (const [from, to] of columnMapping) {
    if (from === to) continue;
    renames.push({
      type: "renameColumn",
      tableName: desiredDef.name,
      from,
      to,
    });
  }

  const firstIndex = Math.min(dropIndex, createIndex);
  const secondIndex = Math.max(dropIndex, createIndex);
  return [
    ...operations.slice(0, firstIndex),
    ...renames,
    ...operations.slice(firstIndex + 1, secondIndex),
    ...operations.slice(secondIndex + 1),
  ];
}

/**
 * Derive the target-side column renames from the two FK pairs: the FK sides
 * are matched by (normalized referenced table, normalized referenced columns,
 * actions), and each matched side's columns zip positionally — both sides
 * were zipped from the same model-key-catalog row keys. Undefined whenever
 * the pairing is not unambiguous or a column falls outside the FK sides.
 */
function deriveMemberRenameMapping(
  previousDef: TableDef,
  desiredDef: TableDef,
  operations: readonly DiffOperation[]
): Map<string, string> | undefined {
  if (
    previousDef.foreignKeys.length !== 2 ||
    desiredDef.foreignKeys.length !== 2 ||
    previousDef.columns.length !== desiredDef.columns.length
  ) {
    return undefined;
  }

  const sidesCompatible = (
    previousFk: TableDef["foreignKeys"][number],
    desiredFk: TableDef["foreignKeys"][number]
  ): boolean =>
    previousFk.columns.length === desiredFk.columns.length &&
    normalizeTable(previousFk.referencedTable, operations) ===
      desiredFk.referencedTable &&
    previousFk.referencedColumns.length ===
      desiredFk.referencedColumns.length &&
    previousFk.referencedColumns.every(
      (column, position) =>
        normalizeColumn(previousFk.referencedTable, column, operations) ===
        desiredFk.referencedColumns[position]
    ) &&
    previousFk.onDelete === desiredFk.onDelete &&
    previousFk.onUpdate === desiredFk.onUpdate;

  const [previousFirst, previousSecond] = previousDef.foreignKeys;
  const [desiredFirst, desiredSecond] = desiredDef.foreignKeys;
  const straight =
    sidesCompatible(previousFirst!, desiredFirst!) &&
    sidesCompatible(previousSecond!, desiredSecond!);
  const crossed =
    sidesCompatible(previousFirst!, desiredSecond!) &&
    sidesCompatible(previousSecond!, desiredFirst!);
  // Prefer the order-preserving pairing; for a self-target junction both can
  // hold, and the order-preserving one is the deterministic choice.
  const pairs: ReadonlyArray<
    readonly [TableDef["foreignKeys"][number], TableDef["foreignKeys"][number]]
  > | null = straight
    ? [
        [previousFirst!, desiredFirst!],
        [previousSecond!, desiredSecond!],
      ]
    : crossed
      ? [
          [previousFirst!, desiredSecond!],
          [previousSecond!, desiredFirst!],
        ]
      : null;
  if (!pairs) return undefined;

  const mapping = new Map<string, string>();
  for (const [previousFk, desiredFk] of pairs) {
    for (const [position, column] of previousFk.columns.entries()) {
      const mapped = desiredFk.columns[position]!;
      const existing = mapping.get(column);
      if (existing !== undefined && existing !== mapped) return undefined;
      mapping.set(column, mapped);
    }
  }
  // Every column must belong to exactly the FK sides — a member junction is
  // all-FK-columns by construction.
  if (mapping.size !== previousDef.columns.length) return undefined;
  const mappedNames = new Set(mapping.values());
  if (mappedNames.size !== desiredDef.columns.length) return undefined;
  for (const column of desiredDef.columns) {
    if (!mappedNames.has(column.name)) return undefined;
  }
  return mapping;
}

/**
 * Identical shape modulo the table name, the mapped column names, and the
 * derived constraint/index NAMES (they embed table and tokens). Everything
 * else — column definitions, ordered primary key, index coverage and
 * uniqueness, unique-constraint coverage — must match exactly, so a canonical
 * order flip or an inverse-cardinality change is NOT a rename.
 */
function isRenameIsomorphic(
  previousDef: TableDef,
  desiredDef: TableDef,
  mapping: ReadonlyMap<string, string>
): boolean {
  const mapColumn = (column: string) => mapping.get(column) ?? column;
  const desiredColumns = new Map(
    desiredDef.columns.map((column) => [column.name, column])
  );
  for (const column of previousDef.columns) {
    const desiredColumn = desiredColumns.get(mapColumn(column.name));
    if (
      !desiredColumn ||
      desiredColumn.type !== column.type ||
      desiredColumn.nullable !== column.nullable ||
      (desiredColumn.default ?? undefined) !== (column.default ?? undefined) ||
      (desiredColumn.autoIncrement ?? false) !== (column.autoIncrement ?? false)
    ) {
      return false;
    }
  }

  const previousPk = previousDef.primaryKey;
  const desiredPk = desiredDef.primaryKey;
  if (!(previousPk && desiredPk)) return false;
  if (previousPk.name !== undefined || desiredPk.name !== undefined) {
    return false;
  }
  if (
    previousPk.columns.length !== desiredPk.columns.length ||
    !previousPk.columns.every(
      (column, position) => mapColumn(column) === desiredPk.columns[position]
    )
  ) {
    return false;
  }

  if (previousDef.indexes.length !== desiredDef.indexes.length) return false;
  for (const [position, index] of previousDef.indexes.entries()) {
    const desiredIndex = desiredDef.indexes[position]!;
    if (
      index.unique !== desiredIndex.unique ||
      index.columns.length !== desiredIndex.columns.length ||
      !index.columns.every(
        (column, columnPosition) =>
          mapColumn(column) === desiredIndex.columns[columnPosition]
      )
    ) {
      return false;
    }
  }

  if (
    previousDef.uniqueConstraints.length !== desiredDef.uniqueConstraints.length
  ) {
    return false;
  }
  for (const [
    position,
    constraint,
  ] of previousDef.uniqueConstraints.entries()) {
    const desiredConstraint = desiredDef.uniqueConstraints[position]!;
    if (
      constraint.columns.length !== desiredConstraint.columns.length ||
      !constraint.columns.every(
        (column, columnPosition) =>
          mapColumn(column) === desiredConstraint.columns[columnPosition]
      )
    ) {
      return false;
    }
  }

  return true;
}

// =============================================================================
// COHERENCE (single home — both snapshots, head of the resolver)
// =============================================================================

/**
 * Refuses a metadata snapshot whose logical entries and physical tables
 * disagree, and a pre-B3 snapshot format. One guard: no serializer-side twin
 * and no parse-site twin exists — push never reads metadata, and squash
 * rewrites it verbatim so the NEXT generate refuses here.
 */
export function validatePolymorphicSnapshotCoherence(
  snapshot: SchemaSnapshot
): void {
  const storages = snapshot.polymorphicStorage ?? [];
  const tablesByName = new Map<string, TableDef>(
    snapshot.tables.map((table) => [table.name, table])
  );
  /** memberJunctionTable → owning member label. */
  const junctionOwners = new Map<string, string>();
  /** `${ownerTable}\u0000${storageRef}` → owning relation label. */
  const registryOwners = new Map<string, string>();

  for (const storage of storages) {
    const declaredKind: unknown = Reflect.get(storage, "kind");
    if (declaredKind !== "toOne" && declaredKind !== "toMany") {
      throw new MigrationError(
        `Polymorphic snapshot entry for "${storage.ownerTable}.${storage.relation}" predates the storage-kind snapshot format. The format changed once with no legacy reader: regenerate the snapshot from the current schema instead of reading a pre-B3 metadata file.`,
        VibORMErrorCode.MIGRATION_INVALID_STATE
      );
    }
    if (storage.kind === "toOne") {
      validateToOneCoherence(storage, tablesByName, registryOwners);
    } else {
      validateToManyCoherence(storage, tablesByName, junctionOwners);
    }
  }

  // Every registry entry must have exactly one metadata owner (the ≤1 half is
  // the registryOwners collision above; this is the ≥1 half).
  for (const table of snapshot.tables) {
    for (const storageRef of Object.keys(table.relationStorage ?? {})) {
      if (!registryOwners.has(`${table.name}\u0000${storageRef}`)) {
        refuseIncoherent(
          `relationStorage entry "${storageRef}" on table "${table.name}" has no owning polymorphic metadata entry`
        );
      }
    }
  }
}

function validateToOneCoherence(
  storage: PolymorphicToOneSnapshot,
  tablesByName: ReadonlyMap<string, TableDef>,
  registryOwners: Map<string, string>
): void {
  const label = `"${storage.ownerTable}.${storage.relation}"`;
  const ownerTable = tablesByName.get(storage.ownerTable);
  if (!ownerTable) {
    refuseIncoherent(
      `owner table "${storage.ownerTable}" of toOne polymorphic relation ${label} is missing from the snapshot`
    );
  }
  const entry = ownerTable.relationStorage?.[storage.storageRef];
  if (!entry) {
    refuseIncoherent(
      `toOne polymorphic relation ${label} resolves no relationStorage registry entry "${storage.storageRef}" on its owner table`
    );
  }
  const registryKey = `${storage.ownerTable}\u0000${storage.storageRef}`;
  const priorOwner = registryOwners.get(registryKey);
  if (priorOwner) {
    refuseIncoherent(
      `relationStorage entry "${storage.storageRef}" on table "${storage.ownerTable}" is claimed by both "${priorOwner}" and ${label}`
    );
  }
  registryOwners.set(registryKey, `${storage.ownerTable}.${storage.relation}`);

  const columnNames = new Set(ownerTable.columns.map((column) => column.name));
  const physicalPartsPresent =
    columnNames.has(entry.typeColumn) &&
    columnNames.has(entry.idColumn) &&
    ownerTable.indexes.some((index) => index.name === entry.index);
  if (!physicalPartsPresent) {
    refuseIncoherent(
      `relationStorage entry "${storage.storageRef}" on table "${storage.ownerTable}" names physical parts that are missing from the table definition`
    );
  }
}

function validateToManyCoherence(
  storage: PolymorphicToManySnapshot,
  tablesByName: ReadonlyMap<string, TableDef>,
  junctionOwners: Map<string, string>
): void {
  for (const member of storage.members) {
    const label = `"${storage.ownerTable}.${storage.relation}.${member.publicType}"`;
    if (!tablesByName.has(member.memberJunctionTable)) {
      refuseIncoherent(
        `member junction table "${member.memberJunctionTable}" of polymorphic member ${label} is missing from the snapshot`
      );
    }
    const priorOwner = junctionOwners.get(member.memberJunctionTable);
    if (priorOwner) {
      refuseIncoherent(
        `member junction table "${member.memberJunctionTable}" has two logical owners: ${priorOwner} and ${label}`
      );
    }
    junctionOwners.set(member.memberJunctionTable, label);
  }
}

function refuseIncoherent(description: string): never {
  throw new MigrationError(
    `Polymorphic snapshot metadata is incoherent: ${description}. Regenerate the snapshot from the current schema; VibORM never reconstructs polymorphic storage from naming conventions.`,
    VibORMErrorCode.MIGRATION_INVALID_STATE
  );
}

// =============================================================================
// CLASSIFICATION (dispatched by storage kind)
// =============================================================================

function resolveStorageHistory(
  previous: NormalizedStorage,
  desired: PolymorphicSnapshotStorage,
  policy: PolymorphicHistoryPolicy
): void {
  if (previous.kind === "toOne" && desired.kind === "toOne") {
    resolveToOneMemberHistory(previous, desired, policy);
    return;
  }
  if (previous.kind === "toMany" && desired.kind === "toMany") {
    resolveToManyMemberHistory(previous, desired, policy);
    return;
  }
  refuseDataBearing(
    policy,
    // The storage KINDS stay `toOne`/`toMany` — that is the snapshot format's
    // own discriminator and it must not move. The MESSAGE names the factory the
    // schema author writes instead, because the builder's cardinality terminals
    // it used to name were retired with the builder.
    `Polymorphic relation "${desired.ownerTable}.${desired.relation}" changed cardinality from s.${previous.kind === "toOne" ? "polymorphicToOne" : "polymorphicToMany"}() to s.${desired.kind === "toOne" ? "polymorphicToOne" : "polymorphicToMany"}(); membership moves between owner-row columns and member junction tables`
  );
}

/**
 * To-one member classification: the stored discriminator IS row data, so a
 * stored-value change, a retarget and a member removal are all data-bearing.
 * A public rename (same stored value, same target) and a member addition are
 * metadata-only; an inverse-cardinality change is exactly structural (the
 * unique flip on the poly index) and invisible here.
 */
function resolveToOneMemberHistory(
  previous: NormalizedToOneStorage,
  desired: PolymorphicToOneSnapshot,
  policy: PolymorphicHistoryPolicy
): void {
  const relationLabel = `${desired.ownerTable}.${desired.relation}`;
  const available = new Set<PolymorphicToOneSnapshotMember>(desired.members);
  const unmatchedPrevious: PolymorphicToOneSnapshotMember[] = [];

  for (const previousMember of previous.members) {
    const sameStoredType = findAvailableMember(
      desired.members,
      available,
      (member) => member.storedType === previousMember.storedType
    );
    if (!sameStoredType) {
      unmatchedPrevious.push(previousMember);
      continue;
    }
    available.delete(sameStoredType);
    if (sameStoredType.targetTable !== previousMember.targetTable) {
      refuseDataBearing(
        policy,
        `Polymorphic member "${relationLabel}.${previousMember.publicType}" changed its target from "${previousMember.targetTable}" to "${sameStoredType.targetTable}" while owner rows may reference the old target`
      );
    }
  }

  for (const previousMember of unmatchedPrevious) {
    const samePublicType = findAvailableMember(
      desired.members,
      available,
      (member) => member.publicType === previousMember.publicType
    );
    if (samePublicType) {
      available.delete(samePublicType);
      refuseDataBearing(
        policy,
        samePublicType.targetTable === previousMember.targetTable
          ? `Polymorphic member "${relationLabel}.${previousMember.publicType}" changed its stored discriminator from "${previousMember.storedType}" to "${samePublicType.storedType}" while owner rows may hold the old value`
          : `Polymorphic member "${relationLabel}.${previousMember.publicType}" changed its target from "${previousMember.targetTable}" to "${samePublicType.targetTable}" while owner rows may reference the old target`
      );
      // A matched public identity is a rename or a discriminator change, NOT a
      // removal: the refusal above is the whole classification for this member.
      continue;
    }
    refuseDataBearing(
      policy,
      `Polymorphic member "${relationLabel}.${previousMember.publicType}" was removed while owner rows may still use discriminator "${previousMember.storedType}"`
    );
  }
}

/**
 * Collection member classification: no row stores the discriminator, so a
 * stored-value change and a public rename are metadata-only — dispatched the
 * OPPOSITE way from toOne by design. What is data-bearing is membership: a
 * retarget, a member removal, and a junction move no accepted rename explains.
 * An inverse-cardinality change is exactly structural (the unique target-side
 * constraint on the member table) and invisible here.
 */
function resolveToManyMemberHistory(
  previous: NormalizedToManyStorage,
  desired: PolymorphicToManySnapshot,
  policy: PolymorphicHistoryPolicy
): void {
  const relationLabel = `${desired.ownerTable}.${desired.relation}`;
  const available = new Set<PolymorphicToManySnapshotMember>(desired.members);
  const unmatchedPrevious: PolymorphicToManySnapshotMember[] = [];

  for (const previousMember of previous.members) {
    const sameStoredType = findAvailableMember(
      desired.members,
      available,
      (member) => member.storedType === previousMember.storedType
    );
    if (!sameStoredType) {
      unmatchedPrevious.push(previousMember);
      continue;
    }
    available.delete(sameStoredType);
    classifyToManyMemberPair(
      relationLabel,
      previousMember,
      sameStoredType,
      policy
    );
  }

  for (const previousMember of unmatchedPrevious) {
    const samePublicType = findAvailableMember(
      desired.members,
      available,
      (member) => member.publicType === previousMember.publicType
    );
    if (samePublicType) {
      available.delete(samePublicType);
      // A stored-value change over an intact junction is metadata-only here.
      classifyToManyMemberPair(
        relationLabel,
        previousMember,
        samePublicType,
        policy
      );
      continue;
    }
    refuseDataBearing(
      policy,
      `Polymorphic member "${relationLabel}.${previousMember.publicType}" was removed while its member junction table "${previousMember.memberJunctionTable}" may hold membership rows`
    );
  }
}

function classifyToManyMemberPair(
  relationLabel: string,
  previousMember: PolymorphicToManySnapshotMember,
  desiredMember: PolymorphicToManySnapshotMember,
  policy: PolymorphicHistoryPolicy
): void {
  if (previousMember.targetTable !== desiredMember.targetTable) {
    refuseDataBearing(
      policy,
      `Polymorphic member "${relationLabel}.${previousMember.publicType}" changed its target from "${previousMember.targetTable}" to "${desiredMember.targetTable}" while its member junction rows may reference the old target`
    );
    // A retarget is the whole classification for this pair; the junction move
    // below would only restate it.
    return;
  }
  if (
    previousMember.memberJunctionTable !== desiredMember.memberJunctionTable
  ) {
    refuseDataBearing(
      policy,
      `Polymorphic member "${relationLabel}.${previousMember.publicType}" moved its member junction table from "${previousMember.memberJunctionTable}" to "${desiredMember.memberJunctionTable}" without a recognized rename, so its membership rows would be dropped and recreated`
    );
  }
}

/**
 * The ONE refusal site for data-bearing polymorphic transitions.
 *
 * With a manual artifact supplied the caller owns the data movement for the
 * whole migration, so this returns instead of throwing — suppression is
 * checked here, at the refusal, rather than by swallowing the error at the call
 * site (which would also swallow a refusal raised for a different relation).
 */
function refuseDataBearing(
  policy: PolymorphicHistoryPolicy,
  description: string
): void {
  if (policy.manualArtifactSupplied) {
    return;
  }
  throw new MigrationError(
    `${description}. This is a data-bearing polymorphic transition: generation refuses to invent the data movement. Supply the complete migration yourself through GenerateOptions.manualMigration — an ordered \`up\` artifact plus an honest rollback policy (\`{ kind: "manual", sql }\` or \`{ kind: "irreversible", reason }\`).`,
    VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
  );
}

// =============================================================================
// IDENTITY, EQUALITY, NORMALIZATION
// =============================================================================

function relationKey(storage: {
  readonly ownerTable: string;
  readonly relation: string;
}): string {
  return `${storage.ownerTable}\u0000${storage.relation}`;
}

/**
 * The pass-2 anchor: a renamed toOne relation keeps its normalized
 * `(ownerTable, storageRef)`; a renamed toMany relation keeps its member set
 * on `(storedType, targetTable)` with at least one member whose junction
 * table an accepted rename (or no rename) carries over.
 */
function sharesIdentityAnchor(
  previous: NormalizedStorage,
  desired: PolymorphicSnapshotStorage
): boolean {
  if (previous.kind === "toOne" && desired.kind === "toOne") {
    return (
      previous.ownerTable === desired.ownerTable &&
      previous.storageRef === desired.storageRef
    );
  }
  if (previous.kind === "toMany" && desired.kind === "toMany") {
    const memberSetKey = (member: {
      readonly storedType: string;
      readonly targetTable: string;
    }) => `${member.storedType}\u0000${member.targetTable}`;
    const previousKeys = new Set(previous.members.map(memberSetKey));
    const desiredKeys = new Set(desired.members.map(memberSetKey));
    if (previousKeys.size !== desiredKeys.size) return false;
    for (const key of previousKeys) {
      if (!desiredKeys.has(key)) return false;
    }
    return previous.members.some((previousMember) =>
      desired.members.some(
        (desiredMember) =>
          desiredMember.storedType === previousMember.storedType &&
          desiredMember.targetTable === previousMember.targetTable &&
          desiredMember.memberJunctionTable ===
            previousMember.memberJunctionTable
      )
    );
  }
  return false;
}

function polymorphicMetadataEqual(
  previous: SchemaSnapshot,
  desired: SchemaSnapshot
): boolean {
  return (
    JSON.stringify(canonicalMetadata(previous.polymorphicStorage ?? [])) ===
    JSON.stringify(canonicalMetadata(desired.polymorphicStorage ?? []))
  );
}

/**
 * Canonical, explicitly-shaped projection: property order is fixed here (not
 * inherited from the input literals), storages sort by (ownerTable, relation,
 * kind) and members by publicType, so array order never reads as a change.
 */
function canonicalMetadata(
  storages: readonly PolymorphicSnapshotStorage[]
): readonly unknown[] {
  return storages
    .map((storage) => canonicalStorage(storage))
    .sort((left, right) => left.sortKey.localeCompare(right.sortKey));
}

function canonicalStorage(storage: PolymorphicSnapshotStorage): {
  readonly sortKey: string;
  readonly kind: "toOne" | "toMany";
  readonly ownerTable: string;
  readonly relation: string;
  readonly storageRef?: string;
  readonly members: readonly unknown[];
} {
  const sortKey = `${storage.ownerTable}\u0000${storage.relation}\u0000${storage.kind}`;
  if (storage.kind === "toOne") {
    return {
      sortKey,
      kind: storage.kind,
      ownerTable: storage.ownerTable,
      relation: storage.relation,
      storageRef: storage.storageRef,
      members: [...storage.members]
        .sort((left, right) => left.publicType.localeCompare(right.publicType))
        .map((member) => ({
          publicType: member.publicType,
          storedType: member.storedType,
          targetTable: member.targetTable,
        })),
    };
  }
  return {
    sortKey,
    kind: storage.kind,
    ownerTable: storage.ownerTable,
    relation: storage.relation,
    members: [...storage.members]
      .sort((left, right) => left.publicType.localeCompare(right.publicType))
      .map((member) => ({
        publicType: member.publicType,
        storedType: member.storedType,
        targetTable: member.targetTable,
        memberJunctionTable: member.memberJunctionTable,
        inverseCardinality: member.inverseCardinality,
      })),
  };
}

function findAvailableMember<Member>(
  members: readonly Member[],
  available: ReadonlySet<Member>,
  matches: (member: Member) => boolean
): Member | undefined {
  for (const member of members) {
    if (available.has(member) && matches(member)) return member;
  }
  return undefined;
}

function normalizeStorage(
  storage: PolymorphicSnapshotStorage,
  operations: readonly DiffOperation[]
): NormalizedStorage {
  if (storage.kind === "toOne") {
    return {
      kind: "toOne",
      ownerTable: normalizeTable(storage.ownerTable, operations),
      relation: storage.relation,
      storageRef: normalizeColumn(
        storage.ownerTable,
        storage.storageRef,
        operations
      ),
      members: storage.members.map((member) => ({
        ...member,
        targetTable: normalizeTable(member.targetTable, operations),
      })),
    };
  }
  return {
    kind: "toMany",
    ownerTable: normalizeTable(storage.ownerTable, operations),
    relation: storage.relation,
    members: storage.members.map((member) => ({
      ...member,
      targetTable: normalizeTable(member.targetTable, operations),
      memberJunctionTable: normalizeTable(
        member.memberJunctionTable,
        operations
      ),
    })),
  };
}

function normalizeTable(
  tableName: string,
  operations: readonly DiffOperation[]
): string {
  let normalized = tableName;

  for (let pass = 0; pass <= operations.length; pass++) {
    const rename = operations.find(
      (operation) =>
        operation.type === "renameTable" && operation.from === normalized
    );
    if (!rename || rename.type !== "renameTable") return normalized;
    normalized = rename.to;
  }

  return normalized;
}

function normalizeColumn(
  tableName: string,
  columnName: string,
  operations: readonly DiffOperation[]
): string {
  const normalizedTable = normalizeTable(tableName, operations);
  let normalized = columnName;

  for (let pass = 0; pass <= operations.length; pass++) {
    const rename = operations.find(
      (operation) =>
        operation.type === "renameColumn" &&
        normalizeTable(operation.tableName, operations) === normalizedTable &&
        operation.from === normalized
    );
    if (!rename || rename.type !== "renameColumn") return normalized;
    normalized = rename.to;
  }

  return normalized;
}
