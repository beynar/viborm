import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { COUNT_RESULT_KEY } from "@adapters/shared/result-parsing";
import { createQueryScope } from "@query-engine/context/query-scope";
import { buildCount } from "@query-engine/operations/count";
import { parseResult, ResultParser } from "@query-engine/result/ResultParser";
import { hydrateSchemaNames, s } from "@schema";
import { describe, expect, test } from "vitest";

const schema = {
  metric: s.model({
    id: s.string().id(),
    count: s.int(),
    _result: s.int(),
  }),
};

hydrateSchemaNames(schema);

const dialects: Array<{
  name: string;
  adapter: DatabaseAdapter;
  quotedCarrier: string;
}> = [
  {
    name: "PostgreSQL",
    adapter: new PostgresAdapter(),
    quotedCarrier: `"${COUNT_RESULT_KEY}"`,
  },
  {
    name: "MySQL",
    adapter: new MySQLAdapter(),
    quotedCarrier: `\`${COUNT_RESULT_KEY}\``,
  },
  {
    name: "SQLite",
    adapter: new SQLiteAdapter(),
    quotedCarrier: `"${COUNT_RESULT_KEY}"`,
  },
];

describe.each(dialects)("$name count result carrier", (dialect) => {
  function createParser() {
    return new ResultParser(dialect.adapter, schema.metric);
  }

  function createScope() {
    return createQueryScope(dialect.adapter, schema.metric);
  }

  test("aliases and parses a plain count with the private carrier", () => {
    const statement = buildCount(createScope(), {}).toStatement("$n");

    expect(statement).toContain(`COUNT(*) AS ${dialect.quotedCarrier}`);
    expect(
      parseResult(createParser(), "count", [{ [COUNT_RESULT_KEY]: 3 }], {})
    ).toBe(3);
  });

  test("aliases the empty-selection simple-count branch", () => {
    const statement = buildCount(createScope(), {
      select: { count: false },
    }).toStatement("$n");

    expect(statement).toContain(`COUNT(*) AS ${dialect.quotedCarrier}`);
  });

  test("keeps a selected scalar named count as an object field", () => {
    const statement = buildCount(createScope(), {
      select: { count: true },
    }).toStatement("$n");

    expect(statement).toContain(
      `AS ${dialect.name === "MySQL" ? "`count`" : '"count"'}`
    );
    expect(
      parseResult(createParser(), "count", [{ count: 2 }], {
        select: { count: true },
      })
    ).toEqual({ count: 2 });
  });

  test("keeps a selected scalar named _result as an object field", () => {
    const statement = buildCount(createScope(), {
      select: { _result: true },
    }).toStatement("$n");

    expect(statement).toContain(
      `AS ${dialect.name === "MySQL" ? "`_result`" : '"_result"'}`
    );
    expect(
      parseResult(createParser(), "count", [{ _result: 4 }], {
        select: { _result: true },
      })
    ).toEqual({ _result: 4 });
  });

  test("rejects unknown and mixed private result shapes", () => {
    const parser = createParser();

    expect(() =>
      parseResult(parser, "count", [{ unexpected: 1 }], {})
    ).toThrow();
    expect(() =>
      parseResult(
        parser,
        "count",
        [{ [COUNT_RESULT_KEY]: 1, unexpected: 2 }],
        {}
      )
    ).toThrow();
  });
});
