import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { NestedWriteError, VibORMErrorCode } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import type { AnyModel } from "@schema/model";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { isRecord } from "@validation/value-guards";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

type Profile = "sqlite-interactive" | "sqlite-atomic-batch";
type Engine = "shipped" | "commands";

interface StatementObservation {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  readonly context?: QueryExecutionContext;
}

class WitnessSQLiteDriver extends SQLite3Driver {
  readonly statements: StatementObservation[] = [];
  afterStatement?: (rows: readonly unknown[]) => void;

  resetObservations(): void {
    this.statements.length = 0;
  }

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push({ sql: statement, parameters, context });
    const response = await super.execute<T>(client, statement, parameters);
    this.afterStatement?.(response.rows);
    return response;
  }
}

class BatchOnlySQLiteDriver extends WitnessSQLiteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, (transaction) =>
      super.executeBatch<T>(transaction, queries)
    );
  }
}

function createDriver(
  profile: Profile,
  database: Database.Database
): WitnessSQLiteDriver {
  return profile === "sqlite-interactive"
    ? new WitnessSQLiteDriver({ client: database })
    : new BatchOnlySQLiteDriver({ client: database });
}

async function migrate<S extends Record<string, AnyModel>>(
  schema: S,
  driver: WitnessSQLiteDriver
) {
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  assert.equal(migration.applied, true);
  driver.resetObservations();
  return client;
}

async function captureFailure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (failure) {
    return failure;
  }
  throw new Error("Expected the operation to fail");
}

function assertDependencyFailure(
  failure: unknown,
  relation: string,
  profile: Profile,
  progress?: {
    readonly memberPath: readonly number[];
    readonly totalMembers: number;
    readonly committedSegments: number;
    readonly committedWriteMembers: number;
  },
  diagnostic?: string
): void {
  assert(failure instanceof NestedWriteError, diagnostic);
  assert.equal(failure.code, VibORMErrorCode.NESTED_WRITE_FAILED, diagnostic);
  assert.equal(
    failure.message,
    `Nested operation 'update' on relation '${relation}' depends on an earlier 'create' target write in the same nested write. Split these operations into separate queries.`,
    diagnostic
  );
  assert.deepEqual(
    { ...failure.meta },
    {
      conflictsWith: "create",
      operation: "update",
      relation,
      ...(profile === "sqlite-atomic-batch" && progress
        ? {
            recordSeriesProgress: {
              atomicity: "segment",
              phase: "planning",
              committedSegments: progress.committedSegments,
              committedWriteMembers: progress.committedWriteMembers,
              completedMembers: 0,
              memberPath: progress.memberPath,
              totalMembers: progress.totalMembers,
            },
          }
        : {}),
    },
    diagnostic
  );
}

function assertShippedDependencyFailure(
  failure: unknown,
  relation: string,
  diagnostic?: string
): void {
  assert(failure instanceof NestedWriteError, diagnostic);
  assert.equal(failure.code, VibORMErrorCode.NESTED_WRITE_FAILED, diagnostic);
  assert.match(
    failure.message,
    new RegExp(`relation '${relation}'`),
    diagnostic
  );
}

function hasWriteTo(
  statements: readonly StatementObservation[],
  table: string
) {
  return statements.some(
    ({ sql }) => /^(?:INSERT|UPDATE|DELETE)\b/.test(sql) && sql.includes(table)
  );
}

function failureObservation(failure: unknown): object {
  if (failure instanceof NestedWriteError) {
    return {
      name: failure.name,
      code: failure.code,
      message: failure.message,
      meta: failure.meta,
    };
  }
  if (failure instanceof Error) {
    return { name: failure.name, message: failure.message };
  }
  return { thrown: String(failure) };
}

interface MatrixCase {
  readonly name: string;
  readonly template: "wanted" | "other";
  readonly members: readonly string[];
  readonly independentWanted: boolean;
  readonly outcome: "failure" | "success";
}

const matrixCases: readonly MatrixCase[] = [
  {
    name: "template wanted refuses before capture",
    template: "wanted",
    members: ["other2"],
    independentWanted: false,
    outcome: "failure",
  },
  {
    name: "actual member wanted refuses before member effects",
    template: "other",
    members: ["wanted"],
    independentWanted: false,
    outcome: "failure",
  },
  {
    name: "later actual member wanted refuses before either member",
    template: "other",
    members: ["second", "wanted"],
    independentWanted: false,
    outcome: "failure",
  },
  {
    name: "disjoint actual member preserves an independent wanted update",
    template: "other",
    members: ["other2"],
    independentWanted: true,
    outcome: "success",
  },
];

