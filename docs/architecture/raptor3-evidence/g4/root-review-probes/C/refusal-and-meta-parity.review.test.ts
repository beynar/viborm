/**
 * ROOT REVIEW — Area C, checklist lines C1 (refusal wordings) and C4
 * (RF-15 diagnostic meta).
 *
 * Every row below is an ADMITTED public request that refuses (or must NOT
 * refuse), asked of the shipped public client and of the private route over
 * byte-identical worlds. What is compared is the whole public identity: the
 * error's class NAME, its `code`, its MESSAGE and its `meta` serialized — the
 * four things a caller can branch on. The committed rows are compared too, so
 * a refusal that writes is not mistaken for one that does not.
 *
 * The rows were chosen against the evidence rather than from it: the four
 * decided key-update shapes at the ROOT and at three NESTED positions the
 * freeze-preparation round added, the two positions the freeze note records as
 * UNVERIFIED (a to-one nested update, and the same family on a junction-free
 * to-one edge), the `Unknown update operation:` identity that round restored,
 * the premise (`NotFoundError`) meta the phase-2 round brought to parity, a
 * provider constraint failure, and the two G4-01 refusals whose sentences the
 * repair rounds took from the shipped source.
 */

import assert from "node:assert/strict";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCandidateClient } from "@query-engine/raptor3/route/client-route";
import { s } from "@schema";
import { createModelFieldRefs } from "@schema/field-ref";
import { createClient } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { describe, test } from "vitest";

const owner = s
  .model({
    id: s.int().id(),
    name: s.string(),
    code: s.string().unique(),
    cents: s.decimal({ precision: 12, scale: 2 }),
    micros: s.decimal({ precision: 12, scale: 4 }),
    items: s.toMany(() => item),
    badge: s.toOne(() => badge),
  })
  .map("g4rc_owners");

const item = s
  .model({
    id: s.int().id(),
    label: s.string(),
    ownerId: s.int().nullable(),
    owner: s
      .toOne(() => owner)
      .fields("ownerId")
      .references("id"),
  })
  .map("g4rc_items");

const badge = s
  .model({
    id: s.int().id(),
    tone: s.string(),
    ownerId: s.int().unique().nullable(),
    owner: s
      .toOne(() => owner)
      .fields("ownerId")
      .references("id"),
  })
  .map("g4rc_badges");

const rate = s
  .model({
    id: s.number().id(),
    tag: s.string(),
  })
  .map("g4rc_rates");

const schema = { badge, item, owner, rate };
const ownerRefs = createModelFieldRefs("owner", owner) as Record<
  string,
  unknown
>;

type Answer = {
  answer: string;
  meta: string;
  owners: unknown;
  items: unknown;
};

async function ask(
  route: "shipped" | "candidate",
  model: keyof typeof schema,
  operation: string,
  args: unknown
): Promise<Answer> {
  const database = new Database(":memory:");
  const driver = new SQLite3Driver({ client: database });
  const config = { driver, schema };
  const client =
    route === "shipped" ? createClient(config) : createCandidateClient(config);
  const migration = await syncLiveSchema(client);
  // biome-ignore lint/suspicious/noMisplacedAssertion: helper called only from cells.
  assert.equal(migration.applied, true, "the world's schema applied");
  database.exec(`
    INSERT INTO g4rc_owners (id,name,code,cents,micros)
      VALUES (1,'one','C1','10.00','2.0000'), (2,'two','C2','20.00','4.0000');
    INSERT INTO g4rc_items (id,label,ownerId) VALUES (10,'i10',1);
    INSERT INTO g4rc_badges (id,tone,ownerId) VALUES (100,'gold',1);
    INSERT INTO g4rc_rates (id,tag) VALUES (1.0,'r1');
  `);
  let answer: string;
  let meta = "-";
  try {
    const view = (
      client as unknown as Record<
        string,
        Record<string, (a: unknown) => Promise<unknown>>
      >
    )[model];
    const value = await view![operation]!(args);
    answer = `ok:${JSON.stringify(value)}`;
  } catch (error) {
    const raised = error as Error & { code?: string; meta?: unknown };
    answer = `${raised.constructor.name}|${raised.code ?? "-"}|${raised.message}`;
    // `correlationId` is a fresh UUID per raised error on BOTH routes, so it is
    // normalized away; every other meta key is compared as it is.
    meta = JSON.stringify(raised.meta ?? null).replace(
      /"correlationId":"[^"]*"/,
      '"correlationId":"<uuid>"'
    );
  }
  const owners = database
    .prepare("SELECT id,name,code,cents FROM g4rc_owners ORDER BY id")
    .all();
  const items = database
    .prepare("SELECT id,label,ownerId FROM g4rc_items ORDER BY id")
    .all();
  await client.$disconnect();
  database.close();
  return { answer, items, meta, owners };
}

