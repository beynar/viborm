import { MigrationError, VibORMErrorCode } from "../../errors";
import type {
  DiffOperation,
  PolymorphicMemberHistoryChange,
  PolymorphicMemberResolver,
  PolymorphicSnapshotMember,
  PolymorphicSnapshotStorage,
  SchemaSnapshot,
} from "../types";

interface NormalizedStorage {
  readonly ownerTable: string;
  readonly typeColumn: string;
  readonly idColumn: string;
  readonly members: readonly PolymorphicSnapshotMember[];
}

interface PendingHistoryChange {
  readonly change: PolymorphicMemberHistoryChange;
  isAcknowledged(): boolean;
}

/**
 * Resolves the member history that structural SQL cannot describe.
 *
 * The differ owns columns and indexes. This comparator runs after accepted
 * structural renames, so it can distinguish a physical rename from a stored
 * discriminator change or a genuine target change.
 */
export async function resolvePolymorphicMemberHistory(
  previous: SchemaSnapshot,
  desired: SchemaSnapshot,
  operations: readonly DiffOperation[],
  resolver: PolymorphicMemberResolver | undefined
): Promise<boolean> {
  const metadataChanged = !polymorphicMetadataEqual(previous, desired);
  const previousStorages = (previous.polymorphicStorage ?? []).map((storage) =>
    normalizeStorage(storage, operations)
  );
  const desiredByDescriptor = new Map<string, PolymorphicSnapshotStorage>();

  for (const storage of desired.polymorphicStorage ?? []) {
    desiredByDescriptor.set(descriptorKey(storage), storage);
  }

  for (const previousStorage of previousStorages) {
    const desiredStorage = desiredByDescriptor.get(
      descriptorKey(previousStorage)
    );
    if (!desiredStorage) continue;

    await resolveStorageHistory(
      previousStorage,
      desiredStorage,
      resolver
    );
  }

  return metadataChanged;
}

function normalizeStorage(
  storage: PolymorphicSnapshotStorage,
  operations: readonly DiffOperation[]
): NormalizedStorage {
  const ownerTable = normalizeTable(storage.ownerTable, operations);

  return {
    ownerTable,
    typeColumn: normalizeColumn(
      storage.ownerTable,
      storage.typeColumn,
      operations
    ),
    idColumn: normalizeColumn(
      storage.ownerTable,
      storage.idColumn,
      operations
    ),
    members: storage.members.map((member) => ({
      ...member,
      targetTable: normalizeTable(member.targetTable, operations),
      referencedColumn: normalizeColumn(
        member.targetTable,
        member.referencedColumn,
        operations
      ),
    })),
  };
}

