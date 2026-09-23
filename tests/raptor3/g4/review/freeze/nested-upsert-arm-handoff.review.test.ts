/**
 * FREEZE-unit review probe, ROUND 2 — the repaired nested `upsert` refusal,
 * attacked at the places the repair's own cells do not reach.
 *
 * Round 2 moved the nested `upsert`'s key refusal off the construction-time
 * throw and onto the found arm's deferred `Assignments`
 * (`commands/relation-body.ts`, `target.found.command.fields.reject(keyRefusal)`,
 * raised by `Assignments.activate()` at `commands/execution.ts:259`). The
 * author's cells and my `nested-refusal-scope.review.test.ts` both measure a
 * REFERENCE to-many edge, one member per request, under a parent `update`.
 *
 * This probe asks whether the handoff is the same answer as the shipped engine
 * when:
 *
 * - the edge is a JUNCTION or a to-ONE rather than a reference to-many (the
 *   shipped engine states the same predicate at `RelationJunctionPart.ts:2772`,
 *   `:3042` and `RelationJunctionToOnePart.ts:1017`, and neither the author nor
 *   round 1 measured either kind — the unit's unverified claim 2);
 * - ONE request carries both arms: a member whose target is absent (creates)
 *   beside a member whose target is present (refuses), in both orders, so a
 *   refusal raised after the sibling's INSERT has to unwind it;
 * - the same found arm carries a SECOND refusal — `Assignments.reject` keeps
 *   the FIRST failure (`refusal ??= failure`), so a nested-write refusal on the
 *   relation key field and the key-portability refusal compete for the sentence
 *   the caller sees;
 * - the payload is the arity-`none` shape (`{}`) rather than `set` + operator.
 *
 * Every row runs the same request on both engines over the same SQLite data and
 * compares the answer AND every table, so a divergence in which arm ran, in
 * which sentence won, or in what stayed committed is a divergence here.
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

const OWNERS = "g4fz2_owners";
const ITEMS = "g4fz2_items";
const TAGS = "g4fz2_tags";
const LINKS = "g4fz2_links";
const PROFILES = "g4fz2_profiles";

const owner = s
  .model({
    id: s.int().id(),
    label: s.string(),
    items: s.toMany(() => item),
    tags: s
      .toMany(() => tag)
      .through(LINKS)
      .source("ownerId")
      .target("tagId"),
    profile: s.toOne(() => profile),
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
const tag = s
  .model({
    id: s.int().id(),
    name: s.string(),
    owners: s.toMany(() => owner),
  })
  .map(TAGS);
const profile = s
  .model({
    id: s.int().id(),
    nick: s.string(),
    ownerId: s.int().unique().nullable(),
    owner: s
      .toOne(() => owner)
      .fields("ownerId")
      .references("id"),
  })
  .map(PROFILES);
const armSchema = { owner, item, tag, profile };

const SEED = `
  INSERT INTO ${OWNERS} (id,label) VALUES (1,'o'), (2,'o2');
  INSERT INTO ${ITEMS} (id,name,ownerId) VALUES (10,'i',1), (11,'j',1);
  INSERT INTO ${TAGS} (id,name) VALUES (20,'t');
  INSERT INTO ${LINKS} (ownerId,tagId) VALUES (1,20);
  INSERT INTO ${PROFILES} (id,nick,ownerId) VALUES (30,'p',1);
`;

interface Outcome {
  readonly answer: string;
  readonly items: unknown[];
  readonly tags: unknown[];
  readonly links: unknown[];
  readonly profiles: unknown[];
}

async function run(
  engine: "shipped" | "candidate",
  model: keyof typeof armSchema,
  operation: Operations,
  args: unknown
): Promise<Outcome> {
  const database = new Database(":memory:");
  const driver = new SQLite3Driver({ client: database });
  const client = createClient({ schema: armSchema, driver });
  // biome-ignore lint/suspicious/noMisplacedAssertion: helper called only from cells.
  assert.equal((await syncLiveSchema(client)).applied, true);
  database.exec(SEED);
  const candidate = createCommandEngine({ schema: armSchema, driver });
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
  const rows = (table: string): unknown[] =>
    database.prepare(`SELECT * FROM ${table}`).all();
  const outcome: Outcome = {
    answer,
    items: rows(ITEMS),
    tags: rows(TAGS),
    links: rows(LINKS),
    profiles: rows(PROFILES),
  };
  await client.$disconnect();
  database.close();
  return outcome;
}

interface Row {
  readonly label: string;
  readonly model: keyof typeof armSchema;
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
const present = (where: number, create: unknown, update: unknown): unknown => ({
  where: { id: where },
  create,
  update,
});

describe("freeze review round 2 — the nested upsert's found-arm handoff", () => {
  it("answers the shipped engine at a JUNCTION and a to-ONE edge, both arms", async () => {
    const divergences = await compare([
      {
        label: "junction upsert, target PRESENT, int key set+increment",
        model: "owner",
        operation: "update",
        args: {
          where: { id: 1 },
          data: {
            tags: {
              upsert: [present(20, { id: 20, name: "t" }, { id: ARITY })],
            },
          },
        },
      },
      {
        label: "junction upsert, target ABSENT, int key set+increment",
        model: "owner",
        operation: "update",
        args: {
          where: { id: 1 },
          data: {
            tags: {
              upsert: [present(99, { id: 99, name: "fresh" }, { id: ARITY })],
            },
          },
        },
      },
      {
        label: "to-one upsert, target PRESENT, int key set+increment",
        model: "owner",
        operation: "update",
        args: {
          where: { id: 1 },
          data: {
            profile: {
              upsert: { create: { id: 30, nick: "p" }, update: { id: ARITY } },
            },
          },
        },
      },
      {
        label: "to-one upsert, target ABSENT (owner 2 has no profile)",
        model: "owner",
        operation: "update",
        args: {
          where: { id: 2 },
          data: {
            profile: {
              upsert: {
                create: { id: 31, nick: "fresh" },
                update: { id: ARITY },
              },
            },
          },
        },
      },
    ]);
    // biome-ignore lint/suspicious/noMisplacedAssertion: this IS the cell.
    assert.deepEqual(divergences, []);
  });

  it("answers the shipped engine when one request carries BOTH arms", async () => {
    const divergences = await compare([
      {
        label: "two members, ABSENT first then PRESENT (refusal must unwind)",
        model: "owner",
        operation: "update",
        args: {
          where: { id: 1 },
          data: {
            items: {
              upsert: [
                present(999, { id: 999, name: "fresh" }, { name: "kept" }),
                present(10, { id: 10, name: "i" }, { id: ARITY }),
              ],
            },
          },
        },
      },
      {
        label: "two members, PRESENT first then ABSENT",
        model: "owner",
        operation: "update",
        args: {
          where: { id: 1 },
          data: {
            items: {
              upsert: [
                present(10, { id: 10, name: "i" }, { id: ARITY }),
                present(999, { id: 999, name: "fresh" }, { name: "kept" }),
              ],
            },
          },
        },
      },
      {
        label: "two ABSENT members, both refusable payloads (both create)",
        model: "owner",
        operation: "update",
        args: {
          where: { id: 1 },
          data: {
            items: {
              upsert: [
                present(998, { id: 998, name: "a" }, { id: ARITY }),
                present(999, { id: 999, name: "b" }, { id: {} }),
              ],
            },
          },
        },
      },
    ]);
    // biome-ignore lint/suspicious/noMisplacedAssertion: this IS the cell.
    assert.deepEqual(divergences, []);
  });

  it("answers the shipped engine's sentence when TWO refusals compete on one arm", async () => {
    const divergences = await compare([
      {
        label:
          "PRESENT target, relation key non-literal AND key arity violated",
        model: "owner",
        operation: "update",
        args: {
          where: { id: 1 },
          data: {
            items: {
              upsert: [
                present(
                  10,
                  { id: 10, name: "i" },
                  { id: ARITY, ownerId: { increment: 1 } }
                ),
              ],
            },
          },
        },
      },
      {
        label: "PRESENT target, relation key non-literal ALONE",
        model: "owner",
        operation: "update",
        args: {
          where: { id: 1 },
          data: {
            items: {
              upsert: [
                present(
                  10,
                  { id: 10, name: "i" },
                  { ownerId: { increment: 1 } }
                ),
              ],
            },
          },
        },
      },
      {
        label: "ABSENT target, relation key non-literal AND key arity violated",
        model: "owner",
        operation: "update",
        args: {
          where: { id: 1 },
          data: {
            items: {
              upsert: [
                present(
                  999,
                  { id: 999, name: "fresh" },
                  { id: ARITY, ownerId: { increment: 1 } }
                ),
              ],
            },
          },
        },
      },
      {
        label: "PRESENT target, arity NONE (`{}`) on the key",
        model: "owner",
        operation: "update",
        args: {
          where: { id: 1 },
          data: {
            items: {
              upsert: [present(10, { id: 10, name: "i" }, { id: {} })],
            },
          },
        },
      },
      {
        label: "ABSENT target, arity NONE (`{}`) on the key",
        model: "owner",
        operation: "update",
        args: {
          where: { id: 1 },
          data: {
            items: {
              upsert: [present(999, { id: 999, name: "fresh" }, { id: {} })],
            },
          },
        },
      },
    ]);
    // biome-ignore lint/suspicious/noMisplacedAssertion: this IS the cell.
    assert.deepEqual(divergences, []);
  });
});
