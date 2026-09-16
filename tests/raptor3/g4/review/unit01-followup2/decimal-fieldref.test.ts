import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { createModelFieldRefs } from "@schema/field-ref";
import { s } from "@schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

/**
 * Repair-2 review. The shipped `where` builder refuses a field reference
 * between two decimal columns of DIFFERENT (precision, scale)
 * (`builders/where-builder.ts:436-455`, `assertComparableDecimalDomains`),
 * because the coefficients are not comparable. Asked of both engines.
 */
const ledger = s
  .model({
    id: s.int().id(),
    cents: s.decimal({ precision: 12, scale: 2 }),
    micros: s.decimal({ precision: 12, scale: 4 }),
    alsoCents: s.decimal({ precision: 12, scale: 2 }),
  })
  .map("fu2_ledger");

const schema = { ledger };
const refs = createModelFieldRefs("ledger", ledger) as Record<string, unknown>;

function build(): { db: Database.Database; driver: SQLite3Driver } {
  const db = new Database(":memory:");
  db.exec(
    `CREATE TABLE fu2_ledger(id INTEGER PRIMARY KEY, cents TEXT NOT NULL, micros TEXT NOT NULL, alsoCents TEXT NOT NULL);
     INSERT INTO fu2_ledger VALUES (1,'1.20','1.2000','1.20'),(2,'2.00','9.0000','3.00');`
  );
  return { db, driver: new SQLite3Driver({ client: db }) };
}

async function bothOutcomes(
  args: Record<string, unknown>
): Promise<{ shipped: unknown; candidate: unknown }> {
  const left = build();
  const right = build();
  const capture = async (run: () => unknown): Promise<unknown> => {
    try {
      return { ok: await run() };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
  try {
    const client = createClient({ schema, driver: left.driver }) as unknown as {
      ledger: { findMany: (input: unknown) => unknown };
    };
    const engine = createCommandEngine({ schema, driver: right.driver });
    return {
      shipped: await capture(() => client.ledger.findMany(args)),
      candidate: await capture(() => engine.execute("ledger", "findMany", args)),
    };
  } finally {
    await left.driver.disconnect();
    left.db.close();
    await right.driver.disconnect();
    right.db.close();
  }
}

describe("G4-01 repair 2 review — decimal field-reference domains", () => {
  it("agrees on a reference between two decimals of the SAME domain", async () => {
    const seen = await bothOutcomes({
      where: { cents: { equals: refs.alsoCents } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    assert.deepEqual(
      seen.candidate,
      seen.shipped,
      `same domain\n  candidate ${JSON.stringify(seen.candidate)}\n  shipped   ${JSON.stringify(seen.shipped)}`
    );
  });

  it("agrees on a reference between two decimals of DIFFERENT domains", async () => {
    const seen = await bothOutcomes({
      where: { cents: { equals: refs.micros } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    assert.deepEqual(
      seen.candidate,
      seen.shipped,
      `different domain\n  candidate ${JSON.stringify(seen.candidate)}\n  shipped   ${JSON.stringify(seen.shipped)}`
    );
  });
});
