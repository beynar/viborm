/**
 * G4-02 author check (decisions round 2) — R-D2 (c) at the NESTED sites.
 *
 * Arnaud's decision (c) is about the SHAPE: "`set` beside an operator … revert
 * to the shipped refusals (parity)". The first decisions round applied it at
 * the two ROOT owners (`EngineSchema.admit` for `update`/`updateMany`, and the
 * upsert found-arm channel in `commands.ts`), and the independent review
 * measured four reachable NESTED shapes where `set` still won and the child's
 * key was rewritten — byte-identical at the committed `0cc61e61`, so inherited,
 * not introduced (`g4/decisions-review.md` finding 1, and its receipt
 * `decisions-review-receipts/probe-nested-key-refusal.log`).
 *
 * Parity at every site the shipped engine states the predicate IS the decision,
 * so the same owner — `EngineSchema.keyPortabilityRefusal`, the sentences it
 * already states — is now asked at the three nested positions the relation body
 * already admits an update payload in: the `update`/`upsert` child selector arm
 * and the `updateMany` member. No new walk and no per-verb table: `connect`,
 * `connectOrCreate` and a `deleteMany` member carry no update payload, so they
 * ask nothing. The shipped engine states the same predicate at nine nested
 * compile sites (`RelationWritePart.ts:856`, `:898`,
 * `RecordUpdateCompiler.ts:1794`, `:3770`, `:3944`, `RelationUpsertPart.ts:1008`,
 * `RelationJunctionPart.ts:2772`, `:3042`, `NestedSelectedRecordSeries.ts:226`).
 *
 * WHEN each position states it is the shipped engine's too (freeze review,
 * finding 1). A nested `update` and an `updateMany` member are asserted at
 * COMPILE time (`RelationWritePart.ts:856`, `:898`), so those refuse before
 * anything is located. A nested `upsert` is not: the shipped engine builds the
 * same assertion as a closure (`RelationUpsertPart.ts:1006`) and invokes it only
 * inside the FOUND arm (`:468`), so an absent target creates its row and the
 * update payload is never judged. The candidate hands the upsert's refusal to
 * its found arm, and the scope-control cell measures BOTH directions.
 *
 * The last cell is the review's note 3: the one bare `Error` still reachable
 * from an admitted public request in this family. A root `upsert` whose update
 * payload names no relation never reaches the found-arm channel, so an empty
 * key operator record fell through to `Queries.prepareUpdate`'s "not
 * implemented" throw; it now answers the shipped engine's own sentence and
 * identity (`builders/set-builder.ts:217-219`), before any statement.
 *
 * Every cell asserts the candidate against the shipped engine over the same
 * SQLite data, answer AND rows, so a refusal that fires late enough to write
 * something fails the cell.
 */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { Operations } from "@client/types";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

const OWNERS = "g4u2nk_owners";
const ITEMS = "g4u2nk_items";
const NOWNERS = "g4u2nk_nowners";
const NITEMS = "g4u2nk_nitems";

const owner = s
  .model({
    id: s.int().id(),
    label: s.string(),
    items: s.toMany(() => item),
  })
  .map(OWNERS);
const item = s
  .model({
    id: s.int().id(),
    name: s.string(),
    ownerId: s.int().nullable(),
    owner: s
      .toOne(() => owner)
      .fields("ownerId")
      .references("id"),
  })
  .map(ITEMS);
// The same shape over a `number` key, for the second sentence
// `keyPortabilityRefusal` states ("Arithmetic updates are not portable for
// number primary key field …").
const nowner = s
  .model({
    id: s.int().id(),
    label: s.string(),
    items: s.toMany(() => nitem),
  })
  .map(NOWNERS);
const nitem = s
  .model({
    id: s.number().id(),
    name: s.string(),
    ownerId: s.int().nullable(),
    owner: s
      .toOne(() => nowner)
      .fields("ownerId")
      .references("id"),
  })
  .map(NITEMS);
const nestedSchema = { owner, item, nowner, nitem };

const SEED = `
  INSERT INTO ${OWNERS} (id,label) VALUES (1,'o');
  INSERT INTO ${ITEMS} (id,name,ownerId) VALUES (10,'i',1);
  INSERT INTO ${NOWNERS} (id,label) VALUES (1,'o');
  INSERT INTO ${NITEMS} (id,name,ownerId) VALUES (10,'i',1);
`;

interface Outcome {
  readonly answer: string;
  readonly items: unknown[];
  readonly owners: unknown[];
  readonly nitems: unknown[];
}

async function run(
  engine: "shipped" | "candidate",
  model: keyof typeof nestedSchema,
  operation: Operations,
  args: unknown
): Promise<Outcome> {
  const database = new Database(":memory:");
  const driver = new SQLite3Driver({ client: database });
  const client = createClient({ schema: nestedSchema, driver });
  // biome-ignore lint/suspicious/noMisplacedAssertion: this helper is only ever called from inside a Vitest cell.
  assert.equal((await syncLiveSchema(client)).applied, true);
  database.exec(SEED);
  const candidate = createCommandEngine({ schema: nestedSchema, driver });
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
  const items = database.prepare(`SELECT * FROM ${ITEMS} ORDER BY id`).all();
  const owners = database.prepare(`SELECT * FROM ${OWNERS} ORDER BY id`).all();
  const nitems = database.prepare(`SELECT * FROM ${NITEMS} ORDER BY id`).all();
  await client.$disconnect();
  database.close();
  return { answer, items, owners, nitems };
}

