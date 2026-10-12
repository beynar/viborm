// engine-04: to-many nested writes run in the engine's fixed clear-first order
// whatever order the caller spells the verbs in; the validator no longer
// refuses an adding verb spelled before a clearing one.
import { s } from "viborm";
import { createMigrationClient } from "viborm/migrations";
import { createClient } from "viborm/sqlite3";

export const meta = {
  id: "engine-04",
  title:
    "To-many verbs spelled adding-first run clear-first instead of being refused",
  plan: "track-a/engine-04",
  needs: [],
  source:
    "docs/architecture/adversarial-review-2026-10-09/evidence/engine/probes/c06-nested-order.mjs (cases 5-7); src/validation/relations/helpers.ts:30; src/query-engine/raptor3/commands/relation-body.ts:53",
};

const post = s.model({
  id: s.int().id().increment(),
  title: s.string(),
  tags: s.toMany(() => tag),
});
const tag = s.model({
  id: s.int().id().increment(),
  name: s.string().unique(),
  posts: s.toMany(() => post),
});
const basket = s.model({
  id: s.int().id().increment(),
  ref: s.string(),
  lines: s.toMany(() => line),
});
const line = s.model({
  id: s.int().id().increment(),
  sku: s.string(),
  basketId: s.int(),
  basket: s
    .toOne(() => basket)
    .fields("basketId")
    .references("id")
    .onDelete("cascade"),
});

const outcome = async (label, expected, run) => {
  try {
    const got = await run();
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    return {
      ok,
      line: `${label}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`,
    };
  } catch (error) {
    return {
      ok: false,
      line: `${label}: threw ${error?.code ?? error?.name} ${String(error?.message).slice(0, 160)}`,
    };
  }
};

export default async function probe() {
  const db = createClient({ schema: { post, tag, basket, line } });
  try {
    await createMigrationClient(db).push();
    const t1 = await db.tag.create({ data: { name: "t1" } });
    const t2 = await db.tag.create({ data: { name: "t2" } });
    const names = (row) => row.tags.map((t) => t.name).sort();

    const p = await db.post.create({
      data: { title: "p", tags: { connect: [{ id: t1.id }] } },
    });
    const swap = await outcome(
      "{connect:[t2], disconnect:[t1]}",
      ["t2"],
      async () =>
        names(
          await db.post.update({
            where: { id: p.id },
            data: {
              tags: { connect: [{ id: t2.id }], disconnect: [{ id: t1.id }] },
            },
            include: { tags: true },
          })
        )
    );

    const b = await db.basket.create({
      data: { ref: "b", lines: { create: [{ sku: "Q" }] } },
      include: { lines: true },
    });
    const replace = await outcome("{create:[R], delete:[Q]}", ["R"], async () =>
      (
        await db.basket.update({
          where: { id: b.id },
          data: {
            lines: { create: [{ sku: "R" }], delete: [{ id: b.lines[0].id }] },
          },
          include: { lines: true },
        })
      ).lines.map((l) => l.sku)
    );

    const spread = { connect: [{ id: t1.id }] };
    const reset = await outcome(
      "{...{connect:[t1]}, set: []}",
      ["t1"],
      async () =>
        names(
          await db.post.update({
            where: { id: p.id },
            data: { tags: { ...spread, set: [] } },
            include: { tags: true },
          })
        )
    );

    const results = [swap, replace, reset];
    return {
      status: results.every((r) => r.ok) ? "pass" : "fail",
      evidence: results.map((r) => r.line).join("; "),
    };
  } finally {
    await db.$disconnect();
  }
}
