/**
 * Independent review probe — G4-02 DECISIONS unit.
 *
 * The private guide now says, as a contract: "`set` never wins over an
 * accompanying operator ANYWHERE." The shipped engine states its key-update
 * predicate in many places — the root validator AND every nested child-update
 * compile site (`RelationWritePart.ts:856`, `:898`,
 * `RecordUpdateCompiler.ts:1794`, `:3770`, `:3944`, `RelationUpsertPart.ts:1008`,
 * `RelationJunctionPart.ts:2772`, `:3042`, `NestedSelectedRecordSeries.ts:226`).
 * The candidate states it in two (`EngineSchema.admit` and the upsert found-arm
 * channel). This probe measures the difference on the shapes that reach a
 * NESTED child key update, so "anywhere" is a measurement rather than a phrase.
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

const OWNERS = "g4r2d_nk_owners";
const ITEMS = "g4r2d_nk_items";

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
const schema = { owner, item };

const SEED = `
  INSERT INTO ${OWNERS} (id,label) VALUES (1,'o');
  INSERT INTO ${ITEMS} (id,name,ownerId) VALUES (10,'i',1);
`;

async function run(
  engine: "shipped" | "candidate",
  model: keyof typeof schema,
  operation: Operations,
  args: unknown
) {
  const database = new Database(":memory:");
  const driver = new SQLite3Driver({ client: database });
  const client = createClient({ schema, driver });
  // biome-ignore lint/suspicious/noMisplacedAssertion: helper called only from cells.
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
        : await candidate.execute(model, operation, args);
    answer = `ok:${JSON.stringify(value)}`;
  } catch (error) {
    answer = `${(error as Error).constructor.name}: ${(error as Error).message}`;
  }
  const items = database.prepare(`SELECT * FROM ${ITEMS} ORDER BY id`).all();
  const owners = database.prepare(`SELECT * FROM ${OWNERS} ORDER BY id`).all();
  await client.$disconnect();
  database.close();
  return { answer, items, owners };
}

describe("G4-02 decisions review — the key-update predicate at NESTED sites", () => {
  it("records what each engine answers for a nested child key update", async () => {
    const cases: [string, keyof typeof schema, Operations, unknown][] = [
      [
        "nested child update: set beside increment on the child's KEY",
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
      ],
      [
        "nested child update: the child's key names NOTHING",
        "owner",
        "update",
        {
          where: { id: 1 },
          data: {
            items: { update: [{ where: { id: 10 }, data: { id: {} } }] },
          },
        },
      ],
      [
        "nested child upsert: set beside increment on the child's KEY",
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
      ],
      [
        "nested updateMany member: set beside increment on the child's KEY",
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
      ],
      [
        "root update: an UNKNOWN member beside one operator",
        "owner",
        "update",
        { where: { id: 1 }, data: { id: { increment: 1, nope: 2 } } },
      ],
    ];
    const differing: string[] = [];
    for (const [name, model, operation, args] of cases) {
      const shipped = await run("shipped", model, operation, args);
      const candidate = await run("candidate", model, operation, args);
      const same =
        shipped.answer === candidate.answer &&
        JSON.stringify(shipped.items) === JSON.stringify(candidate.items) &&
        JSON.stringify(shipped.owners) === JSON.stringify(candidate.owners);
      // biome-ignore lint/suspicious/noConsole: the probe's output IS its receipt.
      console.log(
        `[${name}]\n  shipped   ${shipped.answer}\n            items ${JSON.stringify(shipped.items)} owners ${JSON.stringify(shipped.owners)}\n  candidate ${candidate.answer}\n            items ${JSON.stringify(candidate.items)} owners ${JSON.stringify(candidate.owners)}\n  ${same ? "AGREE" : "DIVERGE"}`
      );
      if (!same) differing.push(name);
    }
    assert.deepEqual(differing, [], "nested key-update shapes that diverge");
  }, 180_000);
});
