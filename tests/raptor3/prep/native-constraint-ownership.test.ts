import assert from "node:assert/strict";
import type { AnyDriver } from "@drivers";
import { UniqueConstraintError, VibORMErrorCode } from "@errors";
import { MySQLMigrationDriver } from "@migrations/drivers/mysql";
import { PostgresMigrationDriver } from "@migrations/drivers/postgres";
import { serializeModels } from "@migrations/serializer";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { getModelKeyCatalog, type AnyModel } from "@schema/model";
import { SchemaValidationError } from "@schema/validation";
import type { Schema } from "@client/types";
import { describe, it } from "vitest";
import type { CandidateEngineFactory } from "../harness/protocol";
import {
  liveProvider,
  runLiveWorld,
  type LiveBarrier,
  type LiveFixture,
  type LiveNames,
} from "../transitions/live-world";

type World = Awaited<ReturnType<typeof runLiveWorld>>;

interface PhysicalConstraint {
  readonly name: string;
  readonly kind: "primary" | "unique";
  readonly columns: readonly string[];
}

const textType = liveProvider === "pg" ? "TEXT" : "VARCHAR(191)";

function migrationTable(schema: Schema, tableName: string) {
  const migrationDriver =
    liveProvider === "pg"
      ? new PostgresMigrationDriver()
      : new MySQLMigrationDriver();
  const snapshot = serializeModels(schema, { migrationDriver });
  const table = snapshot.tables.find(
    (candidate) => candidate.name === tableName
  );
  assert(table, `Migration snapshot must contain ${tableName}`);
  return table;
}

function providerNamespace(driver: AnyDriver) {
  const namespace = driver.adapter.namespace;
  assert(typeof namespace === "string");
  return namespace;
}

function migrationUniqueName(
  schema: Schema,
  tableName: string,
  columns: readonly string[]
) {
  const table = migrationTable(schema, tableName);
  // PostgreSQL retains a UNIQUE constraint. MySQL finalization represents the
  // same database object in the richer unique-index bucket so desired and
  // introspected snapshots do not double-count it.
  const constraints = [
    ...table.uniqueConstraints,
    ...table.indexes
      .filter((index) => index.unique && index.where === undefined)
      .map((index) => ({ name: index.name, columns: index.columns })),
  ].filter(
    (candidate) =>
      candidate.columns.length === columns.length &&
      candidate.columns.every((column, index) => column === columns[index])
  );
  assert.equal(
    constraints.length,
    1,
    `Migration snapshot must own one total UNIQUE(${columns.join(",")}) on ${tableName}`
  );
  const constraint = constraints[0];
  assert(
    constraint,
    `Migration snapshot must own UNIQUE(${columns.join(",")}) on ${tableName}`
  );
  return constraint.name;
}

function assertAddressableKey(
  model: AnyModel,
  selector: string,
  kind: "primary" | "unique" | "compoundUnique",
  fields: readonly string[],
  grouped = false
) {
  const matches = getModelKeyCatalog(model).addressableKeys.filter((key) =>
    key.name === undefined
      ? key.fields.length === 1 && key.fields[0] === selector
      : key.name === selector
  );
  assert(matches.length > 0, `Schema catalog must expose selector ${selector}`);
  const selected = grouped
    ? matches.find((key) => key.name === selector)
    : matches.find((key) => key.name === undefined);
  assert(selected, `Schema catalog must expose the expected ${selector} form`);
  assert.equal(selected.kind, kind);
  assert.deepEqual(selected.fields, fields);
}

