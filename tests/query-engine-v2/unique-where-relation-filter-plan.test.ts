import { MySQL2Driver } from "@drivers/mysql2";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createQueryScope } from "@query-engine/context";
import { buildDelete, buildUpdate } from "@query-engine/operations";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, expect, test } from "vitest";
import type { StatementStep } from "../../src/query-engine-v2/OperationFragment";
import { constructRoutedOperation } from "../../src/query-engine-v2/routing";

/**
 * N6-U2 — how a RELATION filter inside a unique `where` compiles into the WRITE.
 *
 * Two facts no behavioral test can see, because both are about the SHAPE of a
 * statement that answers correctly either way on the dialect that runs it:
 *
 *  1. WHAT THE OUTER REFERENCE NAMES. A unique `where` compiles into the
 *     UPDATE/DELETE as well as into the locate, and a mutation target carries no
 *     alias — so before this unit the correlated `EXISTS` was built against BARE
 *     column names. Where the related model happens to carry a column of the same
 *     name (`id`, here, and in most schemas), the outer reference silently binds
 *     to the RELATED table and the predicate becomes a question about no outer
 *     row at all. It is not an error on any dialect: it is a wrong answer. The
 *     fix is the spelling `buildUpdateMany`/`buildDeleteMany` have always used —
 *     qualify by the target's table name — and this is its tripwire.
 *
 *  2. WHICH DIALECT WRAPS, AND WHEN. MySQL rejects reading the mutated table in a
 *     subquery (ERROR 1093), so `mutationTable` makes the relation-filter builder
 *     hide such a subquery behind a derived table. That wrapper must engage
 *     exactly where the relation READS the mutated table — a self-relation, or a
 *     self-M2M's target side — and nowhere else: wrapping a cross-table subquery
 *     would materialize a derived table for nothing. PostgreSQL and SQLite take
 *     the subquery directly in every case. A behavioral test passes under either
 *     spelling on the dialect that accepts both, so only this can pin it.
 *
 * Planning and compile are pure, so no driver connects here.
 */

const account = s
  .model({
    id: s.int().id(),
    email: s.string().unique(),
    status: s.string(),
    logins: s.oneToMany(() => login),
  })
  .map("uwrf_accounts");

// Carries an `id` of its own — the column whose name makes a decorrelated outer
// reference resolve to the WRONG table instead of failing loudly.
const login = s
  .model({
    id: s.int().id(),
    label: s.string(),
    accountId: s.int().nullable(),
    account: s
      .manyToOne(() => account)
      .fields("accountId")
      .references("id")
      .optional(),
  })
  .map("uwrf_logins");

// A self-relation: the relation filter's FROM is the mutated table itself.
const node = s
  .model({
    id: s.int().id(),
    label: s.string(),
    parentId: s.int().nullable(),
    parent: s
      .manyToOne(() => node)
      .fields("parentId")
      .references("id")
      .optional(),
    children: s.oneToMany(() => node),
  })
  .map("uwrf_nodes");

const schema = { account, login, node };

beforeAll(() => {
  hydrateSchemaNames(schema);
});

type DriverName = "MySQL2" | "PGlite" | "SQLite3";

const makeDriver = (name: DriverName) => {
  if (name === "MySQL2") return new MySQL2Driver();
  if (name === "SQLite3") return new SQLite3Driver();
  return new PGliteDriver();
};

/** The builders take ALREADY-VALIDATED payloads (the parse boundary normalizes
 *  `{ label: "x" }` into `{ label: { equals: "x" } }`), so these are spelled the
 *  way the schema hands them over. */
const LABEL_IS_LIVE = { label: { equals: "live" } };

/** The correlation, qualified by the mutated table. MySQL quotes with backticks
 *  and the others with double quotes, so both spellings are accepted here — a
 *  dialect cannot pass by emitting neither. */
