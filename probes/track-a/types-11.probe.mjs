// types-11 (runtime part): a ValidationError names its model (meta.model), and
// a nested refusal names the failing member instead of the generic
// "did not match any union member" text. Matters for tenant APIs built on
// UntypedClient, whose callers get no model name today. For a nested refusal
// the plan does not choose between the root model and the failing nested one,
// so either is accepted there.
import { s } from "viborm";
import { createMigrationClient } from "viborm/migrations";
import { createClient } from "viborm/sqlite3";

export const meta = {
  id: "types-11",
  title:
    "ValidationError carries meta.model and names the failing union member",
  plan: "track-a/types-11",
  needs: [],
  source:
    "docs/architecture/adversarial-review-2026-10-09/evidence/types/probes/p16-validation-msg.ts; evidence/types/probes/p08-misuse-runtime.ts (C06, C26)",
};

const user = s.model({
  id: s.int().id(),
  email: s.string(),
  age: s.int().nullable(),
  role: s.enum(["a", "b"]),
  posts: s.toMany(() => post),
});
const post = s.model({
  id: s.int().id(),
  title: s.string(),
  authorId: s.int(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
});

const UNION_TEXT = "did not match any union member";

export default async function probe() {
  const db = createClient({ schema: { user, post } });
  try {
    await createMigrationClient(db).push();
    await db.user.create({
      data: {
        id: 1,
        email: "x",
        role: "a",
        posts: { create: [{ id: 1, title: "t" }] },
      },
    });
    const cases = [
      [
        "wrong type",
        ["user"],
        () => db.user.create({ data: { id: 2, email: 5, role: "a" } }),
      ],
      [
        "bad orderBy direction",
        ["user"],
        () => db.user.findMany({ orderBy: { email: "up" } }),
      ],
      [
        "int as string in where",
        ["user"],
        () => db.user.findMany({ where: { age: { gt: "3" } } }),
      ],
      [
        "operator typo beside real",
        ["user"],
        () =>
          db.user.findMany({
            where: { email: { contains: "x", mdoe: "insensitive" } },
          }),
      ],
      [
        "nested update typo",
        ["user", "post"],
        () =>
          db.user.update({
            where: { id: 1 },
            data: {
              posts: {
                update: { where: { id: 1 }, data: { title: "x", titel: "y" } },
              },
            },
          }),
      ],
    ];
    const lines = [];
    let ok = true;
    for (const [label, models, run] of cases) {
      try {
        await run();
        ok = false;
        lines.push(`${label}: no error`);
      } catch (error) {
        const message = String(error?.message);
        const good =
          models.includes(error?.meta?.model) && !message.includes(UNION_TEXT);
        ok &&= good;
        lines.push(
          `${label}: meta.model=${error?.meta?.model} ${error?.code} ${message.slice(0, 110)}`
        );
      }
    }
    return { status: ok ? "pass" : "fail", evidence: lines.join("; ") };
  } finally {
    await db.$disconnect();
  }
}