async function readPhysicalConstraints(
  driver: AnyDriver,
  namespace: string,
  tableName: string
): Promise<PhysicalConstraint[]> {
  const query =
    liveProvider === "pg"
      ? `
SELECT
  constraint_record.conname AS constraint_name,
  constraint_record.contype AS constraint_kind,
  column_record.attname AS column_name,
  key_column.position AS ordinal_position
FROM pg_catalog.pg_constraint AS constraint_record
JOIN pg_catalog.pg_class AS table_record
  ON table_record.oid = constraint_record.conrelid
JOIN pg_catalog.pg_namespace AS namespace_record
  ON namespace_record.oid = table_record.relnamespace
JOIN LATERAL unnest(constraint_record.conkey) WITH ORDINALITY
  AS key_column(attribute_number, position) ON true
JOIN pg_catalog.pg_attribute AS column_record
  ON column_record.attrelid = table_record.oid
 AND column_record.attnum = key_column.attribute_number
WHERE namespace_record.nspname = $1
  AND table_record.relname = $2
  AND constraint_record.contype IN ('p', 'u')
ORDER BY constraint_record.conname, key_column.position`
      : `
SELECT
  table_constraint.CONSTRAINT_NAME AS constraint_name,
  table_constraint.CONSTRAINT_TYPE AS constraint_kind,
  key_column.COLUMN_NAME AS column_name,
  key_column.ORDINAL_POSITION AS ordinal_position
FROM information_schema.TABLE_CONSTRAINTS AS table_constraint
JOIN information_schema.KEY_COLUMN_USAGE AS key_column
  ON key_column.CONSTRAINT_SCHEMA = table_constraint.CONSTRAINT_SCHEMA
 AND key_column.TABLE_NAME = table_constraint.TABLE_NAME
 AND key_column.CONSTRAINT_NAME = table_constraint.CONSTRAINT_NAME
WHERE table_constraint.CONSTRAINT_SCHEMA = ?
  AND table_constraint.TABLE_NAME = ?
  AND table_constraint.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE')
ORDER BY table_constraint.CONSTRAINT_NAME, key_column.ORDINAL_POSITION`;
  const rows = await driver._executeRaw<Record<string, unknown>>(query, [
    namespace,
    tableName,
  ]);
  const constraints = new Map<string, PhysicalConstraint>();
  for (const row of rows.rows) {
    const name = row.constraint_name;
    const providerKind = row.constraint_kind;
    const column = row.column_name;
    assert(typeof name === "string");
    assert(typeof providerKind === "string");
    assert(typeof column === "string");
    const kind =
      providerKind === "p" || providerKind === "PRIMARY KEY"
        ? "primary"
        : "unique";
    const existing = constraints.get(name);
    if (existing) {
      constraints.set(name, {
        ...existing,
        columns: [...existing.columns, column],
      });
    } else {
      constraints.set(name, { name, kind, columns: [column] });
    }
  }
  return [...constraints.values()];
}

async function attestConstraint(
  driver: AnyDriver,
  schema: Schema,
  namespace: string,
  tableName: string,
  kind: "primary" | "unique",
  columns: readonly string[]
) {
  const installed = (
    await readPhysicalConstraints(driver, namespace, tableName)
  ).filter(
    (constraint) =>
      constraint.kind === kind &&
      constraint.columns.length === columns.length &&
      constraint.columns.every((column, index) => column === columns[index])
  );
  assert.equal(
    installed.length,
    1,
    `Provider catalog must expose one ${kind} constraint on ${tableName}(${columns.join(",")})`
  );
  const physical = installed[0];
  assert(physical);
  const desired = migrationTable(schema, tableName);
  if (kind === "primary") {
    assert(desired.primaryKey);
    assert.deepEqual(desired.primaryKey.columns, columns);
  } else {
    assert.equal(
      physical.name,
      migrationUniqueName(schema, tableName, columns),
      "Installed UNIQUE name must match the migration owner's snapshot"
    );
  }
  return physical;
}

function ddlConstraint(
  name: string,
  columns: readonly string[],
  names: LiveNames
) {
  return `CONSTRAINT ${names.quote(name)} UNIQUE(${columns
    .map(names.quote)
    .join(",")})`;
}

function failedUnique(
  world: World,
  expectedTable: string,
  expected: PhysicalConstraint
) {
  assert.equal(
    world.batchFailures.length,
    1,
    "one atomic submission must fail"
  );
  const failure = world.batchFailures[0];
  assert(failure instanceof UniqueConstraintError);
  assert.equal(failure.code, "V3001");
  assert.equal(
    failure.meta.providerCode,
    liveProvider === "pg" ? "23505" : "ER_DUP_ENTRY"
  );
  if (liveProvider === "mysql") assert.equal(failure.meta.providerErrno, 1062);
  assert.equal(failure.meta.table, expectedTable);
  assert.equal(failure.meta.constraint, expected.name);
  assert.deepEqual(failure.meta.columns, undefined);
  const statementIndex = failure.meta.statementIndex;
  assert(
    typeof statementIndex === "number" &&
      Number.isInteger(statementIndex) &&
      statementIndex >= 0
  );
  const rejected = world.failedBatches[0]?.queries[statementIndex];
  assert(
    rejected,
    "Normalized attribution must identify the rejected statement"
  );
  assert.match(rejected.sql, /^\s*INSERT\b/i);
  return { failure, rejected };
}

