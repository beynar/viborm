/**
 * G4-02 phase-2 review FOLLOW-UP 2 — adversarial probes against repair round 4.
 *
 * Round 4 (note §R3.1) moves the row-key portability refusal off
 * `EngineSchema.admit` for `upsert` and hangs it on the materialized FOUND arm,
 * gated by `EngineSchema.namesRelation`, claiming parity with the shipped
 * engine's two-halved gate (`UpsertOperation.ts:291-293`, `:496-504`,
 * `:845-853`). The author's own witness covers seven shapes. These cells attack
 * the shapes it does NOT cover: the other refusal sentence on the gated arm,
 * an operator the gate must NOT refuse, a MATCHED conditional, `set` beside the
 * operator, an arm that already carries a nested-write refusal (the assignment
 * is `=`, not `??=`), the atomic-batch profile the note lists as unverified,
 * an absent row on the divide-by-zero shape, a nested upsert, and the
 * `update`/`updateMany` contract that must still fire.
 *
 * Every cell is differential: the identical request on the client's shipped
 * engine and on the candidate, each in its own world, comparing the answer AND
 * the rows the provider holds afterwards.
 */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

/** D1's profile: no interactive transaction, so `OperationContext.usesBatch`. */
class BatchOnlySQLiteDriver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
}

const intKey = s
  .model({ id: s.int().id(), label: s.string() })
  .map("r3f2_int_keys");
const numKey = s
  .model({ id: s.number().id(), label: s.string() })
  .map("r3f2_num_keys");
const owner = s
  .model({
    id: s.number().id(),
    label: s.string(),
    notes: s.toMany(() => note),
  })
  .map("r3f2_owners");
const note = s
  .model({
    id: s.int().id(),
    ownerId: s.number().nullable(),
    owner: s
      .toOne(() => owner)
      .fields("ownerId")
      .references("id"),
  })
  .map("r3f2_notes");
const intOwner = s
  .model({
    id: s.int().id(),
    label: s.string(),
    items: s.toMany(() => item),
  })
  .map("r3f2_int_owners");
const item = s
  .model({
    id: s.int().id(),
    holderId: s.int().nullable(),
    holder: s
      .toOne(() => intOwner)
      .fields("holderId")
      .references("id"),
  })
  .map("r3f2_items");
const decOwner = s
  .model({
    id: s.decimal({ precision: 8, scale: 2 }).id(),
    label: s.string(),
    tags: s.toMany(() => tag),
  })
  .map("r3f2_dec_owners");
const tag = s
  .model({
    id: s.int().id(),
    holderCode: s.decimal({ precision: 8, scale: 2 }).nullable(),
    holder: s
      .toOne(() => decOwner)
      .fields("holderCode")
      .references("id"),
  })
  .map("r3f2_tags");
const probeSchema = {
  intKey,
  numKey,
  owner,
  note,
  intOwner,
  item,
  decOwner,
  tag,
};

const SEED = `
  INSERT INTO r3f2_int_keys (id,label) VALUES (3,'a');
  INSERT INTO r3f2_num_keys (id,label) VALUES (6.0,'a');
  INSERT INTO r3f2_owners (id,label) VALUES (6.0,'o');
  INSERT INTO r3f2_notes (id,ownerId) VALUES (50,6.0);
  INSERT INTO r3f2_int_owners (id,label) VALUES (3,'p');
  INSERT INTO r3f2_items (id,holderId) VALUES (70,3);
  INSERT INTO r3f2_dec_owners (id,label) VALUES ('600','d');
`;

interface Outcome {
  readonly answer: string;
  readonly rows: unknown[];
}

type ModelName = keyof typeof probeSchema;

async function run(
  model: ModelName,
  table: string,
  operation: "upsert" | "update" | "updateMany",
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
  }
  const rows = database.prepare(`SELECT * FROM ${table}`).all();
  await client.$disconnect();
  database.close();
  return { answer, rows };
}

async function both(
  model: ModelName,
  table: string,
  args: Record<string, unknown>,
  options: {
    operation?: "upsert" | "update" | "updateMany";
    batch?: boolean;
  } = {}
): Promise<Outcome> {
  const operation = options.operation ?? "upsert";
  const batch = options.batch ?? false;
  const shipped = await run(model, table, operation, args, "shipped", batch);
  const candidate = await run(
    model,
    table,
    operation,
    args,
    "candidate",
    batch
  );
  // biome-ignore lint/suspicious/noMisplacedAssertion: helper is only called from a cell.
  assert.deepEqual(
    candidate,
    shipped,
    `candidate ${JSON.stringify(candidate)}\nshipped   ${JSON.stringify(shipped)}`
  );
  return shipped;
}