function matrixSchema(nextTicketId: () => string) {
  const shelf = s
    .model({
      id: s.string().id(),
      label: s.string(),
      bins: s.toMany(() => bin).name("shelfBins"),
      tickets: s.toMany(() => ticket).name("shelfTickets"),
    })
    .map("g29_matrix_shelves");
  const bin = s
    .model({
      id: s.string().id(),
      shelfId: s.string(),
      shelf: s
        .toOne(() => shelf)
        .fields("shelfId")
        .references("id")
        .name("shelfBins"),
      tickets: s.toMany(() => ticket).name("binTickets"),
    })
    .map("g29_matrix_bins");
  const ticket = s
    .model({
      id: s.string().id().default(nextTicketId),
      note: s.string(),
      binId: s.string().nullable(),
      bin: s
        .toOne(() => bin)
        .fields("binId")
        .references("id")
        .name("binTickets"),
      shelfId: s.string().nullable(),
      shelf: s
        .toOne(() => shelf)
        .fields("shelfId")
        .references("id")
        .name("shelfTickets"),
    })
    .map("g29_matrix_tickets");
  return { shelf, bin, ticket };
}

function matrixArgs() {
  return {
    where: { id: "s1" },
    data: {
      label: "prefix",
      bins: {
        updateMany: {
          where: {},
          data: { tickets: { create: { note: "created" } } },
        },
      },
      tickets: {
        update: {
          where: { id: "wanted" },
          data: { note: "looked-up" },
        },
      },
    },
  };
}

async function runMatrixCase(
  profile: Profile,
  engine: Engine,
  testCase: MatrixCase
): Promise<void> {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  const driver = createDriver(profile, database);
  let membersCaptured = false;
  let memberAdmission = 0;
  const admissions: { readonly scope: "template" | "member"; value: string }[] =
    [];
  const schema = matrixSchema(() => {
    const scope = membersCaptured ? "member" : "template";
    const value =
      scope === "template"
        ? testCase.template
        : testCase.members[memberAdmission++]!;
    admissions.push({ scope, value });
    return value;
  });
  const client = await migrate(schema, driver);
  try {
    database
      .prepare("INSERT INTO g29_matrix_shelves(id,label) VALUES (?,?)")
      .run("s1", "initial");
    for (const [index] of testCase.members.entries()) {
      database
        .prepare("INSERT INTO g29_matrix_bins(id,shelfId) VALUES (?,?)")
        .run(`b${index + 1}`, "s1");
    }
    if (testCase.independentWanted) {
      database
        .prepare(
          "INSERT INTO g29_matrix_tickets(id,note,binId,shelfId) VALUES (?,?,NULL,?)"
        )
        .run("wanted", "independent", "s1");
    }
    driver.afterStatement = (rows) => {
      const captured = rows
        .map((row) => (isRecord(row) ? row.id : undefined))
        .filter((id) => typeof id === "string" && /^b\d+$/.test(id));
      if (captured.length === testCase.members.length) membersCaptured = true;
    };
    driver.resetObservations();

    const rawArgs = matrixArgs();
    const run = () =>
      engine === "commands"
        ? createCommandEngine({ schema, driver }).execute(
            "shelf",
            "update",
            rawArgs
          )
        : client.shelf.update(rawArgs);

    let value: unknown;
    let failure: unknown;
    try {
      value = await run();
    } catch (caught) {
      failure = caught;
    }
    const diagnostic = JSON.stringify(
      {
        profile,
        engine,
        admissions,
        dispatch: {
          shelfWrite: hasWriteTo(driver.statements, "g29_matrix_shelves"),
          ticketWrite: hasWriteTo(driver.statements, "g29_matrix_tickets"),
        },
        finalDatabase: {
          shelves: database
            .prepare("SELECT id,label FROM g29_matrix_shelves ORDER BY id")
            .all(),
          tickets: database
            .prepare(
              "SELECT id,note,binId,shelfId FROM g29_matrix_tickets ORDER BY id"
            )
            .all(),
        },
        failure: failureObservation(failure),
      },
      undefined,
      2
    );

    if (testCase.outcome === "failure") {
      if (engine === "commands") {
        assertDependencyFailure(
          failure,
          "tickets",
          profile,
          testCase.template === "wanted"
            ? undefined
            : {
                memberPath: [testCase.members.indexOf("wanted")],
                totalMembers: testCase.members.length,
                committedSegments: 1,
                committedWriteMembers: 1,
              },
          diagnostic
        );
      } else {
        assertShippedDependencyFailure(failure, "tickets", diagnostic);
      }
      if (testCase.template === "wanted") {
        if (engine === "commands") {
          assert.deepEqual(admissions, [
            { scope: "template", value: "wanted" },
          ]);
        } else {
          assert.equal(admissions.length > 0, true);
          assert.equal(
            admissions.every(
              ({ scope, value }) => scope === "template" && value === "wanted"
            ),
            true
          );
        }
        assert.equal(driver.statements.length, 0);
      } else if (engine === "commands") {
        const expectedMemberAdmissions: {
          readonly scope: "member";
          readonly value: string;
        }[] = testCase.members.map((value) => ({ scope: "member", value }));
        assert.deepEqual(admissions, [
          { scope: "template", value: "other" },
          ...expectedMemberAdmissions,
        ]);
        assert.equal(
          hasWriteTo(driver.statements, "g29_matrix_shelves"),
          true,
          "Dynamic dependency discovery must occur after the root prefix dispatch"
        );
        assert.equal(
          hasWriteTo(driver.statements, "g29_matrix_tickets"),
          false,
          "Dependency refusal must precede every selected member effect"
        );
      }
    } else {
      assert.equal(failure, undefined, diagnostic);
      assert.deepEqual(value, { id: "s1", label: "prefix" }, diagnostic);
      if (engine === "commands") {
        assert.deepEqual(admissions, [
          { scope: "template", value: "other" },
          { scope: "member", value: "other2" },
        ]);
      }
    }

    assert.deepEqual(
      database
        .prepare("SELECT id,label FROM g29_matrix_shelves ORDER BY id")
        .all(),
      [
        {
          id: "s1",
          label:
            testCase.outcome === "success" ||
            (profile === "sqlite-atomic-batch" &&
              testCase.template !== "wanted")
              ? "prefix"
              : "initial",
        },
      ]
    );
    assert.deepEqual(
      database
        .prepare(
          "SELECT id,note,binId,shelfId FROM g29_matrix_tickets ORDER BY id"
        )
        .all(),
      testCase.outcome === "success"
        ? [
            { id: "other2", note: "created", binId: "b1", shelfId: null },
            {
              id: "wanted",
              note: "looked-up",
              binId: null,
              shelfId: "s1",
            },
          ]
        : []
    );
  } finally {
    await client.$disconnect();
    database.close();
  }
}