async function runMappedScalarRootRecovery(factory: CandidateEngineFactory) {
  const tableName = "g3p02_root_accounts";
  const account = s
    .model({
      id: s.string().id().map("record_id"),
      email: s.string().unique().map("email_address"),
      label: s.string().map("display_label"),
    })
    .map(tableName);
  const schema = { account };
  assertAddressableKey(account, "email", "unique", ["email"]);
  const uniqueName = migrationUniqueName(schema, tableName, ["email_address"]);
  const initial = {
    accounts: [
      {
        record_id: "decoy",
        email_address: "decoy@x",
        display_label: "decoy",
      },
    ],
  };
  const planted = {
    record_id: "winner",
    email_address: "root-race@x",
    display_label: "winner",
  };
  const final = {
    accounts: [...initial.accounts, { ...planted, display_label: "updated" }],
  };
  let expectedConstraint: PhysicalConstraint | undefined;
  let missing = 0;
  let winner = 0;
  const barrier: LiveBarrier = async (completion, _state, peer) => {
    const selector = completion.statement.parameters.includes("root-race@x");
    if (!selector || completion.transactionOpen) return undefined;
    if (completion.rows.length === 0) {
      missing++;
      const placeholders = liveProvider === "pg" ? "$1,$2,$3" : "?,?,?";
      await peer.write(
        `INSERT INTO ${peer.table(tableName)} (${[
          "record_id",
          "email_address",
          "display_label",
        ]
          .map(peer.quote)
          .join(",")}) VALUES (${placeholders})`,
        Object.values(planted)
      );
      return "root-mapped-scalar-missing";
    }
    winner++;
    return "root-mapped-scalar-winner";
  };
  const fixture: LiveFixture = {
    initial,
    tables: { accounts: { name: tableName, order: ["record_id"] } },
    async invoke(driver, candidate) {
      assert(candidate);
      expectedConstraint = await attestConstraint(
        driver,
        schema,
        providerNamespace(driver),
        tableName,
        "unique",
        ["email_address"]
      );
      return candidate({ schema, driver }).execute("account", "upsert", {
        where: { email: "root-race@x" },
        create: { id: "loser", email: "root-race@x", label: "loser" },
        update: { label: "updated" },
        select: { id: true, email: true, label: true },
      });
    },
    assert(observation) {
      assert.deepEqual(observation.final, final);
      assert.deepEqual(observation.outcome, {
        kind: "success",
        value: { id: "winner", email: "root-race@x", label: "updated" },
      });
    },
  };
  const world = await runLiveWorld(
    fixture,
    (names) => ({
      [tableName]: `${names.quote("record_id")} ${textType} PRIMARY KEY NOT NULL,${names.quote("email_address")} ${textType} NOT NULL,${names.quote("display_label")} ${textType} NOT NULL,${ddlConstraint(uniqueName, ["email_address"], names)}`,
    }),
    factory,
    "atomic-batch",
    barrier
  );
  assert(expectedConstraint);
  const { rejected } = failedUnique(world, tableName, expectedConstraint);
  assert(rejected.sql.includes(tableName));
  assert.deepEqual(rejected.params, ["loser", "root-race@x", "loser"]);
  assert.equal(missing, 1);
  assert.equal(winner, 1);
  assert.equal(
    world.statements.filter((statement) =>
      statement.parameters.includes("loser")
    ).length,
    1,
    "recovery must not retry the losing INSERT"
  );
  fixture.assert(world.observation);
  world.assertHealthy();
}