describe("G4-02 review follow-up 2 — the relation-bearing half of the gate", () => {
  it("answers an int key divide-by-zero beside a relation write the way shipped does", async () => {
    const outcome = await both("intOwner", "r3f2_int_owners", {
      where: { id: 3 },
      create: { id: 3, label: "p" },
      update: { id: { divide: 0 }, items: { create: [{ id: 1 }] } },
    });
    // eslint-disable-next-line no-console
    console.log(`[int-divide-zero+relation] ${outcome.answer}`);
  });

  it("answers a DECIMAL key multiply beside a relation write the way shipped does", async () => {
    const outcome = await both("decOwner", "r3f2_dec_owners", {
      where: { id: "6.00" },
      create: { id: "6.00", label: "d" },
      update: { id: { multiply: "2.00" }, tags: { create: [{ id: 1 }] } },
    });
    console.log(`[decimal-multiply+relation] ${outcome.answer}`);
  });

  it("does NOT refuse a supported int key increment beside a relation write", async () => {
    const outcome = await both("intOwner", "r3f2_int_owners", {
      where: { id: 3 },
      create: { id: 3, label: "p" },
      update: { id: { increment: 1 }, items: { create: [{ id: 1 }] } },
    });
    console.log(`[int-increment+relation] ${outcome.answer}`);
  });

  it("answers a MATCHED conditional the way shipped does", async () => {
    const outcome = await both("owner", "r3f2_owners", {
      where: { id: 6 },
      create: { id: 6, label: "o" },
      targetWhere: { label: "o" },
      update: { id: { multiply: 2 }, notes: { create: [{ id: 1 }] } },
    });
    console.log(`[matched-conditional] ${outcome.answer}`);
  });

  it("answers `set` beside the operator on the gated arm the way shipped does", async () => {
    const outcome = await both("owner", "r3f2_owners", {
      where: { id: 6 },
      create: { id: 6, label: "o" },
      update: { id: { set: 8, multiply: 2 }, notes: { create: [{ id: 1 }] } },
    });
    console.log(`[set-beside-operator] ${outcome.answer}`);
  });

  it("orders the portability refusal against a nested-write refusal the way shipped does", async () => {
    const outcome = await both("owner", "r3f2_owners", {
      where: { id: 6 },
      create: { id: 6, label: "o" },
      update: {
        id: { multiply: 2 },
        notes: {
          disconnect: { id: 50 },
          update: { where: { id: 50 }, data: { id: 51 } },
        },
      },
    });
    console.log(`[portability-vs-nested] ${outcome.answer}`);
  });
});

describe("G4-02 review follow-up 2 — the profile and the absent row", () => {
  it("raises the gated refusal on an ATOMIC BATCH profile the way shipped does", async () => {
    const outcome = await both(
      "owner",
      "r3f2_owners",
      {
        where: { id: 6 },
        create: { id: 6, label: "o" },
        update: { id: { multiply: 2 }, notes: { create: [{ id: 1 }] } },
      },
      { batch: true }
    );
    console.log(`[batch relation-bearing] ${outcome.answer}`);
  });

  it("performs a scalar-only key multiply on an ATOMIC BATCH profile the way shipped does", async () => {
    const outcome = await both(
      "numKey",
      "r3f2_num_keys",
      {
        where: { id: 6 },
        create: { id: 6, label: "a" },
        update: { id: { multiply: 2 } },
      },
      { batch: true }
    );
    console.log(`[batch scalar-only] ${outcome.answer}`);
  });

  it("CREATES the missing row whose scalar update divides the key by zero", async () => {
    const outcome = await both("intKey", "r3f2_int_keys", {
      where: { id: 99 },
      create: { id: 99, label: "new" },
      update: { id: { divide: 0 } },
    });
    console.log(`[absent divide-by-zero] ${outcome.answer}`);
  });

  it("CREATES the missing row whose relation-bearing update divides the key by zero", async () => {
    const outcome = await both("intOwner", "r3f2_int_owners", {
      where: { id: 99 },
      create: { id: 99, label: "fresh" },
      update: { id: { divide: 0 }, items: { create: [{ id: 1 }] } },
    });
    console.log(`[absent relation divide-by-zero] ${outcome.answer}`);
  });
});

describe("G4-02 review follow-up 2 — the contract that must still fire", () => {
  it("still refuses a number key multiply on `update`", async () => {
    const outcome = await both(
      "numKey",
      "r3f2_num_keys",
      { where: { id: 6 }, data: { id: { multiply: 2 } } },
      { operation: "update" }
    );
    assert.equal(
      outcome.answer,
      "QueryEngineError: Arithmetic updates are not portable for number primary key field 'id'. Use an explicit set value."
    );
  });

  it("still refuses an int key divide-by-zero on `updateMany`", async () => {
    const outcome = await both(
      "intKey",
      "r3f2_int_keys",
      { where: { id: 3 }, data: { id: { divide: 0 } } },
      { operation: "updateMany" }
    );
    assert.equal(
      outcome.answer,
      "QueryEngineError: Cannot divide primary key field 'id' by zero."
    );
  });

  it("refuses a relation-bearing `update` key multiply at admission, as shipped does", async () => {
    const outcome = await both(
      "owner",
      "r3f2_owners",
      {
        where: { id: 6 },
        data: { id: { multiply: 2 }, notes: { create: [{ id: 1 }] } },
      },
      { operation: "update" }
    );
    assert.equal(
      outcome.answer,
      "QueryEngineError: Arithmetic updates are not portable for number primary key field 'id'. Use an explicit set value."
    );
  });
});

describe("G4-02 review follow-up 2 — a NESTED upsert's update payload", () => {
  it("answers a nested upsert whose update multiplies the target key the way shipped does", async () => {
    const outcome = await both(
      "intOwner",
      "r3f2_items",
      {
        where: { id: 3 },
        data: {
          items: {
            upsert: [
              {
                where: { id: 70 },
                create: { id: 70 },
                update: { id: { multiply: 2 } },
              },
            ],
          },
        },
      },
      { operation: "update" }
    );
    console.log(`[nested upsert] ${outcome.answer}`);
  });
});
