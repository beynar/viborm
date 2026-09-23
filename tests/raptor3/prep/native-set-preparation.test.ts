import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { UniqueConstraintError } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { overrideTransactionOperation } from "@tests/fixtures/transaction-operation";
import { describe, it } from "vitest";
import type { CandidateEngineFactory } from "../harness/protocol";
import {
  liveProvider,
  runLiveWorld,
  type LiveFixture,
} from "../transitions/live-world";

type World = Awaited<ReturnType<typeof runLiveWorld>>;

const textType = liveProvider === "pg" ? "TEXT" : "VARCHAR(191)";

function assertOneBorrowedTransaction(
  borrowedDrivers: readonly AnyDriver[],
  factoryDriver: AnyDriver
) {
  assert.equal(borrowedDrivers.length, 2);
  const transactionDriver = borrowedDrivers[0];
  assert(transactionDriver);
  assert.notEqual(transactionDriver, factoryDriver);
  assert(
    borrowedDrivers.every((driver) => driver === transactionDriver),
    "Both candidate members must receive the exact same caller-owned transaction driver"
  );
}

function assertNoCandidateTransactionControl(world: World) {
  assert(
    world.statements.every(
      (statement) =>
        !/^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(
          statement.sql
        )
    ),
    "Candidate statements must contain no transaction or savepoint control"
  );
}

function throwTerminalFailure(world: World) {
  if (world.terminalFailure !== undefined) throw world.terminalFailure;
}

async function runScalarCommit(factory: CandidateEngineFactory) {
  const tableName = "g3p03_scalar_commit_records";
  const record = s
    .model({
      id: s.string().id(),
      score: s.int(),
      label: s.string(),
    })
    .map(tableName);
  const schema = { record };
  const initial = {
    records: [{ id: "a", score: 1, label: "existing" }],
  };
  const final = {
    records: [
      { id: "a", score: 11, label: "existing" },
      { id: "b", score: 12, label: "created-b" },
      { id: "c", score: 13, label: "created-c" },
    ],
  };
  const createArgs =
    liveProvider === "pg"
      ? {
          data: [
            { id: "b", score: 2, label: "created-b" },
            { id: "c", score: 3, label: "created-c" },
          ],
          select: { id: true, score: true, label: true },
        }
      : {
          data: [
            { id: "b", score: 2, label: "created-b" },
            { id: "c", score: 3, label: "created-c" },
          ],
        };
  const updateArgs = {
    where: { score: { gte: 1 } },
    data: { score: { increment: 10 } },
  };
  const borrowedDrivers: AnyDriver[] = [];
  const executionOrder: string[] = [];
  let factoryDriver: AnyDriver | undefined;
  const fixture: LiveFixture = {
    expectedExecutions: 2,
    initial,
    tables: { records: { name: tableName, order: ["id"] } },
    async invoke(driver, candidateFactory) {
      assert(candidateFactory);
      factoryDriver = driver;
      const candidate = candidateFactory({ schema, driver });
      const client = createClient({ schema, driver });
      const first = overrideTransactionOperation(client.record.findMany(), {
        async executeWith(transactionDriver) {
          borrowedDrivers.push(transactionDriver);
          executionOrder.push("create-enter");
          const value = await candidate.execute(
            "record",
            "createMany",
            createArgs,
            { kind: "borrowed-transaction", driver: transactionDriver }
          );
          executionOrder.push("create-complete");
          return value;
        },
      });
      const second = overrideTransactionOperation(client.record.findMany(), {
        async executeWith(transactionDriver) {
          borrowedDrivers.push(transactionDriver);
          executionOrder.push("update-enter");
          const value = await candidate.execute(
            "record",
            "updateMany",
            updateArgs,
            { kind: "borrowed-transaction", driver: transactionDriver }
          );
          executionOrder.push("update-complete");
          return value;
        },
      });
      // @ts-expect-error - The registered test shells have the existing runtime
      // transaction-operation owner but are intentionally absent from the public union.
      return client.$transaction([first, second]);
    },
    assert(observation) {
      assert.deepEqual(observation.outcome, {
        kind: "success",
        value: [
          liveProvider === "pg"
            ? [
                { id: "b", score: 2, label: "created-b" },
                { id: "c", score: 3, label: "created-c" },
              ]
            : { count: 2 },
          { count: 3 },
        ],
      });
      assert.deepEqual(observation.final, final);
    },
  };
  const world = await runLiveWorld(
    fixture,
    (names) => ({
      [tableName]: `${names.quote("id")} ${textType} PRIMARY KEY NOT NULL,${names.quote("score")} INTEGER NOT NULL,${names.quote("label")} ${textType} NOT NULL`,
    }),
    factory
  );
  throwTerminalFailure(world);
  assert(factoryDriver);
  assertOneBorrowedTransaction(borrowedDrivers, factoryDriver);
  assert.deepEqual(executionOrder, [
    "create-enter",
    "create-complete",
    "update-enter",
    "update-complete",
  ]);
  assert.equal(world.statements.length, 2);
  assert.equal(world.completions.length, 2);
  const insert = world.statements.filter((statement) =>
    /^\s*INSERT\b/i.test(statement.sql)
  );
  const update = world.statements.filter((statement) =>
    /^\s*UPDATE\b/i.test(statement.sql)
  );
  assert.equal(insert.length, 1);
  assert.equal(update.length, 1);
  const insertStatement = insert[0];
  const updateStatement = update[0];
  assert(insertStatement);
  assert(updateStatement);
  assert(insertStatement.sql.includes(tableName));
  assert(updateStatement.sql.includes(tableName));
  if (liveProvider === "pg")
    assert.match(insertStatement.sql, /\bRETURNING\b/i);
  else assert.doesNotMatch(insertStatement.sql, /\bRETURNING\b/i);
  assert(
    world.completions.every((completion) => completion.transactionOpen),
    "Both set mutations must execute inside the caller-owned transaction"
  );
  assertNoCandidateTransactionControl(world);
  fixture.assert(world.observation);
  world.assertHealthy();
}

