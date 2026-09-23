/**
 * G4-02 author check (repair round 4) — WHERE the row key's portability
 * contract applies, measured against the shipped engine on `upsert`.
 *
 * Round 3 stated the contract at `EngineSchema.admit` for `update`,
 * `updateMany` AND `upsert`. The shipped engine reaches
 * `assertPortablePrimaryKeyUpdateInput` for an upsert's update payload only
 * through the RELATION-bearing arm (`write-engine/UpsertOperation.ts:496-504`,
 * inside `updateHasRelations ? … : undefined`), so a scalar-only upsert was
 * refused by the candidate and performed by the shipped engine — four public
 * shapes, one of which CREATES a row the arithmetic never touches (the second
 * independent review of phase 2, finding A).
 *
 * Every cell below is differential: it runs the identical request on the
 * client's shipped engine and on the candidate, in a world of its own, and
 * compares the answer AND the rows the provider holds afterwards. The first
 * four are the review's four divergent shapes. The last three are the other
 * half of the same gate — a relation-bearing update payload, where the shipped
 * engine DOES assert, on a row that exists, on a row that does not, and ahead
 * of a conditional that would skip — so neither half of the shipped placement
 * (`updateHasRelations`, and `compileFoundArm`'s deferral) can be dropped
 * without this file going red (note §R3.1).
 */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

const intKey = s
  .model({ id: s.int().id(), label: s.string() })
  .map("g4u2u_int_keys");
const numKey = s
  .model({ id: s.number().id(), label: s.string() })
  .map("g4u2u_num_keys");
const decKey = s
  .model({ id: s.decimal({ precision: 8, scale: 2 }).id(), label: s.string() })
  .map("g4u2u_dec_keys");
const owner = s
  .model({
    id: s.number().id(),
    label: s.string(),
    notes: s.toMany(() => note),
  })
  .map("g4u2u_owners");
const note = s
  .model({
    id: s.int().id(),
    ownerId: s.number().nullable(),
    owner: s
      .toOne(() => owner)
      .fields("ownerId")
      .references("id"),
  })
  .map("g4u2u_notes");
const intOwner = s
  .model({
    id: s.int().id(),
    label: s.string(),
    code: s.string().unique(),
    items: s.toMany(() => item),
  })
  .map("g4u2u_int_owners");
const item = s
  .model({
    id: s.int().id(),
    ownerId: s.int().nullable(),
    owner: s
      .toOne(() => intOwner)
      .fields("ownerId")
      .references("id"),
  })
  .map("g4u2u_items");
/** A COMPOUND reference key: the child references both members. */
const pairOwner = s
  .model({
    a: s.int(),
    b: s.int(),
    label: s.string(),
    parts: s.toMany(() => pairPart),
  })
  .id(["a", "b"])
  .map("g4u2u_pair_owners");
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
  .map("g4u2u_pair_parts");
const upsertSchema = {
  intKey,
  numKey,
  decKey,
  owner,
  note,
  intOwner,
  item,
  pairOwner,
  pairPart,
};

const SEED = `
  INSERT INTO g4u2u_int_keys (id,label) VALUES (3,'a');
  INSERT INTO g4u2u_num_keys (id,label) VALUES (6.0,'a');
  INSERT INTO g4u2u_dec_keys (id,label) VALUES ('600','a');
  INSERT INTO g4u2u_owners (id,label) VALUES (6.0,'o');
  INSERT INTO g4u2u_int_owners (id,label,code) VALUES (6,'o','c6');
  INSERT INTO g4u2u_notes (id,ownerId) VALUES (4,NULL);
  INSERT INTO g4u2u_pair_owners (a,b,label) VALUES (2,3,'p');
  INSERT INTO g4u2u_pair_parts (id,ownerA,ownerB) VALUES (80,2,3);
`;

interface Outcome {
  readonly answer: string;
  readonly rows: unknown[];
}

async function upsert(
  model: keyof typeof upsertSchema,
  table: string,
  args: Record<string, unknown>,
  engine: "shipped" | "candidate"
): Promise<Outcome> {
  const database = new Database(":memory:");
  const driver = new SQLite3Driver({ client: database });
  const client = createClient({ schema: upsertSchema, driver });
  // biome-ignore lint/suspicious/noMisplacedAssertion: this helper is only ever called from inside a Vitest cell.
  assert.equal((await syncLiveSchema(client)).applied, true);
  database.exec(SEED);
  const candidate = createCommandEngine({ schema: upsertSchema, driver });
  let answer: string;
  try {
    const value =
      engine === "shipped"
        ? await (
            client as unknown as Record<
              string,
              { upsert(args: unknown): Promise<unknown> }
            >
          )[model]!.upsert(args)
        : await candidate.execute(model, "upsert", args);
    answer = `ok:${JSON.stringify(value)}`;
  } catch (error) {
    answer = `${(error as Error).constructor.name}: ${(error as Error).message}`;
  }
  const rows = database.prepare(`SELECT * FROM ${table}`).all();
  await client.$disconnect();
  database.close();
  return { answer, rows };
}

