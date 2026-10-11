// S11: SQLite rebuilds refuse instead of losing things. Before any effect, a
// table recreation must refuse BY NAME a trigger on the rebuilt table, a view
// whose SQL references it, and a trigger on another table whose SQL references
// it; and a TEXT -> INTEGER change must refuse a value that does not convert
// exactly ('twelve'), while an all-numeric column still converts (control).
import { join } from "node:path";
import Database from "better-sqlite3";
import { s } from "viborm";
import {
  createMigrationClient,
  isMigrationError,
  lenientResolver,
} from "viborm/migrations";
import { createFsStorageWriter } from "viborm/migrations/storage/fs";
import { createClient } from "viborm/sqlite3";

export const meta = {
  id: "S11",
  title:
    "SQLite rebuilds refuse triggers, views and inexact type changes by name",
  plan: "phase-1/lane-L/S11",
  needs: [],
  source:
    "docs/architecture/migrations-durable-objects-review-2026-10-09 FI-05/FI-06 (evidence/fault-injection/probes/p11-tamper.mjs, p04-midfail.mjs); completion-plan-2026-10/code-check-probes/migrations-sqlite/probes/rebuild-probe.mjs; src/migrations/drivers/sqlite/index.ts:255-276,482-700",
};

const ROWS = 10_000;

const schema = (change) =>
  s.model({
    id: s.string().id(),
    sku: s.string().unique(),
    label: change === "nullable" ? s.string().nullable() : s.string(),
    qty: change === "int" ? s.int() : s.string(),
    status: s.enum(["draft", "active", "archived"]),
    price: s.int(),
    stock: s.int().default(0),
    attributes: s.json().nullable(),
    weight: s.number().nullable(),
    note: s.string().nullable(),
    createdAt: s.dateTime().now(),
    updatedAt: s.dateTime().updatedAt(),
  });

const audit = () =>
  s.model({
    id: s.string().id(),
    message: s.string(),
    createdAt: s.dateTime().now(),
  });

const catalog = (db) =>
  db
    .prepare(
      `SELECT type || ':' || name AS o FROM sqlite_master WHERE type IN ('trigger', 'view') ORDER BY 1`
    )
    .all()
    .map((row) => row.o);

/**
 * v1 with ROWS items (qty '1'..; one 'twelve' when `badValue`), the user's
 * extra objects, then v2 generated with `change`; applies v2 and reports.
 */
async function scenario(tmpDir, name, { objects = [], change, badValue }) {
  const dir = join(tmpDir, name);
  const dbPath = join(dir, "db.sqlite");
  const storage = createFsStorageWriter(join(dir, "estate"));
  const v1 = createClient({
    schema: { item: schema(), audit: audit() },
    dataDir: dbPath,
  });
  try {
    await createMigrationClient(v1, { storage }).generate({ name: "v1" });
    await createMigrationClient(v1, { storage }).apply();
    for (let start = 0; start < ROWS; start += 1000) {
      await v1.item.createMany({
        data: Array.from({ length: 1000 }, (_, k) => {
          const i = start + k;
          return {
            id: `item-${i}`,
            sku: `SKU-${i}`,
            label: `Item ${i}`,
            qty: badValue && i === ROWS - 1 ? "twelve" : String(i % 500),
            status: "active",
            price: 100 + (i % 50),
            attributes: { color: "red" },
          };
        }),
      });
    }
  } finally {
    await v1.$disconnect();
  }
  const raw = new Database(dbPath);
  for (const statement of objects) raw.exec(statement);
  const objectsBefore = catalog(raw);
  raw.close();

  const v2 = createClient({
    schema: { item: schema(change), audit: audit() },
    dataDir: dbPath,
  });
  const result = { name };
  try {
    const migrations = createMigrationClient(v2, { storage });
    // Destructive changes (string->int) are approved here so only apply-time
    // behaviour is measured, not generate's consent gate (S13).
    const generated = await migrations.generate({
      name: "v2",
      resolve: lenientResolver,
    });
    result.recreates = generated.sql.includes("__new_item");
    try {
      result.outcome = (await migrations.apply()).outcome;
      result.verify = (await migrations.verify()).ok;
    } catch (error) {
      result.error = error;
      result.outcome = `${isMigrationError(error) ? "MigrationError" : error?.name}/${error?.code}: ${String(error?.message).slice(0, 140)}`;
    }
  } finally {
    await v2.$disconnect();
  }
  const after = new Database(dbPath, { readonly: true });
  try {
    result.objectsBefore = objectsBefore;
    result.objectsAfter = catalog(after);
    result.qtyTypes = after
      .prepare(
        `SELECT typeof("qty") AS t, count(*) AS n FROM "item" GROUP BY 1 ORDER BY 1`
      )
      .all()
      .map((row) => `${row.t}:${row.n}`);
    result.labelRequired =
      after
        .prepare(
          `SELECT "notnull" AS n FROM pragma_table_info('item') WHERE name = 'label'`
        )
        .get().n === 1;
  } finally {
    after.close();
  }
  return result;
}

