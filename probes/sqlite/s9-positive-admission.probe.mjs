// S9: SQLite positive admission. Effectful migration work is admitted only on a
// SQLite driver that declares the migration capability. An undeclared custom
// driver (here a correct, transactional one over better-sqlite3, written the way
// the custom-driver docs show) must be refused before any effect. The stock
// sqlite3 and bun-sqlite drivers stay admitted; D1 and libSQL stay refused.
// The plan fixes no refusal code, so any MigrationError counts as a refusal.
import { join } from "node:path";
import Database from "better-sqlite3";
import { createClient, s } from "viborm";
import { SQLiteAdapter } from "viborm/adapters";
import { BunSQLiteDriver } from "viborm/bun-sqlite";
import { D1Driver } from "viborm/d1";
import { Driver, sqliteResultParser } from "viborm/driver";
import { LibSQLDriver } from "viborm/libsql";
import {
  createMigrationClient,
  isMigrationError,
  MemoryEstateStorage,
} from "viborm/migrations";
import { SQLite3Driver } from "viborm/sqlite3";

export const meta = {
  id: "S9",
  title: "SQLite positive admission: undeclared custom drivers are refused",
  plan: "phase-1/lane-L/S9",
  needs: [],
  source:
    "docs/architecture/migrations-durable-objects-review-2026-10-09 FI-04 (evidence/fault-injection/probes/p16-custom-do-driver.mjs); completion-plan-2026-10/code-check/migrations-sqlite.md S9; src/migrations/admission.ts:115-152, src/migrations/drivers/index.ts:52-56,143-163",
};

const STUB_TOUCHED = "STUB-PROVIDER-TOUCHED";

/** A complete, transactional SQLite driver that declares nothing beyond the Driver contract. */
class CustomSqliteDriver extends Driver {
  adapter = new SQLiteAdapter();
  result = sqliteResultParser;

  constructor(db) {
    super("sqlite", "custom-sqlite");
    this.db = db;
  }

  async initClient() {
    return this.db;
  }

  async closeClient() {
    // The probe owns the database handle.
  }

  run(client, text, params = []) {
    const statement = client.prepare(text);
    const values = params.map((value) => {
      if (typeof value === "boolean") return value ? 1 : 0;
      if (value instanceof Date) return value.toISOString();
      return value;
    });
    if (statement.reader) {
      const rows = statement.all(...values);
      return { rows, rowCount: rows.length };
    }
    const info = statement.run(...values);
    return { rows: [], rowCount: info.changes };
  }

  async execute(client, text, params) {
    return this.run(client, text, params);
  }

  async executeRaw(client, text, params) {
    return this.run(client, text, params);
  }

  async transaction(client, fn) {
    client.exec("BEGIN IMMEDIATE");
    try {
      const value = await fn(client);
      client.exec("COMMIT");
      return value;
    } catch (error) {
      client.exec("ROLLBACK");
      throw error;
    }
  }
}

/**
 * A provider object that throws on first use: reaching it means admission let
 * the work through. `firstAnswer` serves the one read a driver constructor makes.
 */
const stubProvider = (tracker, firstAnswer) => {
  let answered = !firstAnswer;
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (key === "then") return undefined;
        if (!answered && key === firstAnswer.key) {
          answered = true;
          return firstAnswer.value;
        }
        return () => {
          tracker.calls?.push(`${tracker.phase}:${String(key)}`);
          throw new Error(`${STUB_TOUCHED}:${String(key)}`);
        };
      },
    }
  );
};

// BunSQLiteDriver's constructor checks that a supplied database enforces foreign keys.
const bunConstructorRead = {
  key: "query",
  value: () => ({ get: () => ({ foreign_keys: 1 }) }),
};

const schema = () => ({
  item: s.model({
    id: s.string().id(),
    sku: s.string().unique(),
    name: s.string(),
    status: s.enum(["draft", "active", "archived"]),
    price: s.int(),
    stock: s.int().default(0),
    attributes: s.json().nullable(),
    note: s.string().nullable(),
    createdAt: s.dateTime().now(),
    updatedAt: s.dateTime().updatedAt(),
  }),
});

/**
 * generate + apply on a fresh estate; returns the outcome or the refusal.
 * `tracker.phase` tags the stub's provider calls, so only apply-time calls (made
 * after admission ran) count as admission letting the work through.
 */
async function tryApply(makeDriver, tracker = {}) {
  let client;
  tracker.phase = "setup";
  try {
    client = createClient({ schema: schema(), driver: makeDriver() });
    const migrations = createMigrationClient(client, {
      storage: new MemoryEstateStorage(),
    });
    await migrations.generate({ name: "init" });
    tracker.phase = "apply";
    return { outcome: (await migrations.apply()).outcome };
  } catch (error) {
    return { error, refused: isMigrationError(error) };
  } finally {
    tracker.phase = "teardown";
    await client?.$disconnect().catch(() => undefined);
  }
}

const show = (result) =>
  result.outcome ??
  `${result.error?.name}/${result.error?.code ?? "-"}: ${String(result.error?.message).slice(0, 110)}`;

const userTables = (db) =>
  db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    )
    .all()
    .map((row) => row.name);

export default async function probe(ctx) {
  const failures = [];
  const lines = [];

  // (1) Undeclared custom driver: refused before any effect.
  const db = new Database(join(ctx.tmpDir, "custom.sqlite"));
  try {
    const custom = await tryApply(() => new CustomSqliteDriver(db));
    const tables = userTables(db);
    lines.push(`custom-sqlite: ${show(custom)}; tables after: [${tables}]`);
    if (!custom.refused || tables.length > 0) {
      failures.push(
        `undeclared custom SQLite driver admitted for apply (${show(custom)}, tables [${tables}])`
      );
    }
  } finally {
    db.close();
  }

  // (2) Stock sqlite3: admitted and applies.
  const stock = await tryApply(
    () => new SQLite3Driver({ dataDir: join(ctx.tmpDir, "stock.sqlite") })
  );
  lines.push(`sqlite3: ${show(stock)}`);
  if (stock.outcome !== "applied") {
    failures.push(`stock sqlite3 not admitted (${show(stock)})`);
  }

  // (3) Stock bun-sqlite (no Bun here): admission must let the work reach the provider.
  const bunProbe = { calls: [] };
  const bun = await tryApply(
    () =>
      new BunSQLiteDriver({
        client: stubProvider(bunProbe, bunConstructorRead),
      }),
    bunProbe
  );
  lines.push(`bun-sqlite: ${show(bun)}; provider calls: [${bunProbe.calls}]`);
  if (!bunProbe.calls.some((call) => call.startsWith("apply:"))) {
    failures.push(
      `stock bun-sqlite refused before its provider (${show(bun)})`
    );
  }

  // (4) D1 and libSQL stay refused.
  const d1 = await tryApply(() => new D1Driver({ database: stubProvider({}) }));
  lines.push(`d1: ${show(d1)}`);
  if (!d1.refused) failures.push(`d1 not refused (${show(d1)})`);
  const libsql = await tryApply(
    () =>
      new LibSQLDriver({ databaseUrl: `file:${join(ctx.tmpDir, "libsql.db")}` })
  );
  lines.push(`libsql: ${show(libsql)}`);
  if (!libsql.refused) failures.push(`libsql not refused (${show(libsql)})`);

  return failures.length === 0
    ? {
        status: "pass",
        evidence: `undeclared custom driver refused; sqlite3/bun-sqlite admitted; d1/libsql refused\n${lines.join("\n")}`,
      }
    : {
        status: "fail",
        evidence: `${failures.join("; ")}\n${lines.join("\n")}`,
      };
}
