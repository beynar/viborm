import { empty, isSql, join, raw, Sql, sql } from "@src/index";

describe("SQL fragment contracts", () => {
  test("rejects malformed string and value cardinalities", () => {
    expect(() => new Sql([], [])).toThrowError("Expected at least 1 string");
    expect(() => new Sql(["SELECT ", " WHERE ", ""], [1])).toThrowError(
      "Expected 3 strings to have 2 values"
    );
  });

  test("flattens nested fragments lazily and caches both projections", () => {
    const predicate = sql`name = ${"Ada"}`;
    const query = sql`SELECT * FROM users WHERE ${predicate} AND active = ${true}`;

    expect(query.values).toEqual(["Ada", true]);
    expect(query.values).toBe(query.values);
    expect(query.strings).toEqual([
      "SELECT * FROM users WHERE name = ",
      " AND active = ",
      "",
    ]);

    const stringsFirst = sql`SELECT ${1}`;
    expect(stringsFirst.strings).toEqual(["SELECT ", ""]);
    expect(stringsFirst.strings).toBe(stringsFirst.strings);
    expect(stringsFirst.values).toEqual([1]);
  });

  test("composes a child whose flat representation is already canonical", () => {
    const child = sql`name = ${"Ada"}`;
    expect(child.toStatement("$n")).toBe("name = $1");

    const query = sql`SELECT * FROM users WHERE ${child} AND active = ${true}`;

    expect(query.toStatement("$n")).toBe(
      "SELECT * FROM users WHERE name = $1 AND active = $2"
    );
    expect(query.values).toEqual(["Ada", true]);
    expect(child.toStatement("?")).toBe("name = ?");
  });

  test("renders and caches every placeholder convention", () => {
    const query = sql`a = ${1} AND b = ${2}`;

    expect(query.toStatement("$n")).toBe("a = $1 AND b = $2");
    expect(query.toStatement("$n")).toBe("a = $1 AND b = $2");
    expect(query.toStatement(":n")).toBe("a = :1 AND b = :2");
    expect(query.toStatement(":n")).toBe("a = :1 AND b = :2");
    expect(query.toStatement()).toBe("a = ? AND b = ?");
    expect(query.toStatement()).toBe("a = ? AND b = ?");
  });

  test("shares a placeholder-free statement across every convention", () => {
    const statement = raw("SELECT 1");

    expect(statement.toStatement()).toBe("SELECT 1");
    expect(statement.toStatement("$n")).toBe("SELECT 1");
    expect(statement.toStatement(":n")).toBe("SELECT 1");
  });

  test("keeps raw interpolation verbatim instead of binding it", () => {
    const fragment = raw`ORDER BY ${"name"} ${"DESC"}`;

    expect(fragment.strings).toEqual(["ORDER BY name DESC"]);
    expect(fragment.values).toEqual([]);
    expect(sql.raw).toBe(raw);
  });

  test("joins bound values and nested fragments", () => {
    const defaultJoin = join([1, 2]);
    expect(defaultJoin.toStatement()).toBe("?,?");
    expect(defaultJoin.values).toEqual([1, 2]);

    const fragment = sql.join(
      [1, sql`COALESCE(${2}, ${3})`, 4],
      ", ",
      "(",
      ")"
    );
    expect(fragment.toStatement("$n")).toBe("($1, COALESCE($2, $3), $4)");
    expect(fragment.values).toEqual([1, 2, 3, 4]);
  });

  test("returns prefix and suffix for an empty join", () => {
    const fragment = join([], ", ", "(", ")");

    expect(fragment.toStatement()).toBe("()");
    expect(fragment.values).toEqual([]);
  });

  test("exposes only the supported helpers on the callable tag", () => {
    expect(sql.raw).toBe(raw);
    expect(sql.empty).toBe(empty);
    expect(sql.join).toBe(join);
    expect(sql`SELECT ${1}`).toBeInstanceOf(Sql);
  });

  test("recognizes local and structurally compatible SQL fragments", () => {
    expect(isSql(sql`SELECT ${1}`)).toBe(true);
    expect(isSql({ strings: ["SELECT ", ""], values: [1] })).toBe(true);

    expect(isSql(null)).toBe(false);
    expect(isSql(1)).toBe(false);
    expect(isSql({})).toBe(false);
    expect(isSql({ strings: [] })).toBe(false);
    expect(isSql({ strings: "SELECT 1", values: [] })).toBe(false);
    expect(isSql({ strings: ["SELECT 1"], values: "not-an-array" })).toBe(
      false
    );
  });

  test("recognizes a local fragment without reading its projections", () => {
    class ProjectionTrapSql extends Sql {
      override get strings(): never {
        throw new Error("strings projection was read");
      }

      override get values(): never {
        throw new Error("values projection was read");
      }
    }

    expect(isSql(new ProjectionTrapSql(["SELECT 1"], []))).toBe(true);
  });
});

describe("coverage low value", () => {
  test("pins incidental callable-function metadata", () => {
    expect(sql.name).toBe("sql");
    expect(sql.length).toBe(1);
    expect(typeof sql.toString()).toBe("string");
  });
});
