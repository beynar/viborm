import assert from "node:assert/strict";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import {
  NestedWriteError,
  NotFoundError,
  UnsupportedOperationError,
} from "@errors";
import {
  Commands,
  type Choose,
  type RecordCommand,
  type SelectedSeries,
  type SeriesCapture,
} from "@query-engine/raptor3/commands/commands";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { OperationContext } from "@query-engine/raptor3/shared/operation-context";
import {
  type Arguments,
  EngineSchema,
  entries,
  type Input,
  record,
} from "@query-engine/raptor3/shared/schema";
import { bindMembership } from "@query-engine/raptor3/shared/storage";
import { s } from "@schema";
import type { AnyModel } from "@schema/model";
import { createClient } from "@client/client";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { isRecord } from "@validation/value-guards";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

type Profile = "sqlite-interactive" | "sqlite-atomic-batch";

interface StatementObservation {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  readonly context?: QueryExecutionContext;
}

class StructuralSQLiteDriver extends SQLite3Driver {
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
    const result = await super.execute<T>(client, statement, parameters);
    this.afterStatement?.(result.rows);
    return result;
  }
}

class StructuralBatchSQLiteDriver extends StructuralSQLiteDriver {
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
): StructuralSQLiteDriver {
  return profile === "sqlite-interactive"
    ? new StructuralSQLiteDriver({ client: database })
    : new StructuralBatchSQLiteDriver({ client: database });
}

async function migrate<S extends Record<string, AnyModel>>(
  schema: S,
  driver: StructuralSQLiteDriver
) {
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  assert.equal(migration.applied, true);
  driver.resetObservations();
  return client;
}

function hasWrite(
  statements: readonly StatementObservation[],
  table: string
): boolean {
  return statements.some(
    ({ sql }) => /^(?:INSERT|UPDATE|DELETE)\b/.test(sql) && sql.includes(table)
  );
}

/** The dispatch positions of the statements a claim about ORDER names (N1). */
function statementIndexes(
  statements: readonly StatementObservation[],
  matches: (sql: string) => boolean
): number[] {
  const positions: number[] = [];
  for (const [index, { sql }] of statements.entries())
    if (matches(sql)) positions.push(index);
  return positions;
}

/** A read of `table`, never one of the batch route's premise assertions. */
function reads(table: string): (sql: string) => boolean {
  return (sql) =>
    sql.startsWith("SELECT") &&
    sql.includes(`FROM "${table}"`) &&
    !sql.includes("__viborm_assert__");
}

function prioritySchema(nextTicketId: () => string) {
  const shelf = s
    .model({
      id: s.string().id(),
      label: s.string(),
      bins: s.toMany(() => bin).name("priorityShelfBins"),
      earlyHolders: s.toMany(() => earlyHolder).name("priorityEarlyShelf"),
      lateHolders: s.toMany(() => lateHolder).name("priorityLateShelf"),
    })
    .map("cs01_priority_shelves");
  const bin = s
    .model({
      id: s.string().id(),
      shelfId: s.string(),
      shelf: s
        .toOne(() => shelf)
        .fields("shelfId")
        .references("id")
        .name("priorityShelfBins"),
      tickets: s.toMany(() => ticket).name("priorityBinTickets"),
    })
    .map("cs01_priority_bins");
  const ticket = s
    .model({
      id: s.string().id().default(nextTicketId),
      note: s.string(),
      binId: s.string(),
      bin: s
        .toOne(() => bin)
        .fields("binId")
        .references("id")
        .name("priorityBinTickets"),
      earlyHolders: s.toMany(() => earlyHolder).name("priorityEarlyTicket"),
      lateHolders: s.toMany(() => lateHolder).name("priorityLateTicket"),
    })
    .map("cs01_priority_tickets");
  const earlyHolder = s
    .model({
      id: s.string().id(),
      shelfId: s.string(),
      shelf: s
        .toOne(() => shelf)
        .fields("shelfId")
        .references("id")
        .name("priorityEarlyShelf"),
      ticketId: s.string().nullable(),
      earlyTicket: s
        .toOne(() => ticket)
        .fields("ticketId")
        .references("id")
        .name("priorityEarlyTicket"),
    })
    .map("cs01_priority_early_holders");
  const lateHolder = s
    .model({
      id: s.string().id(),
      shelfId: s.string(),
      shelf: s
        .toOne(() => shelf)
        .fields("shelfId")
        .references("id")
        .name("priorityLateShelf"),
      ticketId: s.string().nullable(),
      lateTicket: s
        .toOne(() => ticket)
        .fields("ticketId")
        .references("id")
        .name("priorityLateTicket"),
    })
    .map("cs01_priority_late_holders");
  return { shelf, bin, ticket, earlyHolder, lateHolder };
}

