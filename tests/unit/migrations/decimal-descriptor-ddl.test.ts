/** Live SQLite enforcement of the fixed-decimal DDL contract. */

import { createClient } from "@client/client";
import { s } from "@schema";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema as push } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

const AMOUNT_REAL = /"amount"\s+REAL/i;

function ledger() {
  return {
    ledger: s
      .model({
        id: s.string().id(),
        amount: s.decimal({ precision: 10, scale: 5 }),
        optional: s.decimal({ precision: 10, scale: 5 }).nullable(),
        seeded: s.decimal({ precision: 10, scale: 5 }).default("12.34"),
        rate: s.decimal({ precision: 4, scale: 0 }),
        samples: s.decimal({ precision: 10, scale: 2 }).array(),
        approximate: s.number(),
      })
      .map("decimal_ddl_ledger"),
  };
}

/**
 * How the provider refused a statement.
 *
 * VibORM normalizes a SQLite constraint failure into `CheckConstraintError`
 * with the provider's own code on `meta`, and does not carry the constraint
 * NAME through. So the live legs below prove that the check FIRED and which
 * KIND it was; which constraint carries the descriptor is a fact about the
 * emitted DDL, pinned above where the DDL is the subject.
 */
async function refusalOf(
  driver: { _executeRaw: (sql: string) => Promise<unknown> },
  sql: string
): Promise<string> {
  try {
    await driver._executeRaw(sql);
  } catch (error) {
    const meta = (error as { meta?: { providerCode?: unknown } }).meta;
    return `${(error as Error).constructor.name}:${String(meta?.providerCode)}`;
  }
  throw new Error(`expected a refusal for: ${sql}`);
}

describe("a live SQLite estate", () => {
  test("creates the checked INTEGER and refuses a value outside it", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: ledger(), driver });

    const result = await push(client, { force: true });
    expect(result.sql.join("\n")).toContain(
      'CONSTRAINT "viborm_decimal_amount_10_5" CHECK'
    );

    // The check is the precision. SQLite would otherwise accept any integer
    // and any spelling at all in a column it declared INTEGER.
    // A coefficient one digit past the declared precision.
    expect(
      await refusalOf(
        driver,
        `INSERT INTO "decimal_ddl_ledger" ("id","amount","optional","seeded","rate","samples","approximate") VALUES ('a', 99999999999, NULL, 0, 0, '[]', 1.5)`
      )
    ).toBe("CheckConstraintError:SQLITE_CONSTRAINT_CHECK");

    // TEXT in a column SQLite only declared INTEGER: affinity converts a
    // numeric-looking string, so `typeof` is what refuses this one.
    expect(
      await refusalOf(
        driver,
        `INSERT INTO "decimal_ddl_ledger" ("id","amount","optional","seeded","rate","samples","approximate") VALUES ('b', '12.34', NULL, 0, 0, '[]', 1.5)`
      )
    ).toBe("CheckConstraintError:SQLITE_CONSTRAINT_CHECK");

    // The list check refuses anything that is not a top-level JSON array.
    expect(
      await refusalOf(
        driver,
        `INSERT INTO "decimal_ddl_ledger" ("id","amount","optional","seeded","rate","samples","approximate") VALUES ('d', 1, NULL, 0, 0, 'not json', 1.5)`
      )
    ).toBe("CheckConstraintError:SQLITE_CONSTRAINT_CHECK");

    await expect(
      driver._executeRaw(
        `INSERT INTO "decimal_ddl_ledger" ("id","amount","optional","seeded","rate","samples","approximate") VALUES ('c', 1234000, NULL, 0, 0, '["1"]', 1.5)`
      )
    ).resolves.toBeDefined();

    await client.$disconnect();
  });

  test("no decimal column is created as TEXT or REAL", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema: ledger(), driver });
    const result = await push(client, { force: true });
    expect(result.sql.join("\n")).not.toMatch(AMOUNT_REAL);
    await client.$disconnect();
  });
});

