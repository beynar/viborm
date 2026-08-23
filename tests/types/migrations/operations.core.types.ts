import {
  type DiffOperation,
  type GenerateOptions,
  type PolymorphicSnapshotStorage,
  type PolymorphicToManySnapshot,
  type PolymorphicToOneSnapshot,
  type SerializeOptions,
  serializeModels,
  sortOperations,
  type TableDef,
} from "@src/migrations";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { s } from "@src/schema";

type Expect<Value extends true> = Value;
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;

declare const operation: DiffOperation;

const orderedOperations: DiffOperation[] = sortOperations([operation]);

type _sortKeepsOperationTyping = Expect<
  Equal<typeof orderedOperations, DiffOperation[]>
>;

// The snapshot metadata union dispatches by `kind`.
type _unionDispatchesToOne = Expect<
  Equal<
    Extract<PolymorphicSnapshotStorage, { kind: "toOne" }>,
    PolymorphicToOneSnapshot
  >
>;
type _unionDispatchesToMany = Expect<
  Equal<
    Extract<PolymorphicSnapshotStorage, { kind: "toMany" }>,
    PolymorphicToManySnapshot
  >
>;

// A toOne entry is logical-only: it carries the opaque storageRef join key and
// members without physical column names.
const toOneStorage = {
  ownerTable: "comments",
  relation: "subject",
  kind: "toOne",
  storageRef: "subject_type",
  members: [
    {
      publicType: "post",
      storedType: "content.post.v1",
      targetTable: "posts",
    },
  ],
} satisfies PolymorphicToOneSnapshot;

type _toOneCarriesTheOpaqueStorageRef = Expect<
  Equal<(typeof toOneStorage)["storageRef"], string>
>;

const toManyStorage = {
  ownerTable: "comments",
  relation: "items",
  kind: "toMany",
  members: [
    {
      publicType: "post",
      storedType: "items.post.v1",
      targetTable: "posts",
      memberJunctionTable: "comments_items_post",
      inverseCardinality: "many",
    },
  ],
} satisfies PolymorphicToManySnapshot;

type _toManyMembersNameTheirJunction = Expect<
  Equal<
    (typeof toManyStorage)["members"][number]["memberJunctionTable"],
    string
  >
>;

// The owner TableDef carries the physical-storage registry as an annotation,
// keyed by storage ref.
const annotatedTable = {
  name: "comments",
  columns: [],
  indexes: [],
  foreignKeys: [],
  uniqueConstraints: [],
  relationStorage: {
    subject_type: {
      kind: "polymorphicToOne",
      typeColumn: "subject_type",
      idColumn: "subject_id",
      index: "comments_subject_poly_idx",
    },
  },
} satisfies TableDef;

type _registryRidesTheTableDef = Expect<
  Equal<
    (typeof annotatedTable)["relationStorage"]["subject_type"]["kind"],
    "polymorphicToOne"
  >
>;

// The acknowledgement resolver API is fully deleted. The ONE seam that lifts a
// data-bearing refusal is the manual-migration artifact, and it is now live:
// a complete `up` plus an honest rollback policy, nothing else.
const generateOptions: GenerateOptions = {
  // @ts-expect-error -- polymorphicMemberResolver no longer exists
  polymorphicMemberResolver: () => "acknowledged",
};

type _deletedResolverStaysRefused = typeof generateOptions;

const manualWithSql: GenerateOptions = {
  name: "move-subject-storage",
  manualMigration: {
    up: ['ALTER TABLE "content" ADD COLUMN "subject_type_v2" text;'],
    rollback: {
      kind: "manual",
      sql: ['ALTER TABLE "content" DROP COLUMN "subject_type_v2";'],
    },
  },
};

const manualIrreversible: GenerateOptions = {
  name: "collapse-memberships",
  manualMigration: {
    up: ["DELETE FROM content_subject_post WHERE 1 = 1;"],
    rollback: {
      kind: "irreversible",
      reason: "the discarded membership rows cannot be reconstructed",
    },
  },
};

// `automatic` means "generation inverted the operations it emitted". Manual
// mode emits no generated operations, so the input union has no automatic arm
// — a caller who wants inversion must not pass an artifact at all.
const manualCannotClaimAutomatic: GenerateOptions = {
  name: "wishful",
  manualMigration: {
    up: ["SELECT 1;"],
    // @ts-expect-error -- there is no `automatic` input rollback arm
    rollback: { kind: "automatic" },
  },
};

// The persisted `manual` arm carries no `sql` (the artifact holds it); the
// input arm requires it.
const manualRequiresItsSql: GenerateOptions = {
  name: "incomplete",
  // @ts-expect-error -- a manual rollback must supply its sql
  manualMigration: { up: ["SELECT 1;"], rollback: { kind: "manual" } },
};

type _manualSeamIsLive = [
  typeof manualWithSql,
  typeof manualIrreversible,
  typeof manualCannotClaimAutomatic,
  typeof manualRequiresItsSql,
];

const publicSerializerSchema = {
  user: s.model({ id: s.string().id() }),
};
serializeModels(publicSerializerSchema, {
  migrationDriver: postgresMigrationDriver,
});

const publicSerializeOptions: SerializeOptions = {
  migrationDriver: postgresMigrationDriver,
  // @ts-expect-error -- resolved topology is not a public serializer option
  relations: new Map(),
};

type _publicSerializeOptionsRemainTyped = Expect<
  Equal<typeof publicSerializeOptions, SerializeOptions>
>;