const QUALIFIED_ACCOUNT_CORRELATION =
  /["`]uwrf_accounts["`]\.["`]id["`] = ["`]t\d+["`]\.["`]accountId["`]/;
/** The falsified spelling: a BARE outer column opening the subquery's WHERE. */
const BARE_CORRELATION = /\(["`]id["`] = ["`]t\d+["`]/;
const QUALIFIED_ACCOUNT_DISCRIMINATOR = /["`]uwrf_accounts["`]\.["`]id["`] = /;
const QUALIFIED_NODE_CORRELATION =
  /["`]uwrf_nodes["`]\.["`](id|parentId)["`] = /;
const WRAPPED = /EXISTS \(SELECT \* FROM \(SELECT 1 FROM/;
const MYSQL_NODE_CORRELATION = /`uwrf_nodes`\.`id` = `t\d+`\.`parentId`/;

function updateText(
  name: DriverName,
  model: (typeof schema)[keyof typeof schema],
  where: Record<string, unknown>
): string {
  const scope = createQueryScope(makeDriver(name).adapter, model);
  return buildUpdate(scope, {
    where,
    data: { [model === account ? "status" : "label"]: { set: "x" } },
  }).toStatement("$n");
}

function deleteText(
  name: DriverName,
  model: (typeof schema)[keyof typeof schema],
  where: Record<string, unknown>
): string {
  const scope = createQueryScope(makeDriver(name).adapter, model);
  return buildDelete(scope, { where }).toStatement("$n");
}

describe("the correlation names the mutated table", () => {
  const drivers: DriverName[] = ["MySQL2", "PGlite", "SQLite3"];

  for (const name of drivers) {
    test(`${name}: UPDATE correlates against the target's own table name`, () => {
      const text = updateText(name, account, {
        id: 1,
        logins: { some: LABEL_IS_LIVE },
      });
      expect(text).toMatch(QUALIFIED_ACCOUNT_CORRELATION);
      // The falsified spelling, stated too so the tripwire cannot be satisfied
      // by an unrelated rewrite: no bare `id =` outer reference.
      expect(text).not.toMatch(BARE_CORRELATION);
    });

    test(`${name}: DELETE correlates against the target's own table name`, () => {
      const text = deleteText(name, account, {
        id: 1,
        logins: { some: LABEL_IS_LIVE },
      });
      expect(text).toMatch(QUALIFIED_ACCOUNT_CORRELATION);
      expect(text).not.toMatch(BARE_CORRELATION);
    });

    test(`${name}: the discriminator itself is qualified too`, () => {
      // One spelling for the whole `where`, not one per half.
      const text = updateText(name, account, {
        id: 1,
        logins: { some: LABEL_IS_LIVE },
      });
      expect(text).toMatch(QUALIFIED_ACCOUNT_DISCRIMINATOR);
    });
  }
});

describe("the ERROR 1093 derived-table wrapper engages exactly where it must", () => {
  test("MySQL wraps a SELF-relation subquery — it reads the mutated table", () => {
    for (const text of [
      updateText("MySQL2", node, {
        id: 1,
        children: { some: LABEL_IS_LIVE },
      }),
      deleteText("MySQL2", node, { id: 1, children: { some: LABEL_IS_LIVE } }),
      updateText("MySQL2", node, { id: 1, parent: { is: LABEL_IS_LIVE } }),
    ]) {
      expect(text).toMatch(WRAPPED);
      // The wrapper does not decorrelate: the outer reference survives it.
      expect(text).toMatch(QUALIFIED_NODE_CORRELATION);
    }
  });

  test("MySQL does NOT wrap a CROSS-table subquery — nothing reads the target", () => {
    expect(
      updateText("MySQL2", account, { id: 1, logins: { some: LABEL_IS_LIVE } })
    ).not.toMatch(WRAPPED);
  });

  test("PostgreSQL and SQLite never wrap — they read the mutated table happily", () => {
    for (const name of ["PGlite", "SQLite3"] as const) {
      expect(
        updateText(name, node, { id: 1, children: { some: LABEL_IS_LIVE } })
      ).not.toMatch(WRAPPED);
      expect(
        deleteText(name, node, { id: 1, children: { some: LABEL_IS_LIVE } })
      ).not.toMatch(WRAPPED);
    }
  });
});

describe("the write that actually carries the filter on a non-returning driver", () => {
  // MySQL is non-returning, so `update`/`delete` address the row by the PK their
  // locate captured and the filter never reaches those statements. `upsert`'s
  // UPDATE arm is the one that keeps the original `where` on BOTH substrates —
  // so it is the statement that makes MySQL meet its own 1093 restriction, and
  // the reason the docker leg of this unit is an upsert.
  test("MySQL: upsert's update arm carries the filter, wrapped", () => {
    const schemas = createSchemaRegistry(schema);
    const engine = new QueryEngine(
      new MySQL2Driver(),
      createModelRegistry(schema, schemas)
    );
    const routed = constructRoutedOperation(engine, node, "upsert", {
      where: { id: 1, children: { some: { label: "live" } } },
      create: { id: 1, label: "fresh", parentId: null },
      update: { label: "renamed" },
    });
    if (!routed) throw new Error("'upsert' did not route");
    // A non-empty locate result is the UPDATE arm — the branch under test.
    const fragment = routed.compile({
      [`${routed.planning().steps[0]?.id}.rows`]: [{ id: 1 }],
    });
    const write = fragment.steps.find(
      (step): step is StatementStep => step.kind === "write"
    );
    if (!write) throw new Error("the update arm compiled no write");
    const text = write.statement.toStatement("$n");
    expect(text).toContain("UPDATE `uwrf_nodes`");
    expect(text).toMatch(WRAPPED);
    expect(text).toMatch(MYSQL_NODE_CORRELATION);
  });
});
