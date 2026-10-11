// S10: verified foreign-key lift. A SQLite table recreation of a referenced
// parent is admitted only when the lift is proven. Four drivers, all the stock
// sqlite3 driver with one fault injected through its raw-statement hook:
//   honest           no fault (control: the rebuild applies, every child kept);
//   pragma-ignored   `PRAGMA foreign_keys = OFF` is a no-op (a Durable Object
//                    with a pending write), so the read-back still says 1;
//   pragma-lies      the same, and every read-back (PRAGMA or pragma_foreign_keys)
//                    answers 0, so only the in-transaction row-count /
//                    non-null-FK-count check is left;
//   transactionless  supportsTransactions = false: no bracket, no check today.
// Target: every faulty driver is refused with a MigrationError before effects
// (children intact, item.label still NOT NULL). A pragma fault that never saw
// the OFF statement is reported as not injected rather than judged.
import { join } from "node:path";
import Database from "better-sqlite3";
import { createClient as createDriverClient, s } from "viborm";
import { createMigrationClient, isMigrationError } from "viborm/migrations";
import { createFsStorageWriter } from "viborm/migrations/storage/fs";
import { createClient, SQLite3Driver } from "viborm/sqlite3";

export const meta = {
  id: "S10",
  title: "SQLite foreign-key lift is verified before a parent rebuild",
  plan: "phase-1/lane-L/S10",
  needs: [],
  source:
    "docs/architecture/migrations-durable-objects-review-2026-10-09 FI-01 (verify/fk-pragma.mjs, evidence/fault-injection/do/do-viborm-replay.mjs); completion-plan-2026-10/code-check/migrations-sqlite.md S10; src/migrations/foreign-keys.ts:85-149, src/migrations/apply-v1.ts:229-246",
};

const ITEMS = 10_000;
const PRAGMA_OFF = /^\s*PRAGMA\s+foreign_keys\s*=\s*(OFF|0|false)\s*;?\s*$/i;
const PRAGMA_READ = /^\s*PRAGMA\s+(main\.)?foreign_keys\s*;?\s*$/i;
const PRAGMA_TABLE = /\bpragma_foreign_keys\b(\s*\(\s*\))?/gi;

class FaultySqliteDriver extends SQLite3Driver {
  constructor(options, fault) {
    super(options);
    this.fault = fault;
    // Shared, not per-object: the migration commands run statements through
    // views over this driver (Object.create), whose own writes would not land
    // on the instance the probe inspects.
    this.observed = { off: false };
  }

  intercept(text) {
    if (this.fault === "none") return { text };
    if (PRAGMA_OFF.test(text)) {
      this.observed.off = true;
      return { result: { rows: [], rowCount: 0 } };
    }
    if (this.fault === "pragma-lies" && PRAGMA_READ.test(text)) {
      return { result: { rows: [{ foreign_keys: 0 }], rowCount: 1 } };
    }
    return {
      text:
        this.fault === "pragma-lies"
          ? text.replace(PRAGMA_TABLE, "(SELECT 0 AS foreign_keys)")
          : text,
    };
  }

  async execute(client, text, params, context) {
    const hit = this.intercept(text);
    return hit.result ?? super.execute(client, hit.text, params, context);
  }

  async executeRaw(client, text, params) {
    const hit = this.intercept(text);
    return hit.result ?? super.executeRaw(client, hit.text, params);
  }
}

class TransactionlessSqliteDriver extends SQLite3Driver {
  supportsTransactions = false;
}

const schema = (version) => {
  const label = version === "v2" ? s.string().nullable() : s.string();
  const item = s.model({
    id: s.string().id(),
    sku: s.string().unique(),
    label,
    status: s.enum(["draft", "active", "archived"]),
    price: s.int(),
    stock: s.int().default(0),
    attributes: s.json().nullable(),
    weight: s.number().nullable(),
    note: s.string().nullable(),
    createdAt: s.dateTime().now(),
    updatedAt: s.dateTime().updatedAt(),
    tags: s.toMany(() => tag),
    notes: s.toMany(() => note),
  });
  const tag = s.model({
    id: s.string().id(),
    name: s.string(),
    itemId: s.string(),
    item: s
      .toOne(() => item)
      .fields("itemId")
      .references("id")
      .onDelete("cascade"),
    createdAt: s.dateTime().now(),
  });
  const note = s.model({
    id: s.string().id(),
    body: s.string(),
    itemId: s.string().nullable(),
    item: s
      .toOne(() => item)
      .fields("itemId")
      .references("id")
      .onDelete("setNull"),
    createdAt: s.dateTime().now(),
  });
  return { item, tag, note };
};

