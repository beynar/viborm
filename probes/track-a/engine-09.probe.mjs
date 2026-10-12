// engine-09 + platform-15: a scalar in/notIn list is bound as ONE parameter
// (`= ANY($1::type[])` on Postgres, `IN (SELECT value FROM json_each(?))` on
// SQLite), so 40,000 ids no longer hit the bind cap; same-column OR chains are
// rewritten to IN, so SQLite no longer fails at 999 branches. D1 shares the
// SQLite rendering but is not exercised here (no in-process D1).
import { s } from "viborm";
import { instrumentation } from "viborm/instrumentation";
import { createMigrationClient } from "viborm/migrations";
import { createClient as pgliteClient } from "viborm/pglite";
import { createClient as sqliteClient } from "viborm/sqlite3";

export const meta = {
  id: "engine-09",
  title:
    "Large in/notIn lists bind as one parameter; same-column OR chains become IN",
  plan: "track-a/engine-09+platform-15",
  needs: [],
  source:
    "docs/architecture/adversarial-review-2026-10-09/evidence/engine/probes/h03-order-float.mjs (IN lists); platform lane p19/p25 (OR branches); src/drivers/bind-parameter-capacity.ts:14-24",
};

const order = s
  .model({
    id: s.int().id(),
    reference: s.string().unique(),
    customer: s.string(),
    status: s.enum(["new", "paid", "shipped", "cancelled"]).default("new"),
    total: s.number(),
    currency: s.string().default("EUR"),
    items: s.json(),
    notes: s.string().nullable(),
    priority: s.int().default(0),
    archived: s.boolean().default(false),
    shippedAt: s.dateTime().nullable(),
    createdAt: s.dateTime().now(),
    updatedAt: s.dateTime().updatedAt(),
  })
  .map("order");

const ROWS = 12_000;
const LIST = 40_000;
const BRANCHES = [999, 2000];
// The dialect's bound-list form in the rendered SQL.
const SQLITE_LIST = /json_each\s*\(/i;
const PG_LIST = /ANY\s*\(/i;

const attempt = async (label, run, check) => {
  try {
    const value = await run();
    const ok = check(value);
    return { ok, line: `${label}=${value}${ok ? "" : " (wrong)"}` };
  } catch (error) {
    return {
      ok: false,
      line: `${label} threw ${error?.code ?? error?.name}: ${String(error?.message).slice(0, 110)}`,
    };
  }
};

async function run(dialect, marker, make) {
  const statements = [];
  let capture = false;
  const base = make({ order });
  const db = base.$extends(
    instrumentation({
      logging: {
        query: (event) => {
          if (capture)
            statements.push({ n: event.params?.length ?? -1, sql: event.sql });
        },
        includeSql: true,
        includeParams: true,
      },
    })
  );
  try {
    await createMigrationClient(base).push();
    for (let i = 0; i < ROWS; i += 2000)
      await db.order.createMany({
        data: Array.from({ length: 2000 }, (_, k) => ({
          id: i + k + 1,
          reference: `R${i + k + 1}`,
          customer: `c${(i + k) % 97}`,
          total: (i + k) * 1.5,
          items: [{ sku: "A", qty: 1 }],
        })),
      });
    const ids = Array.from({ length: LIST }, (_, i) => i + 1);
    const results = [];
    capture = true;
    results.push(
      await attempt(
        "findMany in 40k",
        async () =>
          (
            await db.order.findMany({
              where: { id: { in: ids } },
              select: { id: true },
            })
          ).length,
        (n) => n === ROWS
      )
    );
    capture = false;
    // One bound list: a few parameters at most, and the dialect's list form in
    // the SQL (inlining 40k literals would bind none and is not the fix).
    const widest = statements.sort((a, b) => b.n - a.n)[0];
    const listForm = marker.test(String(widest?.sql));
    results.push({
      ok: widest?.n >= 1 && widest.n <= 4 && listForm,
      line: widest
        ? `findMany in 40k bound ${widest.n} params, ${marker.source} ${listForm ? "present" : "absent"}`
        : "findMany in 40k executed no statement",
    });
    results.push(
      await attempt(
        "findMany string in 40k",
        async () =>
          (
            await db.order.findMany({
              where: { reference: { in: ids.map((id) => `R${id}`) } },
              select: { id: true },
            })
          ).length,
        (n) => n === ROWS
      )
    );
    results.push(
      await attempt(
        "findMany notIn 40k",
        async () =>
          (
            await db.order.findMany({
              where: { id: { notIn: ids.slice(1) } },
              select: { id: true },
            })
          ).length,
        (n) => n === 1
      )
    );
    results.push(
      await attempt(
        "updateMany in 40k",
        async () =>
          (
            await db.order.updateMany({
              where: { id: { in: ids } },
              data: { priority: 1 },
            })
          ).count,
        (n) => n === ROWS
      )
    );
    for (const branches of BRANCHES)
      results.push(
        await attempt(
          `OR ${branches} same-column`,
          async () =>
            (
              await db.order.findMany({
                where: { OR: ids.slice(0, branches).map((id) => ({ id })) },
                select: { id: true },
              })
            ).length,
          (n) => n === branches
        )
      );
    results.push(
      await attempt(
        "deleteMany in 40k",
        async () =>
          (await db.order.deleteMany({ where: { id: { in: ids } } })).count,
        (n) => n === ROWS
      )
    );
    return {
      ok: results.every((r) => r.ok),
      line: `${dialect}: ${results.map((r) => r.line).join(", ")}`,
    };
  } finally {
    await base.$disconnect();
  }
}

export default async function probe() {
  const sqlite = await run("sqlite", SQLITE_LIST, (schema) =>
    sqliteClient({ schema })
  );
  const pglite = await run("pglite", PG_LIST, (schema) =>
    pgliteClient({ schema })
  );
  return {
    status: sqlite.ok && pglite.ok ? "pass" : "fail",
    evidence: `${sqlite.line}; ${pglite.line}`,
  };
}
