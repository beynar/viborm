import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { NestedWriteError, VibORMErrorCode } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { isRecord } from "@validation/value-guards";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

interface StatementObservation {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  readonly context?: QueryExecutionContext;
}

interface AdmissionObservation {
  readonly scope: "template" | "member";
  readonly value: "other" | "wanted";
}

type ChoiceCase = "untaken-conflict" | "untaken-clean" | "taken-conflict";
type Profile = "sqlite-interactive" | "sqlite-atomic-batch";

class ChoiceSQLiteDriver extends SQLite3Driver {
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

class ChoiceBatchSQLiteDriver extends ChoiceSQLiteDriver {
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
): ChoiceSQLiteDriver {
  return profile === "sqlite-interactive"
    ? new ChoiceSQLiteDriver({ client: database })
    : new ChoiceBatchSQLiteDriver({ client: database });
}

function choiceSchema(admitTicketId: () => "other" | "wanted") {
  const shelf = s
    .model({
      id: s.string().id(),
      label: s.string(),
      bins: s.toMany(() => bin).name("branchShelfBins"),
      holders: s.toMany(() => holder).name("branchShelfHolders"),
    })
    .map("g29_branch_shelves");
  const bin = s
    .model({
      id: s.string().id(),
      shelfId: s.string(),
      shelf: s
        .toOne(() => shelf)
        .fields("shelfId")
        .references("id")
        .name("branchShelfBins"),
      tickets: s.toMany(() => ticket).name("branchBinTickets"),
    })
    .map("g29_branch_bins");
  const ticket = s
    .model({
      id: s.string().id().default(admitTicketId),
      note: s.string(),
      binId: s.string(),
      bin: s
        .toOne(() => bin)
        .fields("binId")
        .references("id")
        .name("branchBinTickets"),
      holders: s.toMany(() => holder).name("branchTicketHolders"),
    })
    .map("g29_branch_tickets");
  const holder = s
    .model({
      id: s.string().id(),
      label: s.string(),
      shelfId: s.string(),
      shelf: s
        .toOne(() => shelf)
        .fields("shelfId")
        .references("id")
        .name("branchShelfHolders"),
      ticketId: s.string().nullable(),
      ticket: s
        .toOne(() => ticket)
        .fields("ticketId")
        .references("id")
        .name("branchTicketHolders"),
    })
    .map("g29_branch_holders");
  return { shelf, bin, ticket, holder };
}

function choiceArgs(testCase: ChoiceCase) {
  const selectedHolderId = testCase === "taken-conflict" ? "h2" : "h1";
  const create =
    testCase === "untaken-clean"
      ? { id: selectedHolderId, label: "missing" }
      : {
          id: selectedHolderId,
          label: "missing",
          ticket: { connect: { id: "wanted" } },
        };

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
      holders: {
        upsert: {
          where: { id: selectedHolderId },
          create,
          update: { label: "found" },
        },
      },
    },
  };
}

function oneArmArgs(hasConnect: boolean) {
  const data = hasConnect
    ? { label: "never", ticket: { connect: { id: "wanted" } } }
    : { label: "never" };

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
      holders: {
        update: {
          where: { id: "h2" },
          data,
        },
      },
    },
  };
}

