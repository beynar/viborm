/**
 * FREEZE-unit review probe — is the NEW nested key refusal the shipped
 * predicate at the shipped POSITIONS, or is it wider?
 *
 * The freeze unit answered decisions-review finding 1 by asking
 * `EngineSchema.keyPortabilityRefusal` at two new call sites in
 * `commands/relation-body.ts` — the `connect`/`connectOrCreate`/`upsert`/
 * `update` arm (over `conditional.update` / `conditional.data`) and the
 * `updateMany`/`deleteMany` member loop (over `input.data`). Both are asked
 * during CONSTRUCTION, before anything is located.
 *
 * The shipped engine does not assert at construction everywhere:
 *
 * - `RelationUpsertPart.ts:1006` builds `updateLegality` as a CLOSURE and
 *   `:468` calls it only inside the FOUND arm, so a nested upsert whose target
 *   is absent creates its row and never judges the update payload (the same
 *   shape `EngineSchema.keyPortabilityRefusal`'s own docblock says a wider
 *   placement would break at the root: "an upsert that CREATES a row the
 *   arithmetic never touches");
 * - `NestedSelectedRecordSeries.ts:226` asserts per LOCATED row for a
 *   `replayPerRecord` member;
 * - at the ROOT, `UpsertOperation.ts:496` gates `updateLegality` on
 *   `updateHasRelations`, so a relation-free root upsert judges nothing on
 *   either engine.
 *
 * Every cell runs the same request on both engines over the same SQLite data
 * and compares the answer AND the rows, so a refusal the shipped engine does
 * not raise shows up as a divergence rather than as an opinion.
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

const OWNERS = "g4fz_owners";
const ITEMS = "g4fz_items";
const NOWNERS = "g4fz_nowners";
const NITEMS = "g4fz_nitems";

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
const freezeSchema = { owner, item, nowner, nitem };

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
  model: keyof typeof freezeSchema,
  operation: Operations,
  args: unknown
): Promise<Outcome> {
  const database = new Database(":memory:");
  const driver = new SQLite3Driver({ client: database });
  const client = createClient({ schema: freezeSchema, driver });
  // biome-ignore lint/suspicious/noMisplacedAssertion: helper called only from cells.
  assert.equal((await syncLiveSchema(client)).applied, true);
  database.exec(SEED);
  const candidate = createCommandEngine({ schema: freezeSchema, driver });
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

interface Row {
  readonly label: string;
  readonly model: keyof typeof freezeSchema;
  readonly operation: Operations;
  readonly args: unknown;
}

async function compare(rows: readonly Row[]): Promise<string[]> {
  const divergences: string[] = [];
  for (const row of rows) {
    const shipped = await run("shipped", row.model, row.operation, row.args);
    const candidate = await run(
      "candidate",
      row.model,
      row.operation,
      row.args
    );
    const same =
      JSON.stringify(shipped) === JSON.stringify(candidate)
        ? "AGREE"
        : "DIFFER";
    // biome-ignore lint/suspicious/noConsole: the probe's measurement IS its output.
    console.log(
      `${same}  ${row.label}\n    shipped   ${JSON.stringify(shipped)}\n    candidate ${JSON.stringify(candidate)}`
    );
    if (same === "DIFFER") divergences.push(row.label);
  }
  return divergences;
}

const ARITY = { set: 11, increment: 1 };

describe("freeze review — nested key refusal SCOPE", () => {
  it("is not wider than the shipped predicate at the nested upsert's create arm", async () => {
    const divergences = await compare([
      {
        label: "nested upsert, target ABSENT, int key set+increment",
        model: "owner",
        operation: "update",
        args: {
          where: { id: 1 },
          data: {
            items: {
              upsert: [
                {
                  where: { id: 999 },
                  create: { id: 999, name: "fresh" },
                  update: { id: ARITY },
                },
              ],
            },
          },
        },
      },
      {
        label: "nested upsert, target ABSENT, number key increment",
        model: "nowner",
        operation: "update",
        args: {
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
        },
      },
      {
        label: "nested upsert, target PRESENT, int key set+increment (control)",
        model: "owner",
        operation: "update",
        args: {
          where: { id: 1 },
          data: {
            items: {
              upsert: [
                {
                  where: { id: 10 },
                  create: { id: 10, name: "i" },
                  update: { id: ARITY },
                },
              ],
            },
          },
        },
      },
    ]);
    // biome-ignore lint/suspicious/noMisplacedAssertion: this IS the cell.
    assert.deepEqual(divergences, []);
  });

  it("is not wider than the shipped predicate for an unmatched nested updateMany or a missing nested update target", async () => {
    const divergences = await compare([
      {
        label:
          "nested updateMany, where matches NOTHING, int key set+increment",
        model: "owner",
        operation: "update",
        args: {
          where: { id: 1 },
          data: {
            items: {
              updateMany: [{ where: { id: 999 }, data: { id: ARITY } }],
            },
          },
        },
      },
      {
        label: "nested update, target ABSENT, int key set+increment",
        model: "owner",
        operation: "update",
        args: {
          where: { id: 1 },
          data: {
            items: {
              update: [{ where: { id: 999 }, data: { id: ARITY } }],
            },
          },
        },
      },
      {
        label: "nested updateMany, where matches NOTHING, number key increment",
        model: "nowner",
        operation: "update",
        args: {
          where: { id: 1 },
          data: {
            items: {
              updateMany: [
                { where: { id: 999 }, data: { id: { increment: 1 } } },
              ],
            },
          },
        },
      },
    ]);
    // biome-ignore lint/suspicious/noMisplacedAssertion: this IS the cell.
    assert.deepEqual(divergences, []);
  });

  it("measures whether `set` still wins beside an operator at a RELATION-FREE root upsert", async () => {
    // The guide's new absolute (`raptor3/AGENTS.md`, decisions block): "So
    // `set` never wins over an accompanying operator at any position an
    // admitted request reaches". The root upsert's key gate is asked only when
    // the update payload names relations, on BOTH engines
    // (`UpsertOperation.ts:496` / `commands.ts:1238`), so this row measures
    // what a relation-free root upsert actually answers.
    const divergences = await compare([
      {
        label: "root upsert, relation-free update, int key set+increment",
        model: "owner",
        operation: "upsert",
        args: {
          where: { id: 1 },
          create: { id: 1, label: "o" },
          update: { id: ARITY },
        },
      },
      {
        label: "root upsert, relation-free update, number key increment",
        model: "nowner",
        operation: "upsert",
        args: {
          where: { id: 1 },
          create: { id: 1, label: "o" },
          update: { id: { increment: 1 } },
        },
      },
      {
        label: "root upsert, update NAMES a relation, int key set+increment",
        model: "owner",
        operation: "upsert",
        args: {
          where: { id: 1 },
          create: { id: 1, label: "o" },
          update: {
            id: ARITY,
            items: { update: [{ where: { id: 10 }, data: { name: "x" } }] },
          },
        },
      },
    ]);
    // biome-ignore lint/suspicious/noMisplacedAssertion: this IS the cell.
    assert.deepEqual(divergences, []);
  });
});
