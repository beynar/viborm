// engine-10: a sum that overflows to ±Infinity no longer fails the whole
// aggregate / groupBy: the unrelated aggregates of the same call come back,
// and the overflowing field is refused alone or returns its value.
import { s } from "viborm";
import { createMigrationClient } from "viborm/migrations";
import { createClient as pgliteClient } from "viborm/pglite";
import { createClient as sqliteClient } from "viborm/sqlite3";

export const meta = {
  id: "engine-10",
  title:
    "An overflowing _sum does not take the unrelated aggregates down with it",
  plan: "track-a/engine-10",
  needs: [],
  source:
    "docs/architecture/adversarial-review-2026-10-09/lanes/engine.md engine-10 (d-vib.mjs 'aggregate score'); code-check track-a e10-agg.mjs",
};

const reading = s
  .model({
    id: s.int().id(),
    sensor: s.enum(["a", "b"]),
    score: s.number(),
    age: s.int(),
  })
  .map("reading");

async function run(dialect, make) {
  const db = make({ reading });
  const lines = [];
  let ok = true;
  try {
    await createMigrationClient(db).push();
    await db.reading.createMany({
      data: [
        { id: 1, sensor: "a", score: Number.MAX_VALUE, age: 10 },
        { id: 2, sensor: "a", score: Number.MAX_VALUE, age: 20 },
        { id: 3, sensor: "a", score: Number.MAX_VALUE, age: 30 },
      ],
    });
    try {
      const r = await db.reading.aggregate({
        _sum: { score: true },
        _avg: { age: true },
        _count: true,
      });
      const good = r._avg.age === 20 && r._count === 3;
      ok &&= good;
      lines.push(
        `aggregate -> _sum.score=${r._sum.score} _avg.age=${r._avg.age} _count=${r._count}${good ? "" : " (wrong)"}`
      );
    } catch (error) {
      ok = false;
      lines.push(
        `aggregate threw ${error?.code ?? error?.name}: ${String(error?.message).slice(0, 120)}`
      );
    }
    try {
      const [g] = await db.reading.groupBy({
        by: ["sensor"],
        _sum: { score: true },
        _avg: { age: true },
      });
      const good = g?._avg?.age === 20;
      ok &&= good;
      lines.push(
        `groupBy -> _sum.score=${g?._sum?.score} _avg.age=${g?._avg?.age}${good ? "" : " (wrong)"}`
      );
    } catch (error) {
      ok = false;
      lines.push(
        `groupBy threw ${error?.code ?? error?.name}: ${String(error?.message).slice(0, 120)}`
      );
    }
    return { ok, line: `${dialect}: ${lines.join(", ")}` };
  } finally {
    await db.$disconnect();
  }
}

export default async function probe() {
  const sqlite = await run("sqlite", (schema) => sqliteClient({ schema }));
  const pglite = await run("pglite", (schema) => pgliteClient({ schema }));
  return {
    status: sqlite.ok && pglite.ok ? "pass" : "fail",
    evidence: `${sqlite.line}; ${pglite.line}`,
  };
}