const profiles: readonly Profile[] = [
  "sqlite-interactive",
  "sqlite-atomic-batch",
];

for (const profile of profiles) {
  describe(`G2.9 exact selected-member dependency [commands] (${profile})`, () => {
    for (const testCase of matrixCases) {
      it(testCase.name, async () => {
        await runMatrixCase(profile, "commands", testCase);
        if (testCase.template === "wanted") {
          await runMatrixCase(profile, "shipped", testCase);
        }
      });
    }
  });
}

function selfRelationSchema(nextId: () => string) {
  const node = s
    .model({
      id: s.string().id().default(nextId),
      label: s.string(),
      branchParentId: s.string().nullable(),
      branchParent: s
        .toOne(() => node)
        .fields("branchParentId")
        .references("id")
        .name("branches"),
      branches: s.toMany(() => node).name("branches"),
      watchParentId: s.string().nullable(),
      watchParent: s
        .toOne(() => node)
        .fields("watchParentId")
        .references("id")
        .name("watches"),
      watches: s.toMany(() => node).name("watches"),
    })
    .map("g29_self_nodes");
  return { node };
}

async function runSelfRoleSuccess(profile: Profile): Promise<void> {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  const driver = createDriver(profile, database);
  let calls = 0;
  const admitted = ["other", "other2"];
  const schema = selfRelationSchema(() => admitted[calls++]!);
  const client = await migrate(schema, driver);
  try {
    database.exec(`
      INSERT INTO g29_self_nodes(id,label,branchParentId,watchParentId) VALUES
        ('root','root',NULL,NULL),
        ('branch','branch','root',NULL),
        ('wanted','wanted',NULL,'root');
    `);
    driver.resetObservations();
    const value = await createCommandEngine({ schema, driver }).execute(
      "node",
      "update",
      {
        where: { id: "root" },
        data: {
          label: "prefix",
          branches: {
            updateMany: {
              where: { id: "branch" },
              data: { watches: { create: { label: "created" } } },
            },
          },
          watches: {
            update: {
              where: { id: "wanted" },
              data: { label: "looked-up" },
            },
          },
        },
      }
    );
    assert.deepEqual(value, {
      id: "root",
      label: "prefix",
      branchParentId: null,
      watchParentId: null,
    });
    assert.equal(calls, 2);
    assert.deepEqual(
      database
        .prepare(
          "SELECT id,label,branchParentId,watchParentId FROM g29_self_nodes ORDER BY id"
        )
        .all(),
      [
        {
          id: "branch",
          label: "branch",
          branchParentId: "root",
          watchParentId: null,
        },
        {
          id: "other2",
          label: "created",
          branchParentId: null,
          watchParentId: "branch",
        },
        {
          id: "root",
          label: "prefix",
          branchParentId: null,
          watchParentId: null,
        },
        {
          id: "wanted",
          label: "looked-up",
          branchParentId: null,
          watchParentId: "root",
        },
      ]
    );
  } finally {
    await client.$disconnect();
    database.close();
  }
}