interface Row {
  readonly name: string;
  readonly model: keyof typeof schema;
  readonly operation: string;
  readonly args: unknown;
}

const ROWS: Row[] = [
  {
    args: { data: { name: "gone" }, where: { id: 999 } },
    model: "owner",
    name: "premise: root update of a missing row (NotFoundError meta)",
    operation: "update",
  },
  {
    args: { where: { id: 999 } },
    model: "owner",
    name: "premise: root delete of a missing row",
    operation: "delete",
  },
  {
    args: { where: { id: 999 } },
    model: "owner",
    name: "premise: findUniqueOrThrow",
    operation: "findUniqueOrThrow",
  },
  {
    args: { where: { name: "absent" } },
    model: "owner",
    name: "premise: findFirstOrThrow",
    operation: "findFirstOrThrow",
  },
  {
    args: { data: { id: { increment: 1, set: 7 } }, where: { id: 1 } },
    model: "owner",
    name: "R-D2 (c) ROOT: set beside increment on the key",
    operation: "update",
  },
  {
    args: { data: { id: { increment: 1 } }, where: { id: 1 } },
    model: "owner",
    name: "an INT key under increment (arithmetic is portable; both engines perform it)",
    operation: "update",
  },
  {
    args: { data: { id: { increment: 1 } }, where: { id: 1 } },
    model: "rate",
    name: "R-D2 (b) ROOT: a NUMBER key under increment",
    operation: "update",
  },
  {
    args: { data: { id: { multiply: 2 } }, where: { id: 1 } },
    model: "rate",
    name: "R-D2 (b) ROOT: a NUMBER key under multiply",
    operation: "update",
  },
  {
    args: { data: { id: { divide: 0 } }, where: { id: 1 } },
    model: "owner",
    name: "an INT key divided by zero",
    operation: "update",
  },
  {
    args: { data: { id: { increment: 1, set: 9 } }, where: { id: 1 } },
    model: "rate",
    name: "R-D2 (c) ROOT on a NUMBER key: arity wins over portability",
    operation: "update",
  },
  {
    args: { data: { id: {} }, where: { id: 1 } },
    model: "owner",
    name: "arity ROOT: the key names no operation",
    operation: "update",
  },
  {
    args: {
      create: { cents: "1.00", code: "C9", id: 9, micros: "1.0000", name: "n" },
      update: { id: {} },
      where: { id: 1 },
    },
    model: "owner",
    name: "root upsert, no relation in the update payload, key names nothing",
    operation: "upsert",
  },
  {
    args: { data: { id: { increment: 1, set: 7 } }, where: { id: 1 } },
    model: "owner",
    name: "R-D2 (c) ROOT updateMany: set beside increment",
    operation: "updateMany",
  },
  {
    args: {
      data: {
        items: {
          update: [
            { data: { id: { increment: 1, set: 11 } }, where: { id: 10 } },
          ],
        },
      },
      where: { id: 1 },
    },
    model: "owner",
    name: "R-D2 (c) NESTED to-many update",
    operation: "update",
  },
  {
    args: {
      data: {
        items: {
          updateMany: [
            { data: { id: { increment: 1, set: 11 } }, where: { id: 10 } },
          ],
        },
      },
      where: { id: 1 },
    },
    model: "owner",
    name: "R-D2 (c) NESTED to-many updateMany member",
    operation: "update",
  },
  {
    args: {
      data: {
        items: {
          upsert: [
            {
              create: { id: 10, label: "i10" },
              update: { id: { increment: 1, set: 11 } },
              where: { id: 10 },
            },
          ],
        },
      },
      where: { id: 1 },
    },
    model: "owner",
    name: "R-D2 (c) NESTED to-many upsert, target PRESENT (found arm)",
    operation: "update",
  },
  {
    args: {
      data: {
        items: {
          upsert: [
            {
              create: { id: 77, label: "fresh" },
              update: { id: { increment: 1, set: 11 } },
              where: { id: 77 },
            },
          ],
        },
      },
      where: { id: 1 },
    },
    model: "owner",
    name: "R-D2 (c) NESTED to-many upsert, target ABSENT (create arm, must NOT refuse)",
    operation: "update",
  },
  {
    args: {
      data: { badge: { update: { data: { id: { increment: 1, set: 5 } } } } },
      where: { id: 1 },
    },
    model: "owner",
    name: "R-D2 (c) NESTED TO-ONE update (freeze note: unverified edge kind)",
    operation: "update",
  },
  {
    args: {
      data: { owner: { update: { data: { id: { increment: 1, set: 5 } } } } },
      where: { id: 10 },
    },
    model: "item",
    name: "R-D2 (c) NESTED parent-held to-one update",
    operation: "update",
  },
  {
    args: {
      data: { cents: "5.00", code: "C1", id: 3, micros: "1.0000", name: "dup" },
    },
    model: "owner",
    name: "provider: a unique constraint violation",
    operation: "create",
  },
  {
    args: {
      select: { id: true },
      where: { cents: { gt: ownerRefs.micros } },
    },
    model: "owner",
    name: "G4-01 finding J: a decimal field reference across domains",
    operation: "findMany",
  },
  {
    args: { data: { cents: { divide: 0 } }, where: { id: 1 } },
    model: "owner",
    name: "divide a decimal column by zero",
    operation: "update",
  },
  {
    args: {
      select: { id: true },
      where: { name: { contains: "o", mode: "insensitive" } },
    },
    model: "owner",
    name: "control: an admitted request that must NOT refuse",
    operation: "findMany",
  },
];