async function runMappedCompoundNestedRecovery(
  factory: CandidateEngineFactory
) {
  const authorTable = "g3p02_compound_authors";
  const postTable = "g3p02_compound_posts";
  const author = s
    .model({
      id: s.string().id().map("record_id"),
      tenant: s.string().map("tenant_key"),
      code: s.string().map("code_key"),
      name: s.string().map("display_name"),
      posts: s.toMany(() => post),
    })
    .unique(["tenant", "code"], { name: "tenantCode" })
    .map(authorTable);
  const post = s
    .model({
      id: s.string().id().map("record_id"),
      authorId: s.string().map("author_id"),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id"),
    })
    .map(postTable);
  const schema = { author, post };
  assertAddressableKey(
    author,
    "tenantCode",
    "compoundUnique",
    ["tenant", "code"],
    true
  );
  const uniqueName = migrationUniqueName(schema, authorTable, [
    "tenant_key",
    "code_key",
  ]);
  const initial = {
    authors: [
      {
        record_id: "decoy",
        tenant_key: "other",
        code_key: "other",
        display_name: "decoy",
      },
    ],
    posts: [],
  };
  const planted = {
    record_id: "winner",
    tenant_key: "tenant-1",
    code_key: "code-1",
    display_name: "winner",
  };
  let expectedConstraint: PhysicalConstraint | undefined;
  let missing = 0;
  let winner = 0;
  const barrier: LiveBarrier = async (completion, _state, peer) => {
    const parameters = completion.statement.parameters;
    const selector =
      parameters.includes("tenant-1") && parameters.includes("code-1");
    if (!selector || completion.transactionOpen) return undefined;
    if (completion.rows.length === 0) {
      missing++;
      const placeholders = liveProvider === "pg" ? "$1,$2,$3,$4" : "?,?,?,?";
      await peer.write(
        `INSERT INTO ${peer.table(authorTable)} (${[
          "record_id",
          "tenant_key",
          "code_key",
          "display_name",
        ]
          .map(peer.quote)
          .join(",")}) VALUES (${placeholders})`,
        Object.values(planted)
      );
      return "nested-mapped-compound-missing";
    }
    winner++;
    return "nested-mapped-compound-winner";
  };
  const fixture: LiveFixture = {
    initial,
    tables: {
      authors: { name: authorTable, order: ["record_id"] },
      posts: { name: postTable, order: ["record_id"] },
    },
    async invoke(driver, candidate) {
      assert(candidate);
      expectedConstraint = await attestConstraint(
        driver,
        schema,
        providerNamespace(driver),
        authorTable,
        "unique",
        ["tenant_key", "code_key"]
      );
      return candidate({ schema, driver }).execute("post", "create", {
        data: {
          id: "post-1",
          author: {
            connectOrCreate: {
              where: {
                tenantCode: { tenant: "tenant-1", code: "code-1" },
              },
              create: {
                id: "loser",
                tenant: "tenant-1",
                code: "code-1",
                name: "loser",
              },
            },
          },
        },
        select: { id: true, authorId: true },
      });
    },
    assert(observation) {
      assert.deepEqual(observation.outcome, {
        kind: "success",
        value: { id: "post-1", authorId: "winner" },
      });
      assert.deepEqual(observation.final, {
        authors: [...initial.authors, planted],
        posts: [{ record_id: "post-1", author_id: "winner" }],
      });
    },
  };
  const world = await runLiveWorld(
    fixture,
    (names) => ({
      [authorTable]: `${names.quote("record_id")} ${textType} PRIMARY KEY NOT NULL,${names.quote("tenant_key")} ${textType} NOT NULL,${names.quote("code_key")} ${textType} NOT NULL,${names.quote("display_name")} ${textType} NOT NULL,${ddlConstraint(uniqueName, ["tenant_key", "code_key"], names)}`,
      [postTable]: `${names.quote("record_id")} ${textType} PRIMARY KEY NOT NULL,${names.quote("author_id")} ${textType} NOT NULL,FOREIGN KEY(${names.quote("author_id")}) REFERENCES ${names.table(authorTable)}(${names.quote("record_id")})`,
    }),
    factory,
    "atomic-batch",
    barrier
  );
  assert(expectedConstraint);
  const { rejected } = failedUnique(world, authorTable, expectedConstraint);
  assert.deepEqual(rejected.params, ["loser", "tenant-1", "code-1", "loser"]);
  assert.equal(missing, 1);
  assert.equal(winner, 1);
  assert.equal(
    world.statements.filter((statement) =>
      statement.parameters.includes("loser")
    ).length,
    1
  );
  fixture.assert(world.observation);
  world.assertHealthy();
}