async function runScalarRollback(factory: CandidateEngineFactory) {
  const tableName = "g3p03_scalar_rollback_records";
  const record = s
    .model({ id: s.string().id(), label: s.string() })
    .map(tableName);
  const schema = { record };
  const initial = {
    records: [
      { id: "a", label: "keep-a" },
      { id: "b", label: "keep-b" },
    ],
  };
  const borrowedDrivers: AnyDriver[] = [];
  let providerFailure: unknown;
  let factoryDriver: AnyDriver | undefined;
  const fixture: LiveFixture = {
    expectedExecutions: 2,
    initial,
    tables: { records: { name: tableName, order: ["id"] } },
    async invoke(driver, candidateFactory) {
      assert(candidateFactory);
      factoryDriver = driver;
      const candidate = candidateFactory({ schema, driver });
      const client = createClient({ schema, driver });
      const first = overrideTransactionOperation(client.record.findMany(), {
        executeWith(transactionDriver) {
          borrowedDrivers.push(transactionDriver);
          return candidate.execute(
            "record",
            "updateMany",
            { where: { id: "a" }, data: { label: "must-roll-back" } },
            { kind: "borrowed-transaction", driver: transactionDriver }
          );
        },
      });
      const second = overrideTransactionOperation(client.record.findMany(), {
        executeWith(transactionDriver) {
          borrowedDrivers.push(transactionDriver);
          return candidate.execute(
            "record",
            "createMany",
            { data: [{ id: "b", label: "duplicate" }] },
            { kind: "borrowed-transaction", driver: transactionDriver }
          );
        },
      });
      await assert.rejects(
        // @ts-expect-error - The registered test shells are intentionally absent
        // from the public operation union while retaining their runtime owner.
        client.$transaction([first, second]),
        (failure) => {
          providerFailure = failure;
          return true;
        }
      );
      return "caller-rolled-back";
    },
    assert(observation) {
      assert.deepEqual(observation.outcome, {
        kind: "success",
        value: "caller-rolled-back",
      });
      assert.deepEqual(observation.final, initial);
    },
  };
  const world = await runLiveWorld(
    fixture,
    (names) => ({
      [tableName]: `${names.quote("id")} ${textType} PRIMARY KEY NOT NULL,${names.quote("label")} ${textType} NOT NULL`,
    }),
    factory
  );
  throwTerminalFailure(world);
  assert(factoryDriver);
  assertOneBorrowedTransaction(borrowedDrivers, factoryDriver);
  assert(providerFailure instanceof UniqueConstraintError);
  assert.equal(
    providerFailure.meta.providerCode,
    liveProvider === "pg" ? "23505" : "ER_DUP_ENTRY"
  );
  assert.equal(providerFailure.meta.table, tableName);
  assert.equal(
    providerFailure.meta.constraint,
    liveProvider === "pg" ? `${tableName}_pkey` : "PRIMARY"
  );
  assert.equal(world.statements.length, 2);
  assert.equal(world.completions.length, 1);
  const update = world.statements[0];
  const insert = world.statements[1];
  assert(update);
  assert(insert);
  assert.match(update.sql, /^\s*UPDATE\b/i);
  assert.match(insert.sql, /^\s*INSERT\b/i);
  assert.equal(update.completed, true);
  assert.equal(insert.completed, false);
  assert.equal(world.completions[0]?.transactionOpen, true);
  assertNoCandidateTransactionControl(world);
  fixture.assert(world.observation);
  world.assertHealthy();
}

