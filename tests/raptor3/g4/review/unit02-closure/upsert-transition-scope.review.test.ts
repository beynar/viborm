/**
 * G4-02 CLOSURE review — adversarial probes against obligation 3a, the
 * "THIRD shipped key owner" mirror (`EngineSchema.keyTransitionRefusal`,
 * `shared/schema.ts:243-292`, consulted from `commands.ts`'s upsert branch).
 *
 * The author's five differential cells (note §R4.3) all address the row by its
 * own key or by a non-key unique, with a single-member reference key. These
 * cells attack the CONDITIONS of the mirror instead:
 *
 *  - the shipped engine pins the pre-value from the DISCRIMINATOR alone
 *    (`pinnedTargetValues` -> `getWhereUniqueEntries`,
 *    `write-engine/shared.ts:154-166`), while the candidate pins from
 *    `selector.facts.equals`, which also collects equalities written in an
 *    extended `where`'s filter half and inside `AND`/`OR`/`NOT` arms;
 *  - the shipped engine raises the transition refusal only when the reference
 *    key has exactly ONE member (`RecordUpdateCompiler.ts:3310-3312`,
 *    `referencedFields.length === 1`), while the candidate's `pairs.some(...)`
 *    accepts a compound reference key;
 *  - `buildRecordUpdateCompiler` is also reached from a root `update`, so the
 *    same analysis-time owner answers that verb too.
 *
 * Every cell is differential: the identical request on the client's own shipped
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

/** Single-member reference key, int PK, plus a non-key unique to address by. */
const pinOwner = s
  .model({
    id: s.int().id(),
    code: s.string().unique(),
    label: s.string(),
    items: s.toMany(() => pinItem),
  })
  .map("r3c_pin_owners");
const pinItem = s
  .model({
    id: s.int().id(),
    holderId: s.int().nullable(),
    holder: s
      .toOne(() => pinOwner)
      .fields("holderId")
      .references("id"),
  })
  .map("r3c_pin_items");

/** A COMPOUND reference key: the child references both members. */
const pairOwner = s
  .model({
    a: s.int(),
    b: s.int(),
    label: s.string(),
    parts: s.toMany(() => pairPart),
  })
  .id(["a", "b"])
  .map("r3c_pair_owners");
const pairPart = s
  .model({
    id: s.int().id(),
    ownerA: s.int().nullable(),
    ownerB: s.int().nullable(),
    owner: s
      .toOne(() => pairOwner)
      .fields("ownerA", "ownerB")
      .references("a", "b"),
  })
  .map("r3c_pair_parts");

/** A bigint key, for the `0n` arm of the same operand test. */
const bigOwner = s
  .model({
    id: s.bigInt().id(),
    label: s.string(),
    leaves: s.toMany(() => bigLeaf),
  })
  .map("r3c_big_owners");
const bigLeaf = s
  .model({
    id: s.int().id(),
    holderId: s.bigInt().nullable(),
    holder: s
      .toOne(() => bigOwner)
      .fields("holderId")
      .references("id"),
  })
  .map("r3c_big_leaves");

const probeSchema = {
  pinOwner,
  pinItem,
  pairOwner,
  pairPart,
  bigOwner,
  bigLeaf,
};

const SEED = `
  INSERT INTO r3c_pin_owners (id,code,label) VALUES (6,'c6','o');
  INSERT INTO r3c_pin_items (id,holderId) VALUES (70,6);
  INSERT INTO r3c_pair_owners (a,b,label) VALUES (2,3,'p');
  INSERT INTO r3c_pair_parts (id,ownerA,ownerB) VALUES (80,2,3);
  INSERT INTO r3c_big_owners (id,label) VALUES (9,'b');
  INSERT INTO r3c_big_leaves (id,holderId) VALUES (90,9);
`;

type ModelName = keyof typeof probeSchema;

interface Outcome {
  readonly answer: string;
  readonly rows: unknown[];
}

async function run(
  model: ModelName,
  table: string,
  operation: "upsert" | "update",
  args: Record<string, unknown>,
  engine: "shipped" | "candidate"
): Promise<Outcome> {
  const database = new Database(":memory:");
  const driver = new SQLite3Driver({ client: database });
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
    answer = `ok:${JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? `${item}n` : item
    )}`;
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
  operation: "upsert" | "update" = "upsert"
): Promise<{ shipped: Outcome; candidate: Outcome }> {
  const shipped = await run(model, table, operation, args, "shipped");
  const candidate = await run(model, table, operation, args, "candidate");
  return { shipped, candidate };
}