/** A database at v1 with ITEMS items, one cascade tag and one setNull note each. */
async function prepare(dir) {
  const dbPath = join(dir, "db.sqlite");
  const storage = createFsStorageWriter(join(dir, "estate"));
  const client = createClient({ schema: schema("v1"), dataDir: dbPath });
  try {
    await createMigrationClient(client, { storage }).generate({ name: "v1" });
    await createMigrationClient(client, { storage }).apply();
    for (let start = 0; start < ITEMS; start += 1000) {
      const ids = Array.from({ length: 1000 }, (_, k) => `item-${start + k}`);
      await client.item.createMany({
        data: ids.map((id, k) => ({
          id,
          sku: `SKU-${start + k}`,
          label: `Item ${start + k}`,
          status: "active",
          price: 100 + k,
          attributes: { color: "red", size: k % 5 },
        })),
      });
      await client.tag.createMany({
        data: ids.map((id) => ({ id: `tag-${id}`, name: "sale", itemId: id })),
      });
      await client.note.createMany({
        data: ids.map((id) => ({ id: `note-${id}`, body: "ok", itemId: id })),
      });
    }
  } finally {
    await client.$disconnect();
  }
  const next = createClient({ schema: schema("v2"), dataDir: dbPath });
  try {
    const generated = await createMigrationClient(next, { storage }).generate({
      name: "v2",
    });
    if (!generated.sql.includes("__new_item")) {
      throw new Error("v2 does not recreate the parent table item");
    }
  } finally {
    await next.$disconnect();
  }
  return { dbPath, storage };
}

const census = (dbPath) => {
  const db = new Database(dbPath, { readonly: true });
  try {
    const one = (text) => Object.values(db.prepare(text).get())[0];
    return {
      tags: one(`SELECT count(*) FROM "tag"`),
      linkedNotes: one(
        `SELECT count(*) FROM "note" WHERE "itemId" IS NOT NULL`
      ),
      labelNullable:
        one(
          `SELECT "notnull" FROM pragma_table_info('item') WHERE name = 'label'`
        ) === 0,
    };
  } finally {
    db.close();
  }
};

async function scenario(tmpDir, name, makeDriver) {
  const dir = join(tmpDir, name);
  const { dbPath, storage } = await prepare(dir);
  const driver = makeDriver({ dataDir: dbPath });
  const client = createDriverClient({ schema: schema("v2"), driver });
  let outcome;
  let refused = false;
  try {
    outcome = (await createMigrationClient(client, { storage }).apply())
      .outcome;
  } catch (error) {
    refused = isMigrationError(error);
    outcome = `${refused ? "MigrationError" : error?.name}/${error?.code}: ${String(error?.message).slice(0, 120)}`;
  } finally {
    await client.$disconnect();
  }
  const after = census(dbPath);
  const intact = after.tags === ITEMS && after.linkedNotes === ITEMS;
  return {
    refused,
    intact,
    rebuilt: after.labelNullable,
    faultMissed:
      driver.fault !== undefined &&
      driver.fault !== "none" &&
      !driver.observed.off,
    applied: outcome === "applied" && after.labelNullable,
    line: `${name}: ${outcome}; tags ${ITEMS}->${after.tags}, linked notes ${ITEMS}->${after.linkedNotes}`,
  };
}

export default async function probe(ctx) {
  const failures = [];
  const lines = [];

  const honest = await scenario(
    ctx.tmpDir,
    "honest",
    (options) => new FaultySqliteDriver(options, "none")
  );
  lines.push(honest.line);
  if (!(honest.applied && honest.intact)) {
    failures.push(
      "control: the unfaulted stock driver did not rebuild the parent keeping every child"
    );
  }

  for (const [name, makeDriver] of [
    [
      "pragma-ignored",
      (options) => new FaultySqliteDriver(options, "pragma-ignored"),
    ],
    [
      "pragma-lies",
      (options) => new FaultySqliteDriver(options, "pragma-lies"),
    ],
    ["transactionless", (options) => new TransactionlessSqliteDriver(options)],
  ]) {
    const result = await scenario(ctx.tmpDir, name, makeDriver);
    lines.push(result.line);
    if (result.faultMissed) {
      failures.push(
        `${name}: fault not injected (no PRAGMA foreign_keys=OFF seen through execute/executeRaw)`
      );
    } else if (!result.refused) {
      failures.push(
        `${name}: not refused before effects${result.intact ? "" : " (children lost)"}`
      );
    } else if (!result.intact || result.rebuilt) {
      failures.push(
        `${name}: refused after effects (${result.intact ? "" : "children lost, "}item rebuilt: ${result.rebuilt})`
      );
    }
  }

  return failures.length === 0
    ? {
        status: "pass",
        evidence: `unproven lifts refused with children intact; control rebuild applied\n${lines.join("\n")}`,
      }
    : {
        status: "fail",
        evidence: `${failures.join("; ")}\n${lines.join("\n")}`,
      };
}