async function runRelationSeries(factory: CandidateEngineFactory) {
  const shelfTable = "g3p03_series_shelves";
  const binTable = "g3p03_series_bins";
  const shelf = s
    .model({
      id: s.int().id(),
      room: s.string(),
      bins: s.toMany(() => bin),
    })
    .map(shelfTable);
  const bin = s
    .model({
      id: s.int().id(),
      label: s.string(),
      shelfId: s.int().nullable(),
      shelf: s
        .toOne(() => shelf)
        .fields("shelfId")
        .references("id"),
    })
    .map(binTable);
  const schema = { shelf, bin };
  const initial = {
    shelves: [
      { id: 98, room: "north" },
      { id: 99, room: "south" },
    ],
    bins: [
      { id: 11, label: "one", shelfId: null },
      { id: 12, label: "two", shelfId: null },
      { id: 13, label: "three", shelfId: null },
    ],
  };
  const borrowedDrivers: AnyDriver[] = [];
  let factoryDriver: AnyDriver | undefined;
  const fixture: LiveFixture = {
    expectedExecutions: 2,
    initial,
    tables: {
      shelves: { name: shelfTable, order: ["id"] },
      bins: { name: binTable, order: ["id"] },
    },
    async invoke(driver, candidateFactory) {
      assert(candidateFactory);
      factoryDriver = driver;
      const candidate = candidateFactory({ schema, driver });
      const client = createClient({ schema, driver });
      const first = overrideTransactionOperation(client.bin.findMany(), {
        executeWith(transactionDriver) {
          borrowedDrivers.push(transactionDriver);
          return candidate.execute(
            "bin",
            "updateMany",
            {
              where: { id: { in: [12, 11] } },
              data: { label: "moved", shelf: { connect: { id: 99 } } },
            },
            { kind: "borrowed-transaction", driver: transactionDriver }
          );
        },
      });
      const second = overrideTransactionOperation(client.bin.findMany(), {
        executeWith(transactionDriver) {
          borrowedDrivers.push(transactionDriver);
          return candidate.execute(
            "bin",
            "deleteMany",
            { where: { id: 13 } },
            { kind: "borrowed-transaction", driver: transactionDriver }
          );
        },
      });
      // @ts-expect-error - The registered test shells are intentionally absent
      // from the public operation union while retaining their runtime owner.
      return client.$transaction([first, second]);
    },
    assert(observation) {
      assert.deepEqual(observation.outcome, {
        kind: "success",
        value: [{ count: 2 }, { count: 1 }],
      });
      assert.deepEqual(observation.final, {
        shelves: initial.shelves,
        bins: [
          { id: 11, label: "moved", shelfId: 99 },
          { id: 12, label: "moved", shelfId: 99 },
        ],
      });
    },
  };
  const world = await runLiveWorld(
    fixture,
    (names) => ({
      [shelfTable]: `${names.quote("id")} INTEGER PRIMARY KEY NOT NULL,${names.quote("room")} ${textType} NOT NULL`,
      [binTable]: `${names.quote("id")} INTEGER PRIMARY KEY NOT NULL,${names.quote("label")} ${textType} NOT NULL,${names.quote("shelfId")} INTEGER NULL,FOREIGN KEY(${names.quote("shelfId")}) REFERENCES ${names.table(shelfTable)}(${names.quote("id")})`,
    }),
    factory
  );
  throwTerminalFailure(world);
  assert(factoryDriver);
  assertOneBorrowedTransaction(borrowedDrivers, factoryDriver);
  const capture = world.completions.find(
    (completion) =>
      /^\s*SELECT\b/i.test(completion.statement.sql) &&
      completion.statement.sql.includes(binTable) &&
      completion.rows.length === 2
  );
  assert(capture, "Relation-bearing updateMany must capture two actual roots");
  const capturedIds = capture.rows.map((row) => {
    assert(row !== null && typeof row === "object" && "id" in row);
    assert(typeof row.id === "number");
    return row.id;
  });
  const memberUpdates = world.statements.filter(
    (statement) =>
      /^\s*UPDATE\b/i.test(statement.sql) && statement.sql.includes(binTable)
  );
  assert.equal(memberUpdates.length, 2);
  assert.deepEqual(
    memberUpdates.map((statement) => statement.parameters.at(-1)),
    capturedIds,
    "Ordinary member updates must preserve the provider's captured root order"
  );
  const deletion = world.statements.filter(
    (statement) =>
      /^\s*DELETE\b/i.test(statement.sql) && statement.sql.includes(binTable)
  );
  assert.equal(deletion.length, 1);
  const deletionStatement = deletion[0];
  assert(deletionStatement);
  const deleteIndex = world.statements.indexOf(deletionStatement);
  assert(
    memberUpdates.every(
      (statement) => world.statements.indexOf(statement) < deleteIndex
    ),
    "The second array member must start only after every selected-series member"
  );
  assert(
    world.completions.every((completion) => completion.transactionOpen),
    "Capture, ordinary members, and deletion must share the caller transaction"
  );
  assertNoCandidateTransactionControl(world);
  fixture.assert(world.observation);
  world.assertHealthy();
}

