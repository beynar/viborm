import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import {
  NestedWriteError,
  UniqueConstraintError,
  VibORMErrorCode,
} from "@errors";
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

function assertMissingTicketFailure(
  failure: unknown,
  profile: Profile,
  progress: {
    readonly committedSegments: number;
    readonly committedWriteMembers: number;
    readonly completedMembers: number;
  },
  diagnostic?: string
): void {
  assert(failure instanceof NestedWriteError, diagnostic);
  assert.equal(failure.code, VibORMErrorCode.NESTED_WRITE_FAILED, diagnostic);
  assert.equal(
    failure.message,
    "Cannot update relation 'tickets': target record was not found for this parent.",
    diagnostic
  );
  assert.deepEqual(
    { ...failure.meta },
    {
      relation: "tickets",
      ...(profile === "sqlite-atomic-batch"
        ? {
            recordSeriesProgress: {
              atomicity: "segment",
              phase: "member",
              committedSegments: progress.committedSegments,
              committedWriteMembers: progress.committedWriteMembers,
              completedMembers: progress.completedMembers,
            },
          }
        : {}),
    },
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
    name: "template wanted executes the create it names and takes the missing-target refusal",
    template: "wanted",
    members: ["other2"],
    independentWanted: false,
    outcome: "failure",
  },
  {
    name: "actual member wanted executes the create it names and takes the missing-target refusal",
    template: "other",
    members: ["wanted"],
    independentWanted: false,
    outcome: "failure",
  },
  {
    name: "later actual member wanted executes both creates and takes the missing-target refusal",
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

    const expectedAdmissions = [
      { scope: "template", value: testCase.template },
      ...testCase.members.map((value) => ({ scope: "member", value })),
    ];
    if (testCase.outcome === "failure") {
      // N1 (D-51): these three cells pinned DESIGN §6.2's mode-independent veto
      // ("Nested operation 'update' on relation 'tickets' depends on an earlier
      // 'create' target write in the same nested write. Split these operations
      // into separate queries."), raised before any selected member effect;
      // now the lookup is an ordered observation taken AFTER that create, which
      // lands its ticket on the bin, so `shelf.tickets` never gains the member
      // the lookup names and the correlated not-found refusal answers instead.
      // Nothing further commits: the live route rolls the unit back, and the
      // batch route keeps the segments D-51 accepts, reported as progress. The
      // client route answers exactly as the command engine does.
      const memberTickets = testCase.members.map((id, index) => ({
        id,
        note: "created",
        binId: `b${index + 1}`,
        shelfId: null,
      }));
      assertMissingTicketFailure(
        failure,
        profile,
        {
          committedSegments: testCase.members.length + 1,
          committedWriteMembers: testCase.members.length + 1,
          completedMembers: testCase.members.length,
        },
        diagnostic
      );
      assert.deepEqual(admissions, expectedAdmissions, diagnostic);
      assert.equal(
        hasWriteTo(driver.statements, "g29_matrix_shelves"),
        true,
        "Dynamic dependency discovery must occur after the root prefix dispatch"
      );
      assert.equal(
        hasWriteTo(driver.statements, "g29_matrix_tickets"),
        true,
        "The observed create must execute before the dependent lookup"
      );
      assert.deepEqual(
        database
          .prepare("SELECT id,label FROM g29_matrix_shelves ORDER BY id")
          .all(),
        [
          {
            id: "s1",
            label: profile === "sqlite-atomic-batch" ? "prefix" : "initial",
          },
        ],
        diagnostic
      );
      assert.deepEqual(
        database
          .prepare(
            "SELECT id,note,binId,shelfId FROM g29_matrix_tickets ORDER BY id"
          )
          .all(),
        profile === "sqlite-atomic-batch" ? memberTickets : [],
        diagnostic
      );
      return;
    }

    assert.equal(failure, undefined, diagnostic);
    assert.deepEqual(value, { id: "s1", label: "prefix" }, diagnostic);
    assert.deepEqual(admissions, expectedAdmissions, diagnostic);
    assert.deepEqual(
      database
        .prepare("SELECT id,label FROM g29_matrix_shelves ORDER BY id")
        .all(),
      [{ id: "s1", label: "prefix" }],
      diagnostic
    );
    assert.deepEqual(
      database
        .prepare(
          "SELECT id,note,binId,shelfId FROM g29_matrix_tickets ORDER BY id"
        )
        .all(),
      [
        { id: "other2", note: "created", binId: "b1", shelfId: null },
        {
          id: "wanted",
          note: "looked-up",
          binId: null,
          shelfId: "s1",
        },
      ],
      diagnostic
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
  // The inner note's id default answers the seeded note's own id every time
  // it is asked — a deterministic default, so D-25's one region re-plan on
  // the live route admits the same duplicate again.
  const admissions: string[] = [];
  const schema = nestedSeriesSchema(() => {
    admissions.push("wanted");
    return "wanted";
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
    // Hoisted verbatim out of the live tail below so that the batch branch's
    // early return does not narrow `profile` under them.
    const expectedShelfLabel =
      profile === "sqlite-atomic-batch" ? "prefix" : "initial";
    const expectedBinLabel =
      profile === "sqlite-atomic-batch" ? "outer-member" : "bin";
    if (profile === "sqlite-atomic-batch") {
      // N1 (D-51): this cell pinned DESIGN §6.2's mode-independent veto
      // ("Nested operation 'update' on relation 'notes' depends on an earlier
      // 'create' target write in the same nested write. Split these operations
      // into separate queries.") held until the inner capture; now the inner
      // create executes with the id the inner member admitted, `wanted`, which
      // is the seeded note's own id — so the database's integrity answer is the
      // operation's failure, the batch carrying that INSERT aborts, and the two
      // segments the barrier already committed stay committed (D-51's
      // succession of statements). The seeded note is untouched.
      assert.ok(admissions.length > 0, diagnostic);
      assert(failure instanceof UniqueConstraintError, diagnostic);
      assert.equal(failure.message, "Unique constraint violation", diagnostic);
      assert.equal(
        hasWriteTo(driver.statements, "g29_nested_notes"),
        true,
        diagnostic
      );
      assert.deepEqual(
        database
          .prepare("SELECT id,label FROM g29_nested_shelves ORDER BY id")
          .all(),
        [{ id: "s1", label: "prefix" }],
        diagnostic
      );
      assert.deepEqual(
        database.prepare("SELECT id,label,shelfId FROM g29_nested_bins").all(),
        [{ id: "b1", label: "outer-member", shelfId: "s1" }],
        diagnostic
      );
      assert.deepEqual(
        database
          .prepare("SELECT id,text,ticketId,binId FROM g29_nested_notes")
          .all(),
        [{ id: "wanted", text: "independent", ticketId: null, binId: "b1" }],
        diagnostic
      );
      return;
    }
    // N1 (D-51): this cell pinned DESIGN §6.2's mode-independent veto held
    // until the inner capture. Now the inner create executes with the id the
    // inner member admitted, `wanted`, the seeded note's own id: the INSERT's
    // unique violation is the operation's failure. On the live route the
    // rejected INSERT spends D-25's one region recovery — the operation is
    // planned a SECOND time from the same admitted arguments, its members
    // admitted again, the same duplicate key inserted again — and the
    // database's answer stands, the whole transaction rolled back.
    // The batch route's recovery is bounded by member admission (one attempt,
    // above): D-25's documented asymmetry, not a disagreement.
    // Two plans admitted the inner member: D-25's one region re-plan.
    assert.ok(admissions.length > 1, diagnostic);
    assert(failure instanceof UniqueConstraintError, diagnostic);
    assert.equal(failure.message, "Unique constraint violation", diagnostic);
    assert.equal(
      hasWriteTo(driver.statements, "g29_nested_notes"),
      true,
      diagnostic
    );
    assert.deepEqual(
      database
        .prepare("SELECT id,label FROM g29_nested_shelves ORDER BY id")
        .all(),
      [{ id: "s1", label: expectedShelfLabel }]
    );
    assert.deepEqual(
      database.prepare("SELECT id,label,shelfId FROM g29_nested_bins").all(),
      [{ id: "b1", label: expectedBinLabel, shelfId: "s1" }]
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

// N1 (D-51): re-expressed on both substrates — the inner create executes and
// the database's integrity answer is the operation's failure; the batch route
// keeps the segments the barrier committed, the live route re-plans once
// (D-25) and rolls back.
const nestedSeriesCell: Record<Profile, string> = {
  "sqlite-atomic-batch":
    "runs the inner create found at the inner capture and takes the database's answer",
  "sqlite-interactive":
    "runs the inner create found at the inner capture, re-plans once on its duplicate key and rolls back",
};

for (const profile of profiles) {
  describe(`G2.9 nested selected-series dependency [commands] (${profile})`, () => {
    it(nestedSeriesCell[profile], async () => {
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
