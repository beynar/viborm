// engine-11 (documentation item: plan §7 lists no engine-11 behaviour change,
// so the current semantics are documented): relation
// `isNot: P` means NOT(is: P), so a related row whose compared field is NULL
// DOES match. This pins the behaviour the 1.2.0 docs describe
// (relations-to-one.mdx, compatibility.mdx); if it changes, the docs must too.
import { s } from "viborm";
import { createMigrationClient } from "viborm/migrations";
import { createClient } from "viborm/sqlite3";

export const meta = {
  id: "engine-11",
  title:
    "Relation isNot keeps NULL-valued related rows (documented two-valued meaning)",
  plan: "track-a/engine-11",
  needs: [],
  source:
    "docs/architecture/adversarial-review-2026-10-09/lanes/engine.md engine-11; code-check track-a e11-isnot.mjs",
};

const user = s.model({
  id: s.int().id(),
  name: s.string().nullable(),
  comments: s.toMany(() => comment),
});
const comment = s.model({
  id: s.int().id(),
  body: s.string(),
  authorId: s.int(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
});

export default async function probe() {
  const db = createClient({ schema: { user, comment } });
  try {
    await createMigrationClient(db).push();
    await db.user.createMany({
      data: [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
        { id: 3, name: null },
      ],
    });
    await db.comment.createMany({
      data: [
        { id: 1, body: "a", authorId: 1 },
        { id: 2, body: "b", authorId: 2 },
        { id: 3, body: "c", authorId: 3 },
      ],
    });
    const ids = async (where, model = db.comment) =>
      (
        await model.findMany({
          where,
          select: { id: true },
          orderBy: { id: "asc" },
        })
      ).map((r) => r.id);
    const isNot = await ids({ author: { isNot: { name: "Alice" } } });
    const notIs = await ids({ NOT: { author: { is: { name: "Alice" } } } });
    const rootNot = await ids({ NOT: { name: "Alice" } }, db.user);
    const documented =
      JSON.stringify(isNot) === "[2,3]" && JSON.stringify(notIs) === "[2,3]";
    return {
      status: documented ? "pass" : "fail",
      evidence: `comment author isNot {name:'Alice'} -> ${JSON.stringify(isNot)}; NOT {author:{is}} -> ${JSON.stringify(notIs)}; user root NOT {name:'Alice'} -> ${JSON.stringify(rootNot)}`,
    };
  } finally {
    await db.$disconnect();
  }
}
