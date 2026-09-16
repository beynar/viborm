/**
 * G4-02 phase-2 review FOLLOW-UP 2 — attribution probes.
 *
 * `upsert-gate.review.test.ts` found three divergences. These cells decide, on
 * the same tree, whether each is round 4's, phase 2's, or older than the unit:
 *
 *  - the atomic-batch internal `Error` (is it reachable through an operator the
 *    candidate already implemented at HEAD, i.e. `increment`?);
 *  - where the shipped engine raises "Cannot divide a primary key by zero." for
 *    a relation-bearing upsert whose row is MISSING (stack printed);
 *  - whether an `int` key, which the batch guard admits, is unaffected.
 */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

class BatchOnlySQLiteDriver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
}

const intKey = s
  .model({ id: s.int().id(), label: s.string() })
  .map("r3f3_int_keys");
const numKey = s
  .model({ id: s.number().id(), label: s.string() })
  .map("r3f3_num_keys");
const money = s
  .model({
    id: s.int().id(),
    amount: s.decimal({ precision: 10, scale: 2 }),
    rate: s.number(),
  })
  .map("r3f3_money");
const intOwner = s
  .model({
    id: s.int().id(),
    label: s.string(),
    items: s.toMany(() => item),
  })
  .map("r3f3_int_owners");
const item = s
  .model({
    id: s.int().id(),
    holderId: s.int().nullable(),
    holder: s
      .toOne(() => intOwner)
      .fields("holderId")
      .references("id"),
  })
  .map("r3f3_items");
const probeSchema = { intKey, numKey, money, intOwner, item };

const SEED = `
  INSERT INTO r3f3_int_keys (id,label) VALUES (3,'a');
  INSERT INTO r3f3_num_keys (id,label) VALUES (6.0,'a');
  INSERT INTO r3f3_money (id,amount,rate) VALUES (1,'1050',2.5);
  INSERT INTO r3f3_int_owners (id,label) VALUES (3,'p');
  INSERT INTO r3f3_items (id,holderId) VALUES (70,3);
`;

interface Outcome {
  readonly answer: string;
  readonly rows: unknown[];
  readonly stack?: string;
}

type ModelName = keyof typeof probeSchema;

async function run(
  model: ModelName,
  table: string,
  operation: "upsert" | "update",
  args: Record<string, unknown>,
  engine: "shipped" | "candidate",
  batch: boolean
): Promise<Outcome> {
  const database = new Database(":memory:");
  const driver = batch
    ? new BatchOnlySQLiteDriver({ client: database })
    : new SQLite3Driver({ client: database });
  const client = createClient({ schema: probeSchema, driver });
  // biome-ignore lint/suspicious/noMisplacedAssertion: helper is only called from a cell.
  assert.equal((await syncLiveSchema(client)).applied, true);
  database.exec(SEED);
  const candidate = createCommandEngine({ schema: probeSchema, driver });
  let answer: string;
  let stack: string | undefined;
  try {
    const value =
      engine === "shipped"
        ? await (
            client as unknown as Record<
              string,
              Record<string, (args: unknown) => Promise<unknown>>
            >
          )[model]![operation]!(args)
        : await candidate.execute(model, operation, args);
    answer = `ok:${JSON.stringify(value)}`;
  } catch (error) {
    answer = `${(error as Error).constructor.name}: ${(error as Error).message}`;
    stack = (error as Error).stack;
  }
  const rows = database.prepare(`SELECT * FROM ${table}`).all();
  await client.$disconnect();
  database.close();
  return { answer, rows, stack };
}

async function both(
  model: ModelName,
  table: string,
  args: Record<string, unknown>,
  options: { operation?: "upsert" | "update"; batch?: boolean } = {}
): Promise<{ shipped: Outcome; candidate: Outcome }> {
  const operation = options.operation ?? "upsert";
  const batch = options.batch ?? false;
  return {
    shipped: await run(model, table, operation, args, "shipped", batch),
    candidate: await run(model, table, operation, args, "candidate", batch),
  };
}

describe("G4-02 review follow-up 2 — the atomic-batch internal Error, attributed", () => {
  it("reaches the same internal Error through `increment`, which HEAD already implemented", async () => {
    const outcome = await both(
      "numKey",
      "r3f3_num_keys",
      {
        where: { id: 6 },
        create: { id: 6, label: "a" },
        update: { id: { increment: 1 } },
      },
      { batch: true }
    );
    console.log(
      `[batch number-key increment] shipped=${outcome.shipped.answer} candidate=${outcome.candidate.answer}`
    );
  });

  it("performs the same multiply on an INT key under batch", async () => {
    const outcome = await both(
      "intKey",
      "r3f3_int_keys",
      {
        where: { id: 3 },
        create: { id: 3, label: "a" },
        update: { id: { multiply: 2 } },
      },
      { batch: true }
    );
    console.log(
      `[batch int-key multiply] shipped=${outcome.shipped.answer} candidate=${outcome.candidate.answer}`
    );
    assert.deepEqual(
      { answer: outcome.candidate.answer, rows: outcome.candidate.rows },
      { answer: outcome.shipped.answer, rows: outcome.shipped.rows }
    );
  });

  it("performs a NON-key decimal multiply under batch on both engines", async () => {
    const outcome = await both(
      "money",
      "r3f3_money",
      { where: { id: 1 }, data: { amount: { multiply: "2.00" } } },
      { operation: "update", batch: true }
    );
    console.log(
      `[batch non-key decimal multiply] shipped=${outcome.shipped.answer} candidate=${outcome.candidate.answer}`
    );
    assert.deepEqual(
      { answer: outcome.candidate.answer, rows: outcome.candidate.rows },
      { answer: outcome.shipped.answer, rows: outcome.shipped.rows }
    );
  });
});

describe("G4-02 review follow-up 2 — where the shipped engine refuses the missing-row divide", () => {
  it("prints the shipped stack for a relation-bearing upsert on a MISSING row", async () => {
    const outcome = await both("intOwner", "r3f3_int_owners", {
      where: { id: 99 },
      create: { id: 99, label: "fresh" },
      update: { id: { divide: 0 }, items: { create: [{ id: 1 }] } },
    });
    console.log(`[shipped missing-row divide] ${outcome.shipped.answer}`);
    console.log(
      `[shipped stack]\n${(outcome.shipped.stack ?? "").split("\n").slice(0, 12).join("\n")}`
    );
    console.log(`[candidate missing-row divide] ${outcome.candidate.answer}`);
  });

  it("prints both answers for a relation-bearing upsert MULTIPLY on a MISSING row", async () => {
    const outcome = await both("intOwner", "r3f3_int_owners", {
      where: { id: 99 },
      create: { id: 99, label: "fresh" },
      update: { id: { multiply: 2 }, items: { create: [{ id: 1 }] } },
    });
    console.log(
      `[missing-row int multiply] shipped=${outcome.shipped.answer} candidate=${outcome.candidate.answer}`
    );
  });
});