describe("Area C — refusal identity and diagnostic meta, both routes", () => {
  test("every admitted refusal answers one class, code, sentence and meta", async () => {
    const differing: string[] = [];
    for (const row of ROWS) {
      const shipped = await ask("shipped", row.model, row.operation, row.args);
      const candidate = await ask(
        "candidate",
        row.model,
        row.operation,
        row.args
      );
      const same =
        shipped.answer === candidate.answer &&
        shipped.meta === candidate.meta &&
        JSON.stringify(shipped.owners) === JSON.stringify(candidate.owners) &&
        JSON.stringify(shipped.items) === JSON.stringify(candidate.items);
      // biome-ignore lint/suspicious/noConsole: the probe's output IS its receipt.
      console.log(
        [
          `[${row.name}]`,
          `  shipped   ${shipped.answer}`,
          `            meta ${shipped.meta}`,
          `            owners ${JSON.stringify(shipped.owners)} items ${JSON.stringify(shipped.items)}`,
          `  candidate ${candidate.answer}`,
          `            meta ${candidate.meta}`,
          `            owners ${JSON.stringify(candidate.owners)} items ${JSON.stringify(candidate.items)}`,
          `  ${same ? "AGREE" : "DIVERGE"}`,
        ].join("\n")
      );
      if (!same) differing.push(row.name);
    }
    assert.deepEqual(
      differing,
      [],
      "public refusal identities, meta or committed rows that diverge"
    );
  }, 300_000);
});