const limitTable = "g3p03_compound_limit_records";

function compoundLimitSchema() {
  const record = s
    .model({
      tenant: s.string().map("tenant_key"),
      code: s.string().map("code_key"),
      cohort: s.string(),
      value: s.int(),
    })
    .id(["tenant", "code"])
    .map(limitTable);
  return { record };
}

const limitInitial = {
  records: [
    { tenant_key: "t1", code_key: "selected-a", cohort: "selected", value: 1 },
    { tenant_key: "t1", code_key: "selected-b", cohort: "selected", value: 2 },
    { tenant_key: "t2", code_key: "selected-a", cohort: "selected", value: 3 },
    { tenant_key: "t1", code_key: "delete-a", cohort: "delete", value: 4 },
    { tenant_key: "t2", code_key: "delete-a", cohort: "delete", value: 5 },
    { tenant_key: "t2", code_key: "control", cohort: "control", value: 6 },
  ],
};

function assertObservedRow(
  row: unknown
): asserts row is Record<string, unknown> {
  assert(row !== null && typeof row === "object" && !Array.isArray(row));
}

function observedRows(rows: readonly unknown[] | undefined) {
  return (rows ?? []).map((row) => {
    assertObservedRow(row);
    return row;
  });
}

function limitTableDefinition(names: { quote(identifier: string): string }) {
  return `${names.quote("tenant_key")} ${textType} NOT NULL,${names.quote("code_key")} ${textType} NOT NULL,${names.quote("cohort")} ${textType} NOT NULL,${names.quote("value")} INTEGER NOT NULL,PRIMARY KEY(${names.quote("tenant_key")},${names.quote("code_key")})`;
}