function report(name: string, pair: { shipped: Outcome; candidate: Outcome }) {
  // biome-ignore lint/suspicious/noConsole: the probe's measurement IS its output.
  console.log(
    `[${name}]\n  shipped   ${pair.shipped.answer}\n            rows ${JSON.stringify(pair.shipped.rows)}\n  candidate ${pair.candidate.answer}\n            rows ${JSON.stringify(pair.candidate.rows)}`
  );
}

function assertSame(
  name: string,
  pair: { shipped: Outcome; candidate: Outcome }
) {
  report(name, pair);
  assert.deepEqual(
    pair.candidate,
    pair.shipped,
    `${name}\ncandidate ${JSON.stringify(pair.candidate)}\nshipped   ${JSON.stringify(pair.shipped)}`
  );
}

describe("G4-02 closure review — the third key owner's conditions", () => {
  it("pins the pre-value from the DISCRIMINATOR, not from an AND arm (row present)", async () => {
    // The discriminator is `code`; `id` is pinned only inside an AND arm, which
    // `partitionWhereUnique` files under `filters` and `pinnedTargetValues`
    // never reads. The shipped engine therefore has no analysis-time pre-value.
    assertSame(
      "and-arm pin, row present",
      await both("pinOwner", "r3c_pin_owners", {
        where: { code: "c6", AND: [{ id: 6 }] },
        create: { id: 6, code: "c6", label: "fresh" },
        update: { id: { divide: 0 }, items: { create: [{ id: 1 }] } },
      })
    );
  });

  it("pins the pre-value from the DISCRIMINATOR, not from an AND arm (row ABSENT)", async () => {
    assertSame(
      "and-arm pin, row absent",
      await both("pinOwner", "r3c_pin_owners", {
        where: { code: "nope", AND: [{ id: 6 }] },
        create: { id: 99, code: "nope", label: "fresh" },
        update: { id: { divide: 0 }, items: { create: [{ id: 1 }] } },
      })
    );
  });

  it("does not raise the transition refusal for a COMPOUND reference key (row present)", async () => {
    // `referencedFields.length === 1` is the shipped condition; a compound
    // reference key falls through to the per-member compile-time source.
    assertSame(
      "compound reference key, row present",
      await both("pairOwner", "r3c_pair_owners", {
        where: { a_b: { a: 2, b: 3 } },
        create: { a: 2, b: 3, label: "p" },
        update: { a: { divide: 0 }, parts: { create: [{ id: 1 }] } },
      })
    );
  });

  it("does not raise the transition refusal for a COMPOUND reference key (row ABSENT)", async () => {
    assertSame(
      "compound reference key, row absent",
      await both("pairOwner", "r3c_pair_owners", {
        where: { a_b: { a: 7, b: 8 } },
        create: { a: 7, b: 8, label: "fresh" },
        update: { a: { divide: 0 }, parts: { create: [{ id: 1 }] } },
      })
    );
  });

  it("answers a root UPDATE with a child-held relation beside the divide the way shipped does", async () => {
    assertSame(
      "root update, relation-bearing divide, row present",
      await both(
        "pinOwner",
        "r3c_pin_owners",
        {
          where: { id: 6 },
          data: { id: { divide: 0 }, items: { create: [{ id: 1 }] } },
        },
        "update"
      )
    );
  });

  it("answers a root UPDATE on an ABSENT row the way shipped does", async () => {
    assertSame(
      "root update, relation-bearing divide, row absent",
      await both(
        "pinOwner",
        "r3c_pin_owners",
        {
          where: { id: 404 },
          data: { id: { divide: 0 }, items: { create: [{ id: 1 }] } },
        },
        "update"
      )
    );
  });

  it("answers a bigint key `divide: 0n` beside a child-held relation the way shipped does", async () => {
    assertSame(
      "bigint key divide 0n, row present",
      await both("bigOwner", "r3c_big_owners", {
        where: { id: 9n },
        create: { id: 9n, label: "b" },
        update: { id: { divide: 0n }, leaves: { create: [{ id: 1 }] } },
      })
    );
  });

  it("answers a CONNECT payload on the child-held relation the way shipped does", async () => {
    assertSame(
      "child-held connect beside the divide, row present",
      await both("pinOwner", "r3c_pin_owners", {
        where: { id: 6 },
        create: { id: 6, code: "c6", label: "o" },
        update: { id: { divide: 0 }, items: { connect: [{ id: 70 }] } },
      })
    );
  });

  it("answers a relation that does NOT reference the rewritten key the way shipped does", async () => {
    // `pinItem.holder` references `id`; rewriting `code` (a unique, not the
    // row key) builds no referenced-key transition on either engine.
    assertSame(
      "relation beside a non-key rewrite",
      await both("pinOwner", "r3c_pin_owners", {
        where: { id: 6 },
        create: { id: 6, code: "c6", label: "o" },
        update: { code: "c7", items: { create: [{ id: 1 }] } },
      })
    );
  });
});
