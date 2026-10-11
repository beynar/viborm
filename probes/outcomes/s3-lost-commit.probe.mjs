// S3 step 3: a transactional migration whose COMMIT succeeds but whose
// acknowledgement is lost reports the true outcome: V11020 (driven by the
// driver's commitCertainty, after re-reading the marker) or, once the marker
// re-read proves the commit, `applied`. Never a plain failure that hides a
// committed schema change. The loss is emulated on both stock transports,
// armed only for the migration group's own transaction:
// - better-sqlite3: exec("COMMIT") commits, then throws;
// - PGlite (the Postgres path S3 is about): query("COMMIT") commits, then
//   rejects.
// On SQLite the implementer must therefore re-read the marker after any
// transaction failure, not only after a may-have-committed one.
// The COMMIT may reach better-sqlite3 through exec or through a prepared
// statement, so both lose the reply. The facts (column, marker) are read
// through the raw handle: after a failed COMMIT's cleanup the client itself
// may refuse every statement, which is exactly when V11020 is the answer.
import { PGlite } from "@electric-sql/pglite";
import Database from "better-sqlite3";
import { s } from "viborm";
import {
  createMigrationClient,
  isMigrationError,
  MemoryEstateStorage,
} from "viborm/migrations";
import { createClient as createPgliteClient } from "viborm/pglite";
import { createClient as createSqliteClient } from "viborm/sqlite3";

export const meta = {
  id: "S3-lost-commit",
  title:
    "A lost transactional COMMIT raises V11020 (or reports applied), never a plain failure",
  plan: "phase-1/lane-O/S3",
  needs: [],
  source:
    "completion-plan-2026-10/code-check/migrations-sqlite.md (S3 correction c); src/drivers/driver-transaction-base.ts:488-507",
};

const ROWS = 2000;
const ARM_ON = /ALTER TABLE (?:"public"\.)?"invoice" ADD COLUMN "reference"/;
const COMMIT = /^\s*COMMIT\b/i;

const fields = {
  id: s.string().id(),
  number: s.string().unique(),
  customerEmail: s.string(),
  status: s.enum(["draft", "sent", "paid", "void"]).default("draft"),
  currency: s.string().default("EUR"),
  amountCents: s.int(),
  taxCents: s.int().default(0),
  balanceCents: s.int(),
  notes: s.string().nullable(),
  metadata: s.json().nullable(),
  dueAt: s.dateTime().nullable(),
  paidAt: s.dateTime().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
};

const lose = (state) => {
  state.armed = false;
  state.lost += 1;
  throw new Error("probe: connection lost after COMMIT");
};

/** A prepared COMMIT whose `run` commits, then loses the reply. */
function losingStatement(statement, state) {
  return new Proxy(statement, {
    get(target, member) {
      const method = Reflect.get(target, member, target);
      if (typeof method !== "function") return method;
      if (member !== "run") return method.bind(target);
      return (...args) => {
        method.apply(target, args);
        return lose(state);
      };
    },
  });
}

/**
 * A connection whose next COMMIT after an armed statement commits, then
 * "loses" the reply. better-sqlite3 sends statements through exec/prepare,
 * PGlite (including the migration's pinned BEGIN/COMMIT) through query.
 */
function lossy(handle) {
  const state = { armed: false, lost: 0 };
  const proxy = new Proxy(handle, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (!["exec", "prepare", "query"].includes(property)) {
        return value.bind(target);
      }
      return (text, ...rest) => {
        if (ARM_ON.test(text)) state.armed = true;
        const result = value.call(target, text, ...rest);
        if (!(state.armed && COMMIT.test(text))) return result;
        if (property === "prepare") return losingStatement(result, state);
        return result instanceof Promise
          ? result.then(() => lose(state))
          : lose(state);
      };
    },
  });
  return { proxy, state };
}

const DIALECTS = {
  sqlite: {
    open: () => {
      const db = new Database(":memory:");
      return {
        ...lossy(db),
        createClient: createSqliteClient,
        hasColumn: async () =>
          db
            .prepare(
              `SELECT count(*) AS n FROM pragma_table_info('invoice') WHERE name = 'reference'`
            )
            .get().n === 1,
        markerState: async () =>
          db
            .prepare(
              `SELECT json_extract(payload, '$.stateId') AS id FROM "_viborm_migration_state"`
            )
            .get()?.id ?? null,
        close: async () => db.close(),
      };
    },
  },
  pglite: {
    open: () => {
      const pg = new PGlite();
      return {
        ...lossy(pg),
        createClient: createPgliteClient,
        hasColumn: async () =>
          (
            await pg.query(
              `SELECT 1 FROM information_schema.columns WHERE table_name = 'invoice' AND column_name = 'reference'`
            )
          ).rows.length === 1,
        markerState: async () =>
          (
            await pg.query(
              `SELECT (payload::json)->>'stateId' AS id FROM "_viborm_migration_state"`
            )
          ).rows[0]?.id ?? null,
        close: () => pg.close(),
      };
    },
  },
};

async function run(dialect) {
  const { proxy, state, createClient, hasColumn, markerState, close } =
    DIALECTS[dialect].open();
  const storage = new MemoryEstateStorage();
  const v1 = createClient({
    client: proxy,
    schema: { invoice: s.model(fields) },
  });
  const v2 = createClient({
    client: proxy,
    schema: {
      invoice: s.model({ ...fields, reference: s.string().nullable() }),
    },
  });
  try {
    const m1 = createMigrationClient(v1, { storage });
    await m1.generate({ name: "init" });
    await m1.apply();
    for (let start = 0; start < ROWS; start += 500) {
      await v1.invoice.createMany({
        data: Array.from({ length: 500 }, (_, i) => ({
          id: `inv-${start + i}`,
          number: `N-${start + i}`,
          customerEmail: `c${start + i}@example.test`,
          amountCents: 1000,
          balanceCents: 1000,
        })),
      });
    }
    const m2 = createMigrationClient(v2, { storage });
    const target = await m2.generate({ name: "add-reference" });
    let outcome;
    let error;
    try {
      outcome = (await m2.apply()).outcome;
    } catch (caught) {
      error = caught;
    }
    const committed = await hasColumn();
    const marker = await markerState();
    const facts = `lost=${state.lost} columnCommitted=${committed} markerAtTarget=${marker === target.stateId}`;
    if (state.lost !== 1 || !committed) {
      return {
        ok: false,
        line: `${dialect}: emulation did not lose exactly one committed COMMIT: ${facts}`,
      };
    }
    if (error === undefined) {
      return {
        ok: outcome === "applied" && marker === target.stateId,
        line: `${dialect}: apply returned ${outcome}; ${facts}`,
      };
    }
    const observed = `${error.name} ${error.code} meta=${JSON.stringify(error.meta)}: ${String(error.message).split("\n")[0].slice(0, 100)}`;
    const ambiguous =
      isMigrationError(error) &&
      error.code === "V11020" &&
      typeof error.meta?.effectState === "string";
    return {
      ok: ambiguous,
      line: `${dialect}: ${ambiguous ? "" : "lost COMMIT reported as "}${observed}; ${facts}`,
    };
  } finally {
    // A client the failed COMMIT condemned may refuse even this.
    await v1.$disconnect().catch(() => undefined);
    await v2.$disconnect().catch(() => undefined);
    await close();
  }
}

export default async function probe() {
  const results = [await run("sqlite"), await run("pglite")];
  return {
    status: results.every((result) => result.ok) ? "pass" : "fail",
    evidence: results.map((result) => result.line).join("; "),
  };
}