async function runDuplicateSelectorRefusalAndDistinctControl(
  factory: CandidateEngineFactory
) {
  const duplicateTable = "g3p02_duplicate_operation_sentinel";
  const duplicatePost = s
    .model({
      id: s.string().id(),
      lookup: s.string().unique().map("scalar_lookup"),
      tenant: s.string().map("tenant_key"),
      code: s.string().map("code_key"),
      label: s.string(),
    })
    .unique(["tenant", "code"], { name: "lookup" })
    .map(duplicateTable);
  const tableName = "g3p02_distinct_selector_posts";
  const post = s
    .model({
      id: s.string().id(),
      lookup: s.string().unique().map("scalar_lookup"),
      tenant: s.string().map("tenant_key"),
      code: s.string().map("code_key"),
      label: s.string(),
    })
    .unique(["tenant", "code"], { name: "tenantCode" })
    .map(tableName);
  const schema = { post };
  assertAddressableKey(post, "lookup", "unique", ["lookup"]);
  assertAddressableKey(
    post,
    "tenantCode",
    "compoundUnique",
    ["tenant", "code"],
    true
  );
  const scalarName = migrationUniqueName(schema, tableName, ["scalar_lookup"]);
  const compoundName = migrationUniqueName(schema, tableName, [
    "tenant_key",
    "code_key",
  ]);
  const initial = {
    posts: [
      {
        id: "compound-row",
        scalar_lookup: "compound-lookup",
        tenant_key: "tenant-hit",
        code_key: "code-hit",
        label: "compound",
      },
      {
        id: "scalar-row",
        scalar_lookup: "scalar-hit",
        tenant_key: "scalar-tenant",
        code_key: "scalar-code",
        label: "scalar",
      },
    ],
  };
  let scalarConstraint: PhysicalConstraint | undefined;
  let compoundConstraint: PhysicalConstraint | undefined;
  const fixture: LiveFixture = {
    expectedExecutions: 2,
    initial,
    tables: { posts: { name: tableName, order: ["id"] } },
    async invoke(driver, candidate) {
      assert(candidate);
      assert.throws(
        () => candidate({ schema: { post: duplicatePost }, driver }),
        (failure) => {
          assert(failure instanceof SchemaValidationError);
          assert.equal(failure.code, VibORMErrorCode.INVALID_INPUT);
          assert.deepEqual(failure.issues, [
            {
              code: "I006",
              severity: "error",
              model: "post",
              message:
                "Public selector name 'lookup' is ambiguous in 'post'; a compound selector must not reuse a model field, logical filter, or another compound selector name",
            },
          ]);
          return true;
        }
      );
      scalarConstraint = await attestConstraint(
        driver,
        schema,
        providerNamespace(driver),
        tableName,
        "unique",
        ["scalar_lookup"]
      );
      compoundConstraint = await attestConstraint(
        driver,
        schema,
        providerNamespace(driver),
        tableName,
        "unique",
        ["tenant_key", "code_key"]
      );
      const engine = candidate({ schema, driver });
      return {
        scalar: await engine.execute("post", "findUnique", {
          where: { lookup: "scalar-hit" },
          select: { id: true, label: true },
        }),
        compound: await engine.execute("post", "findUnique", {
          where: {
            tenantCode: { tenant: "tenant-hit", code: "code-hit" },
          },
          select: { id: true, label: true },
        }),
      };
    },
    assert(observation) {
      assert.deepEqual(observation.outcome, {
        kind: "success",
        value: {
          scalar: { id: "scalar-row", label: "scalar" },
          compound: { id: "compound-row", label: "compound" },
        },
      });
      assert.deepEqual(observation.final, initial);
    },
  };
  const world = await runLiveWorld(
    fixture,
    (names) => ({
      [tableName]: `${names.quote("id")} ${textType} PRIMARY KEY NOT NULL,${names.quote("scalar_lookup")} ${textType} NOT NULL,${names.quote("tenant_key")} ${textType} NOT NULL,${names.quote("code_key")} ${textType} NOT NULL,${names.quote("label")} ${textType} NOT NULL,${ddlConstraint(scalarName, ["scalar_lookup"], names)},${ddlConstraint(compoundName, ["tenant_key", "code_key"], names)}`,
    }),
    factory,
    "atomic-batch"
  );
  if (world.terminalFailure !== undefined) throw world.terminalFailure;
  assert(scalarConstraint);
  assert(compoundConstraint);
  assert.equal(world.statements.length, 2);
  assert.equal(world.completions.length, 2);
  assert(
    world.statements.every(
      (statement) =>
        !statement.sql.includes(duplicateTable) &&
        !statement.parameters.includes(duplicateTable)
    ),
    "The rejected schema must perform no provider operation work"
  );
  fixture.assert(world.observation);
  world.assertHealthy();
}

