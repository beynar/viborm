/**
 * Issue #45 — definition-time rules over a native type per dialect.
 *
 * No dialect is bound when a schema is validated, and each dialect a map names
 * is a column some migration will create. So the identifier-storage rules
 * (F013, FK012) and the SQLite DateTime foreign-key form are asked of EVERY
 * dialect the declaration selects, through the one resolver — never only the
 * dialect a tagged shorthand happened to name.
 */

import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import type { Model } from "@schema/model";
import {
  MYSQL,
  type NativeType,
  type NativeTypeMap,
  PG,
  SQLITE,
} from "@schema/scalars/native-types";
import { validateSchema } from "@schema/validation";
import { resolveSchemaRelations } from "@schema/validation/relation-resolution";
import { describe, expect, test } from "vitest";

const DIALECT_NAMED = /the (\w+) column/;
const SAME_SQLITE_DATETIME_FORM = /same SQLite DateTime physical form/i;

/** The issues the relation-resolution gate refuses a schema with. */
const refusal = (schema: Record<string, Model<any>>) => {
  hydrateSchemaNames(schema);
  const models = new Map(Object.entries(schema));
  const modelToName = new Map<Model<any>, string>();
  for (const [name, model] of models) modelToName.set(model, name);
  const resolution = resolveSchemaRelations(models, {
    modelToName,
    tableToModels: new Map(),
  });
  return resolution.ok ? [] : resolution.issues;
};

describe("F013 — an entry the identifier domain cannot live in", () => {
  test("is refused on the dialect whose entry it is", () => {
    const user = s.model({
      id: s.string({ pg: PG.STRING.TEXT, mysql: MYSQL.INT.INT }).id().uuid(),
    });
    const issues = refusal({ user }).filter((issue) => issue.code === "F013");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("the mysql column 'INT'");
    expect(issues[0]?.repair).toContain("BINARY(16), VARBINARY(16), BLOB");
  });

  test("is refused once per unusable entry", () => {
    const user = s.model({
      id: s
        .string({
          pg: PG.INT.INTEGER,
          mysql: MYSQL.INT.INT,
          sqlite: SQLITE.INT.INTEGER,
        })
        .id()
        .ulid(),
    });
    const dialects = refusal({ user })
      .filter((issue) => issue.code === "F013")
      .map((issue) => DIALECT_NAMED.exec(issue.message)?.[1]);
    expect(dialects).toEqual(["pg", "mysql", "sqlite"]);
  });

  test("a map of usable entries is accepted", () => {
    const user = s.model({
      id: s
        .string({
          pg: PG.BLOB.BYTEA,
          mysql: MYSQL.STRING.VARCHAR(36),
          sqlite: SQLITE.STRING.TEXT,
        })
        .id()
        .uuid(),
    });
    expect(refusal({ user })).toEqual([]);
  });
});

describe("FK012 — a foreign key stores its key the way the key does", () => {
  const schemaWith = (
    keyStorage: NativeType | NativeTypeMap,
    foreignStorage: NativeType | NativeTypeMap
  ) => {
    const user = s.model({
      id: s.string(keyStorage).id().uuid(),
      posts: s.toMany(() => post),
    });
    const post = s.model({
      id: s.string().id(),
      authorId: s.string(foreignStorage),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    });
    return { user, post };
  };

  test("disagreement on a dialect only the map names is refused, naming it", () => {
    const issue = refusal(
      schemaWith(
        { pg: PG.BLOB.BYTEA, mysql: MYSQL.STRING.VARCHAR(36) },
        {
          pg: PG.BLOB.BYTEA,
        }
      )
    ).find((entry) => entry.code === "FK012");
    expect(issue?.message).toContain("on mysql");
    expect(issue?.message).toContain("BINARY(16)");
    expect(issue?.message).toContain("VARCHAR(36)");
  });

  test("the same map on both columns is accepted", () => {
    const storage = { pg: PG.BLOB.BYTEA, mysql: MYSQL.STRING.VARCHAR(36) };
    expect(refusal(schemaWith(storage, storage))).toEqual([]);
  });

  test("a map and a shorthand that store alike are accepted", () => {
    expect(
      refusal(schemaWith({ pg: PG.STRING.TEXT }, PG.STRING.VARCHAR(40)))
    ).toEqual([]);
  });
});

describe("a DateTime foreign key's SQLite form", () => {
  const reference = (
    local: NativeType | NativeTypeMap,
    remote: NativeType | NativeTypeMap
  ) => {
    const parent = s.model({
      at: s.dateTime(remote).id(),
      children: s.toMany(() => child),
    });
    const child = s.model({
      id: s.string().id(),
      parentAt: s.dateTime(local),
      parent: s
        .toOne(() => parent)
        .fields("parentAt")
        .references("at"),
    });
    return validateSchema({ parent, child });
  };

  test("is read from the map's SQLite entry", () => {
    expect(
      reference(
        { pg: PG.DATETIME.TIMESTAMP(3), sqlite: SQLITE.DATETIME.INTEGER },
        SQLITE.DATETIME.INTEGER
      ).valid
    ).toBe(true);
    const refused = reference(
      { pg: PG.DATETIME.TIMESTAMP(3), sqlite: SQLITE.DATETIME.REAL },
      { sqlite: SQLITE.DATETIME.INTEGER }
    );
    const issue = refused.errors.find((entry) => entry.code === "FK003");
    expect(issue?.message).toContain("datetime(julianDay)");
    expect(issue?.repair).toMatch(SAME_SQLITE_DATETIME_FORM);
  });

  test("a map without a SQLite entry is SQLite's TEXT form", () => {
    expect(
      reference({ pg: PG.DATETIME.TIMESTAMP(3) }, SQLITE.DATETIME.TEXT).valid
    ).toBe(true);
  });
});