function priorityArgs(lateFound: boolean) {
  return {
    where: { id: "s1" },
    data: {
      label: "prefix",
      bins: {
        updateMany: {
          where: {},
          data: { tickets: { create: { note: "member" } } },
        },
      },
      earlyHolders: {
        update: {
          where: { id: "early" },
          data: { earlyTicket: { connect: { id: "second" } } },
        },
      },
      lateHolders: {
        upsert: {
          where: { id: lateFound ? "late" : "missing" },
          create: { id: "missing", ticketId: null },
          update: { lateTicket: { connect: { id: "first" } } },
        },
      },
    },
  };
}

function priorityCommands(
  schema: ReturnType<typeof prioritySchema>,
  driver: StructuralSQLiteDriver,
  lateFound: boolean
): {
  readonly admitted: Arguments;
  readonly commands: Commands;
  readonly context: OperationContext;
  readonly root: RecordCommand;
} {
  const engineSchema = new EngineSchema(schema);
  const raw: Arguments = priorityArgs(lateFound);
  const admitted = engineSchema.admit(schema.shelf, "update", raw);
  const context = new OperationContext(engineSchema, driver, "shelf", "update");
  const commands = new Commands(context);
  const located = commands.lookup(
    schema.shelf,
    { kind: "query", where: admitted.where! },
    () => new NotFoundError("shelf", "update")
  );
  const root = commands.update(located, admitted.data, raw.data);
  for (const field of engineSchema.keys(schema.shelf)) root.fields.field(field);
  return { admitted, commands, context, root };
}

function requireChoice(root: RecordCommand, relation: string): Choose {
  const choice = root.body
    .map((occurrence) => occurrence.command)
    .find(
      (command): command is Choose =>
        command.kind === "choose" &&
        command.lookup.origin?.relation === relation
    );
  assert(choice);
  return choice;
}