async function resolveStorageHistory(
  previous: NormalizedStorage,
  desired: PolymorphicSnapshotStorage,
  resolver: PolymorphicMemberResolver | undefined
): Promise<void> {
  const availableDesired = new Set(desired.members);
  const unmatchedPrevious: PolymorphicSnapshotMember[] = [];

  for (const previousMember of previous.members) {
    const sameStoredType = findAvailableMember(
      desired.members,
      availableDesired,
      (member) => member.storedType === previousMember.storedType
    );

    if (!sameStoredType) {
      unmatchedPrevious.push(previousMember);
      continue;
    }

    availableDesired.delete(sameStoredType);
    if (!hasSameTarget(previousMember, sameStoredType)) {
      await requireAcknowledgement(
        makeChange(
          "memberRetargeted",
          previous,
          desired,
          previousMember,
          sameStoredType
        ),
        resolver
      );
    }
  }

  for (const previousMember of unmatchedPrevious) {
    const samePublicType = findAvailableMember(
      desired.members,
      availableDesired,
      (member) => member.publicType === previousMember.publicType
    );

    if (samePublicType) {
      availableDesired.delete(samePublicType);
      await requireAcknowledgement(
        makeChange(
          hasSameTarget(previousMember, samePublicType)
            ? "storedValueChanged"
            : "memberRetargeted",
          previous,
          desired,
          previousMember,
          samePublicType
        ),
        resolver
      );
      continue;
    }

    await requireAcknowledgement(
      makeChange(
        "memberRemoved",
        previous,
        desired,
        previousMember,
        undefined
      ),
      resolver
    );
  }
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

function canonicalMetadata(
  storages: readonly PolymorphicSnapshotStorage[]
): readonly PolymorphicSnapshotStorage[] {
  return storages
    .map((storage) => ({
      ...storage,
      members: [...storage.members].sort((left, right) =>
        memberKey(left).localeCompare(memberKey(right))
      ),
    }))
    .sort((left, right) =>
      `${descriptorKey(left)}\u0000${left.relation}`.localeCompare(
        `${descriptorKey(right)}\u0000${right.relation}`
      )
    );
}

function memberKey(member: PolymorphicSnapshotMember): string {
  return `${member.publicType}\u0000${member.storedType}\u0000${member.targetTable}\u0000${member.referencedColumn}`;
}

function findAvailableMember(
  members: readonly PolymorphicSnapshotMember[],
  available: ReadonlySet<PolymorphicSnapshotMember>,
  matches: (member: PolymorphicSnapshotMember) => boolean
): PolymorphicSnapshotMember | undefined {
  for (const member of members) {
    if (available.has(member) && matches(member)) return member;
  }
  return undefined;
}

function hasSameTarget(
  previous: PolymorphicSnapshotMember,
  desired: PolymorphicSnapshotMember
): boolean {
  return (
    previous.targetTable === desired.targetTable &&
    previous.referencedColumn === desired.referencedColumn
  );
}

function makeChange(
  kind: PolymorphicMemberHistoryChange["kind"],
  previous: NormalizedStorage,
  desired: PolymorphicSnapshotStorage,
  from: PolymorphicSnapshotMember,
  to: PolymorphicSnapshotMember | undefined
): PendingHistoryChange {
  const description = describeChange(
    kind,
    previous.ownerTable,
    desired.relation,
    from,
    to
  );

  let acknowledged = false;
  const change: PolymorphicMemberHistoryChange = {
    kind,
    ownerTable: previous.ownerTable,
    relation: desired.relation,
    typeColumn: previous.typeColumn,
    from,
    to,
    description,
    acknowledgeMigrated: () => {
      acknowledged = true;
      return "acknowledged";
    },
    reject: () => "reject",
  };
  return { change, isAcknowledged: () => acknowledged };
}

function describeChange(
  kind: PolymorphicMemberHistoryChange["kind"],
  ownerTable: string,
  relation: string,
  from: PolymorphicSnapshotMember,
  to: PolymorphicSnapshotMember | undefined
): string {
  const member = `polymorphic member "${ownerTable}.${relation}.${from.publicType}"`;

  if (kind === "memberRemoved") {
    return `${member} was removed while stored rows may still use discriminator "${from.storedType}"`;
  }
  if (kind === "storedValueChanged") {
    return `${member} changed its stored discriminator from "${from.storedType}" to "${to?.storedType}"`;
  }
  return `${member} changed its target from "${from.targetTable}.${from.referencedColumn}" to "${to?.targetTable}.${to?.referencedColumn}"`;
}

async function requireAcknowledgement(
  pending: PendingHistoryChange,
  resolver: PolymorphicMemberResolver | undefined
): Promise<void> {
  const { change } = pending;
  const resolution = await resolver?.(change);
  if (resolution === "acknowledged" && pending.isAcknowledged()) return;

  throw new MigrationError(
    `Polymorphic relation history change requires an explicit data-migration acknowledgement: ${change.description}. ` +
      "Return change.acknowledgeMigrated() from polymorphicMemberResolver after affected rows have been migrated.",
    VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
  );
}

function descriptorKey(storage: {
  readonly ownerTable: string;
  readonly typeColumn: string;
  readonly idColumn: string;
}): string {
  return `${storage.ownerTable}\u0000${storage.typeColumn}\u0000${storage.idColumn}`;
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
