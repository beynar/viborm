/**
 * G4-02 phase-2 review — the scalar update language, against the SHIPPED engine.
 *
 * The unit's own arithmetic cell asserts the candidate's values against
 * hand-written constants. These probes assert the candidate against the shipped
 * engine on the same database, which is the parity the brief asks for
 * ("provider numeric semantics"), and they attack the shapes the author's cell
 * does not reach: negative operands, integer truncation toward zero, a bigint
 * multiply, a float decrement, an int divide by zero, and the non-decimal
 * divide-by-zero that the shipped engine deliberately leaves to the provider.
 */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { Decimal } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { canonicalizeDecimal } from "@validation/primitives/decimal-codec";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

const ledger = s
  .model({
    id: s.int().id(),
    count: s.int(),
    ratio: s.number(),
    big: s.bigInt(),
    amount: s.decimal({ precision: 12, scale: 2 }),
  })
  .map("r2_ledgers");
const schema = { ledger };

async function world() {
  const database = new Database(":memory:");
  const driver = new SQLite3Driver({ client: database });
  const client = createClient({ schema, driver });
  assert.equal((await syncLiveSchema(client)).applied, true);
  const candidate = createCommandEngine({ schema, driver });
  return {
    database,
    client: client as unknown as Record<
      string,
      Record<string, (args?: unknown) => Promise<unknown>>
    >,
    candidate,
    async close() {
      await client.$disconnect();
      database.close();
    },
  };
}

interface Seed {
  readonly count: number;
  readonly ratio: number;
  readonly big: bigint;
  readonly amount: string;
}

const SEED: Seed = {
  count: -7,
  ratio: 2.5,
  big: 9_007_199_254_740_993n,
  amount: "10.50",
};

/** The same update through both engines, on two rows of one table. */
async function bothEngines(
  live: Awaited<ReturnType<typeof world>>,
  data: Record<string, unknown>,
  seed: Seed = SEED
): Promise<{ shipped: unknown; candidate: unknown }> {
  live.database.prepare(`DELETE FROM r2_ledgers`).run();
  const insert = live.database.prepare(
    `INSERT INTO r2_ledgers (id, count, ratio, big, amount) VALUES (?, ?, ?, ?, ?)`
  );
  // The decimal column is stored as an unscaled coefficient on SQLite.
  const coefficient = String(Math.round(Number(seed.amount) * 100));
  insert.run(1, seed.count, seed.ratio, String(seed.big), coefficient);
  insert.run(2, seed.count, seed.ratio, String(seed.big), coefficient);
  const shipped = await live.client.ledger?.update?.({
    where: { id: 1 },
    data,
  });
  const candidate = await live.candidate.execute("ledger", "update", {
    where: { id: 2 },
    data,
  });
  return { shipped, candidate };
}

function comparable(value: unknown): unknown {
  const row = { ...(value as Record<string, unknown>) };
  delete row.id;
  for (const [key, member] of Object.entries(row))
    if (member instanceof Decimal) row[key] = canonicalizeDecimal(member);
  return row;
}

describe("G4-02 review — arithmetic parity with the shipped engine", () => {
  it("multiplies, divides, decrements and increments identically on int/float/bigint/decimal", async () => {
    const live = await world();
    try {
      for (const data of [
        { count: { multiply: 3 } },
        { count: { multiply: -3 } },
        { count: { divide: 2 } },
        { count: { divide: -2 } },
        { count: { decrement: 5 } },
        { count: { increment: -5 } },
        { ratio: { divide: 4 } },
        { ratio: { decrement: 0.25 } },
        { ratio: { multiply: -2 } },
        { big: { multiply: 2n } },
        { big: { decrement: 3n } },
        { big: { divide: 2n } },
        { amount: { multiply: "2.00" } },
        { amount: { divide: "8.00" } },
        { amount: { multiply: "-1.01" } },
        { amount: { increment: "0.01" } },
        { amount: { decrement: "0.01" } },
      ]) {
        const { shipped, candidate } = await bothEngines(live, data);
        assert.deepEqual(
          comparable(candidate),
          comparable(shipped),
          `divergence for ${JSON.stringify(data, (_k, v) =>
            typeof v === "bigint" ? `${v}n` : v
          )}: candidate ${JSON.stringify(comparable(candidate), (_k, v) =>
            typeof v === "bigint" ? `${v}n` : v
          )} vs shipped ${JSON.stringify(comparable(shipped), (_k, v) =>
            typeof v === "bigint" ? `${v}n` : v
          )}`
        );
      }
    } finally {
      await live.close();
    }
  });

  it("answers an int/float divide by zero the same way as the shipped engine", async () => {
    const live = await world();
    try {
      for (const data of [
        { count: { divide: 0 } },
        { ratio: { divide: 0 } },
      ]) {
        let shippedFailure: unknown;
        let candidateFailure: unknown;
        let shipped: unknown;
        let candidate: unknown;
        live.database.prepare(`DELETE FROM r2_ledgers`).run();
        const insert = live.database.prepare(
          `INSERT INTO r2_ledgers (id, count, ratio, big, amount) VALUES (?, ?, ?, ?, ?)`
        );
        insert.run(1, 8, 2.5, "1", "1050");
        insert.run(2, 8, 2.5, "1", "1050");
        try {
          shipped = await live.client.ledger?.update?.({
            where: { id: 1 },
            data,
          });
        } catch (failure) {
          shippedFailure = failure;
        }
        try {
          candidate = await live.candidate.execute("ledger", "update", {
            where: { id: 2 },
            data,
          });
        } catch (failure) {
          candidateFailure = failure;
        }
        assert.equal(
          (candidateFailure as Error | undefined)?.constructor.name,
          (shippedFailure as Error | undefined)?.constructor.name,
          `${JSON.stringify(data)}: candidate ${String(candidateFailure)} vs shipped ${String(shippedFailure)}`
        );
        if (!shippedFailure)
          assert.deepEqual(
            comparable(candidate),
            comparable(shipped),
            `${JSON.stringify(data)} value divergence`
          );
      }
    } finally {
      await live.close();
    }
  });
});