async function bothEngines(
  model: keyof typeof upsertSchema,
  table: string,
  args: Record<string, unknown>
): Promise<Outcome> {
  const shipped = await upsert(model, table, args, "shipped");
  const candidate = await upsert(model, table, args, "candidate");
  // biome-ignore lint/suspicious/noMisplacedAssertion: this helper is only ever called from inside a Vitest cell.
  assert.deepEqual(
    candidate,
    shipped,
    `candidate ${JSON.stringify(candidate)}\nshipped   ${JSON.stringify(shipped)}`
  );
  return shipped;
}

describe("G4-02 — a scalar-only upsert carries no key-portability assertion", () => {
  it("multiplies a NUMBER key on the found arm, identically on both seams", async () => {
    const outcome = await bothEngines("numKey", "g4u2u_num_keys", {
      where: { id: 6 },
      create: { id: 6, label: "a" },
      update: { id: { multiply: 2 } },
    });
    // Pinned, so a silent move to a refusal on either engine is visible here.
    assert.equal(outcome.answer, 'ok:{"id":12,"label":"a"}');
  });

  it("multiplies a DECIMAL key on the found arm, identically on both seams", async () => {
    const outcome = await bothEngines("decKey", "g4u2u_dec_keys", {
      where: { id: "6.00" },
      create: { id: "6.00", label: "a" },
      update: { id: { multiply: "2.00" } },
    });
    assert.equal(outcome.answer, 'ok:{"id":"12","label":"a"}');
  });

  it("carries an int key divide-by-zero to the provider, identically on both seams", async () => {
    const outcome = await bothEngines("intKey", "g4u2u_int_keys", {
      where: { id: 3 },
      create: { id: 3, label: "a" },
      update: { id: { divide: 0 } },
    });
    // The statement IS issued: the refusal identity is the provider's, not the
    // engine's `Cannot divide primary key field 'id' by zero.`
    assert.equal(
      outcome.answer.startsWith("QueryError:"),
      true,
      outcome.answer
    );
  });

  it("CREATES the missing row whose update names key arithmetic, identically on both seams", async () => {
    const outcome = await bothEngines("numKey", "g4u2u_num_keys", {
      where: { id: 99 },
      create: { id: 99, label: "new" },
      update: { id: { multiply: 2 } },
    });
    assert.equal(outcome.answer, 'ok:{"id":99,"label":"new"}');
    assert.deepEqual(outcome.rows, [
      { id: 6, label: "a" },
      { id: 99, label: "new" },
    ]);
  });
});

describe("G4-02 — a relation-bearing upsert update DOES carry it", () => {
  it("refuses a number key multiply beside a relation write, identically on both seams", async () => {
    const outcome = await bothEngines("owner", "g4u2u_owners", {
      where: { id: 6 },
      create: { id: 6, label: "o" },
      update: {
        id: { multiply: 2 },
        notes: { create: [{ id: 1 }] },
      },
    });
    assert.equal(
      outcome.answer,
      "QueryEngineError: Arithmetic updates are not portable for number primary key field 'id'. Use an explicit set value."
    );
  });

  it("still CREATES the missing row on both seams, because the assertion is found-arm", async () => {
    // `UpsertOperation.compileFoundArm` runs `updateLegality` only after the
    // found arm is selected, so an upsert whose row is absent writes its create
    // arm and never reaches the contract. The candidate carries the refusal on
    // that same arm rather than at admission, which is why this is parity and
    // not a recorded divergence.
    const outcome = await bothEngines("owner", "g4u2u_owners", {
      where: { id: 99 },
      create: { id: 99, label: "fresh" },
      update: { id: { multiply: 2 }, notes: { create: [{ id: 1 }] } },
    });
    assert.equal(outcome.answer, 'ok:{"id":99,"label":"fresh"}');
    assert.deepEqual(outcome.rows, [
      { id: 6, label: "o" },
      { id: 99, label: "fresh" },
    ]);
  });

  it("refuses ahead of a conditional that would skip, identically on both seams", async () => {
    // Shipped order: found-arm legality runs BEFORE conditional skip/update
    // selection, so an unmatched `targetWhere` does not hide the refusal.
    const outcome = await bothEngines("owner", "g4u2u_owners", {
      where: { id: 6 },
      create: { id: 6, label: "o" },
      targetWhere: { label: "absent" },
      update: { id: { multiply: 2 }, notes: { create: [{ id: 1 }] } },
    });
    assert.equal(
      outcome.answer,
      "QueryEngineError: Arithmetic updates are not portable for number primary key field 'id'. Use an explicit set value."
    );
  });
});

