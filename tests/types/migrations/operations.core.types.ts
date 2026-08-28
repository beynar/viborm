import { sql } from "@sql";
import {
  type ApplyOptions,
  createFsStorageWriter,
  createMigrationClient,
  type GenerateOptions,
  type PushOptions,
} from "@src/migrations";

declare const client: Parameters<typeof createMigrationClient>[0];

const generateOptions: GenerateOptions = {
  // @ts-expect-error -- polymorphicMemberResolver no longer exists
  polymorphicMemberResolver: () => "acknowledged",
};

type _deletedResolverStaysRefused = typeof generateOptions;

const manualWithSql: GenerateOptions = {
  name: "move-subject-storage",
  manualMigration: {
    transitions: [
      {
        from: null,
        execution: "stepwise",
        up: [sql`ALTER TABLE content ADD COLUMN subject_type_v2 text`],
        rollback: {
          kind: "manual",
          execution: "stepwise",
          sql: [sql`ALTER TABLE content DROP COLUMN subject_type_v2`],
        },
      },
    ],
  },
};

const manualIrreversible: GenerateOptions = {
  name: "collapse-memberships",
  manualMigration: {
    transitions: [
      {
        from: null,
        execution: "transactional",
        up: [sql`DELETE FROM content_subject_post`],
        rollback: {
          kind: "irreversible",
          reason: "the discarded membership rows cannot be reconstructed",
        },
      },
    ],
  },
};

const manualCannotClaimAutomatic: GenerateOptions = {
  name: "wishful",
  manualMigration: {
    transitions: [
      {
        from: null,
        execution: "stepwise",
        up: [sql`SELECT 1`],
        rollback: {
          // @ts-expect-error -- there is no `automatic` input rollback arm
          kind: "automatic",
        },
      },
    ],
  },
};

type _manualSeamIsLive = [
  typeof manualWithSql,
  typeof manualIrreversible,
  typeof manualCannotClaimAutomatic,
];

const applyByName: ApplyOptions = { to: { name: "add-users" } };
const applyByPrefix: ApplyOptions = { to: { prefix: "a1b2c3d4" } };
const applyByIndex: ApplyOptions = {
  // @ts-expect-error -- apply targets a state selector, not a numeric index
  to: 5,
};

type _applySelectors = [
  typeof applyByName,
  typeof applyByPrefix,
  typeof applyByIndex,
];

const pushDryRun: PushOptions = { dryRun: true };
const pushForceGone: PushOptions = {
  dryRun: true,
  // @ts-expect-error -- generic force authorization is not a V1 push option
  force: true,
};

type _pushOptions = [typeof pushDryRun, typeof pushForceGone];

const migrations = createMigrationClient(client, {
  storage: createFsStorageWriter("./migrations"),
});

const _storageDriverBesideReal = () =>
  createMigrationClient(client, {
    storage: createFsStorageWriter("./migrations"),
    // @ts-expect-error -- the composition root takes `storage`, not `storageDriver`
    storageDriver: createFsStorageWriter("./migrations"),
  });

// @ts-expect-error -- squash is not a V1 operation
const _noSquash = () => migrations.squash({ from: 0, to: 1 });
// @ts-expect-error -- pending() is not a V1 operation; use status().pending
const _noPending = () => migrations.pending();
// @ts-expect-error -- journal() is not a V1 operation
const _noJournal = () => migrations.journal();

type _removedVerbs = [
  typeof _storageDriverBesideReal,
  typeof _noSquash,
  typeof _noPending,
  typeof _noJournal,
];
