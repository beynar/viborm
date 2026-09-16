import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { createModelFieldRefs } from "@schema/field-ref";
import { AnyNull, DbNull, JsonNull } from "@schema/json-null";
import { s } from "@schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";
import {
  closeWorld,
  createWorld,
  schema,
  seedAuthor,
  seedPost,
  type World,
} from "./world";

/**
 * Repair-3 witnesses (review follow-up-2 findings H, I and J). All three are
 * REGISTERED REFUSALS the shipped engine owns, so every witness is
 * DIFFERENTIAL — the two engines are asked the same admitted input over the
 * same SQLite data and must answer the same value or the same message — and
 * every one also pins the shipped sentence ABSOLUTELY, so an agreement cannot
 * pass by both engines being wrong in the same new way.
 */

/** Both engines' outcome for one call: the value answered, or the message thrown. */
async function outcomes(
  seed: (world: World) => void,
  model: string,
  operation: Parameters<World["engine"]["execute"]>[1],
  args: Record<string, unknown>
): Promise<{ shipped: unknown; candidate: unknown }> {
  const shippedWorld = createWorld();
  const candidateWorld = createWorld();
  seed(shippedWorld);
  seed(candidateWorld);
  try {
    const client = createClient({
      schema,
      driver: shippedWorld.driver,
    }) as unknown as Record<string, Record<string, (input: unknown) => unknown>>;
    return {
      shipped: await capture(() => client[model]![operation]!(args)),
      candidate: await capture(() =>
        candidateWorld.engine.execute(model, operation, args)
      ),
    };
  } finally {
    await closeWorld(shippedWorld);
    await closeWorld(candidateWorld);
  }
}