function hasStatement(
  statements: readonly StatementObservation[],
  pattern: RegExp
): boolean {
  return statements.some(({ sql }) => pattern.test(sql));
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

function assertDependencyFailure(
  failure: unknown,
  diagnostic: string,
  progress?: {
    readonly phase: "member";
    readonly committedSegments: number;
    readonly committedWriteMembers: number;
    readonly completedMembers: number;
  }
): void {
  assert(failure instanceof NestedWriteError, diagnostic);
  assert.equal(failure.code, VibORMErrorCode.NESTED_WRITE_FAILED, diagnostic);
  assert.equal(
    failure.message,
    "Nested operation 'connect' on relation 'ticket' depends on an earlier 'create' target write in the same nested write. Split these operations into separate queries.",
    diagnostic
  );
  assert.deepEqual(
    { ...failure.meta },
    {
      conflictsWith: "create",
      operation: "connect",
      relation: "ticket",
      ...(progress
        ? {
            recordSeriesProgress: {
              atomicity: "segment",
              ...progress,
            },
          }
        : {}),
    },
    diagnostic
  );
}

function assertMissingHolderFailure(
  failure: unknown,
  diagnostic: string,
  progress?: {
    readonly phase: "member";
    readonly committedSegments: number;
    readonly committedWriteMembers: number;
    readonly completedMembers: number;
  }
): void {
  assert(failure instanceof NestedWriteError, diagnostic);
  assert.equal(failure.code, VibORMErrorCode.NESTED_WRITE_FAILED, diagnostic);
  assert.equal(
    failure.message,
    "Cannot update relation 'holders': target record was not found for this parent.",
    diagnostic
  );
  assert.deepEqual(
    { ...failure.meta },
    {
      relation: "holders",
      ...(progress
        ? {
            recordSeriesProgress: {
              atomicity: "segment",
              ...progress,
            },
          }
        : {}),
    },
    diagnostic
  );
}

async function runChoiceCase(
  profile: Profile,
  testCase: ChoiceCase
): Promise<void> {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  const driver = createDriver(profile, database);
  let captureReached = false;
  const admissions: AdmissionObservation[] = [];
  const schema = choiceSchema(() => {
    const scope = captureReached ? "member" : "template";
    const value = scope === "member" ? "wanted" : "other";
    admissions.push({ scope, value });
    return value;
  });
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  assert.equal(migration.applied, true);

  try {
    database.exec(`
      INSERT INTO g29_branch_shelves VALUES('s1','initial');
      INSERT INTO g29_branch_bins VALUES('b1','s1');
      INSERT INTO g29_branch_holders VALUES('h1','initial','s1',NULL);
    `);
    driver.afterStatement = (rows) => {
      if (rows.some((row) => isRecord(row) && row.id === "b1")) {
        captureReached = true;
      }
    };
    driver.resetObservations();

    let value: unknown;
    let failure: unknown;
    try {
      value = await createCommandEngine({ schema, driver }).execute(
        "shelf",
        "update",
        choiceArgs(testCase)
      );
    } catch (caught) {
      failure = caught;
    }

    const shelves = database
      .prepare("SELECT id,label FROM g29_branch_shelves ORDER BY id")
      .all();
    const tickets = database
      .prepare("SELECT id,note,binId FROM g29_branch_tickets ORDER BY id")
      .all();
    const holders = database
      .prepare(
        "SELECT id,label,shelfId,ticketId FROM g29_branch_holders ORDER BY id"
      )
      .all();
    const diagnostic = JSON.stringify(
      {
        profile,
        engine: "commands",
        testCase,
        admissions,
        dispatch: {
          shelfUpdate: hasStatement(
            driver.statements,
            /^UPDATE\b.*g29_branch_shelves/
          ),
          ticketInsert: hasStatement(
            driver.statements,
            /^INSERT\b.*g29_branch_tickets/
          ),
          holderInsert: hasStatement(
            driver.statements,
            /^INSERT\b.*g29_branch_holders/
          ),
          holderUpdate: hasStatement(
            driver.statements,
            /^UPDATE\b.*g29_branch_holders/
          ),
        },
        finalDatabase: { shelves, tickets, holders },
        value,
        failure: failureObservation(failure),
      },
      undefined,
      2
    );

    assert.deepEqual(
      admissions,
      [
        { scope: "template", value: "other" },
        { scope: "member", value: "wanted" },
      ],
      diagnostic
    );

    if (testCase === "taken-conflict") {
      assertDependencyFailure(
        failure,
        diagnostic,
        profile === "sqlite-atomic-batch"
          ? {
              phase: "member",
              committedSegments: 2,
              committedWriteMembers: 2,
              completedMembers: 1,
            }
          : undefined
      );
      if (profile === "sqlite-atomic-batch") {
        assert.equal(
          hasStatement(driver.statements, /^UPDATE\b.*g29_branch_shelves/),
          true,
          diagnostic
        );
        assert.equal(
          hasStatement(driver.statements, /^INSERT\b.*g29_branch_tickets/),
          true,
          diagnostic
        );
      }
      assert.equal(
        hasStatement(
          driver.statements,
          /^(?:INSERT|UPDATE)\b.*g29_branch_holders/
        ),
        false,
        diagnostic
      );
      assert.deepEqual(
        shelves,
        [
          {
            id: "s1",
            label: profile === "sqlite-atomic-batch" ? "prefix" : "initial",
          },
        ],
        diagnostic
      );
      assert.deepEqual(
        tickets,
        profile === "sqlite-atomic-batch"
          ? [{ id: "wanted", note: "created", binId: "b1" }]
          : [],
        diagnostic
      );
      assert.deepEqual(
        holders,
        [{ id: "h1", label: "initial", shelfId: "s1", ticketId: null }],
        diagnostic
      );
      return;
    }

    assert.equal(failure, undefined, diagnostic);
    assert.deepEqual(value, { id: "s1", label: "prefix" }, diagnostic);
    assert.equal(
      hasStatement(driver.statements, /^UPDATE\b.*g29_branch_shelves/),
      true,
      diagnostic
    );
    assert.equal(
      hasStatement(driver.statements, /^INSERT\b.*g29_branch_tickets/),
      true,
      diagnostic
    );
    assert.equal(
      hasStatement(driver.statements, /^UPDATE\b.*g29_branch_holders/),
      true,
      diagnostic
    );
    assert.equal(
      hasStatement(driver.statements, /^INSERT\b.*g29_branch_holders/),
      false,
      diagnostic
    );
    assert.deepEqual(shelves, [{ id: "s1", label: "prefix" }], diagnostic);
    assert.deepEqual(
      tickets,
      [{ id: "wanted", note: "created", binId: "b1" }],
      diagnostic
    );
    assert.deepEqual(
      holders,
      [{ id: "h1", label: "found", shelfId: "s1", ticketId: null }],
      diagnostic
    );
  } finally {
    await client.$disconnect();
    database.close();
  }
}

async function runOneArmCase(
  profile: Profile,
  hasConnect: boolean
): Promise<void> {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  const driver = createDriver(profile, database);
  let captureReached = false;
  const admissions: AdmissionObservation[] = [];
  const schema = choiceSchema(() => {
    const scope = captureReached ? "member" : "template";
    const value = scope === "member" ? "wanted" : "other";
    admissions.push({ scope, value });
    return value;
  });
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  assert.equal(migration.applied, true);

  try {
    database.exec(`
      INSERT INTO g29_branch_shelves VALUES('s1','initial');
      INSERT INTO g29_branch_bins VALUES('b1','s1');
      INSERT INTO g29_branch_holders VALUES('h1','initial','s1',NULL);
    `);
    driver.afterStatement = (rows) => {
      if (rows.some((row) => isRecord(row) && row.id === "b1")) {
        captureReached = true;
      }
    };
    driver.resetObservations();

    let value: unknown;
    let failure: unknown;
    try {
      value = await createCommandEngine({ schema, driver }).execute(
        "shelf",
        "update",
        oneArmArgs(hasConnect)
      );
    } catch (caught) {
      failure = caught;
    }

    const shelves = database
      .prepare("SELECT id,label FROM g29_branch_shelves ORDER BY id")
      .all();
    const tickets = database
      .prepare("SELECT id,note,binId FROM g29_branch_tickets ORDER BY id")
      .all();
    const holders = database
      .prepare(
        "SELECT id,label,shelfId,ticketId FROM g29_branch_holders ORDER BY id"
      )
      .all();
    const diagnostic = JSON.stringify(
      {
        profile,
        engine: "commands",
        branch: "one-arm-found-body",
        hasConnect,
        admissions,
        dispatch: {
          shelfUpdate: hasStatement(
            driver.statements,
            /^UPDATE\b.*g29_branch_shelves/
          ),
          ticketInsert: hasStatement(
            driver.statements,
            /^INSERT\b.*g29_branch_tickets/
          ),
          holderInsert: hasStatement(
            driver.statements,
            /^INSERT\b.*g29_branch_holders/
          ),
          holderUpdate: hasStatement(
            driver.statements,
            /^UPDATE\b.*g29_branch_holders/
          ),
        },
        finalDatabase: { shelves, tickets, holders },
        value,
        failure: failureObservation(failure),
      },
      undefined,
      2
    );

    assert.deepEqual(
      admissions,
      [
        { scope: "template", value: "other" },
        { scope: "member", value: "wanted" },
      ],
      diagnostic
    );
    assert.equal(value, undefined, diagnostic);
    assertMissingHolderFailure(
      failure,
      diagnostic,
      profile === "sqlite-atomic-batch"
        ? {
            phase: "member",
            committedSegments: 2,
            committedWriteMembers: 2,
            completedMembers: 1,
          }
        : undefined
    );
    assert.equal(
      hasStatement(driver.statements, /^UPDATE\b.*g29_branch_shelves/),
      true,
      diagnostic
    );
    assert.equal(
      hasStatement(driver.statements, /^INSERT\b.*g29_branch_tickets/),
      true,
      diagnostic
    );
    assert.equal(
      hasStatement(
        driver.statements,
        /^(?:INSERT|UPDATE)\b.*g29_branch_holders/
      ),
      false,
      diagnostic
    );
    assert.deepEqual(
      shelves,
      [
        {
          id: "s1",
          label: profile === "sqlite-atomic-batch" ? "prefix" : "initial",
        },
      ],
      diagnostic
    );
    assert.deepEqual(
      tickets,
      profile === "sqlite-atomic-batch"
        ? [{ id: "wanted", note: "created", binId: "b1" }]
        : [],
      diagnostic
    );
    assert.deepEqual(
      holders,
      [{ id: "h1", label: "initial", shelfId: "s1", ticketId: null }],
      diagnostic
    );
  } finally {
    await client.$disconnect();
    database.close();
  }
}

describe("G2.9 dependency choice locality [commands] (sqlite-interactive)", () => {
  it("ignores a conflicting lookup in an untaken create arm", async () => {
    await runChoiceCase("sqlite-interactive", "untaken-conflict");
  });

  it("preserves the selected update when the untaken arm has no lookup", async () => {
    await runChoiceCase("sqlite-interactive", "untaken-clean");
  });

  it("refuses the same conflicting lookup when its create arm is taken", async () => {
    await runChoiceCase("sqlite-interactive", "taken-conflict");
  });
});

describe("G2.9 dependency choice locality [commands] (sqlite-atomic-batch)", () => {
  it("ignores a conflicting lookup in an untaken create arm", async () => {
    await runChoiceCase("sqlite-atomic-batch", "untaken-conflict");
  });

  it("preserves the selected update when the untaken arm has no lookup", async () => {
    await runChoiceCase("sqlite-atomic-batch", "untaken-clean");
  });

  it("refuses the same conflicting lookup when its create arm is taken", async () => {
    await runChoiceCase("sqlite-atomic-batch", "taken-conflict");
  });
});

const profiles: readonly Profile[] = [
  "sqlite-interactive",
  "sqlite-atomic-batch",
];

for (const profile of profiles) {
  describe(`G2.9 one-arm dependency locality [commands] (${profile})`, () => {
    it("ignores a conflicting lookup in an untaken found body", async () => {
      await runOneArmCase(profile, true);
    });

    it("preserves missing-target behavior when the untaken body has no lookup", async () => {
      await runOneArmCase(profile, false);
    });
  });
}