async function runPriorityCase(
  profile: Profile,
  lateFound: boolean
): Promise<void> {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  const driver = createDriver(profile, database);
  let captureReached = false;
  const admissions: { readonly scope: "template" | "member"; value: string }[] =
    [];
  let member = 0;
  const memberValues = ["first", "second"] as const;
  const schema = prioritySchema(() => {
    const scope = captureReached ? "member" : "template";
    const value = scope === "template" ? "other" : memberValues[member++]!;
    admissions.push({ scope, value });
    return value;
  });
  const client = await migrate(schema, driver);
  try {
    database.exec(`
      INSERT INTO cs01_priority_shelves VALUES('s1','initial');
      INSERT INTO cs01_priority_bins VALUES('b1','s1');
      INSERT INTO cs01_priority_bins VALUES('b2','s1');
      INSERT INTO cs01_priority_early_holders VALUES('early','s1',NULL);
      INSERT INTO cs01_priority_late_holders VALUES('late','s1',NULL);
    `);
    driver.afterStatement = (rows) => {
      if (
        rows.filter(
          (row) => isRecord(row) && (row.id === "b1" || row.id === "b2")
        ).length === 2
      ) {
        captureReached = true;
      }
    };
    driver.resetObservations();

    const { admitted, commands, context, root } = priorityCommands(
      schema,
      driver,
      lateFound
    );
    const earlyChoice = requireChoice(root, "earlyHolders");
    const lateChoice = requireChoice(root, "lateHolders");
    // This witness isolates member-major analysis from ordinary deferred branch
    // activation: only the existing choice Selections are also observed as guards.
    // Presence is therefore known when the series resumes; late absence deliberately
    // remains uncached and is reobserved when that choice executes.
    commands.place(root, earlyChoice.lookup, "before");
    commands.place(root, lateChoice.lookup, "before");
    const occurrence = commands.analyze(root);

    let failure: unknown;
    let produced: unknown;
    try {
      produced = await context.run(() =>
        commands.execution.complete(occurrence, admitted)
      );
    } catch (caught) {
      failure = caught;
    }

    // N1 (D-51): pinned DESIGN §6.2's veto — WHICH of the two dependent connects
    // was refused first ("Nested operation 'connect' on relation '<edge>' depends
    // on an earlier 'create' target write in the same nested write. Split these
    // operations into separate queries.", member-major: member zero's guard-observed
    // active arm before member one's earlier read), with its planning progress and
    // no ticket written. The veto is retired: each connect is an ORDERED
    // OBSERVATION taken at its consumer's execution point, after the bins member
    // that creates its target, so both execute in body order and the cell now pins
    // which member each observation resolves against — and that no observation is
    // taken for the arm the guard did not activate.
    assert.equal(failure, undefined);
    assert.deepEqual(produced, { id: "s1", label: "prefix" });
    assert.deepEqual(admissions, [
      { scope: "template", value: "other" },
      { scope: "member", value: "first" },
      { scope: "member", value: "second" },
    ]);
    assert.equal(hasWrite(driver.statements, "cs01_priority_tickets"), true);
    const created = statementIndexes(driver.statements, (sql) =>
      sql.startsWith('INSERT INTO "cs01_priority_tickets"')
    );
    const observed = statementIndexes(
      driver.statements,
      reads("cs01_priority_tickets")
    );
    assert.equal(created.length, 2);
    // The untaken arm opens no observation; the taken ones are read after BOTH
    // creates, never at the capture phase that precedes them.
    assert.equal(observed.length, lateFound ? 2 : 1);
    assert.equal(observed[0]! > created[1]!, true);
    // One end state for both routes: member one's ticket answers the earlier
    // read, member zero's answers the guard-observed active arm, and the arm the
    // guard found absent creates its holder instead of connecting one.
    assert.deepEqual(
      {
        shelves: database
          .prepare("SELECT id,label FROM cs01_priority_shelves ORDER BY id")
          .all(),
        tickets: database
          .prepare(
            "SELECT id,note,binId FROM cs01_priority_tickets ORDER BY id"
          )
          .all(),
        earlyHolders: database
          .prepare(
            "SELECT id,shelfId,ticketId FROM cs01_priority_early_holders ORDER BY id"
          )
          .all(),
        lateHolders: database
          .prepare(
            "SELECT id,shelfId,ticketId FROM cs01_priority_late_holders ORDER BY id"
          )
          .all(),
      },
      {
        shelves: [{ id: "s1", label: "prefix" }],
        tickets: [
          { id: "first", note: "member", binId: "b1" },
          { id: "second", note: "member", binId: "b2" },
        ],
        earlyHolders: [{ id: "early", shelfId: "s1", ticketId: "second" }],
        lateHolders: lateFound
          ? [{ id: "late", shelfId: "s1", ticketId: "first" }]
          : [
              { id: "late", shelfId: "s1", ticketId: null },
              { id: "missing", shelfId: "s1", ticketId: null },
            ],
      }
    );
  } finally {
    await client.$disconnect();
    database.close();
  }
}

