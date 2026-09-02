import {
  MySQLAdapter as ExportedMySQLAdapter,
  PostgresAdapter as ExportedPostgresAdapter,
  SQLiteAdapter as ExportedSQLiteAdapter,
  mysqlAdapter,
  postgresAdapter,
  sqliteAdapter,
} from "@adapters";
import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { Sql, sql } from "@sql";

const decimal = { precision: 6, scale: 2 };
const INSERT_STATEMENT = /^INSERT\s+INTO/;

const adapters: { name: string; adapter: DatabaseAdapter }[] = [
  { name: "postgres", adapter: new PostgresAdapter() },
  { name: "mysql", adapter: new MySQLAdapter() },
  { name: "sqlite", adapter: new SQLiteAdapter() },
];

function expectSql(
  fragment: Sql,
  statement: string,
  values: readonly unknown[] = []
): void {
  // biome-ignore lint/suspicious/noMisplacedAssertion: This assertion helper is called only inside Vitest tests.
  expect(fragment.toStatement()).toBe(statement);
  // biome-ignore lint/suspicious/noMisplacedAssertion: This assertion helper is called only inside Vitest tests.
  expect(fragment.values).toEqual(values);
}

function expectComposable(fragments: Sql[]): void {
  for (const fragment of fragments) {
    // biome-ignore lint/suspicious/noMisplacedAssertion: This assertion helper is called only inside Vitest tests.
    expect(fragment).toBeInstanceOf(Sql);
    // biome-ignore lint/suspicious/noMisplacedAssertion: This assertion helper is called only inside Vitest tests.
    expect(fragment.toStatement().length).toBeGreaterThan(0);
    // biome-ignore lint/suspicious/noMisplacedAssertion: This assertion helper is called only inside Vitest tests.
    expect(Array.isArray(fragment.values)).toBe(true);
  }
}

describe("adapter public surface", () => {
  test("reexports each canonical dialect constructor and instance", () => {
    expect(ExportedMySQLAdapter).toBe(MySQLAdapter);
    expect(ExportedPostgresAdapter).toBe(PostgresAdapter);
    expect(ExportedSQLiteAdapter).toBe(SQLiteAdapter);
    expect(mysqlAdapter).toBeInstanceOf(MySQLAdapter);
    expect(postgresAdapter).toBeInstanceOf(PostgresAdapter);
    expect(sqliteAdapter).toBeInstanceOf(SQLiteAdapter);
  });
});

