/**
 * G4-02 phase-2 review FOLLOW-UP — adversarial probes against repair round 3.
 *
 * Round 3 claims (note §R2.1/§R2.2) that `Queries.updateValue` now NAMES the
 * updated key in every integer and float domain, and that `EngineSchema.admit`
 * mirrors two shipped portability refusals for the operators phase 2 made
 * reachable. These cells attack both claims from shapes the author's own
 * checks do not cover: a DEPENDENT riding a multiplied key (the property the
 * note still lists as unverified), a model with NO row key at all (the new
 * admission hook dereferences `rowKey!`), a non-key arithmetic payload (the
 * mirror must not over-fire), `upsert` (a third admitted operation the hook
 * covers), a non-finite operand (the shipped arm deliberately NOT mirrored),
 * and negative integer quotients (truncation direction).
 *
 * Each cell states the SHIPPED answer as the expectation.
 */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

/** MySQL's `supportsReturning: false`, credential-free. */
class NonReturningDriver extends SQLite3Driver {
  constructor(options: { client: Database.Database }) {
    super(options);
    this.adapter.capabilities.supportsReturning = false;
  }
}

const parent = s
  .model({
    id: s.int().id(),
    label: s.string(),
    children: s.toMany(() => child),
  })
  .map("r3f_parents");
const child = s
  .model({
    id: s.int().id(),
    parentId: s.int().nullable(),
    parent: s.toOne(() => parent).fields("parentId").references("id"),
  })
  .map("r3f_children");
const bigKey = s
  .model({ id: s.bigInt().id(), label: s.string() })
  .map("r3f_big_keys");
const numKey = s
  .model({ id: s.number().id(), label: s.string() })
  .map("r3f_num_keys");
const decKey = s
  .model({ id: s.decimal({ precision: 8, scale: 2 }).id(), label: s.string() })
  .map("r3f_dec_keys");
const money = s
  .model({
    id: s.int().id(),
    amount: s.decimal({ precision: 10, scale: 2 }),
  })
  .map("r3f_money");
const schema = { parent, child, bigKey, numKey, money, decKey };

const SEED = `
  INSERT INTO r3f_parents (id,label) VALUES (3,'p');
  INSERT INTO r3f_children (id,parentId) VALUES (100,3);
  INSERT INTO r3f_big_keys (id,label) VALUES (-7,'a');
  INSERT INTO r3f_num_keys (id,label) VALUES (6.0,'a');
  INSERT INTO r3f_money (id,amount) VALUES ('1050',1);
  INSERT INTO r3f_dec_keys (id,label) VALUES ('600','a');
`;

interface Outcome {
  readonly answer: string;
  readonly rows: unknown[];
}

async function run(
  model: keyof typeof schema,
  operation: string,
  args: Record<string, unknown>,
  engine: "shipped" | "candidate",
  table: string,
  returning = true
): Promise<Outcome> {
  const database = new Database(":memory:");
  const driver = returning
    ? new SQLite3Driver({ client: database })
    : new NonReturningDriver({ client: database });
  const client = createClient({ schema, driver });
  assert.equal((await syncLiveSchema(client)).applied, true);
  database.exec(SEED);
  const candidate = createCommandEngine({ schema, driver });
  let answer: string;
  try {
    const value =
      engine === "shipped"
        ? await (
            client as unknown as Record<
              string,
              Record<string, (args: unknown) => Promise<unknown>>
            >
          )[model]![operation]!(args)
        : await candidate.execute(model, operation as never, args);
    answer = `ok:${JSON.stringify(value)}`;
  } catch (error) {
    answer = `${(error as Error).constructor.name}: ${(error as Error).message}`;
  }
  const rows = database.prepare(`SELECT * FROM ${table}`).all();
  await client.$disconnect();
  database.close();
  return { answer, rows };
}

async function both(
  model: keyof typeof schema,
  operation: string,
  args: Record<string, unknown>,
  table: string,
  returning = true
): Promise<void> {
  const shipped = await run(model, operation, args, "shipped", table, returning);
  const candidate = await run(
    model,
    operation,
    args,
    "candidate",
    table,
    returning
  );
  assert.deepEqual(
    candidate,
    shipped,
    `candidate ${JSON.stringify(candidate)}\nshipped   ${JSON.stringify(shipped)}`
  );
}

