import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { NestedWriteError, VibORMErrorCode } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { isRecord } from "@validation/value-guards";
import v from "@validation/primitives/v";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

type Profile = "sqlite-interactive" | "sqlite-atomic-batch";

interface StatementObservation {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  readonly context?: QueryExecutionContext;
}

interface AdmissionObservation {
  readonly scope: "template" | "member";
  readonly input: string;
  readonly value: string;
}

class BoundarySQLiteDriver extends SQLite3Driver {
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

class BoundaryBatchSQLiteDriver extends BoundarySQLiteDriver {
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
): BoundarySQLiteDriver {
  return profile === "sqlite-interactive"
    ? new BoundarySQLiteDriver({ client: database })
    : new BoundaryBatchSQLiteDriver({ client: database });
}

function boundarySchema(admitLookup: (input: string) => string) {
  const shelf = s
    .model({
      id: s.string().id(),
      label: s.string(),
      // Declaration and raw-object order make this the earlier sibling.
      tickets: s.toMany(() => ticket).name("boundaryShelfTickets"),
      bins: s.toMany(() => bin).name("boundaryShelfBins"),
    })
    .map("g29_boundary_shelves");
  const bin = s
    .model({
      id: s.string().id(),
      shelfId: s.string(),
      shelf: s
        .toOne(() => shelf)
        .fields("shelfId")
        .references("id")
        .name("boundaryShelfBins"),
      tickets: s.toMany(() => ticket).name("boundaryBinTickets"),
    })
    .map("g29_boundary_bins");
  const ticket = s
    .model({
      id: s.string().id(),
      lookupKey: s
        .string()
        .schema(v.string({ transform: admitLookup }))
        .unique(),
      note: s.string(),
      binId: s.string().nullable(),
      bin: s
        .toOne(() => bin)
        .fields("binId")
        .references("id")
        .name("boundaryBinTickets"),
      shelfId: s.string().nullable(),
      shelf: s
        .toOne(() => shelf)
        .fields("shelfId")
        .references("id")
        .name("boundaryShelfTickets"),
    })
    .map("g29_boundary_tickets");
  return { shelf, bin, ticket };
}

function emptyBoundarySchema(admitLookup: (input: string) => string) {
  const shelf = s
    .model({
      id: s.string().id(),
      label: s.string(),
      bins: s.toMany(() => bin).name("emptyShelfBins"),
      tickets: s.toMany(() => ticket).name("emptyShelfTickets"),
    })
    .map("g29_boundary_shelves");
  const bin = s
    .model({
      id: s.string().id(),
      shelfId: s.string(),
      shelf: s
        .toOne(() => shelf)
        .fields("shelfId")
        .references("id")
        .name("emptyShelfBins"),
      tickets: s.toMany(() => ticket).name("emptyBinTickets"),
    })
    .map("g29_boundary_bins");
  const ticket = s
    .model({
      id: s.string().id(),
      lookupKey: s
        .string()
        .schema(v.string({ transform: admitLookup }))
        .unique(),
      note: s.string(),
      binId: s.string().nullable(),
      bin: s
        .toOne(() => bin)
        .fields("binId")
        .references("id")
        .name("emptyBinTickets"),
      shelfId: s.string().nullable(),
      shelf: s
        .toOne(() => shelf)
        .fields("shelfId")
        .references("id")
        .name("emptyShelfTickets"),
    })
    .map("g29_boundary_tickets");
  return { shelf, bin, ticket };
}

function reverseDependencyArgs() {
  return {
    where: { id: "s1" },
    data: {
      label: "prefix",
      tickets: {
        create: {
          id: "created",
          lookupKey: "wanted",
          note: "earlier",
          binId: "b1",
        },
      },
      bins: {
        updateMany: {
          where: {},
          data: {
            tickets: {
              update: {
                where: { lookupKey: "raw-member-lookup" },
                data: { note: "member-effect" },
              },
            },
          },
        },
      },
    },
  };
}

function emptyCaptureArgs() {
  return {
    where: { id: "s1" },
    data: {
      label: "prefix",
      bins: {
        updateMany: {
          where: {},
          data: {
            tickets: {
              update: {
                where: { lookupKey: "raw-member-lookup" },
                data: { note: "must-not-run" },
              },
            },
          },
        },
      },
      tickets: {
        update: {
          where: { lookupKey: "wanted" },
          data: { note: "looked-up" },
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
  profile: Profile,
  diagnostic: string
): void {
  assert(failure instanceof NestedWriteError, diagnostic);
  assert.equal(failure.code, VibORMErrorCode.NESTED_WRITE_FAILED, diagnostic);
  assert.equal(
    failure.message,
    "Nested operation 'update' on relation 'tickets' depends on an earlier 'create' target write in the same nested write. Split these operations into separate queries.",
    diagnostic
  );
  assert.deepEqual(
    { ...failure.meta },
    {
      conflictsWith: "create",
      operation: "update",
      relation: "tickets",
      ...(profile === "sqlite-atomic-batch"
        ? {
            recordSeriesProgress: {
              atomicity: "segment",
              phase: "planning",
              committedSegments: 1,
              committedWriteMembers: 1,
              completedMembers: 0,
              memberPath: [0],
              totalMembers: 1,
            },
          }
        : {}),
    },
    diagnostic
  );
}

async function runBoundary(
  profile: Profile,
  capturedMember: boolean
): Promise<void> {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  const driver = createDriver(profile, database);
  let captureReached = false;
  const admissions: AdmissionObservation[] = [];
  const admitLookup = (input: string) => {
    if (input !== "raw-member-lookup") return input;
    const scope = captureReached ? "member" : "template";
    const value = scope === "template" ? "other" : "wanted";
    admissions.push({ scope, input, value });
    return value;
  };
  const schema = capturedMember
    ? boundarySchema(admitLookup)
    : emptyBoundarySchema(admitLookup);
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  assert.equal(migration.applied, true);

  try {
    database.exec(
      capturedMember
        ? `
            INSERT INTO g29_boundary_shelves VALUES('s1','initial');
            INSERT INTO g29_boundary_shelves VALUES('s2','decoy');
            INSERT INTO g29_boundary_bins VALUES('b1','s1');
          `
        : `
            INSERT INTO g29_boundary_shelves VALUES('s1','initial');
            INSERT INTO g29_boundary_shelves VALUES('s2','decoy');
            INSERT INTO g29_boundary_bins VALUES('b1','s2');
            INSERT INTO g29_boundary_tickets VALUES('existing','wanted','independent',NULL,'s1');
          `
    );
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
        capturedMember ? reverseDependencyArgs() : emptyCaptureArgs()
      );
    } catch (caught) {
      failure = caught;
    }

    const shelves = database
      .prepare("SELECT id,label FROM g29_boundary_shelves ORDER BY id")
      .all();
    const tickets = database
      .prepare(
        "SELECT id,lookupKey,note,binId,shelfId FROM g29_boundary_tickets ORDER BY id"
      )
      .all();
    const diagnostic = JSON.stringify(
      {
        profile,
        engine: "commands",
        boundary: capturedMember ? "earlier-write" : "empty-capture",
        admissions,
        dispatch: {
          shelfWrite: hasStatement(
            driver.statements,
            /^UPDATE\b.*g29_boundary_shelves/
          ),
          ticketInsert: hasStatement(
            driver.statements,
            /^INSERT\b.*g29_boundary_tickets/
          ),
          ticketUpdate: hasStatement(
            driver.statements,
            /^UPDATE\b.*g29_boundary_tickets/
          ),
        },
        finalDatabase: { shelves, tickets },
        value,
        failure: failureObservation(failure),
      },
      undefined,
      2
    );

    assert.equal(
      hasStatement(driver.statements, /^UPDATE\b.*g29_boundary_shelves/),
      true,
      diagnostic
    );
    if (capturedMember) {
      assert.equal(
        hasStatement(driver.statements, /^INSERT\b.*g29_boundary_tickets/),
        false,
        diagnostic
      );
      assert.deepEqual(
        admissions,
        [
          {
            scope: "template",
            input: "raw-member-lookup",
            value: "other",
          },
          {
            scope: "member",
            input: "raw-member-lookup",
            value: "wanted",
          },
        ],
        diagnostic
      );
      assertDependencyFailure(failure, profile, diagnostic);
      assert.equal(
        hasStatement(driver.statements, /^UPDATE\b.*g29_boundary_tickets/),
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
          { id: "s2", label: "decoy" },
        ],
        diagnostic
      );
      assert.deepEqual(tickets, [], diagnostic);
      return;
    }

    assert.deepEqual(
      admissions,
      [
        {
          scope: "template",
          input: "raw-member-lookup",
          value: "other",
        },
      ],
      diagnostic
    );
    assert.equal(failure, undefined, diagnostic);
    assert.deepEqual(value, { id: "s1", label: "prefix" }, diagnostic);
    assert.equal(
      hasStatement(driver.statements, /^UPDATE\b.*g29_boundary_tickets/),
      true,
      diagnostic
    );
    assert.equal(
      hasStatement(driver.statements, /^INSERT\b.*g29_boundary_tickets/),
      false,
      diagnostic
    );
    assert.deepEqual(
      shelves,
      [
        { id: "s1", label: "prefix" },
        { id: "s2", label: "decoy" },
      ],
      diagnostic
    );
    assert.deepEqual(
      tickets,
      [
        {
          id: "existing",
          lookupKey: "wanted",
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
  describe(`G2.9 dependency boundaries [commands] (${profile})`, () => {
    it("refuses an actual member lookup that conflicts with an earlier sibling write", async () => {
      await runBoundary(profile, true);
    });

    it("admits only the template and preserves a later sibling after an empty capture", async () => {
      await runBoundary(profile, false);
    });
  });
}
