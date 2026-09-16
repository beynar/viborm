/**
 * G4-02 closure repair ROUND 2 — adversarial probes against the NEW authority
 * the round installs for the key-transition refusal:
 *
 *  - the pre-value is now the prepared selector's `facts.keys`
 *    (`shared/query.ts:221`, written only where `prepareScalarPredicate` marks a
 *    column `key: true`), passed at `commands.ts:1203`;
 *  - the child-held reference edge is now read off `RecordCommand.transitions`,
 *    which `RelationBody.relation` pushes (`relation-body.ts:194-201`) — so the
 *    refusal sees exactly the edges the command tree built, and nothing else;
 *  - the arity clause is `edge.pairs.length === 1` (`schema.ts:292-296`).
 *
 * Round 1 of this review measured the two WIDE directions (an `AND`-arm pin and
 * a compound reference key). These cells attack the other side of each new
 * owner: shapes where the command tree builds NO edge (an empty relation array,
 * a junction, a create-arm-only relation), shapes where a pin exists in a
 * spelling `partitionWhereUnique` files differently from
 * `prepareScalarPredicate` (`{ equals }` syntax on the addressable key), the
 * other nested verbs beside the divide, and the refusal's new PLACEMENT (it now
 * runs after the update arm is constructed, so a refusal raised while
 * constructing it wins).
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

/** Single-member reference key, int PK, a non-key unique, and a junction. */
const boxOwner = s
  .model({
    id: s.int().id(),
    code: s.string().unique(),
    label: s.string(),
    items: s.toMany(() => boxItem),
    tags: s
      .toMany(() => boxTag)
      .through("r3c2_owner_tags")
      .source("ownerId")
      .target("tagId"),
  })
  .map("r3c2_owners");
const boxItem = s
  .model({
    id: s.int().id(),
    label: s.string(),
    holderId: s.int().nullable(),
    holder: s
      .toOne(() => boxOwner)
      .fields("holderId")
      .references("id"),
  })
  .map("r3c2_items");
const boxTag = s
  .model({
    id: s.int().id(),
    label: s.string(),
    owners: s.toMany(() => boxOwner),
  })
  .map("r3c2_tags");

const probeSchema = { boxOwner, boxItem, boxTag };

const SEED = `
  INSERT INTO r3c2_owners (id,code,label) VALUES (6,'c6','o');
  INSERT INTO r3c2_items (id,label,holderId) VALUES (70,'i','6');
  INSERT INTO r3c2_tags (id,label) VALUES (5,'t');
`;

type ModelName = keyof typeof probeSchema;

interface Outcome {
  readonly answer: string;
  readonly owners: unknown[];
  readonly items: unknown[];
  readonly links: unknown[];
}

async function run(
  model: ModelName,
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
  const owners = database.prepare("SELECT * FROM r3c2_owners").all();
  const items = database.prepare("SELECT * FROM r3c2_items").all();
  const links = database.prepare("SELECT * FROM r3c2_owner_tags").all();
  await client.$disconnect();
  database.close();
  return { answer, owners, items, links };
}

async function both(
  model: ModelName,
  args: Record<string, unknown>,
  operation: "upsert" | "update" = "upsert"
): Promise<{ shipped: Outcome; candidate: Outcome }> {
  const shipped = await run(model, operation, args, "shipped");
  const candidate = await run(model, operation, args, "candidate");
  return { shipped, candidate };
}

function assertSame(
  name: string,
  pair: { shipped: Outcome; candidate: Outcome }
) {
  // biome-ignore lint/suspicious/noConsole: the probe's measurement IS its output.
  console.log(
    `[${name}]\n  shipped   ${pair.shipped.answer}\n            owners ${JSON.stringify(pair.shipped.owners)} items ${JSON.stringify(pair.shipped.items)} links ${JSON.stringify(pair.shipped.links)}\n  candidate ${pair.candidate.answer}\n            owners ${JSON.stringify(pair.candidate.owners)} items ${JSON.stringify(pair.candidate.items)} links ${JSON.stringify(pair.candidate.links)}`
  );
  assert.deepEqual(
    pair.candidate,
    pair.shipped,
    `${name}\ncandidate ${JSON.stringify(pair.candidate)}\nshipped   ${JSON.stringify(pair.shipped)}`
  );
}

const divide = { divide: 0 };

