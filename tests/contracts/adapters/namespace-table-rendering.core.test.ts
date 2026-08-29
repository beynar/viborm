/**
 * The persistent-table renderer and its one qualified-identifier primitive.
 *
 * `identifiers.table()` is the sole entry for a persistent model or junction
 * table; `escape()` stays the owner of every statement-local name. This suite
 * pins both halves of that split at the adapter boundary, plus the two
 * properties the primitive is built for: it composes through a CALLER-SUPPLIED
 * quoter (runtime and migration drivers escape differently), and a bound
 * namespace is quoted ONCE per adapter, never once per statement.
 */

import { getAdapterInternals } from "@adapters/adapter-internals";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { mysqlAdapter } from "@src/adapters/databases/mysql/mysql-adapter";
import { postgresAdapter } from "@src/adapters/databases/postgres/postgres-adapter";
import { sqliteAdapter } from "@src/adapters/databases/sqlite/sqlite-adapter";
import { createIdentifiers } from "@src/adapters/shared/standard-sql";
import {
  createIdentifierQuoter,
  createQualifiedIdentifierRenderer,
  type IdentifierQuoter,
  renderQualifiedIdentifier,
} from "@src/sql/identifiers";
import { describe, expect, test } from "vitest";

const pgQuote = createIdentifierQuoter('"');
const mysqlQuote = createIdentifierQuoter("`");

/**
 * A quoter with observably different mechanics from either dialect's. The
 * primitive must route BOTH components through it and add nothing but the
 * separator, which is what lets the migration drivers keep their own escape
 * and null-guard semantics while sharing this composition.
 */
const foreignQuote: IdentifierQuoter = (name) => `<${name}>`;

describe("renderQualifiedIdentifier", () => {
  test("an absent namespace contributes no prefix", () => {
    expect(renderQualifiedIdentifier(pgQuote, undefined, "user")).toBe(
      '"user"'
    );
    expect(renderQualifiedIdentifier(mysqlQuote, undefined, "user")).toBe(
      "`user`"
    );
  });

  test("a present namespace contributes exactly one quoted prefix", () => {
    expect(renderQualifiedIdentifier(pgQuote, "billing", "user")).toBe(
      '"billing"."user"'
    );
    expect(renderQualifiedIdentifier(mysqlQuote, "billing", "user")).toBe(
      "`billing`.`user`"
    );
  });

  test("both components are escaped by the supplied quoter", () => {
    expect(renderQualifiedIdentifier(pgQuote, 'b"g', 'u"r')).toBe(
      '"b""g"."u""r"'
    );
    expect(renderQualifiedIdentifier(mysqlQuote, "b`g", "u`r")).toBe(
      "`b``g`.`u``r`"
    );
  });

  test("a foreign quoter composes without adding dialect syntax", () => {
    expect(renderQualifiedIdentifier(foreignQuote, "billing", "user")).toBe(
      "<billing>.<user>"
    );
    expect(renderQualifiedIdentifier(foreignQuote, undefined, "user")).toBe(
      "<user>"
    );
  });

  test("the empty string is a namespace, not an absence", () => {
    // Normalization refuses it upstream; the primitive itself holds no policy.
    expect(renderQualifiedIdentifier(pgQuote, "", "user")).toBe('""."user"');
  });
});

describe("createQualifiedIdentifierRenderer", () => {
  test("renders exactly what the primitive renders", () => {
    for (const namespace of [undefined, "billing", 'b"g']) {
      const render = createQualifiedIdentifierRenderer(pgQuote, namespace);
      expect(render("user")).toBe(
        renderQualifiedIdentifier(pgQuote, namespace, "user")
      );
    }
  });

  test("quotes the namespace once, not once per object", () => {
    const seen: string[] = [];
    const counting: IdentifierQuoter = (name) => {
      seen.push(name);
      return pgQuote(name);
    };
    const render = createQualifiedIdentifierRenderer(counting, "billing");
    for (let index = 0; index < 25; index++) render(`t${index}`);

    expect(seen.filter((name) => name === "billing")).toHaveLength(1);
    expect(seen).toHaveLength(26);
  });
});