async function bothEngines(
  model: keyof typeof nestedSchema,
  operation: Operations,
  args: unknown,
  expected?: string
): Promise<Outcome> {
  const shipped = await run("shipped", model, operation, args);
  const candidate = await run("candidate", model, operation, args);
  // biome-ignore lint/suspicious/noMisplacedAssertion: this helper is only ever called from inside a Vitest cell.
  assert.deepEqual(
    candidate,
    shipped,
    `candidate ${JSON.stringify(candidate)}\nshipped   ${JSON.stringify(shipped)}`
  );
  if (expected !== undefined)
    // biome-ignore lint/suspicious/noMisplacedAssertion: this helper is only ever called from inside a Vitest cell.
    assert.equal(candidate.answer, expected);
  return candidate;
}

const keys = (rows: unknown[]): unknown[] =>
  rows.map((row) => (row as { id: unknown }).id);

const ARITY_SET_INCREMENT =
  "QueryEngineError: Primary key field 'id' accepts exactly one update operation; received set, increment.";
const ARITY_NONE =
  "QueryEngineError: Primary key field 'id' accepts exactly one update operation; received none.";

describe("G4-02 — R-D2 (c) at the nested sites (decisions round 2)", () => {
  it("refuses a nested child update whose key names set beside an operator", async () => {
    await bothEngines(
      "owner",
      "update",
      {
        where: { id: 1 },
        data: {
          items: {
            update: [
              { where: { id: 10 }, data: { id: { set: 11, increment: 1 } } },
            ],
          },
        },
      },
      ARITY_SET_INCREMENT
    );
  });

  it("refuses a nested child upsert whose key names set beside an operator", async () => {
    await bothEngines(
      "owner",
      "update",
      {
        where: { id: 1 },
        data: {
          items: {
            upsert: [
              {
                where: { id: 10 },
                create: { id: 10, name: "i" },
                update: { id: { set: 11, increment: 1 } },
              },
            ],
          },
        },
      },
      ARITY_SET_INCREMENT
    );
  });

  it("refuses a nested updateMany member whose key names set beside an operator", async () => {
    await bothEngines(
      "owner",
      "update",
      {
        where: { id: 1 },
        data: {
          items: {
            updateMany: [
              { where: { id: 10 }, data: { id: { set: 11, increment: 1 } } },
            ],
          },
        },
      },
      ARITY_SET_INCREMENT
    );
  });

  it("answers the arity sentence when a nested child key names nothing", async () => {
    await bothEngines(
      "owner",
      "update",
      {
        where: { id: 1 },
        data: {
          items: { update: [{ where: { id: 10 }, data: { id: {} } }] },
        },
      },
      ARITY_NONE
    );
  });

  it("keeps the refusal inside the shipped predicate's SHAPE and POSITIONS", async () => {
    // The scope control, in both directions. It is the shipped predicate at the
    // shipped positions, never a wider "no nested key writes" rule.
    //
    // (a) SHAPE — a nested child key naming exactly one operation is reachable.
    await bothEngines("owner", "update", {
      where: { id: 1 },
      data: {
        items: {
          update: [{ where: { id: 10 }, data: { id: { set: 11 } } }],
        },
      },
    });
    await bothEngines("owner", "update", {
      where: { id: 1 },
      data: {
        items: {
          update: [{ where: { id: 10 }, data: { id: { increment: 1 } } }],
        },
      },
    });
    // (b) POSITION — a nested `upsert` whose target is ABSENT takes the CREATE
    // arm, and the update payload is never judged. The shipped engine builds
    // the assertion as a closure (`RelationUpsertPart.ts:1006`) and invokes it
    // only inside the found arm (`:468`), so the very payloads the second and
    // third cells refuse on a PRESENT target must CREATE the row here — the
    // failure mode `EngineSchema.keyPortabilityRefusal`'s docblock names, "an
    // upsert that CREATES a row the arithmetic never touches". Raised as the
    // freeze review's finding 1; a construction-time refusal fails these two.
    const created = await bothEngines("owner", "update", {
      where: { id: 1 },
      data: {
        items: {
          upsert: [
            {
              where: { id: 999 },
              create: { id: 999, name: "fresh" },
              update: { id: { set: 11, increment: 1 } },
            },
          ],
        },
      },
    });
    assert.deepEqual(keys(created.items), [10, 999]);
    const createdNumberKey = await bothEngines("nowner", "update", {
      where: { id: 1 },
      data: {
        items: {
          upsert: [
            {
              where: { id: 999 },
              create: { id: 999, name: "fresh" },
              update: { id: { increment: 1 } },
            },
          ],
        },
      },
    });
    assert.deepEqual(keys(createdNumberKey.nitems), [10, 999]);
  });

  it("answers the shipped sentence for a relation-free root upsert whose key names nothing", async () => {
    // Review note 3: the last bare `Error` reachable from an admitted public
    // request in this family. No relation in the update payload means the
    // found-arm key channel never runs, exactly as shipped.
    await bothEngines(
      "owner",
      "upsert",
      {
        where: { id: 1 },
        create: { id: 1, label: "o" },
        update: { id: {} },
      },
      "QueryEngineError: Unknown update operation: "
    );
  });
});