for (const profile of profiles) {
  describe(`G2.9 self-relation occurrence roles [commands] (${profile})`, () => {
    it("keeps disjoint writes separate even when every occurrence has one model", async () => {
      await runSelfRoleSuccess(profile);
    });
  });
}

function nestedSeriesSchema(nextNoteId: () => string) {
  const shelf = s
    .model({
      id: s.string().id(),
      label: s.string(),
      bins: s.toMany(() => bin).name("nestedShelfBins"),
    })
    .map("g29_nested_shelves");
  const bin = s
    .model({
      id: s.string().id(),
      label: s.string(),
      shelfId: s.string(),
      shelf: s
        .toOne(() => shelf)
        .fields("shelfId")
        .references("id")
        .name("nestedShelfBins"),
      tickets: s.toMany(() => ticket).name("nestedBinTickets"),
      notes: s.toMany(() => note).name("nestedBinNotes"),
    })
    .map("g29_nested_bins");
  const ticket = s
    .model({
      id: s.string().id(),
      label: s.string(),
      binId: s.string(),
      bin: s
        .toOne(() => bin)
        .fields("binId")
        .references("id")
        .name("nestedBinTickets"),
      notes: s.toMany(() => note).name("nestedTicketNotes"),
    })
    .map("g29_nested_tickets");
  const note = s
    .model({
      id: s.string().id().default(nextNoteId),
      text: s.string(),
      ticketId: s.string().nullable(),
      ticket: s
        .toOne(() => ticket)
        .fields("ticketId")
        .references("id")
        .name("nestedTicketNotes"),
      binId: s.string().nullable(),
      bin: s
        .toOne(() => bin)
        .fields("binId")
        .references("id")
        .name("nestedBinNotes"),
    })
    .map("g29_nested_notes");
  return { shelf, bin, ticket, note };
}

async function runNestedSeriesRefusal(profile: Profile): Promise<void> {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  const driver = createDriver(profile, database);
  const admitted = ["other", "other", "wanted"];
  let calls = 0;
  const admissions: string[] = [];
  const schema = nestedSeriesSchema(() => {
    const value = admitted[calls++]!;
    admissions.push(value);
    return value;
  });
  const client = await migrate(schema, driver);
  try {
    database.exec(`
      INSERT INTO g29_nested_shelves VALUES('s1','initial');
      INSERT INTO g29_nested_bins VALUES('b1','bin','s1');
      INSERT INTO g29_nested_tickets VALUES('t1','ticket','b1');
      INSERT INTO g29_nested_notes VALUES('wanted','independent',NULL,'b1');
    `);
    driver.resetObservations();
    let failure: unknown;
    try {
      await createCommandEngine({ schema, driver }).execute("shelf", "update", {
        where: { id: "s1" },
        data: {
          label: "prefix",
          bins: {
            updateMany: {
              where: { id: "b1" },
              data: {
                label: "outer-member",
                tickets: {
                  updateMany: {
                    where: { id: "t1" },
                    data: { notes: { create: { text: "created" } } },
                  },
                },
                notes: {
                  update: {
                    where: { id: "wanted" },
                    data: { text: "looked-up" },
                  },
                },
              },
            },
          },
        },
      });
    } catch (caught) {
      failure = caught;
    }
    const diagnostic = JSON.stringify(
      {
        profile,
        engine: "commands",
        admissions,
        dispatch: {
          shelfWrite: hasWriteTo(driver.statements, "g29_nested_shelves"),
          binWrite: hasWriteTo(driver.statements, "g29_nested_bins"),
          noteWrite: hasWriteTo(driver.statements, "g29_nested_notes"),
        },
        finalDatabase: {
          shelves: database
            .prepare("SELECT id,label FROM g29_nested_shelves ORDER BY id")
            .all(),
          bins: database
            .prepare("SELECT id,label,shelfId FROM g29_nested_bins ORDER BY id")
            .all(),
          notes: database
            .prepare(
              "SELECT id,text,ticketId,binId FROM g29_nested_notes ORDER BY id"
            )
            .all(),
        },
        failure: failureObservation(failure),
      },
      undefined,
      2
    );
    assert.deepEqual(admissions, admitted, diagnostic);
    assertDependencyFailure(
      failure,
      "notes",
      profile,
      {
        memberPath: [0, 0],
        totalMembers: 1,
        committedSegments: 2,
        committedWriteMembers: 2,
      },
      diagnostic
    );
    assert.equal(
      hasWriteTo(driver.statements, "g29_nested_notes"),
      false,
      "Inner dependency refusal must precede the first inner member effect"
    );
    assert.deepEqual(
      database
        .prepare("SELECT id,label FROM g29_nested_shelves ORDER BY id")
        .all(),
      [
        {
          id: "s1",
          label: profile === "sqlite-atomic-batch" ? "prefix" : "initial",
        },
      ]
    );
    assert.deepEqual(
      database.prepare("SELECT id,label,shelfId FROM g29_nested_bins").all(),
      [
        {
          id: "b1",
          label: profile === "sqlite-atomic-batch" ? "outer-member" : "bin",
          shelfId: "s1",
        },
      ]
    );
    assert.deepEqual(
      database
        .prepare("SELECT id,text,ticketId,binId FROM g29_nested_notes")
        .all(),
      [{ id: "wanted", text: "independent", ticketId: null, binId: "b1" }]
    );
  } finally {
    await client.$disconnect();
    database.close();
  }
}