describe("G4-02 repair round 3 — the named key, attacked", () => {
  it("carries a DEPENDENT through a multiplied parent key (non-returning)", async () => {
    await both(
      "parent",
      "update",
      { where: { id: 3 }, data: { id: { multiply: 4 } } },
      "r3f_children",
      false
    );
  });

  it("carries a DEPENDENT through a divided parent key (non-returning)", async () => {
    await both(
      "parent",
      "update",
      { where: { id: 3 }, data: { id: { divide: 3 } } },
      "r3f_children",
      false
    );
  });

  it("truncates a NEGATIVE bigint quotient the way the shipped engine does", async () => {
    await both(
      "bigKey",
      "update",
      { where: { id: -7 }, data: { id: { divide: 2 } } },
      "r3f_big_keys",
      false
    );
  });

  it("multiplies a NEGATIVE bigint key the way the shipped engine does", async () => {
    await both(
      "bigKey",
      "update",
      { where: { id: -7 }, data: { id: { multiply: 3 } } },
      "r3f_big_keys",
      false
    );
  });
});

describe("G4-02 repair round 3 — the admission mirror, attacked", () => {
  // A model with no row key cannot exist: schema validation refuses it
  // ([M001] "must have an ID field"), so `EngineSchema.keys`'s `rowKey!`
  // assertion the new admission hook rides is unreachable from the public
  // surface. Measured, not assumed — the cell that tried is removed.

  it("does not fire for arithmetic on a NON-key decimal column", async () => {
    await both(
      "money",
      "update",
      { where: { id: 1 }, data: { amount: { multiply: "2.5" } } },
      "r3f_money"
    );
  });

  it("refuses a number key multiply through upsert as the shipped engine does", async () => {
    await both(
      "numKey",
      "upsert",
      {
        where: { id: 6 },
        create: { id: 6, label: "a" },
        update: { id: { multiply: 2 } },
      },
      "r3f_num_keys"
    );
  });

  it("refuses an int key divide-by-zero through updateMany as shipped does", async () => {
    await both(
      "parent",
      "updateMany",
      { where: { id: 3 }, data: { id: { divide: 0 } } },
      "r3f_parents"
    );
  });

  it("refuses an int key divide-by-zero through upsert as the shipped engine does", async () => {
    await both(
      "parent",
      "upsert",
      {
        where: { id: 3 },
        create: { id: 3, label: "p" },
        update: { id: { divide: 0 } },
      },
      "r3f_parents"
    );
  });

  it("answers an INT key multiply through upsert the way the shipped engine does", async () => {
    await both(
      "money",
      "upsert",
      {
        where: { id: 1 },
        create: { id: 1, amount: "10.50" },
        update: { id: { multiply: 2 } },
      },
      "r3f_money"
    );
  });

  it("answers a DECIMAL key multiply through upsert the way the shipped engine does", async () => {
    await both(
      "decKey",
      "upsert",
      {
        where: { id: "6.00" },
        create: { id: "6.00", label: "a" },
        update: { id: { multiply: "2.00" } },
      },
      "r3f_dec_keys"
    );
  });

  it("upserts a MISSING row whose update names key arithmetic, as shipped does", async () => {
    await both(
      "numKey",
      "upsert",
      {
        where: { id: 99 },
        create: { id: 99, label: "new" },
        update: { id: { multiply: 2 } },
      },
      "r3f_num_keys"
    );
  });

  it("answers a FLOAT key increment the way the shipped engine does", async () => {
    await both(
      "numKey",
      "update",
      { where: { id: 6 }, data: { id: { increment: 1 } } },
      "r3f_num_keys"
    );
  });

  it("answers a non-finite int key operand the way the shipped engine does", async () => {
    await both(
      "parent",
      "update",
      { where: { id: 3 }, data: { id: { multiply: Number.POSITIVE_INFINITY } } },
      "r3f_parents"
    );
  });
});
