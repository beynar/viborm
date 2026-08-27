/**
 * The execution target a driver's SQL actually names.
 *
 * The adapter owns the namespace, so two drivers over ONE externally supplied
 * pool address different namespaces without touching provider connection
 * state — no `USE`, no `SET search_path`, nothing session-scoped. This suite
 * proves the deterministic half of that contract: the statements each driver's
 * engine compiles reach only its own namespace, through the base driver and
 * through every transaction view built from it. The provider-level halves are
 * the PGlite isolation suite and the docker provider legs.
 */

import { type AnyDriver, TransactionBoundDriver } from "@drivers";
import { MySQL2Driver } from "@drivers/mysql2";
import { PgDriver } from "@drivers/pg";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames } from "@schema";
import {
  NAMESPACE_SCHEMA_TABLES,
  namespaceSchema,
} from "@tests/fixtures/namespace-schema";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test, vi } from "vitest";

// The stub the provider module would hand back; a supplied pool is never
// connected here because nothing in this suite executes.
vi.mock("mysql2/promise", () => ({
  createPool: () => ({ end: () => Promise.resolve() }),
}));

const USE_STATEMENT = /\bUSE\b/;
const SEARCH_PATH_STATEMENT = /search_path/i;

hydrateSchemaNames(namespaceSchema);
const registry = createModelRegistry(
  namespaceSchema,
  createSchemaRegistry(namespaceSchema)
);
const { user } = namespaceSchema;

/** Representative read, insert and delete statements one driver compiles. */
const statementsOf = (driver: AnyDriver): string[] => {
  const engine = new QueryEngine(driver, registry);
  const placeholder = driver.dialect === "postgresql" ? "$n" : "?";
  return [
    engine
      .build(user, "findMany", { include: { tags: true, posts: true } })
      .toStatement(placeholder),
    engine
      .build(user, "createMany", { data: [{ id: "u1", email: "e" }] })
      .toStatement(placeholder),
    engine
      .build(user, "deleteMany", { where: { email: { equals: "e" } } })
      .toStatement(placeholder),
  ];
};

const namesNamespace = (text: string, namespace: string, quote: '"' | "`") =>
  text.includes(`${quote}${namespace}${quote}.`);

describe("two drivers over one supplied pool address different namespaces", () => {
  test("MySQL2 drivers sharing a pool never name each other's database", async () => {
    const { createPool } = await import("mysql2/promise");
    const pool = createPool({});
    const a = new MySQL2Driver({ pool, namespace: "app_a" });
    const b = new MySQL2Driver({ pool, namespace: "app_b" });

    for (const text of statementsOf(a)) {
      expect(namesNamespace(text, "app_a", "`")).toBe(true);
      expect(namesNamespace(text, "app_b", "`")).toBe(false);
    }
    for (const text of statementsOf(b)) {
      expect(namesNamespace(text, "app_b", "`")).toBe(true);
      expect(namesNamespace(text, "app_a", "`")).toBe(false);
    }
  });

  test("pg drivers sharing a pool never name each other's schema", async () => {
    const { Pool } = await import("pg");
    const pool = new Pool();
    try {
      const a = new PgDriver({ pool, namespace: "tenant_a" });
      const b = new PgDriver({ pool, namespace: "tenant_b" });

      for (const text of statementsOf(a)) {
        expect(namesNamespace(text, "tenant_a", '"')).toBe(true);
        expect(namesNamespace(text, "tenant_b", '"')).toBe(false);
      }
      for (const text of statementsOf(b)) {
        expect(namesNamespace(text, "tenant_b", '"')).toBe(true);
        expect(namesNamespace(text, "tenant_a", '"')).toBe(false);
      }
      // One statement shape, two targets: nothing but the prefix differs.
      expect(
        statementsOf(a).map((text) => text.replaceAll('"tenant_a".', '"NS".'))
      ).toEqual(
        statementsOf(b).map((text) => text.replaceAll('"tenant_b".', '"NS".'))
      );
    } finally {
      await pool.end();
    }
  });
});

describe("transaction views execute against the base driver's namespace", () => {
  test("a root, a transaction and a nested transaction compile identical SQL", () => {
    const base = new PgDriver({ namespace: "tenant_a" });
    const transaction = new TransactionBoundDriver(base, null);
    const nested = new TransactionBoundDriver(transaction, null);

    const rendered = statementsOf(base);
    expect(statementsOf(transaction)).toEqual(rendered);
    expect(statementsOf(nested)).toEqual(rendered);
    for (const text of rendered) {
      expect(namesNamespace(text, "tenant_a", '"')).toBe(true);
    }
  });

  test("an unbound MySQL base stays unbound through its views", () => {
    const base = new MySQL2Driver();
    const nested = new TransactionBoundDriver(
      new TransactionBoundDriver(base, null),
      null
    );

    for (const text of statementsOf(nested)) {
      for (const table of NAMESPACE_SCHEMA_TABLES) {
        expect(text).not.toContain(`\`.\`${table}\``);
      }
    }
  });
});

describe("no session-scoped target statement is compiled", () => {
  test("neither dialect emits USE or SET search_path", () => {
    const compiled = [
      ...statementsOf(new PgDriver({ namespace: "tenant_a" })),
      ...statementsOf(new MySQL2Driver({ namespace: "app_a" })),
    ];
    for (const text of compiled) {
      expect(text).not.toMatch(USE_STATEMENT);
      expect(text).not.toMatch(SEARCH_PATH_STATEMENT);
    }
  });
});