for (const profile of profiles) {
  describe(`G2.9 nested selected-series dependency [commands] (${profile})`, () => {
    it("keeps an inner unresolved dependency until the inner capture", async () => {
      await runNestedSeriesRefusal(profile);
    });
  });
}

function publishedParentSchema() {
  const shelf = s
    .model({
      id: s.string().id(),
      code: s.string().unique(),
      label: s.string(),
      bins: s.toMany(() => bin).name("publishedBins"),
    })
    .map("g29_published_shelves");
  const bin = s
    .model({
      id: s.string().id(),
      shelfCode: s.string(),
      shelf: s
        .toOne(() => shelf)
        .fields("shelfCode")
        .references("code")
        .name("publishedBins"),
      tickets: s.toMany(() => ticket).name("publishedTickets"),
    })
    .map("g29_published_bins");
  const ticket = s
    .model({
      id: s.string().id(),
      note: s.string(),
      binId: s.string(),
      bin: s
        .toOne(() => bin)
        .fields("binId")
        .references("id")
        .name("publishedTickets"),
    })
    .map("g29_published_tickets");
  return { shelf, bin, ticket };
}

async function runPublishedParentSuccess(profile: Profile): Promise<void> {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  const driver = createDriver(profile, database);
  const schema = publishedParentSchema();
  const client = await migrate(schema, driver);
  try {
    database.exec(`
      INSERT INTO g29_published_shelves VALUES('s1','code-1','initial');
      INSERT INTO g29_published_bins VALUES('b1','code-1');
      INSERT INTO g29_published_tickets VALUES('t1','initial','b1');
    `);
    driver.resetObservations();
    const value = await createCommandEngine({ schema, driver }).execute(
      "shelf",
      "update",
      {
        where: { id: "s1" },
        data: {
          label: "prefix",
          bins: {
            updateMany: {
              where: { id: "b1" },
              data: {
                tickets: {
                  update: {
                    where: { id: "t1" },
                    data: { note: "member-used-parent" },
                  },
                },
              },
            },
          },
        },
      }
    );
    assert.deepEqual(value, { id: "s1", code: "code-1", label: "prefix" });
    assert.equal(hasWriteTo(driver.statements, "g29_published_tickets"), true);
    assert.deepEqual(
      database.prepare("SELECT id,note,binId FROM g29_published_tickets").all(),
      [{ id: "t1", note: "member-used-parent", binId: "b1" }]
    );
  } finally {
    await client.$disconnect();
    database.close();
  }
}

for (const profile of profiles) {
  describe(`G2.9 published-parent dependency [commands] (${profile})`, () => {
    it("lets a member lookup consume its already-published parent values", async () => {
      await runPublishedParentSuccess(profile);
    });
  });
}