for (const profile of ["sqlite-interactive", "sqlite-atomic-batch"] as const) {
  describe(`CS-01 member-major/read-major priority (${profile})`, () => {
    it("connects member one's ticket at the earlier read, then member zero's at the later guard-observed active arm", async () => {
      await runPriorityCase(profile, true);
    });

    it("reobserves the guard-observed absence, creates through that untaken arm, and connects member one's ticket at the earlier read", async () => {
      await runPriorityCase(profile, false);
    });
  });
}

const occurrenceNode = s
  .model({ id: s.string().id(), label: s.string() })
  .map("cs01_occurrence_nodes");

function occurrenceCommands(
  driver: StructuralSQLiteDriver,
  rawData: Input
): { commands: Commands; root: RecordCommand } {
  const schema = new EngineSchema({ occurrenceNode });
  const raw: Arguments = { data: rawData };
  const admitted = schema.admit(occurrenceNode, "create", raw);
  const commands = new Commands(
    new OperationContext(schema, driver, "occurrenceNode", "create")
  );
  return {
    commands,
    root: commands.create(occurrenceNode, admitted.data, raw.data),
  };
}

describe("CS-01 Selection observation identity versus occurrence identity", () => {
  it("observes one present Selection once across two ordered placements", async () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE cs01_occurrence_nodes(id TEXT PRIMARY KEY, label TEXT NOT NULL);
      INSERT INTO cs01_occurrence_nodes VALUES('present','existing');
    `);
    const driver = new StructuralSQLiteDriver({ client: database });
    try {
      const { commands, root } = occurrenceCommands(driver, {
        id: "created",
        label: "created",
      });
      const selection = commands.lookup(occurrenceNode, {
        kind: "query",
        where: { id: "present" },
      });
      commands.place(root, selection, "before");
      commands.place(root, selection, "after");
      const occurrence = commands.analyze(root);

      await commands.execution.run(occurrence);

      assert.deepEqual(
        driver.statements.map(({ sql }) => sql.match(/^\w+/)?.[0]),
        ["SELECT", "INSERT"]
      );
    } finally {
      await driver.disconnect();
      database.close();
    }
  });

  it("reobserves an absent Selection at its later placement after a producer", async () => {
    const database = new Database(":memory:");
    database.exec(
      "CREATE TABLE cs01_occurrence_nodes(id TEXT PRIMARY KEY, label TEXT NOT NULL);"
    );
    const driver = new StructuralSQLiteDriver({ client: database });
    try {
      const { commands, root } = occurrenceCommands(driver, {
        id: "created",
        label: "created",
      });
      const selection = commands.lookup(occurrenceNode, {
        kind: "query",
        where: { id: "created" },
      });
      commands.place(root, selection, "before");
      commands.place(root, selection, "after");
      const occurrence = commands.analyze(root);

      await commands.execution.run(occurrence);

      assert.deepEqual(
        driver.statements.map(({ sql }) => sql.match(/^\w+/)?.[0]),
        ["SELECT", "INSERT", "SELECT"]
      );
      assert.deepEqual(
        database.prepare("SELECT id,label FROM cs01_occurrence_nodes").get(),
        { id: "created", label: "created" }
      );
    } finally {
      await driver.disconnect();
      database.close();
    }
  });
});

type ReconciliationCase =
  | "agree-partial"
  | "agree-complete"
  | "agree-reordered"
  | "conflict";

function reconciliationSchema() {
  const pair = s
    .model({
      a: s.string(),
      b: s.string(),
      label: s.string(),
      kids: s.toMany(() => kid),
    })
    .id(["a", "b"])
    .map("cs01_reconcile_pairs");
  const kid = s
    .model({
      id: s.string().id(),
      slug: s.string().unique(),
      label: s.string(),
      pa: s.string().nullable().map("parent_a"),
      pb: s.string().nullable().map("parent_b"),
      pair: s
        .toOne(() => pair)
        .fields("pa", "pb")
        .references("a", "b"),
    })
    .map("cs01_reconcile_kids");
  return { pair, kid };
}

function reconciliationArgs(testCase: ReconciliationCase) {
  const parent =
    testCase === "agree-reordered"
      ? { b: "west", a: "north", label: "parent" }
      : { a: "north", b: "west", label: "parent" };
  const update = {
    ...(testCase === "agree-complete" || testCase === "conflict"
      ? { label: "first" }
      : {}),
    pa: testCase === "conflict" ? "south" : "north",
    ...(testCase === "agree-complete" ? { pb: { set: "west" } } : {}),
  };
  const first = {
    where: { slug: "found" },
    create: { id: "unused", slug: "unused", label: "unused" },
    update,
  };
  return {
    data: {
      ...parent,
      kids: {
        upsert: first,
      },
    },
  };
}

async function executeReconciliationPublication(
  schema: ReturnType<typeof reconciliationSchema>,
  driver: StructuralSQLiteDriver,
  testCase: "agree-partial" | "agree-reordered"
): Promise<unknown> {
  const engineSchema = new EngineSchema(schema);
  const raw: Arguments = reconciliationArgs(testCase);
  const admitted = engineSchema.admit(schema.pair, "create", raw);
  const context = new OperationContext(engineSchema, driver, "pair", "create");
  const commands = new Commands(context);
  const root = commands.create(schema.pair, admitted.data, raw.data);

  // CREATE admits the agreeing upsert but has no later correlated mutation verb.
  // Admit that consumer through UPDATE's real public recipe, then bind its
  // selected-series occurrence to this root's exact resolved `kids` edge.
  const consumerRaw: Arguments = {
    where: { a_b: { a: "north", b: "west" } },
    data: {
      kids: {
        updateMany: {
          where: { slug: "found" },
          data: { label: "must-not-run" },
        },
      },
    },
  };
  const consumer = engineSchema.admit(schema.pair, "update", consumerRaw);
  const consumerMember = entries(record(consumer.data.kids).updateMany)[0]!;
  const rawConsumerMember = entries(
    record(consumerRaw.data.kids).updateMany
  )[0]!;
  const edge = bindMembership(engineSchema, schema.pair, "kids");
  const selection = commands.lookup(
    schema.kid,
    {
      kind: "query",
      where: record(consumerMember.where),
      membership: { edge, parent: root.fields },
    },
    () =>
      new NestedWriteError(
        "Cannot update relation 'kids': target record was not found for this parent.",
        "kids"
      )
  );
  const origin = commands.createOrigin("kids", "updateMany");
  selection.origin = origin;
  const mutationRaw = record(rawConsumerMember.data);
  const analysis = commands.update(
    selection,
    record(consumerMember.data),
    mutationRaw,
    true
  );
  analysis.origin = origin;
  const series: SelectedSeries = {
    selection,
    analysis,
    mutation: { kind: "update", raw: mutationRaw },
  };
  const target = commands.place(
    root,
    commands.selectedSeries(series),
    "after",
    origin
  );
  // The recipe's own second half (`RelationBody.requireSeriesCapture`): a
  // selected series is always placed with its capture. Under DESIGN §6.2's
  // veto this consumer never reached execution and the capture could be left
  // out; N1 executes it, and a series without its capture is not the shape the
  // public recipe builds.
  const capture: SeriesCapture = { kind: "captureSeries", target };
  commands.place(root, capture, "capture");
  for (const field of engineSchema.keys(schema.pair)) root.fields.field(field);
  const occurrence = commands.analyze(root);
  return context.run(() => commands.execution.complete(occurrence, admitted));
}

for (const testCase of [
  "agree-partial",
  "agree-complete",
  "agree-reordered",
  "conflict",
] as const) {
  it(`CS-01 reconciles the whole body before authoritative contribution publication: ${testCase}`, async () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec(`
      CREATE TABLE cs01_reconcile_pairs(
        a TEXT NOT NULL,
        b TEXT NOT NULL,
        label TEXT NOT NULL,
        PRIMARY KEY(a,b)
      );
      CREATE TABLE cs01_reconcile_kids(
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        parent_a TEXT,
        parent_b TEXT,
        FOREIGN KEY(parent_a,parent_b)
          REFERENCES cs01_reconcile_pairs(a,b)
      );
      INSERT INTO cs01_reconcile_pairs VALUES('old','pair','old');
      INSERT INTO cs01_reconcile_kids
      VALUES('target','found','stored','old','pair');
    `);
    const driver = new StructuralSQLiteDriver({ client: database });
    const schema = reconciliationSchema();
    try {
      let value: unknown;
      let failure: unknown;
      try {
        value =
          testCase === "agree-partial" || testCase === "agree-reordered"
            ? await executeReconciliationPublication(schema, driver, testCase)
            : await createCommandEngine({ schema, driver }).execute(
                "pair",
                "create",
                reconciliationArgs(testCase)
              );
      } catch (caught) {
        failure = caught;
      }

      if (testCase === "conflict") {
        assert(failure instanceof UnsupportedOperationError);
        assert.match(failure.message, /owns 'pa, pb'/);
      } else if (testCase === "agree-complete") {
        assert.equal(failure, undefined);
        assert.deepEqual(value, {
          a: "north",
          b: "west",
          label: "parent",
        });
      } else {
        // N1 (D-51): pinned DESIGN §6.2's veto ("Nested operation 'updateMany' on
        // relation 'kids' depends on an earlier 'upsert' membership write in the
        // same nested write. Split these operations into separate queries.",
        // meta operation `updateMany` / conflictsWith `upsert`), raised before any
        // statement. The reconciliation it guarded is unchanged — an agreeing
        // contribution is still admitted in either key order, a conflicting one is
        // still the `owns 'pa, pb'` refusal — and the consumer now takes its
        // MEMBERSHIP observation after the upsert published that contribution.
        const diagnostic =
          failure instanceof Error
            ? `${failure.name}: ${failure.message}`
            : `thrown: ${String(failure)}`;
        assert.equal(failure, undefined, diagnostic);
        assert.deepEqual(value, { a: "north", b: "west", label: "parent" });
      }
      if (testCase === "agree-partial" || testCase === "agree-reordered") {
        const published = statementIndexes(driver.statements, (sql) =>
          sql.startsWith('UPDATE "cs01_reconcile_kids" SET "parent_a"')
        );
        assert.equal(published.length, 1);
        const observed = statementIndexes(
          driver.statements,
          reads("cs01_reconcile_kids")
        ).filter((index) => index > published[0]!);
        const consumed = statementIndexes(driver.statements, (sql) =>
          sql.startsWith('UPDATE "cs01_reconcile_kids" SET "label"')
        );
        // The observation is taken between the publication and its consumer, in
        // either key order: the capture no longer precedes the upsert it depends on.
        assert.equal(observed.length, 1);
        assert.equal(consumed.length, 1);
        assert.equal(observed[0]! < consumed[0]!, true);
      }
      assert.deepEqual(
        database
          .prepare("SELECT a,b,label FROM cs01_reconcile_pairs ORDER BY a,b")
          .all(),
        testCase === "conflict"
          ? [{ a: "old", b: "pair", label: "old" }]
          : [
              { a: "north", b: "west", label: "parent" },
              { a: "old", b: "pair", label: "old" },
            ]
      );
      assert.deepEqual(
        database
          .prepare(
            "SELECT id,slug,label,parent_a,parent_b FROM cs01_reconcile_kids"
          )
          .get(),
        testCase === "conflict"
          ? {
              id: "target",
              slug: "found",
              label: "stored",
              parent_a: "old",
              parent_b: "pair",
            }
          : {
              id: "target",
              slug: "found",
              // The consumer's own data, named "must-not-run" by the veto that
              // refused it; the member the observation finds is updated (D-51).
              label: testCase === "agree-complete" ? "first" : "must-not-run",
              parent_a: "north",
              parent_b: "west",
            }
      );
    } finally {
      await driver.disconnect();
      database.close();
    }
  });
}
