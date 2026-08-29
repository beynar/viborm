import { sql } from "@sql";
import {
  type ApplyOptions,
  type ApplyResult,
  type BaselineResult,
  type CheckResult,
  createFsStorageWriter,
  createMigrationClient,
  type DownResult,
  type GenerateOptions,
  type GenerateResult,
  type GraphResult,
  type ListResult,
  type LogResult,
  type MigrationStorageReader,
  type PushApplyResult,
  type PushOptions,
  type PushPreview,
  type ResetResult,
  type ResolveResult,
  type ShowResult,
  type StatusResult,
  type VerifyResult,
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

declare const reader: MigrationStorageReader;

const liveMigrations = createMigrationClient(client);
liveMigrations.push({ dryRun: true });
liveMigrations.log();
// @ts-expect-error -- estate operations are absent without storage
liveMigrations.apply();
// @ts-expect-error -- a supplied options object must carry storage
createMigrationClient(client, {});

const readableMigrations = createMigrationClient(client, { storage: reader });
readableMigrations.apply();
readableMigrations.graph();
// @ts-expect-error -- generation requires a storage writer
readableMigrations.generate();
// @ts-expect-error -- reset requires a storage writer
readableMigrations.reset();

const _publicResultTypes = async () => {
  const generated: GenerateResult = await migrations.generate();
  const checked: CheckResult = await migrations.check();
  const listed: ListResult = await migrations.list();
  const shown: ShowResult = await migrations.show({ name: "init" });
  const graph: GraphResult = await migrations.graph();
  const status: StatusResult = await migrations.status();
  const verified: VerifyResult = await migrations.verify();
  const log: LogResult = await migrations.log();
  const applied: ApplyResult = await migrations.apply();
  const down: DownResult = await migrations.down();
  const baseline: BaselineResult = await migrations.baseline({
    to: { name: "init" },
  });
  const resolved: ResolveResult = await migrations.resolve({
    outcome: "retry",
  });
  const reset: ResetResult = await migrations.reset();
  const preview: PushPreview = await migrations.push({ dryRun: true });
  const pushed: PushApplyResult = await migrations.push();
  return {
    generated,
    checked,
    listed,
    shown,
    graph,
    status,
    verified,
    log,
    applied,
    down,
    baseline,
    resolved,
    reset,
    preview,
    pushed,
  };
};

const _storageDriverBesideReal = () =>
  // @ts-expect-error -- the composition root takes `storage`, not `storageDriver`
  createMigrationClient(client, {
    storage: createFsStorageWriter("./migrations"),
    storageDriver: createFsStorageWriter("./migrations"),
  });

const heldMigrationClientOptions = {
  storage: createFsStorageWriter("./migrations"),
  storageDriver: createFsStorageWriter("./migrations"),
};

const _nonFreshStorageDriverBesideReal = () =>
  // @ts-expect-error -- held option bags reject unknown keys structurally too
  createMigrationClient(client, heldMigrationClientOptions);

// @ts-expect-error -- squash is not a V1 operation
const _noSquash = () => migrations.squash({ from: 0, to: 1 });
// @ts-expect-error -- pending() is not a V1 operation; use status().pending
const _noPending = () => migrations.pending();
// @ts-expect-error -- journal() is not a V1 operation
const _noJournal = () => migrations.journal();

type _removedVerbs = [
  typeof _publicResultTypes,
  typeof _storageDriverBesideReal,
  typeof _nonFreshStorageDriverBesideReal,
  typeof _noSquash,
  typeof _noPending,
  typeof _noJournal,
];