describe("shared adapter SQL vocabulary", () => {
  for (const { name, adapter } of adapters) {
    describe(name, () => {
      test("comparison, membership, range, and existence operators compose parameters", () => {
        const left = sql.raw`left_col`;
        const right = sql`${7}`;
        const values = sql`(${1}, ${2})`;

        expectSql(adapter.operators.eq(left, right), "left_col = ?", [7]);
        expectSql(adapter.operators.neq(left, right), "left_col <> ?", [7]);
        expectSql(adapter.operators.lt(left, right), "left_col < ?", [7]);
        expectSql(adapter.operators.lte(left, right), "left_col <= ?", [7]);
        expectSql(adapter.operators.gt(left, right), "left_col > ?", [7]);
        expectSql(adapter.operators.gte(left, right), "left_col >= ?", [7]);
        expectSql(
          adapter.operators.in(left, values),
          "left_col IN (?, ?)",
          [1, 2]
        );
        expectSql(
          adapter.operators.notIn(left, values),
          "left_col NOT IN (?, ?)",
          [1, 2]
        );
        expectSql(adapter.operators.isNull(left), "left_col IS NULL");
        expectSql(adapter.operators.isNotNull(left), "left_col IS NOT NULL");
        expectSql(
          adapter.operators.between(left, sql`${1}`, sql`${9}`),
          "left_col BETWEEN ? AND ?",
          [1, 9]
        );
        expectSql(
          adapter.operators.notBetween(left, sql`${1}`, sql`${9}`),
          "left_col NOT BETWEEN ? AND ?",
          [1, 9]
        );
        expectSql(
          adapter.operators.exists(sql`SELECT ${1}`),
          "EXISTS (SELECT ?)",
          [1]
        );
        expectSql(
          adapter.operators.notExists(sql`SELECT ${1}`),
          "NOT EXISTS (SELECT ?)",
          [1]
        );
      });

      test("logical operators own their empty, singleton, and plural cases", () => {
        const one = sql`a = ${1}`;
        const two = sql`b = ${2}`;

        expect(adapter.operators.and().toStatement()).toBe(
          name === "sqlite" ? "1" : "TRUE"
        );
        expect(adapter.operators.or().toStatement()).toBe(
          name === "sqlite" ? "0" : "FALSE"
        );
        expect(adapter.operators.and(one)).toBe(one);
        expect(adapter.operators.or(one)).toBe(one);
        expectSql(adapter.operators.and(one, two), "(a = ? AND b = ?)", [1, 2]);
        expectSql(adapter.operators.or(one, two), "(a = ? OR b = ?)", [1, 2]);
        expectSql(adapter.operators.not(one), "NOT (a = ?)", [1]);
      });

      test("portable expressions and aggregates preserve their operands", () => {
        const left = sql`${2}`;
        const right = sql`${3}`;

        expectSql(adapter.expressions.caseWhen([], left), "?", [2]);
        expectSql(
          adapter.expressions.caseWhen(
            [{ when: sql`flag = ${true}`, then: left }],
            right
          ),
          "CASE WHEN flag = ? THEN ? ELSE ? END",
          [true, 2, 3]
        );
        expectSql(adapter.expressions.add(left, right), "(? + ?)", [2, 3]);
        expectSql(adapter.expressions.subtract(left, right), "(? - ?)", [2, 3]);
        expectSql(adapter.expressions.multiply(left, right), "(? * ?)", [2, 3]);
        expectSql(adapter.expressions.divide(left, right), "(? / ?)", [2, 3]);
        expectSql(adapter.expressions.upper(left), "UPPER(?)", [2]);
        expectSql(adapter.expressions.lower(left), "LOWER(?)", [2]);
        expectSql(
          adapter.expressions.coalesce(left, right),
          "COALESCE(?, ?)",
          [2, 3]
        );

        expectSql(adapter.aggregates.count(), "COUNT(*)");
        expectSql(adapter.aggregates.count(left), "COUNT(?)", [2]);
        expectSql(
          adapter.aggregates.countDistinct(left),
          "COUNT(DISTINCT ?)",
          [2]
        );
        expectSql(adapter.aggregates.sum(left), "SUM(?)", [2]);
        expectSql(adapter.aggregates.avg(left), "AVG(?)", [2]);
        expectSql(adapter.aggregates.min(left), "MIN(?)", [2]);
        expectSql(adapter.aggregates.max(left), "MAX(?)", [2]);
      });

      test("clauses, relation filters, subqueries, and set operations remain fragments", () => {
        const columns = sql.raw`id, name`;
        const table = sql.raw`users`;
        const predicate = sql`id = ${1}`;

        expectSql(adapter.clauses.select(columns), "SELECT id, name");
        expectSql(
          adapter.clauses.selectDistinct(columns),
          "SELECT DISTINCT id, name"
        );
        expectSql(adapter.clauses.from(table), "FROM users");
        expectSql(adapter.clauses.where(predicate), "WHERE id = ?", [1]);
        expectSql(adapter.clauses.orderBy(columns), "ORDER BY id, name");
        expectComposable([
          adapter.clauses.limit(sql`${3}`),
          adapter.clauses.offset(sql`${4}`),
        ]);
        expectSql(adapter.clauses.groupBy(columns), "GROUP BY id, name");
        expectSql(adapter.clauses.having(predicate), "HAVING id = ?", [1]);

        const subquery = sql`SELECT ${1}`;
        expectSql(adapter.filters.some(subquery), "EXISTS (SELECT ?)", [1]);
        expectSql(
          adapter.filters.every(subquery),
          "NOT EXISTS (SELECT ?)",
          [1]
        );
        expectSql(adapter.filters.none(subquery), "NOT EXISTS (SELECT ?)", [1]);
        expectSql(adapter.filters.is(subquery), "EXISTS (SELECT ?)", [1]);
        expectSql(
          adapter.filters.isNot(subquery),
          "NOT EXISTS (SELECT ?)",
          [1]
        );
        expectSql(adapter.subqueries.scalar(subquery), "(SELECT ?)", [1]);
        expect(adapter.subqueries.correlate(subquery, "q").values).toEqual([1]);
        expectSql(
          adapter.subqueries.existsCheck(table, predicate),
          "SELECT 1 FROM users WHERE id = ?",
          [1]
        );

        expectSql(
          adapter.setOperations.union(sql`SELECT ${1}`, sql`SELECT ${2}`),
          "SELECT ? UNION SELECT ?",
          [1, 2]
        );
        expectSql(
          adapter.setOperations.unionAll(sql`SELECT ${1}`, sql`SELECT ${2}`),
          "SELECT ? UNION ALL SELECT ?",
          [1, 2]
        );
        expectSql(
          adapter.setOperations.intersect(sql`SELECT ${1}`, sql`SELECT ${2}`),
          "SELECT ? INTERSECT SELECT ?",
          [1, 2]
        );
        expectSql(
          adapter.setOperations.except(sql`SELECT ${1}`, sql`SELECT ${2}`),
          "SELECT ? EXCEPT SELECT ?",
          [1, 2]
        );
      });

      test("CTEs preserve names, union choice, and bound values", () => {
        const ordinary = adapter.cte.with([
          { name: "first", query: sql`SELECT ${1}` },
          { name: "second", query: sql`SELECT ${2}` },
        ]);
        expect(ordinary.toStatement()).toContain("WITH");
        expect(ordinary.values).toEqual([1, 2]);

        const all = adapter.cte.recursive(
          "tree",
          sql`SELECT ${1}`,
          sql`SELECT ${2}`
        );
        const distinct = adapter.cte.recursive(
          "tree",
          sql`SELECT ${1}`,
          sql`SELECT ${2}`,
          "distinct"
        );
        expect(all.toStatement()).toContain("UNION ALL");
        expect(distinct.toStatement()).toContain("UNION\n");
        expect(all.values).toEqual([1, 2]);
        expect(distinct.values).toEqual([1, 2]);
      });

      test("a column without a table alias remains one quoted identifier", () => {
        expect(adapter.identifiers.column("", "field").toStatement()).toBe(
          name === "mysql" ? "`field`" : '"field"'
        );
      });

      test("ordinary assignments and mutations cover optional clauses", () => {
        const table = sql.raw`users`;
        const column = sql.raw`score`;
        const value = sql`${2}`;
        const where = sql`id = ${1}`;

        expectSql(adapter.set.assign(column, value), "score = ?", [2]);
        expectSql(
          adapter.set.increment(column, value),
          "score = score + ?",
          [2]
        );
        expectSql(
          adapter.set.decrement(column, value),
          "score = score - ?",
          [2]
        );
        expectSql(
          adapter.set.multiply(column, value),
          "score = score * ?",
          [2]
        );
        expectSql(adapter.set.divide(column, value), "score = score / ?", [2]);

        expectSql(
          adapter.mutations.update(table, column),
          "UPDATE users SET score"
        );
        expectSql(
          adapter.mutations.update(table, column, where),
          "UPDATE users SET score WHERE id = ?",
          [1]
        );
        expectSql(adapter.mutations.delete(table), "DELETE FROM users");
        expectSql(
          adapter.mutations.delete(table, where),
          "DELETE FROM users WHERE id = ?",
          [1]
        );
      });
    });
  }
});