/** Refused with a MigrationError whose message names `object`, and nothing changed. */
const refusedByName = (result, object) =>
  isMigrationError(result.error) &&
  String(result.error.message).includes(object) &&
  result.labelRequired &&
  result.objectsAfter.join() === result.objectsBefore.join();

const describe = (result) =>
  `${result.name}: recreates=${result.recreates} apply=${result.outcome}${result.verify === undefined ? "" : ` verify=${result.verify}`}; triggers/views ${result.objectsBefore.join(",") || "-"} -> ${result.objectsAfter.join(",") || "-"}; qty ${result.qtyTypes.join(",")}`;

export default async function probe(ctx) {
  const failures = [];
  const lines = [];

  const named = [
    {
      name: "trigger-on-table",
      object: "item_audit",
      objects: [
        `CREATE TRIGGER "item_audit" AFTER UPDATE ON "item" BEGIN INSERT INTO "audit" ("id", "message") VALUES (NEW."id" || '-' || random(), 'updated'); END`,
      ],
    },
    {
      name: "view-on-table",
      object: "item_labels",
      objects: [
        `CREATE VIEW "item_labels" AS SELECT "id", "label" FROM "item"`,
      ],
    },
    {
      name: "trigger-referencing-table",
      object: "audit_touches_item",
      objects: [
        `CREATE TRIGGER "audit_touches_item" AFTER INSERT ON "audit" BEGIN UPDATE "item" SET "stock" = "stock" + 1 WHERE "id" = NEW."message"; END`,
      ],
    },
  ];
  for (const item of named) {
    const result = await scenario(ctx.tmpDir, item.name, {
      objects: item.objects,
      change: "nullable",
    });
    lines.push(describe(result));
    if (!refusedByName(result, item.object)) {
      failures.push(
        `${item.name}: not refused by name "${item.object}" before effects`
      );
    }
  }

  const bad = await scenario(ctx.tmpDir, "text-to-int-twelve", {
    change: "int",
    badValue: true,
  });
  lines.push(describe(bad));
  const untouched = bad.qtyTypes.join() === `text:${ROWS}`;
  if (!(bad.error && untouched)) {
    failures.push(
      `TEXT->INTEGER with 'twelve' not refused before effects (qty ${bad.qtyTypes.join(",")})`
    );
  }

  const good = await scenario(ctx.tmpDir, "text-to-int-numeric", {
    change: "int",
  });
  lines.push(describe(good));
  if (
    !(good.outcome === "applied" && good.qtyTypes.join() === `integer:${ROWS}`)
  ) {
    failures.push(
      "control: an all-numeric TEXT->INTEGER change did not convert"
    );
  }

  return failures.length === 0
    ? {
        status: "pass",
        evidence: `trigger, view and referencing trigger refused by name; 'twelve' refused; numeric text converts\n${lines.join("\n")}`,
      }
    : {
        status: "fail",
        evidence: `${failures.join("; ")}\n${lines.join("\n")}`,
      };
}