async function runUnrelatedConstraintRefusal(factory: CandidateEngineFactory) {
  const authorTable = "g3p02_unrelated_authors";
  const postTable = "g3p02_unrelated_posts";
  const author = s
    .model({
      id: s.string().id(),
      email: s.string().unique(),
      name: s.string(),
      posts: s.toMany(() => post),
    })
    .map(authorTable);
  const post = s
    .model({
      id: s.string().id(),
      authorId: s.string(),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id"),
    })
    .map(postTable);
  const schema = { author, post };
  assertAddressableKey(author, "id", "primary", ["id"]);
  const emailName = migrationUniqueName(schema, authorTable, ["email"]);
  const initial = { authors: [], posts: [] };
  const planted = { id: "other", email: "occupied@x", name: "blocker" };
  let expectedConstraint: PhysicalConstraint | undefined;
  let missing = 0;
  const barrier: LiveBarrier = async (completion, _state, peer) => {
    if (
      !completion.statement.parameters.includes("wanted") ||
      completion.transactionOpen
    )
      return undefined;
    if (completion.rows.length !== 0) return undefined;
    missing++;
    const placeholders = liveProvider === "pg" ? "$1,$2,$3" : "?,?,?";
    await peer.write(
      `INSERT INTO ${peer.table(authorTable)} (${["id", "email", "name"].map(peer.quote).join(",")}) VALUES (${placeholders})`,
      Object.values(planted)
    );
    return "unrelated-constraint-missing";
  };
  const fixture: LiveFixture = {
    initial,
    tables: {
      authors: { name: authorTable, order: ["id"] },
      posts: { name: postTable, order: ["id"] },
    },
    async invoke(driver, candidate) {
      assert(candidate);
      expectedConstraint = await attestConstraint(
        driver,
        schema,
        providerNamespace(driver),
        authorTable,
        "unique",
        ["email"]
      );
      return candidate({ schema, driver }).execute("post", "create", {
        data: {
          id: "post-unrelated",
          author: {
            connectOrCreate: {
              where: { id: "wanted" },
              create: { id: "wanted", email: "occupied@x", name: "loser" },
            },
          },
        },
      });
    },
    assert(observation) {
      assert.equal(observation.outcome.kind, "failure");
      assert.deepEqual(observation.final, { authors: [planted], posts: [] });
    },
  };
  const world = await runLiveWorld(
    fixture,
    (names) => ({
      [authorTable]: `${names.quote("id")} ${textType} PRIMARY KEY NOT NULL,${names.quote("email")} ${textType} NOT NULL,${names.quote("name")} ${textType} NOT NULL,${ddlConstraint(emailName, ["email"], names)}`,
      [postTable]: `${names.quote("id")} ${textType} PRIMARY KEY NOT NULL,${names.quote("authorId")} ${textType} NOT NULL,FOREIGN KEY(${names.quote("authorId")}) REFERENCES ${names.table(authorTable)}(${names.quote("id")})`,
    }),
    factory,
    "atomic-batch",
    barrier
  );
  assert(expectedConstraint);
  const { failure, rejected } = failedUnique(
    world,
    authorTable,
    expectedConstraint
  );
  assert.deepEqual(rejected.params, ["wanted", "occupied@x", "loser"]);
  assert.equal(missing, 1);
  assert.equal(world.terminalFailure, failure);
  assert.equal(
    world.statements.filter((statement) =>
      statement.parameters.includes("loser")
    ).length,
    1
  );
  fixture.assert(world.observation);
  world.assertHealthy();
}