describe("dialect physical SQL vocabulary", () => {
  const postgres = new PostgresAdapter();
  const mysql = new MySQLAdapter();
  const sqlite = new SQLiteAdapter();

  test("literals retain each provider's physical representation", () => {
    expectSql(postgres.literals.null(), "NULL");
    expectSql(postgres.literals.list([]), "()");
    expectSql(postgres.literals.list([sql`${1}`, sql`${2}`]), "(?, ?)", [1, 2]);
    expectSql(postgres.literals.value("x"), "?", ["x"]);
    expect(postgres.literals.json({ a: 1 }).values).toHaveLength(1);
    expectSql(mysql.literals.json({ a: 1 }), "?", ['{"a":1}']);
    expectSql(sqlite.literals.json({ a: 1 }), "?", ['{"a":1}']);

    const iso = "2024-01-02T03:04:05.006Z";
    expectSql(postgres.literals.dateTime(iso), "?", [iso]);
    expectSql(mysql.literals.dateTime(iso), "?", ["2024-01-02 03:04:05.006"]);
    expectSql(sqlite.literals.dateTime(iso), "?", [iso]);

    expect(postgres.literals.decimal("12.30", decimal).toStatement()).toBe(
      "CAST(? AS NUMERIC(6,2))"
    );
    expect(mysql.literals.decimal("12.30", decimal).toStatement()).toBe(
      "CAST(? AS DECIMAL(6,2))"
    );
    expectSql(sqlite.literals.decimal("12.30", decimal), "CAST(? AS INTEGER)", [
      "1230",
    ]);
  });

  test("text predicates pin case, wildcard, and prefix semantics", () => {
    const column = sql.raw`name`;
    const value = sql`${"A%_\\"}`;

    for (const adapter of [postgres, mysql, sqlite]) {
      expectComposable([
        adapter.operators.like(column, value),
        adapter.operators.notLike(column, value),
        adapter.operators.ilike(column, value),
        adapter.operators.notIlike(column, value),
        adapter.operators.containsText(column, value),
        adapter.operators.startsWithText(column, value),
        adapter.operators.endsWithText(column, value),
        adapter.operators.startsWithPrefix(column, "A%_\\"),
        adapter.operators.exactTextEq(column, value),
        adapter.operators.exactTextIn(column, sql`(${"A"}, ${"B"})`),
      ]);
    }

    expect(postgres.operators.startsWithPrefix(column, "A%_\\").values).toEqual(
      ["A\\%\\_\\\\%"]
    );
    expect(
      mysql.operators.startsWithPrefix(column, "A%_\\").toStatement()
    ).toContain("LEFT(BINARY name");
    expect(sqlite.operators.startsWithPrefix(column, "a*?[").values).toEqual([
      "a[*][?][[]*",
    ]);
  });

  test("dialect expressions cover concatenation, folding, casts, and decimal domains", () => {
    for (const adapter of [postgres, mysql, sqlite]) {
      const only = sql`${1}`;
      expectSql(adapter.expressions.concat(), "''");
      expect(adapter.expressions.concat(only)).toBe(only);
      expectComposable([
        adapter.expressions.concat(sql`${1}`, sql`${2}`),
        adapter.expressions.asciiCaseFold(sql.raw`name`),
        adapter.expressions.caseSensitiveText(sql.raw`name`),
        adapter.expressions.greatest(sql`${1}`, sql`${2}`),
        adapter.expressions.least(sql`${1}`, sql`${2}`),
        adapter.expressions.decimalCast(sql`${"12.30"}`, decimal),
        adapter.expressions.cast(sql`${1}`, "text"),
        adapter.expressions.cast(sql`${1}`, "integer"),
        adapter.expressions.cast(sql`${1}`, "boolean"),
        adapter.expressions.cast(sql`${1}`, "numeric"),
        adapter.expressions.blobToHex(sql.raw`payload`),
      ]);
    }

    expect(
      postgres.expressions.concat(sql.raw`a`, sql.raw`b`).toStatement()
    ).toBe("(a || b)");
    expect(mysql.expressions.concat(sql.raw`a`, sql.raw`b`).toStatement()).toBe(
      "CONCAT(a, b)"
    );
    expect(
      sqlite.expressions.greatest(sql.raw`a`, sql.raw`b`).toStatement()
    ).toBe("MAX(a, b)");
  });

  test("exact decimal aggregate and assignment SQL receives the descriptor", () => {
    const wholeDecimal = { precision: 6, scale: 0 };
    for (const adapter of [postgres, mysql, sqlite]) {
      expectComposable([
        adapter.aggregates.decimalAvg(sql.raw`amount`, decimal),
        adapter.aggregates.decimalAvg(sql.raw`amount`, wholeDecimal),
        adapter.set.increment(sql.raw`amount`, sql`${"1.20"}`, { decimal }),
        adapter.set.increment(sql.raw`amount`, sql`${"1"}`, {
          decimal: wholeDecimal,
        }),
        adapter.set.decrement(sql.raw`amount`, sql`${"1.20"}`, { decimal }),
        adapter.set.decrement(sql.raw`amount`, sql`${"1"}`, {
          decimal: wholeDecimal,
        }),
        adapter.set.multiply(sql.raw`amount`, sql`${"1.20"}`, { decimal }),
        adapter.set.multiply(sql.raw`amount`, sql`${"1"}`, {
          decimal: wholeDecimal,
        }),
        adapter.set.divide(sql.raw`amount`, sql`${"1.20"}`, { decimal }),
        adapter.set.divide(sql.raw`amount`, sql`${"1"}`, {
          decimal: wholeDecimal,
        }),
      ]);
    }

    expect(postgres.aggregates.decimalSumOperandPrecision("-123")).toBe(3);
    expect(
      postgres.aggregates.decimalSumOperandPrecision("1".repeat(1001))
    ).toBeUndefined();
    expect(mysql.aggregates.decimalSumOperandPrecision("1".repeat(65))).toBe(
      65
    );
    expect(
      mysql.aggregates.decimalSumOperandPrecision("1".repeat(66))
    ).toBeUndefined();
    expect(
      sqlite.aggregates.decimalSumOperandPrecision("9223372036854775807")
    ).toBe(19);
    expect(
      sqlite.aggregates.decimalSumOperandPrecision("-9223372036854775808")
    ).toBe(19);
    expect(
      sqlite.aggregates.decimalSumOperandPrecision("9223372036854775808")
    ).toBeUndefined();
    expect(
      sqlite.aggregates.decimalSumOperandPrecision("-9223372036854775809")
    ).toBeUndefined();
    expect(
      sqlite.aggregates.decimalSumOperandPrecision("1".repeat(20))
    ).toBeUndefined();
    expect(sqlite.aggregates.decimalSumOperandPrecision("123")).toBe(3);
  });

  test("JSON builders cover empty and populated documents and portable paths", () => {
    for (const adapter of [postgres, mysql, sqlite]) {
      expectComposable([
        adapter.json.boolean(sql`active = ${true}`),
        adapter.json.document(sql`document_value`),
        adapter.json.object([]),
        adapter.json.object([["id", sql`${1}`]]),
        adapter.json.array([]),
        adapter.json.array([sql`${1}`]),
        adapter.json.emptyArray(),
        adapter.json.agg(sql.raw`row_value`),
        adapter.json.objectFromColumns([]),
        adapter.json.objectFromColumns([["id", sql`${1}`]]),
        adapter.json.extract(sql.raw`document_value`, []),
        adapter.json.extract(sql.raw`document_value`, ["items", "0", "a.b"]),
        adapter.json.extractText(sql.raw`document_value`, []),
        adapter.json.extractText(sql.raw`document_value`, ["items", "0"]),
        adapter.json.numberAtPath(sql.raw`document_value`, ["score"]),
        adapter.json.stringAtPath(sql.raw`document_value`, ["name"]),
        adapter.json.contains(sql.raw`document_value`, sql`${"[1]"}`),
        adapter.json.lastElement(sql.raw`document_value`),
        adapter.json.value({ id: 1 }),
      ]);
    }

    expect(
      mysql.json.extract(sql.raw`doc`, ["items", "0", "a.b"]).values
    ).toEqual(['$."items"[0]."a.b"']);
    expect(sqlite.json.extract(sql.raw`doc`, ["items", "0"]).values).toEqual([
      '$."items"',
      "$[0]",
    ]);
    expect(postgres.json.extract(sql.raw`doc`, ["items", "0"]).values).toEqual([
      ["items", "0"],
    ]);
    expect(() => sqlite.json.extract(sql.raw`doc`, ['a"b'])).toThrow(
      "portable query contract"
    );
    expect(() => sqlite.json.extractText(sql.raw`doc`, ["a\\b"])).toThrow(
      "portable query contract"
    );
  });

  test("array vocabulary covers native and JSON containers", () => {
    for (const adapter of [postgres, mysql, sqlite]) {
      expectComposable([
        adapter.arrays.literal([]),
        adapter.arrays.literal([sql`${1}`, sql`${2}`]),
        adapter.arrays.value([1, 2]),
        adapter.arrays.enumValue(["ADMIN", "USER"]),
        adapter.arrays.has(sql.raw`roles`, sql`${"ADMIN"}`),
        adapter.arrays.hasEvery(sql.raw`roles`, sql`${["ADMIN"]}`),
        adapter.arrays.hasSome(sql.raw`roles`, sql`${["ADMIN"]}`),
        adapter.arrays.isEmpty(sql.raw`roles`),
        adapter.arrays.decimalProjection(sql.raw`amounts`),
        adapter.set.push(sql.raw`roles`, adapter.arrays.value(["ADMIN"])),
        adapter.set.unshift(sql.raw`roles`, adapter.arrays.value(["ADMIN"])),
      ]);
    }

    expect(
      postgres.arrays.enumValue(["", "NULL", 'a"b', "c\\d", "x,y"]).values
    ).toEqual(['{"","NULL","a\\"b","c\\\\d","x,y"}']);
    expect(mysql.arrays.value([1n]).values).toEqual(['["1"]']);
    expect(sqlite.arrays.value([1n]).values).toEqual(['["1"]']);
    expect(mysql.arrays.value).toBe(mysql.arrays.enumValue);
    expect(sqlite.arrays.value).toBe(sqlite.arrays.enumValue);
  });

  test("ordering and integer division keep dialect semantics", () => {
    for (const adapter of [postgres, mysql, sqlite]) {
      expectSql(adapter.orderBy.asc(sql.raw`name`), "name ASC");
      expectSql(adapter.orderBy.desc(sql.raw`name`), "name DESC");
      expectComposable([
        adapter.orderBy.nullsFirst(sql.raw`name`, "asc"),
        adapter.orderBy.nullsFirst(sql.raw`name`, "desc"),
        adapter.orderBy.nullsLast(sql.raw`name`, "asc"),
        adapter.orderBy.nullsLast(sql.raw`name`, "desc"),
      ]);
    }

    expectSql(
      mysql.set.divide(sql.raw`count`, sql`${2}`, { integer: true }),
      "count = TRUNCATE(count / ?, 0)",
      [2]
    );
    expectSql(
      sqlite.set.divide(sql.raw`count`, sql`${2}`, { integer: true }),
      "count = count / CAST(? AS INTEGER)",
      [2]
    );
  });

  test("insert, conflict, returning, assertions, and identities stay dialect-correct", () => {
    for (const adapter of [postgres, mysql, sqlite]) {
      const table = adapter.identifiers.escape("users");
      const rows = [[sql`${1}`, sql`${"Ada"}`]];
      const insert = adapter.mutations.insert(table, ["id", "name"], rows);
      const insertSelect = adapter.mutations.insert(
        table,
        ["id"],
        { select: sql`SELECT ${1}` },
        sql.empty
      );
      expect(insert.toStatement()).toContain("INSERT INTO");
      expect(insert.values).toEqual([1, "Ada"]);
      expect(insertSelect.toStatement()).toMatch(INSERT_STATEMENT);
      expect(insertSelect.values).toEqual([1]);
      expectComposable([
        adapter.mutations.insertDefault(table),
        adapter.mutations.onConflict(sql.raw`id`, sql.raw`NOTHING`),
        adapter.mutations.onConflictUpdate(sql`name = ${"Ada"}`),
        adapter.assertions.exists(sql`SELECT ${1}`),
        adapter.assertions.notExists(sql`SELECT ${1}`),
        adapter.lastInsertId(),
      ]);
    }

    expectComposable([
      postgres.mutations.onConflict(null, sql.raw`NOTHING`),
      postgres.mutations.onConflict(
        sql.raw`id`,
        sql.raw`NOTHING`,
        sql`active = ${true}`
      ),
      postgres.mutations.onConflictUpdate(
        sql`name = ${"Ada"}`,
        sql`active = ${true}`
      ),
      sqlite.mutations.onConflict(null, sql.raw`NOTHING`),
      sqlite.mutations.onConflict(
        sql.raw`id`,
        sql.raw`NOTHING`,
        sql`active = ${true}`
      ),
      sqlite.mutations.onConflictUpdate(
        sql`name = ${"Ada"}`,
        sql`active = ${true}`
      ),
    ]);

    expect(mysql.mutations.returning(sql.raw`id`).toStatement()).toBe("");
    expect(postgres.mutations.returning(sql.raw`id`).toStatement()).toBe(
      "RETURNING id"
    );
    expect(sqlite.mutations.returning(sql.raw`id`).toStatement()).toBe(
      "RETURNING id"
    );
    expect(
      mysql.mutations.onConflictUpdate(sql.raw`name = VALUES(name)`)
    ).toBeDefined();
    expect(
      mysql.mutations
        .onConflict(sql.raw`id`, sql.raw`name = VALUES(name)`)
        .toStatement()
    ).toBe("ON DUPLICATE KEY UPDATE name = VALUES(name)");
    expect(postgres.mutations.skipDuplicates("id").suffix.toStatement()).toBe(
      "ON CONFLICT DO NOTHING"
    );
    expect(sqlite.mutations.skipDuplicates("id").suffix.toStatement()).toBe(
      "ON CONFLICT DO NOTHING"
    );
    expect(mysql.mutations.skipDuplicates("i`d").suffix.toStatement()).toBe(
      "ON DUPLICATE KEY UPDATE `i``d` = `i``d`"
    );
  });

  test("join support fails closed where the capability is absent", () => {
    const table = sql.raw`posts`;
    const condition = sql.raw`posts.user_id = users.id`;

    for (const adapter of [postgres, mysql, sqlite]) {
      expectComposable([
        adapter.joins.inner(table, condition),
        adapter.joins.left(table, condition),
        adapter.joins.cross(table),
      ]);
    }
    expectComposable([
      postgres.joins.right(table, condition),
      postgres.joins.full(table, condition),
      postgres.joins.lateral(sql`SELECT ${1}`, "p"),
      postgres.joins.lateralLeft(sql`SELECT ${1}`, "p"),
      mysql.joins.right(table, condition),
      mysql.joins.lateral(sql`SELECT ${1}`, "p"),
      mysql.joins.lateralLeft(sql`SELECT ${1}`, "p"),
    ]);

    expect(() => mysql.joins.full(table, condition)).toThrow(
      "MySQL does not support FULL OUTER JOIN"
    );
    expect(() => sqlite.joins.right(table, condition)).toThrow(
      "SQLite does not support RIGHT JOIN"
    );
    expect(() => sqlite.joins.full(table, condition)).toThrow(
      "SQLite does not support FULL OUTER JOIN"
    );
    expect(() => sqlite.joins.lateral(sql`SELECT ${1}`, "p")).toThrow(
      "SQLite does not support LATERAL joins"
    );
    expect(() => sqlite.joins.lateralLeft(sql`SELECT ${1}`, "p")).toThrow(
      "SQLite does not support LATERAL joins"
    );
  });

  test("capability flags describe the grammar each adapter exposes", () => {
    expect(postgres.capabilities).toEqual({
      supportsReturning: true,
      supportsCteWithMutations: true,
      supportsFullOuterJoin: true,
      supportsLateralJoins: true,
      supportsVector: false,
      supportsUpsertWhere: true,
      supportsTargetedUpsert: true,
      supportsMutationTargetInSubquery: true,
      supportsMutationRowLimit: false,
    });
    expect(mysql.capabilities).toEqual({
      supportsReturning: false,
      supportsCteWithMutations: false,
      supportsFullOuterJoin: false,
      supportsLateralJoins: true,
      supportsVector: false,
      supportsUpsertWhere: false,
      supportsTargetedUpsert: false,
      supportsMutationTargetInSubquery: false,
      supportsMutationRowLimit: true,
    });
    expect(sqlite.capabilities).toEqual({
      supportsReturning: true,
      supportsCteWithMutations: false,
      supportsFullOuterJoin: false,
      supportsLateralJoins: false,
      supportsVector: false,
      supportsUpsertWhere: true,
      supportsTargetedUpsert: true,
      supportsMutationTargetInSubquery: true,
      supportsMutationRowLimit: false,
    });
  });
});

describe("coverage low value", () => {
  test("reserved expression and array members still return composable SQL", () => {
    for (const { adapter } of adapters) {
      expectComposable([
        adapter.arrays.length(sql.raw`items`),
        adapter.arrays.get(sql.raw`items`, sql`${0}`),
        adapter.arrays.push(sql.raw`items`, sql`${1}`),
        adapter.arrays.set(sql.raw`items`, sql`${0}`, sql`${1}`),
        adapter.expressions.greatest(sql`${1}`, sql`${2}`),
        adapter.expressions.least(sql`${1}`, sql`${2}`),
      ]);
    }
  });

  test("PostgreSQL's reserved vector primitives remain renderable", () => {
    const adapter = new PostgresAdapter();
    expectComposable([
      adapter.vector.literal([1, 2, 3]),
      adapter.vector.l2(sql.raw`embedding`, sql`${"[1,2,3]"}`),
      adapter.vector.cosine(sql.raw`embedding`, sql`${"[1,2,3]"}`),
    ]);
  });
});