async function capture(run: () => unknown): Promise<unknown> {
  try {
    return { ok: await run() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The thrown message, or a readable failure naming what was answered instead. */
function message(outcome: unknown): string {
  const seen = outcome as { error?: string };
  return seen.error ?? `answered ${JSON.stringify(outcome)}`;
}

function seedPosts(world: World): void {
  seedAuthor(world, { id: 1, author_name: "ada" });
  seedAuthor(world, { id: 2, author_name: "bob" });
  for (const [id, authorId] of [
    [1, 1],
    [2, 1],
    [3, 2],
  ] as [number, number][])
    seedPost(world, { id, author_id: authorId, rank: id });
}

describe("G4-01 repair 3 — the cursor refusal identity (finding H, Q-P01)", () => {
  const ORDERS: [string, string, Record<string, unknown>][] = [
    ["a to-one relation path", "post", { author: { name: "asc" } }],
    ["a collection _count", "author", { posts: { _count: "asc" } }],
  ];

  for (const [label, model, orderBy] of ORDERS)
    it(`words the cursor refusal for ${label} the way the shipped engine does`, async () => {
      const seen = await outcomes(seedPosts, model, "findMany", {
        orderBy,
        cursor: { id: 1 },
        take: 2,
        select: { id: true },
      });
      assert.equal(
        message(seen.candidate),
        message(seen.shipped),
        `${label}\n  candidate ${JSON.stringify(seen.candidate)}\n  shipped   ${JSON.stringify(seen.shipped)}`
      );
      // Absolute: the agreement is on the SHIPPED sentence, not on any sentence.
      assert.equal(
        message(seen.shipped),
        "Cursor pagination supports direct scalar sort directions only; relation and vector-distance orderBy are not supported."
      );
    });

  it("still pages a direct scalar order beside a cursor on both engines", async () => {
    const seen = await outcomes(seedPosts, "post", "findMany", {
      orderBy: { id: "asc" },
      cursor: { id: 1 },
      take: 2,
      select: { id: true },
    });
    assert.deepEqual(seen.candidate, seen.shipped);
    assert.deepEqual(seen.shipped, { ok: [{ id: 1 }, { id: 2 }] });
  });
});

describe("G4-01 repair 3 — the JSON sentinel-with-path refusal (finding I, Q-W05)", () => {
  function seedProfiles(world: World): void {
    seedAuthor(world, { id: 1, profile: '{"a":null}' });
    seedAuthor(world, { id: 2, profile: null });
    seedAuthor(world, { id: 3, profile: "null" });
  }

  for (const [label, sentinel] of [
    ["DbNull", DbNull],
    ["JsonNull", JsonNull],
    ["AnyNull", AnyNull],
  ] as [string, unknown][])
    it(`words the path + ${label} refusal the way the shipped engine does`, async () => {
      const seen = await outcomes(seedProfiles, "author", "findMany", {
        where: { profile: { path: ["a"], equals: sentinel } },
        orderBy: { id: "asc" },
        select: { id: true },
      });
      assert.equal(
        message(seen.candidate),
        message(seen.shipped),
        `${label}\n  candidate ${JSON.stringify(seen.candidate)}\n  shipped   ${JSON.stringify(seen.shipped)}`
      );
      // Absolute: the refusal names the FIELD and the SENTINEL, which is what
      // makes it actionable when several JSON columns share one filter.
      assert.equal(
        message(seen.shipped),
        `JSON filter for field 'profile' cannot combine 'path' with the ${label} sentinel: the sentinels distinguish the database NULL from the JSON null value of the WHOLE column. Use 'path' with 'equals: null' to test for a JSON null at that path.`
      );
    });

  it("still answers a path with a plain equals: null on both engines", async () => {
    const seen = await outcomes(seedProfiles, "author", "findMany", {
      where: { profile: { path: ["a"], equals: null } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    assert.deepEqual(seen.candidate, seen.shipped);
    assert.deepEqual(seen.shipped, { ok: [{ id: 1 }] });
  });

  it("still answers a whole-column sentinel on both engines", async () => {
    for (const [sentinel, expected] of [
      [DbNull, [2]],
      [JsonNull, [3]],
      [AnyNull, [2, 3]],
    ] as [unknown, number[]][]) {
      const seen = await outcomes(seedProfiles, "author", "findMany", {
        where: { profile: { equals: sentinel } },
        orderBy: { id: "asc" },
        select: { id: true },
      });
      assert.deepEqual(seen.candidate, seen.shipped);
      assert.deepEqual(seen.shipped, {
        ok: expected.map((id) => ({ id })),
      });
    }
  });
});

/**
 * Finding J needs two decimal columns of DIFFERENT declared domains, which the
 * unit world does not have, so this witness carries its own two-model world.
 * Every value is written at its own declared scale — what the storage codec
 * produces — so `1.20` and `1.2000` are the SAME decimal and the mismatch is a
 * wrong answer rather than a different spelling.
 */
const ledger = s
  .model({
    id: s.int().id(),
    cents: s.decimal({ precision: 12, scale: 2 }),
    micros: s.decimal({ precision: 12, scale: 4 }),
    alsoCents: s.decimal({ precision: 12, scale: 2 }),
    tally: s.int(),
    otherTally: s.int(),
  })
  .map("g4r3_ledger");

const ledgerSchema = { ledger };
const refs = createModelFieldRefs("ledger", ledger) as Record<string, unknown>;

async function ledgerOutcomes(
  args: Record<string, unknown>
): Promise<{ shipped: unknown; candidate: unknown }> {
  const build = (): { db: Database.Database; driver: SQLite3Driver } => {
    const db = new Database(":memory:");
    db.exec(
      `CREATE TABLE g4r3_ledger(
         id INTEGER PRIMARY KEY,
         cents TEXT NOT NULL,
         micros TEXT NOT NULL,
         alsoCents TEXT NOT NULL,
         tally INTEGER NOT NULL,
         otherTally INTEGER NOT NULL
       );
       INSERT INTO g4r3_ledger VALUES
         (1,'1.20','1.2000','1.20',7,7),
         (2,'2.00','9.0000','3.00',1,2);`
    );
    return { db, driver: new SQLite3Driver({ client: db }) };
  };
  const left = build();
  const right = build();
  try {
    const client = createClient({
      schema: ledgerSchema,
      driver: left.driver,
    }) as unknown as { ledger: { findMany: (input: unknown) => unknown } };
    const engine = createCommandEngine({
      schema: ledgerSchema,
      driver: right.driver,
    });
    return {
      shipped: await capture(() => client.ledger.findMany(args)),
      candidate: await capture(() =>
        engine.execute("ledger", "findMany", args)
      ),
    };
  } finally {
    await left.driver.disconnect();
    left.db.close();
    await right.driver.disconnect();
    right.db.close();
  }
}

describe("G4-01 repair 3 — decimal field-reference domains (finding J, SC-04)", () => {
  const where = (input: Record<string, unknown>) => ({
    where: input,
    orderBy: { id: "asc" },
    select: { id: true },
  });

  it("answers a reference between two decimals of the SAME domain", async () => {
    const seen = await ledgerOutcomes(
      where({ cents: { equals: refs.alsoCents } })
    );
    assert.deepEqual(seen.candidate, seen.shipped);
    assert.deepEqual(seen.shipped, { ok: [{ id: 1 }] });
  });

  it("refuses a reference between two decimals of DIFFERENT domains", async () => {
    const seen = await ledgerOutcomes(where({ cents: { equals: refs.micros } }));
    assert.equal(
      message(seen.candidate),
      message(seen.shipped),
      `candidate ${JSON.stringify(seen.candidate)}\nshipped ${JSON.stringify(seen.shipped)}`
    );
    assert.equal(
      message(seen.shipped),
      "Field reference 'micros' cannot be compared with 'cents' on 'ledger': 'cents' is decimal(12,2) and 'micros' is decimal(12,4). Two decimals compare exactly only when they declare the same precision and scale."
    );
  });

  it("names the two columns in the order the filter asked them", async () => {
    const seen = await ledgerOutcomes(where({ micros: { equals: refs.cents } }));
    assert.equal(message(seen.candidate), message(seen.shipped));
    assert.equal(
      message(seen.shipped),
      "Field reference 'cents' cannot be compared with 'micros' on 'ledger': 'micros' is decimal(12,4) and 'cents' is decimal(12,2). Two decimals compare exactly only when they declare the same precision and scale."
    );
  });

  it("refuses the mismatch under every ordered comparison too", async () => {
    for (const operator of ["lt", "lte", "gt", "gte"]) {
      const seen = await ledgerOutcomes(
        where({ cents: { [operator]: refs.micros } })
      );
      assert.equal(message(seen.candidate), message(seen.shipped), operator);
      assert.match(
        message(seen.shipped),
        /Two decimals compare exactly only when they declare the same precision and scale\.$/
      );
    }
  });

  it("does not refuse a reference between two NON-decimal columns", async () => {
    const seen = await ledgerOutcomes(
      where({ tally: { equals: refs.otherTally } })
    );
    assert.deepEqual(seen.candidate, seen.shipped);
    assert.deepEqual(seen.shipped, { ok: [{ id: 1 }] });
  });

  it("does not refuse a decimal reference inside a negation of the same domain", async () => {
    const seen = await ledgerOutcomes(
      where({ NOT: { cents: { equals: refs.alsoCents } } })
    );
    assert.deepEqual(seen.candidate, seen.shipped);
    assert.deepEqual(seen.shipped, { ok: [{ id: 2 }] });
  });
});