async function runWrongTableProducerRefusal(factory: CandidateEngineFactory) {
  const authorTable = "g3p02_wrong_authors";
  const badgeTable = "g3p02_wrong_badges";
  const postTable = "g3p02_wrong_posts";
  const author = s
    .model({
      id: s.string().id(),
      name: s.string(),
      posts: s.toMany(() => post),
    })
    .map(authorTable);
  const badge = s
    .model({
      id: s.string().id(),
      label: s.string(),
      posts: s.toMany(() => post),
    })
    .map(badgeTable);
  const post = s
    .model({
      id: s.string().id(),
      authorId: s.string(),
      badgeId: s.string(),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id"),
      badge: s
        .toOne(() => badge)
        .fields("badgeId")
        .references("id"),
    })
    .map(postTable);
  const schema = { author, badge, post };
  const initial = {
    authors: [],
    badges: [{ id: "occupied", label: "existing" }],
    posts: [],
  };
  let expectedConstraint: PhysicalConstraint | undefined;
  let missing = 0;
  const barrier: LiveBarrier = async (completion) => {
    if (
      !completion.statement.parameters.includes("wanted") ||
      completion.transactionOpen
    )
      return undefined;
    if (completion.rows.length !== 0) return undefined;
    missing++;
    return "wrong-table-producer-missing";
  };
  const fixture: LiveFixture = {
    initial,
    tables: {
      authors: { name: authorTable, order: ["id"] },
      badges: { name: badgeTable, order: ["id"] },
      posts: { name: postTable, order: ["id"] },
    },
    async invoke(driver, candidate) {
      assert(candidate);
      expectedConstraint = await attestConstraint(
        driver,
        schema,
        providerNamespace(driver),
        badgeTable,
        "primary",
        ["id"]
      );
      return candidate({ schema, driver }).execute("post", "create", {
        data: {
          id: "post-wrong",
          author: {
            connectOrCreate: {
              where: { id: "wanted" },
              create: { id: "wanted", name: "conditional-loser" },
            },
          },
          badge: { create: { id: "occupied", label: "wrong-producer" } },
        },
      });
    },
    assert(observation) {
      assert.equal(observation.outcome.kind, "failure");
      assert.deepEqual(observation.final, initial);
    },
  };
  const world = await runLiveWorld(
    fixture,
    (names) => ({
      [authorTable]: `${names.quote("id")} ${textType} PRIMARY KEY NOT NULL,${names.quote("name")} ${textType} NOT NULL`,
      [badgeTable]: `${names.quote("id")} ${textType} PRIMARY KEY NOT NULL,${names.quote("label")} ${textType} NOT NULL`,
      [postTable]: `${names.quote("id")} ${textType} PRIMARY KEY NOT NULL,${names.quote("authorId")} ${textType} NOT NULL,${names.quote("badgeId")} ${textType} NOT NULL,FOREIGN KEY(${names.quote("authorId")}) REFERENCES ${names.table(authorTable)}(${names.quote("id")}),FOREIGN KEY(${names.quote("badgeId")}) REFERENCES ${names.table(badgeTable)}(${names.quote("id")})`,
    }),
    factory,
    "atomic-batch",
    barrier
  );
  assert(expectedConstraint);
  const { failure, rejected } = failedUnique(
    world,
    badgeTable,
    expectedConstraint
  );
  assert(rejected.sql.includes(badgeTable));
  assert.deepEqual(rejected.params, ["occupied", "wrong-producer"]);
  const failedSubmission = world.failedBatches[0];
  assert(failedSubmission);
  assert(
    failedSubmission.queries.some(
      (query) =>
        query.sql.includes(authorTable) &&
        query.params?.includes("conditional-loser")
    ),
    "the rejected atomic submission must contain the eligible missing producer"
  );
  assert.equal(missing, 1);
  assert.equal(world.terminalFailure, failure);
  assert.equal(
    world.statements.filter((statement) =>
      statement.parameters.includes("wrong-producer")
    ).length,
    1
  );
  assert.equal(
    world.statements.filter((statement) =>
      statement.parameters.includes("conditional-loser")
    ).length,
    1
  );
  fixture.assert(world.observation);
  world.assertHealthy();
}

describe(`G3P-02 native ${liveProvider} constraint ownership`, () => {
  it(
    "g3p02-mapped-scalar-root-recovery",
    () => runMappedScalarRootRecovery(createCommandEngine),
    30_000
  );
  it(
    "g3p02-mapped-compound-nested-recovery",
    () => runMappedCompoundNestedRecovery(createCommandEngine),
    30_000
  );
  it(
    "g3p02-duplicate-selector-definition-refusal-and-distinct-control",
    () => runDuplicateSelectorRefusalAndDistinctControl(createCommandEngine),
    30_000
  );
  it(
    "g3p02-unrelated-constraint-refusal",
    () => runUnrelatedConstraintRefusal(createCommandEngine),
    30_000
  );
  it(
    "g3p02-wrong-table-producer-refusal",
    () => runWrongTableProducerRefusal(createCommandEngine),
    30_000
  );
});
