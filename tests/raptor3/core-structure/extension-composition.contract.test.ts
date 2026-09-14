import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation";
import { isRecord } from "@validation/value-guards";
import Database from "better-sqlite3";
import { it } from "vitest";

interface StatementObservation {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  readonly context?: QueryExecutionContext;
}

class CompositionSQLiteDriver extends SQLite3Driver {
  readonly statements: StatementObservation[] = [];
  afterStatement?: (rows: readonly unknown[]) => void;

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

function compositionSchema(
  nextTicketId: () => string,
  admitHolderLookup: (input: string) => string,
  nextHolderId: () => string
) {
  const shelf = s
    .model({
      id: s.string().id(),
      label: s.string(),
      bins: s.toMany(() => bin).name("cs01CompositionShelfBins"),
      holders: s.toMany(() => holder).name("cs01CompositionShelfHolders"),
    })
    .map("cs01_composition_shelves");
  const bin = s
    .model({
      id: s.string().id(),
      label: s.string(),
      shelfId: s.string(),
      shelf: s
        .toOne(() => shelf)
        .fields("shelfId")
        .references("id")
        .name("cs01CompositionShelfBins"),
      tickets: s.toMany(() => ticket).name("cs01CompositionBinTickets"),
    })
    .map("cs01_composition_bins");
  const ticket = s
    .model({
      id: s.string().id().default(nextTicketId),
      note: s.string(),
      binId: s.string(),
      bin: s
        .toOne(() => bin)
        .fields("binId")
        .references("id")
        .name("cs01CompositionBinTickets"),
    })
    .map("cs01_composition_tickets");
  const holder = s
    .model({
      id: s.string().id().default(nextHolderId),
      lookupKey: s
        .string()
        .schema(v.string({ transform: admitHolderLookup }))
        .unique(),
      label: s.string(),
      shelfId: s.string(),
      shelf: s
        .toOne(() => shelf)
        .fields("shelfId")
        .references("id")
        .name("cs01CompositionShelfHolders"),
    })
    .map("cs01_composition_holders");
  return { shelf, bin, ticket, holder };
}

async function compositionWorld(hasHolder: boolean) {
  let selectedShelf: string | undefined;
  const ticketAdmissions: Array<"template" | "member"> = [];
  const holderAdmissions: Array<"template" | "member"> = [];
  const schema = compositionSchema(
    () => {
      const scope = selectedShelf ? "member" : "template";
      ticketAdmissions.push(scope);
      return scope === "template" ? "template-ticket" : "member-ticket";
    },
    () => {
      const scope = selectedShelf ? "member" : "template";
      holderAdmissions.push(scope);
      return selectedShelf
        ? `${hasHolder ? "holder" : "missing"}-${selectedShelf}`
        : "template-holder";
    },
    () => `new-${selectedShelf ?? "template"}`
  );
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  const driver = new CompositionSQLiteDriver({ client: database });
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  assert.equal(migration.applied, true);
  database.exec(`
    INSERT INTO cs01_composition_shelves VALUES('s1','one');
    INSERT INTO cs01_composition_shelves VALUES('s2','two');
    INSERT INTO cs01_composition_shelves VALUES('s3','three');
    INSERT INTO cs01_composition_bins VALUES('b1','initial','s1');
    INSERT INTO cs01_composition_bins VALUES('b2','initial','s2');
    INSERT INTO cs01_composition_bins VALUES('b3','initial','s3');
    CREATE TRIGGER cs01_composition_terminal_label
    AFTER UPDATE OF label ON cs01_composition_bins
    WHEN NEW.label='touched' AND OLD.label <> NEW.label
    BEGIN
      UPDATE cs01_composition_shelves
      SET label='terminal'
      WHERE id=NEW.shelfId;
    END;
    ${
      hasHolder
        ? `
          INSERT INTO cs01_composition_holders VALUES('h1','holder-s1','initial','s1');
          INSERT INTO cs01_composition_holders VALUES('h2','holder-s2','initial','s2');
          INSERT INTO cs01_composition_holders VALUES('h3','holder-s3','initial','s3');
        `
        : ""
    }
  `);
  driver.afterStatement = (rows) => {
    for (const row of rows) {
      if (
        isRecord(row) &&
        typeof row.id === "string" &&
        /^s[123]$/.test(row.id)
      ) {
        selectedShelf = row.id;
      }
    }
  };
  driver.statements.length = 0;
  return {
    client,
    database,
    driver,
    holderAdmissions,
    schema,
    ticketAdmissions,
  };
}

function compositionArgs(limit: number) {
  return {
    where: {},
    data: {
      bins: {
        updateMany: {
          where: {},
          data: {
            label: "touched",
            tickets: { create: { note: "created" } },
          },
        },
      },
      holders: {
        upsert: {
          where: { lookupKey: "raw-holder" },
          create: { lookupKey: "raw-holder", label: "created" },
          update: { label: "found" },
        },
      },
    },
    limit,
    select: { label: true },
  };
}

async function runComposition(hasHolder: boolean): Promise<void> {
  const world = await compositionWorld(hasHolder);
  try {
    const rows = await createCommandEngine({
      schema: world.schema,
      driver: world.driver,
    }).execute("shelf", "updateMany", compositionArgs(1));

    assert.deepEqual(rows, [{ label: "terminal" }]);
    assert.deepEqual(world.ticketAdmissions, [
      "template",
      "member",
      "member",
    ]);
    assert.deepEqual(world.holderAdmissions, [
      "template",
      "template",
      "member",
      "member",
    ]);
    assert.deepEqual(
      world.database
        .prepare(
          "SELECT SUM(label='terminal') terminal,SUM(label IN ('one','two','three')) untouched FROM cs01_composition_shelves"
        )
        .get(),
      { terminal: 1, untouched: 2 }
    );
    assert.deepEqual(
      world.database
        .prepare(
          "SELECT SUM(label='touched') touched,SUM(label='initial') untouched FROM cs01_composition_bins"
        )
        .get(),
      { touched: 1, untouched: 2 }
    );
    assert.deepEqual(
      world.database
        .prepare("SELECT id,note FROM cs01_composition_tickets")
        .all(),
      [{ id: "member-ticket", note: "created" }]
    );
    assert.deepEqual(
      world.database
        .prepare(
          "SELECT label,COUNT(*) count FROM cs01_composition_holders GROUP BY label ORDER BY label"
        )
        .all(),
      hasHolder
        ? [
            { label: "found", count: 1 },
            { label: "initial", count: 2 },
          ]
        : [{ label: "created", count: 1 }]
    );
  } finally {
    await world.client.$disconnect();
    world.database.close();
  }
}

it("CS-01 composition returns trigger-updated capped rows after an active choice arm and nested series", async () => {
  await runComposition(true);
});

it("CS-01 composition keeps the untaken choice arm inert while returning trigger-updated capped rows", async () => {
  await runComposition(false);
});

it("CS-01 composition keeps limit zero SQL-free across selection, series, and choice", async () => {
  const world = await compositionWorld(true);
  try {
    const rows = await createCommandEngine({
      schema: world.schema,
      driver: world.driver,
    }).execute("shelf", "updateMany", compositionArgs(0));

    assert.deepEqual(rows, []);
    assert.deepEqual(world.ticketAdmissions, ["template"]);
    assert.deepEqual(world.holderAdmissions, ["template", "template"]);
    assert.equal(world.driver.statements.length, 0);
    assert.deepEqual(
      world.database
        .prepare("SELECT id,label FROM cs01_composition_shelves ORDER BY id")
        .all(),
      [
        { id: "s1", label: "one" },
        { id: "s2", label: "two" },
        { id: "s3", label: "three" },
      ]
    );
  } finally {
    await world.client.$disconnect();
    world.database.close();
  }
});

it("CS-01 composition reaches the nested series, choice, and trigger-driven result without extension options", async () => {
  const world = await compositionWorld(false);
  try {
    const { limit: _limit, select: _select, ...args } = compositionArgs(1);
    const result = await createCommandEngine({
      schema: world.schema,
      driver: world.driver,
    }).execute("shelf", "updateMany", { ...args, where: { id: "s1" } });

    assert.deepEqual(result, { count: 1 });
    assert.deepEqual(world.ticketAdmissions, [
      "template",
      "member",
      "member",
    ]);
    assert.deepEqual(world.holderAdmissions, [
      "template",
      "template",
      "member",
      "member",
    ]);
    assert.deepEqual(
      world.database
        .prepare("SELECT id,label FROM cs01_composition_shelves ORDER BY id")
        .all(),
      [
        { id: "s1", label: "terminal" },
        { id: "s2", label: "two" },
        { id: "s3", label: "three" },
      ]
    );
    assert.deepEqual(
      world.database
        .prepare("SELECT id,label FROM cs01_composition_bins ORDER BY id")
        .all(),
      [
        { id: "b1", label: "touched" },
        { id: "b2", label: "initial" },
        { id: "b3", label: "initial" },
      ]
    );
    assert.deepEqual(
      world.database
        .prepare("SELECT id,note,binId FROM cs01_composition_tickets")
        .all(),
      [{ id: "member-ticket", note: "created", binId: "b1" }]
    );
    assert.deepEqual(
      world.database
        .prepare(
          "SELECT id,lookupKey,label,shelfId FROM cs01_composition_holders"
        )
        .all(),
      [
        {
          id: "new-s1",
          lookupKey: "missing-s1",
          label: "created",
          shelfId: "s1",
        },
      ]
    );
  } finally {
    await world.client.$disconnect();
    world.database.close();
  }
});
