import assert from "node:assert/strict";
import { sqliteDecimalCheck } from "@adapters/databases/sqlite/storage/decimal";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { createModelFieldRefs } from "@schema/field-ref";
import { createIdentifierQuoter } from "@src/sql/identifiers";
import { createTestCommandEngine } from "@tests/raptor3/harness/command-engine";
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
  db.pragma("foreign_keys = ON");
  const quote = createIdentifierQuoter('"');
  db.exec(
    `CREATE TABLE fu2_ledger(
       id INTEGER PRIMARY KEY,
       cents INTEGER NOT NULL ${sqliteDecimalCheck({ name: "cents", nullable: false }, { precision: 12, scale: 2 }, "scalar", quote)},
       micros INTEGER NOT NULL ${sqliteDecimalCheck({ name: "micros", nullable: false }, { precision: 12, scale: 4 }, "scalar", quote)},
       alsoCents INTEGER NOT NULL ${sqliteDecimalCheck({ name: "alsoCents", nullable: false }, { precision: 12, scale: 2 }, "scalar", quote)}
     );
     INSERT INTO fu2_ledger VALUES (1,120,12000,120),(2,200,90000,300);`
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
    const engine = createTestCommandEngine({ schema, driver: right.driver });
    return {
      shipped: await capture(() => client.ledger.findMany(args)),
      candidate: await capture(() =>
        engine.execute("ledger", "findMany", args)
      ),
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
    assert.deepEqual(seen.candidate, { ok: [{ id: 1 }] });
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
