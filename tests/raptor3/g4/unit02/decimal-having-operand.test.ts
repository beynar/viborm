/**
 * G4-02 author check — the decimal `having { _sum }` operand domain (§10.10).
 *
 * `having: { amount: { _sum: { gt: x } } }` compares `SUM(amount)`, whose domain
 * is the WIDENED one: a sum may legitimately exceed the column's precision while
 * keeping its scale. Binding the operand in the FIELD's domain (what
 * `lowerOperation`'s `bind` did before phase 2) sends a different literal than
 * the shipped engine for the same public request, and on SQLite — where the
 * column holds an unscaled integer coefficient — a too-narrow cast is a wrong
 * comparison rather than a rounding difference.
 *
 * The property is asserted as an EQUALITY with the shipped lowering on all three
 * dialects, plus the registered refusal for a coefficient the provider cannot
 * cast exactly. The shipped side is the oracle
 * (`tests/contracts/engine/query/decimal-having-operand-sql.core.test.ts` is its
 * own contract); nothing is imported from the shipped builders into the
 * candidate.
 */

import assert from "node:assert/strict";
import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import type { Dialect } from "@drivers";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { Queries } from "@query-engine/raptor3/shared/query";
import { hydrateSchemaNames, s } from "@schema";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, it } from "vitest";

const ledger = s
  .model({
    id: s.string().id(),
    bucket: s.string(),
    amount: s.decimal({ precision: 16, scale: 2 }),
  })
  .map("g4u2_having_ledger");

const schema = { ledger };

beforeAll(() => hydrateSchemaNames(schema));

const dialects: {
  readonly name: string;
  readonly dialect: Dialect;
  readonly adapter: () => DatabaseAdapter;
}[] = [
  {
    name: "PostgreSQL",
    dialect: "postgresql",
    adapter: () => new PostgresAdapter(),
  },
  { name: "MySQL", dialect: "mysql", adapter: () => new MySQLAdapter() },
  { name: "SQLite", dialect: "sqlite", adapter: () => new SQLiteAdapter() },
];

function shipped(
  adapter: DatabaseAdapter,
  dialect: Dialect,
  args: Record<string, unknown>
): string {
  const registry = createModelRegistry(schema, createSchemaRegistry(schema));
  const engine = new QueryEngine(new SqlOnlyDriver(adapter, dialect), registry);
  return engine.build(ledger, "groupBy", args).toStatement("$n");
}

function candidate(
  adapter: DatabaseAdapter,
  args: Record<string, unknown>
): string {
  const engineSchema = new EngineSchema(schema);
  const queries = new Queries(engineSchema, adapter);
  const admitted = engineSchema.admit(ledger, "groupBy", args);
  return queries.grouped(ledger, admitted).sql.toStatement("$n");
}

/** Everything after the last comparison operator: the rendered operand. */
function operandAfter(statement: string, operator: string): string {
  const index = statement.lastIndexOf(`${operator} `);
  assert.ok(index >= 0, `no '${operator}' comparison in: ${statement}`);
  return statement.slice(index + operator.length + 1).trim();
}

const having = (operand: string) => ({
  by: ["bucket"],
  having: { amount: { _sum: { gt: operand } } },
  _count: true,
});

describe("G4-02 decimal having _sum operand (§10.10)", () => {
  it("binds the operand exactly as the shipped engine does, on all three dialects", () => {
    for (const { name, dialect, adapter } of dialects) {
      const args = having("5");
      const shippedOperand = operandAfter(
        shipped(adapter(), dialect, args),
        ">"
      );
      const candidateOperand = operandAfter(candidate(adapter(), args), ">");
      assert.equal(
        candidateOperand,
        shippedOperand,
        `${name}: the _sum operand must be lowered in the widened domain`
      );
    }
  });

  it("binds a sum operand WIDER than the column's own precision, as shipped", () => {
    // Coefficient 1_500_000_000_000_000_000: nineteen digits, three past the
    // column's own precision of 16, legal for a SUM and inside every dialect's
    // exact cast domain (it is the shipped contract's own pinned in-range
    // value). This is the case a field-domain cast gets wrong.
    for (const { name, dialect, adapter } of dialects) {
      const args = having("15000000000000000.00");
      const shippedOperand = operandAfter(
        shipped(adapter(), dialect, args),
        ">"
      );
      const candidateOperand = operandAfter(candidate(adapter(), args), ">");
      assert.equal(candidateOperand, shippedOperand, name);
    }
  });

  it("raises the registered refusal when the provider cannot cast the coefficient", () => {
    // SQLite's exact HAVING operand cast domain is bounded; past it the owner
    // refuses instead of silently changing the value written.
    const args = having("1000000000000000000000000000.00");
    const observe = (build: () => string): string => {
      try {
        return `ok:${build()}`;
      } catch (error) {
        return `error:${(error as Error).message}`;
      }
    };
    const shippedOutcome = observe(() =>
      shipped(new SQLiteAdapter(), "sqlite", args)
    );
    const candidateOutcome = observe(() => candidate(new SQLiteAdapter(), args));
    assert.match(
      candidateOutcome,
      /outside this provider's exact HAVING operand cast domain/
    );
    assert.equal(candidateOutcome, shippedOutcome);
  });
});