describe("createIdentifiers", () => {
  test("quotes a bound namespace once for the whole adapter", () => {
    const seen: string[] = [];
    const counting: IdentifierQuoter = (name) => {
      seen.push(name);
      return pgQuote(name);
    };
    const identifiers = createIdentifiers(counting, "billing");
    for (let index = 0; index < 25; index++) {
      identifiers.table("user", `t${index}`);
      identifiers.table("post");
    }

    expect(seen.filter((name) => name === "billing")).toHaveLength(1);
  });

  test("an unbound group renders the escaped object alone", () => {
    const identifiers = createIdentifiers(pgQuote);
    expect(identifiers.table("user").toStatement()).toBe('"user"');
    expect(identifiers.table("user", "t0").toStatement()).toBe(
      '"user" AS "t0"'
    );
  });

  test("neither form binds a parameter", () => {
    const identifiers = createIdentifiers(pgQuote, "billing");
    expect(identifiers.table("user").values).toEqual([]);
    expect(identifiers.table("user", "t0").values).toEqual([]);
  });
});

describe("adapter table rendering", () => {
  const cases = [
    ["PostgreSQL default", new PostgresAdapter(), '"public"."user"'],
    ["PostgreSQL bound", new PostgresAdapter("billing"), '"billing"."user"'],
    ["MySQL bound", new MySQLAdapter("billing"), "`billing`.`user`"],
    ["MySQL unbound", new MySQLAdapter(), "`user`"],
    ["SQLite", new SQLiteAdapter(), '"user"'],
  ] as const;

  for (const [name, adapter, qualified] of cases) {
    test(`${name} renders the same object with and without an alias`, () => {
      expect(adapter.identifiers.table("user").toStatement()).toBe(qualified);
      const quote = name.startsWith("MySQL") ? "`" : '"';
      expect(adapter.identifiers.table("user", "t0").toStatement()).toBe(
        `${qualified} AS ${quote}t0${quote}`
      );
    });
  }

  test("the stock singletons carry the same defaults as fresh adapters", () => {
    expect(postgresAdapter.identifiers.table("user").toStatement()).toBe(
      '"public"."user"'
    );
    expect(mysqlAdapter.identifiers.table("user").toStatement()).toBe("`user`");
    expect(sqliteAdapter.identifiers.table("user").toStatement()).toBe(
      '"user"'
    );
  });
});

describe("statement-local names are never qualified", () => {
  const bound = new PostgresAdapter("billing");

  test("escape renders one bare identifier", () => {
    expect(bound.identifiers.escape("__viborm_mutation").toStatement()).toBe(
      '"__viborm_mutation"'
    );
    expect(bound.identifiers.escape("user").toStatement()).toBe('"user"');
  });

  test("column references stay two-part", () => {
    expect(bound.identifiers.column("t0", "email").toStatement()).toBe(
      '"t0"."email"'
    );
    expect(bound.identifiers.column("user", "email").toStatement()).toBe(
      '"user"."email"'
    );
  });

  test("aliased expressions carry no namespace", () => {
    expect(
      bound.identifiers
        .aliased(bound.identifiers.escape("__viborm_mutation"), "t0")
        .toStatement()
    ).toBe('"__viborm_mutation" AS "t0"');
  });

  test("CTE names carry no namespace", () => {
    const cte = bound.cte.with([
      { name: "__viborm_mutation", query: bound.raw("SELECT 1") },
    ]);
    expect(cte.toStatement()).toBe('WITH "__viborm_mutation" AS (SELECT 1)');
  });

  test("the connection-local batch temp table carries no namespace", () => {
    for (const adapter of [
      new PostgresAdapter("billing"),
      new MySQLAdapter("billing"),
      new SQLiteAdapter(),
    ]) {
      const setup = getAdapterInternals(adapter).batchRefs.setup("batch-1");
      for (const statement of setup) {
        expect(statement.toStatement()).not.toContain("billing");
      }
      expect(
        getAdapterInternals(adapter)
          .batchRefs.read("batch-1", "key")
          .toStatement()
      ).not.toContain("billing");
    }
  });
});
