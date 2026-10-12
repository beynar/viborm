// engine-14 + types-10 (runtime part): caller-input mistakes are refused as
// ValidationError V4001 carrying the operator path, not as V9001 ("a bug;
// please report it") or V2001; a sentinel in filter position is refused the
// same way, not reported through its internal `kind` key.
import { DbNull, JsonNull, s } from "viborm";
import { createMigrationClient } from "viborm/migrations";
import { createClient } from "viborm/sqlite3";

export const meta = {
  id: "engine-14",
  title: "Caller-input refusals are V4001 with the operator path",
  plan: "track-a/engine-14+types-10",
  needs: [],
  source:
    "docs/architecture/adversarial-review-2026-10-09/evidence/engine/probes/f07-json-null.mjs; evidence/types/probes/p08-misuse-runtime.ts (C44, C45, C47); src/query-engine/raptor3/shared/query.ts:3203",
};

const user = s.model({
  id: s.int().id(),
  email: s.string().unique(),
  role: s.enum(["USER", "ADMIN"]).default("USER"),
  meta: s.json().nullable(),
});

const hasIssueAt = (error, path) =>
  (error?.issues ?? []).some(
    (issue) => issue.path === path || String(issue.path).startsWith(`${path}.`)
  );

export default async function probe() {
  const db = createClient({ schema: { user } });
  try {
    await createMigrationClient(db).push();
    await db.user.createMany({
      data: [
        { id: 1, email: "a@x", meta: DbNull },
        { id: 2, email: "b@x", meta: { a: 1 } },
      ],
    });
    const cases = [
      [
        "path + JsonNull",
        "where.meta",
        () =>
          db.user.findMany({
            where: { meta: { path: ["a"], equals: JsonNull } },
          }),
      ],
      ["groupBy by: []", "by", () => db.user.groupBy({ by: [] })],
      [
        "groupBy orderBy outside by",
        "orderBy",
        () => db.user.groupBy({ by: ["role"], orderBy: { email: "asc" } }),
      ],
      [
        "createMany select: {}",
        "select",
        () =>
          db.user.createMany({ data: [{ id: 3, email: "c@x" }], select: {} }),
      ],
      [
        "where {meta: DbNull}",
        "where.meta",
        () => db.user.findMany({ where: { meta: DbNull } }),
      ],
    ];
    const lines = [];
    let ok = true;
    for (const [label, path, run] of cases) {
      try {
        await run();
        ok = false;
        lines.push(`${label}: no error`);
      } catch (error) {
        // No refusal may leak an internal key such as a sentinel's `kind`.
        const good =
          error?.code === "V4001" &&
          hasIssueAt(error, path) &&
          !String(error?.message).includes("kind");
        ok &&= good;
        lines.push(
          `${label}: ${error?.code} ${String(error?.message).slice(0, 90)}`
        );
      }
    }
    return { status: ok ? "pass" : "fail", evidence: lines.join("; ") };
  } finally {
    await db.$disconnect();
  }
}