describe("G4-02 — the THIRD owner the deleted engine had: the key transition at analysis", () => {
  it("refuses a divide-by-zero beside a relation write with the analysis sentence", async () => {
    const outcome = await bothEngines("intOwner", "g4u2u_int_owners", {
      where: { id: 6 },
      create: { id: 6, label: "o", code: "c6" },
      update: { id: { divide: 0 }, items: { create: [{ id: 1 }] } },
    });
    assert.equal(
      outcome.answer,
      "QueryEngineError: Cannot divide a primary key by zero."
    );
  });

  it("refuses the SAME way on a missing row, and writes nothing", async () => {
    const outcome = await bothEngines("intOwner", "g4u2u_int_owners", {
      where: { id: 99 },
      create: { id: 99, label: "fresh", code: "c99" },
      update: { id: { divide: 0 }, items: { create: [{ id: 1 }] } },
    });
    assert.equal(
      outcome.answer,
      "QueryEngineError: Cannot divide a primary key by zero."
    );
    assert.deepEqual(outcome.rows, [{ id: 6, label: "o", code: "c6" }]);
  });

  it("answers a PARENT-held relation beside the same divide", async () => {
    const outcome = await bothEngines("note", "g4u2u_notes", {
      where: { id: 4 },
      create: { id: 4 },
      update: { id: { divide: 0 }, owner: { connect: { id: 6 } } },
    });
    // A parent-held relation builds no referenced-key transition, so the third
    // owner never runs and the validator's sentence is the answer on both.
    assert.equal(
      outcome.answer,
      "QueryEngineError: Cannot divide primary key field 'id' by zero."
    );
  });

  it("answers a scalar-only divide-by-zero unchanged", async () => {
    const outcome = await bothEngines("intOwner", "g4u2u_int_owners", {
      where: { id: 6 },
      create: { id: 6, label: "o", code: "c6" },
      update: { id: { divide: 0 } },
    });
    // No relation at all: neither gate applies and the provider answers.
    assert.equal(outcome.answer, "QueryError: Query execution failed");
  });

  it("R-D2 (c) PARITY: answers the transition's OWN sentence for an upsert with relations", async () => {
    // R-D2 (c), decided by Arnaud on 2026-09-15: `set` beside an operator
    // reverts to the shipped refusals. This shape has its own sentence, from
    // this same analysis-time owner (`mutation-identity.ts:187`, reached from
    // the `UpsertOperation` constructor), because the post-transition key value
    // is what cannot be computed — so it is refused BEFORE either arm, and no
    // row is written. The `update`/`updateMany` arity sentence is in
    // `key-arithmetic.test.ts`; both belong to the one family.
    const args = {
      where: { id: 6 },
      create: { id: 6, label: "o" },
      update: { id: { set: 8, multiply: 2 }, notes: { create: [{ id: 7 }] } },
    };
    const outcome = await bothEngines("owner", "g4u2u_owners", args);
    assert.equal(
      outcome.answer,
      "QueryEngineError: Cannot determine the updated primary key for model 'owner' because field 'id' uses an unsupported operation."
    );
    assert.deepEqual(outcome.rows, [{ id: 6, label: "o" }]);
  });

  it("R-D2 (c) refuses the SAME way on a missing row, and writes nothing", async () => {
    // The owner is the transition, not the found arm: an absent row is refused
    // too, and the `create` arm never runs — the half of the placement that a
    // found-arm-only refusal would get wrong.
    const args = {
      where: { id: 99 },
      create: { id: 99, label: "fresh" },
      update: { id: { set: 8, multiply: 2 }, notes: { create: [{ id: 7 }] } },
    };
    const outcome = await bothEngines("owner", "g4u2u_owners", args);
    assert.equal(
      outcome.answer,
      "QueryEngineError: Cannot determine the updated primary key for model 'owner' because field 'id' uses an unsupported operation."
    );
    assert.deepEqual(outcome.rows, [{ id: 6, label: "o" }]);
  });

  it("R-D2 (c) answers the ARITY sentence where no transition is built", async () => {
    // A PARENT-held relation beside the same payload builds no referenced-key
    // transition, so the third owner never runs and the found arm's validator
    // answers — the `update`/`updateMany` sentence, on both engines.
    const args = {
      where: { id: 4 },
      create: { id: 4 },
      update: { id: { set: 8, multiply: 2 }, owner: { connect: { id: 6 } } },
    };
    const outcome = await bothEngines("note", "g4u2u_notes", args);
    assert.equal(
      outcome.answer,
      "QueryEngineError: Primary key field 'id' accepts exactly one update operation; received set, multiply."
    );
  });

  it("answers the same divide addressed by a NON-key unique", async () => {
    const outcome = await bothEngines("intOwner", "g4u2u_int_owners", {
      where: { code: "c6" },
      create: { id: 6, label: "o", code: "c6" },
      update: { id: { divide: 0 }, items: { create: [{ id: 1 }] } },
    });
    // The locator pins no key literal, so the transition is not nameable at
    // analysis and the found arm's validator answers on both engines.
    assert.equal(
      outcome.answer,
      "QueryEngineError: Cannot divide primary key field 'id' by zero."
    );
  });

  // The two CONDITIONS of the mirror, which round 5 stated wider than the
  // shipped owner states them (round-5 review, findings 2 and 3). The pins come
  // from the DISCRIMINATOR — `selector.facts.keys`, the `key: true` prepared
  // columns, which are the shipped `pinnedTargetValues` entries — and the
  // reference key must have exactly one member.

  it("pins the pre-value from the DISCRIMINATOR, not from an AND arm", async () => {
    const outcome = await bothEngines("intOwner", "g4u2u_int_owners", {
      where: { code: "c6", AND: [{ id: 6 }] },
      create: { id: 6, label: "o", code: "c6" },
      update: { id: { divide: 0 }, items: { create: [{ id: 1 }] } },
    });
    // `code` is the discriminator; `id` is pinned only inside an `AND` arm,
    // which `partitionWhereUnique` files under `filters` and
    // `pinnedTargetValues` never reads — so there is no analysis-time
    // pre-value and the found arm's validator answers on both engines.
    assert.equal(
      outcome.answer,
      "QueryEngineError: Cannot divide primary key field 'id' by zero."
    );
  });

  it("CREATES the absent row whose key is pinned only in an AND arm", async () => {
    const outcome = await bothEngines("intOwner", "g4u2u_int_owners", {
      where: { code: "nope", AND: [{ id: 6 }] },
      create: { id: 99, label: "fresh", code: "nope" },
      update: { id: { divide: 0 }, items: { create: [{ id: 1 }] } },
    });
    assert.equal(outcome.answer, 'ok:{"id":99,"label":"fresh","code":"nope"}');
    assert.deepEqual(outcome.rows, [
      { id: 6, label: "o", code: "c6" },
      { id: 99, label: "fresh", code: "nope" },
    ]);
  });

  it("does not raise the transition sentence for a COMPOUND reference key", async () => {
    const outcome = await bothEngines("pairOwner", "g4u2u_pair_owners", {
      where: { a_b: { a: 2, b: 3 } },
      create: { a: 2, b: 3, label: "p" },
      update: { a: { divide: 0 }, parts: { create: [{ id: 1 }] } },
    });
    // `referencedFields.length === 1` is the shipped condition
    // (`RecordUpdateCompiler.ts:3310`): a compound reference key falls through
    // to the per-member compile-time source, so the validator answers.
    assert.equal(
      outcome.answer,
      "QueryEngineError: Cannot divide primary key field 'a' by zero."
    );
  });

  it("CREATES the absent row of a COMPOUND reference key", async () => {
    const outcome = await bothEngines("pairOwner", "g4u2u_pair_owners", {
      where: { a_b: { a: 7, b: 8 } },
      create: { a: 7, b: 8, label: "fresh" },
      update: { a: { divide: 0 }, parts: { create: [{ id: 1 }] } },
    });
    assert.equal(outcome.answer, 'ok:{"a":7,"b":8,"label":"fresh"}');
    assert.deepEqual(outcome.rows, [
      { a: 2, b: 3, label: "p" },
      { a: 7, b: 8, label: "fresh" },
    ]);
  });
});