async function runCompoundLimits(factory: CandidateEngineFactory) {
  const schema = compoundLimitSchema();
  const fixture: LiveFixture = {
    expectedExecutions: 2,
    initial: limitInitial,
    tables: {
      records: { name: limitTable, order: ["tenant_key", "code_key"] },
    },
    async invoke(driver, candidateFactory) {
      assert(candidateFactory);
      const candidate = candidateFactory({ schema, driver });
      const updated = await candidate.execute("record", "updateMany", {
        where: { cohort: "selected" },
        data: { value: { set: 9 } },
        limit: 2,
      });
      const deleted = await candidate.execute("record", "deleteMany", {
        where: { cohort: "delete" },
        limit: 1,
      });
      return [updated, deleted];
    },
    assert(observation) {
      assert.deepEqual(observation.outcome, {
        kind: "success",
        value: [{ count: 2 }, { count: 1 }],
      });
      const rows = observedRows(observation.final.records);
      assert.equal(rows.length, 5);
      const selected = rows.filter((row) => row.cohort === "selected");
      assert.equal(selected.length, 3);
      const originalSelectedValues = new Map([
        ["t1\u0000selected-a", 1],
        ["t1\u0000selected-b", 2],
        ["t2\u0000selected-a", 3],
      ]);
      assert.equal(selected.filter((row) => row.value === 9).length, 2);
      for (const row of selected) {
        const identity = `${String(row.tenant_key)}\u0000${String(row.code_key)}`;
        const originalValue = originalSelectedValues.get(identity);
        assert.notEqual(originalValue, undefined);
        assert(row.value === 9 || row.value === originalValue);
      }
      const retainedDelete = rows.filter((row) => row.cohort === "delete");
      assert.equal(retainedDelete.length, 1);
      assert.deepEqual(
        retainedDelete[0],
        retainedDelete[0]?.value === 4
          ? {
              tenant_key: "t1",
              code_key: "delete-a",
              cohort: "delete",
              value: 4,
            }
          : {
              tenant_key: "t2",
              code_key: "delete-a",
              cohort: "delete",
              value: 5,
            }
      );
      assert.deepEqual(
        rows.filter((row) => row.cohort === "control"),
        [
          {
            tenant_key: "t2",
            code_key: "control",
            cohort: "control",
            value: 6,
          },
        ]
      );
      assert.equal(
        new Set(
          rows.map(
            (row) => `${String(row.tenant_key)}\u0000${String(row.code_key)}`
          )
        ).size,
        rows.length,
        "The capped mutations must preserve complete compound row identities"
      );
    },
  };
  const world = await runLiveWorld(
    fixture,
    (names) => ({ [limitTable]: limitTableDefinition(names) }),
    factory
  );
  throwTerminalFailure(world);
  assert.equal(world.statements.length, 2);
  assert.equal(world.completions.length, 2);
  const update = world.statements[0];
  const deletion = world.statements[1];
  assert(update);
  assert(deletion);
  assert.match(update.sql, /^\s*UPDATE\b/i);
  assert.match(deletion.sql, /^\s*DELETE\b/i);
  assert.equal(
    world.statements.some((statement) => /^\s*SELECT\b/i.test(statement.sql)),
    false,
    "A capped scalar mutation must remain one set statement"
  );
  if (liveProvider === "pg") {
    assert.equal(update.parameters.at(-1), 2);
    assert.equal(deletion.parameters.at(-1), 1);
    for (const statement of world.statements) {
      assert.match(
        statement.sql,
        /\(\s*"tenant_key"\s*,\s*"code_key"\s*\)\s+IN\s*\(\s*SELECT\b/i,
        "PostgreSQL must cap through both columns of the complete compound key"
      );
      assert.match(statement.sql, /\bLIMIT\s+\$\d+\b/i);
    }
  } else {
    assert.doesNotMatch(update.sql, /\bIN\s*\(\s*SELECT\b/i);
    assert.doesNotMatch(deletion.sql, /\bIN\s*\(\s*SELECT\b/i);
    assert.match(update.sql, /\bLIMIT\s+2\s*$/i);
    assert.match(
      deletion.sql,
      /\bLIMIT\s+1\s*$/i,
      "MySQL must use its native mutation limit suffix"
    );
  }
  fixture.assert(world.observation);
  world.assertHealthy();
}

async function runZeroLimits(factory: CandidateEngineFactory) {
  const schema = compoundLimitSchema();
  const fixture: LiveFixture = {
    expectedExecutions: 2,
    initial: limitInitial,
    tables: {
      records: { name: limitTable, order: ["tenant_key", "code_key"] },
    },
    async invoke(driver, candidateFactory) {
      assert(candidateFactory);
      const candidate = candidateFactory({ schema, driver });
      const updated = await candidate.execute("record", "updateMany", {
        where: { cohort: "selected" },
        data: { value: { set: 9 } },
        limit: 0,
      });
      const deleted = await candidate.execute("record", "deleteMany", {
        where: { cohort: "delete" },
        limit: 0,
      });
      return [updated, deleted];
    },
    assert(observation) {
      assert.deepEqual(observation.outcome, {
        kind: "success",
        value: [{ count: 0 }, { count: 0 }],
      });
      assert.deepEqual(observation.final, observation.initial);
    },
  };
  const world = await runLiveWorld(
    fixture,
    (names) => ({ [limitTable]: limitTableDefinition(names) }),
    factory
  );
  throwTerminalFailure(world);
  assert.equal(world.statements.length, 0);
  assert.equal(world.completions.length, 0);
  fixture.assert(world.observation);
  world.assertHealthy();
}

describe(`G3P-03 native ${liveProvider} set preparation`, () => {
  it(
    "g3p03-scalar-array-commit",
    () => runScalarCommit(createCommandEngine),
    30_000
  );
  it(
    "g3p03-scalar-array-failure-rolls-back",
    () => runScalarRollback(createCommandEngine),
    30_000
  );
  it(
    "g3p03-relation-update-many-array-order",
    () => runRelationSeries(createCommandEngine),
    30_000
  );
  it(
    "g3p03-compound-scalar-mutation-limits",
    () => runCompoundLimits(createCommandEngine),
    30_000
  );
  it(
    "g3p03-zero-mutation-limits-run-no-statements",
    () => runZeroLimits(createCommandEngine),
    30_000
  );
});