describe("G4-02 closure round 2 review — the transition owner's boundaries", () => {
  it("pins the key from an `{ equals }` selector the way shipped does (row present)", async () => {
    // `partitionWhereUnique` files the addressable key under `entries` with its
    // RAW value — `{ equals: 6 }`, not `6` — while `prepareScalarPredicate`
    // unwraps the equality and marks `facts.keys`. If the two disagree, the
    // candidate names a post-transition value the shipped engine cannot.
    assertSame(
      "equals-syntax pin, row present",
      await both("boxOwner", {
        where: { id: { equals: 6 } },
        create: { id: 6, code: "c6", label: "fresh" },
        update: { id: divide, items: { create: [{ id: 1, label: "n" }] } },
      })
    );
  });

  it("pins the key from an `{ equals }` selector the way shipped does (row ABSENT)", async () => {
    assertSame(
      "equals-syntax pin, row absent",
      await both("boxOwner", {
        where: { id: { equals: 404 } },
        create: { id: 404, code: "c404", label: "fresh" },
        update: { id: divide, items: { create: [{ id: 1, label: "n" }] } },
      })
    );
  });

  it("answers an EMPTY relation array beside the divide the way shipped does (row present)", async () => {
    // The command tree calls `RelationBody.relation` once per entry, so an empty
    // array builds no edge and pushes no transition. The shipped compiler builds
    // the relation PART from the payload key, not from its entries.
    assertSame(
      "empty create array, row present",
      await both("boxOwner", {
        where: { id: 6 },
        create: { id: 6, code: "c6", label: "fresh" },
        update: { id: divide, items: { create: [] } },
      })
    );
  });

  it("answers an EMPTY relation array beside the divide the way shipped does (row ABSENT)", async () => {
    assertSame(
      "empty create array, row absent",
      await both("boxOwner", {
        where: { id: 404 },
        create: { id: 404, code: "c404", label: "fresh" },
        update: { id: divide, items: { create: [] } },
      })
    );
  });

  it("answers a child-held DISCONNECT beside the divide the way shipped does", async () => {
    assertSame(
      "child-held disconnect beside the divide",
      await both("boxOwner", {
        where: { id: 6 },
        create: { id: 6, code: "c6", label: "fresh" },
        update: { id: divide, items: { disconnect: [{ id: 70 }] } },
      })
    );
  });

  it("answers a child-held SET beside the divide the way shipped does", async () => {
    assertSame(
      "child-held set beside the divide",
      await both("boxOwner", {
        where: { id: 6 },
        create: { id: 6, code: "c6", label: "fresh" },
        update: { id: divide, items: { set: [{ id: 70 }] } },
      })
    );
  });

  it("answers a child-held UPDATE beside the divide the way shipped does", async () => {
    assertSame(
      "child-held update beside the divide",
      await both("boxOwner", {
        where: { id: 6 },
        create: { id: 6, code: "c6", label: "fresh" },
        update: {
          id: divide,
          items: { update: [{ where: { id: 70 }, data: { label: "u" } }] },
        },
      })
    );
  });

  it("answers a JUNCTION relation beside the divide the way shipped does", async () => {
    // A junction edge is never a child-held reference, so the command tree
    // pushes no transition. The shipped engine's junction part reads the
    // parent's post-transition key too.
    assertSame(
      "junction connect beside the divide",
      await both("boxOwner", {
        where: { id: 6 },
        create: { id: 6, code: "c6", label: "fresh" },
        update: { id: divide, tags: { connect: [{ id: 5 }] } },
      })
    );
  });

  it("answers a relation named only in the CREATE arm the way shipped does (row present)", async () => {
    assertSame(
      "create-arm relation, row present",
      await both("boxOwner", {
        where: { id: 6 },
        create: {
          id: 6,
          code: "c6",
          label: "fresh",
          items: { create: [{ id: 2, label: "c" }] },
        },
        update: { id: divide },
      })
    );
  });

  it("answers a relation named only in the CREATE arm the way shipped does (row ABSENT)", async () => {
    assertSame(
      "create-arm relation, row absent",
      await both("boxOwner", {
        where: { id: 404 },
        create: {
          id: 404,
          code: "c404",
          label: "fresh",
          items: { create: [{ id: 2, label: "c" }] },
        },
        update: { id: divide },
      })
    );
  });

  it("answers a NON-KEY unique locator beside the divide the way shipped does (row present)", async () => {
    // `code` is the discriminator; the primary key is not pinned at all, so
    // neither engine can name the post-transition value at analysis.
    assertSame(
      "non-key unique locator, row present",
      await both("boxOwner", {
        where: { code: "c6" },
        create: { id: 6, code: "c6", label: "fresh" },
        update: { id: divide, items: { create: [{ id: 1, label: "n" }] } },
      })
    );
  });

  it("answers a NON-KEY unique locator beside the divide the way shipped does (row ABSENT)", async () => {
    assertSame(
      "non-key unique locator, row absent",
      await both("boxOwner", {
        where: { code: "nope" },
        create: { id: 99, code: "nope", label: "fresh" },
        update: { id: divide, items: { create: [{ id: 1, label: "n" }] } },
      })
    );
  });

  it("orders the transition refusal against a malformed nested create the way shipped does", async () => {
    // The refusal now runs AFTER the update arm is constructed, so any refusal
    // raised while constructing it wins. The shipped compiler validates the
    // nested payload at admission, before the compiler runs at all.
    assertSame(
      "malformed nested create beside the divide",
      await both("boxOwner", {
        where: { id: 6 },
        create: { id: 6, code: "c6", label: "fresh" },
        update: {
          id: divide,
          items: { create: [{ id: "not-an-int", label: "n" }] },
        },
      })
    );
  });

  it("answers a CONNECT of a missing child beside the divide the way shipped does", async () => {
    assertSame(
      "connect of a missing child beside the divide",
      await both("boxOwner", {
        where: { id: 6 },
        create: { id: 6, code: "c6", label: "fresh" },
        update: { id: divide, items: { connect: [{ id: 999 }] } },
      })
    );
  });
});
