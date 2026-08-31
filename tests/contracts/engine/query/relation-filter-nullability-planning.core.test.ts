import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { buildWhere } from "@query-engine/builders/where-builder";
import type { QueryScope } from "@query-engine/types";
import { s } from "@schema";
import type { Sql } from "@sql";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { describe, expect, test } from "vitest";

const account = s
  .model({
    tenant: s.string(),
    code: s.string(),
    profile: s.toOne(() => profile),
  })
  .id(["tenant", "code"])
  .map("relation_filter_accounts");

const profile = s
  .model({
    id: s.string().id(),
    accountTenant: s.string().nullable(),
    accountCode: s.string().nullable(),
    account: s
      .toOne(() => account)
      .fields("accountTenant", "accountCode")
      .references("tenant", "code"),
  })
  .unique(["accountTenant", "accountCode"])
  .map("relation_filter_profiles");

prepareSchema({ account, profile });

function where(scope: QueryScope, filter: Record<string, unknown>): Sql {
  const condition = buildWhere(scope, filter, scope.rootAlias);
  if (!condition) throw new Error("Expected a relation filter condition.");
  return condition;
}

describe("relation nullability predicates", () => {
  test("a compound parent-held relation is null when any foreign-key member is null", () => {
    const scope = scopeFor(new PostgresAdapter(), profile);

    expect(where(scope, { account: { is: null } }).toStatement("$n")).toBe(
      '("t0"."accountTenant" IS NULL OR "t0"."accountCode" IS NULL)'
    );
  });

  test("a compound parent-held relation is present only when every foreign-key member is present", () => {
    const scope = scopeFor(new PostgresAdapter(), profile);

    expect(where(scope, { account: { isNot: null } }).toStatement("$n")).toBe(
      '("t0"."accountTenant" IS NOT NULL AND "t0"."accountCode" IS NOT NULL)'
    );
  });

  test("the inverse one-to-one side uses correlated existence for null and presence", () => {
    const nullScope = scopeFor(new PostgresAdapter(), account);
    const presentScope = scopeFor(new PostgresAdapter(), account);
    const absent = where(nullScope, { profile: { is: null } }).toStatement("$n");
    const present = where(presentScope, {
      profile: { isNot: null },
    }).toStatement("$n");

    expect(absent).toContain("NOT EXISTS");
    expect(absent).toContain('"t0"."tenant" = "t1"."accountTenant"');
    expect(absent).toContain('"t0"."code" = "t1"."accountCode"');
    expect(present).toContain("EXISTS");
    expect(present).not.toContain("NOT EXISTS");
  });

  test("MySQL hides an inverse self-target read behind a derived table during mutation", () => {
    const readScope = scopeFor(new MySQLAdapter(), account);
    const mutationScope = {
      ...readScope,
      mutationTable: "relation_filter_profiles",
    } satisfies QueryScope;
    const condition = where(mutationScope, {
      profile: { is: { id: { equals: "profile-1" } } },
    });
    const statement = condition.toStatement("?");

    expect(statement).toContain("SELECT * FROM (");
    expect(statement).toContain("relation_filter_profiles");
    expect(condition.values).toEqual(["profile-1", "profile-1"]);
  });
});

describe("coverage low value", () => {
  test("rejects relation filters that lost their normalized operator envelope", () => {
    const accountScope = scopeFor(new PostgresAdapter(), account);
    const profileScope = scopeFor(new PostgresAdapter(), profile);

    expect(() => where(accountScope, { profile: {} })).toThrow(
      "requires one of: is, isNot"
    );
    expect(() => where(accountScope, { profile: { is: "profile-1" } })).toThrow(
      "profile.is' requires an object"
    );
    expect(() => where(profileScope, { account: { isNot: 1 } })).toThrow(
      "account.isNot' requires an object"
    );
  });
});
