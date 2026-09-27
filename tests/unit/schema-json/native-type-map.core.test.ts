/**
 * Issue #45 — a native type per dialect in a schema document.
 *
 * `nativeByDialect` is the map spelled as data — the value a coded schema
 * passes, each entry spelled like `native` — and it is mutually exclusive with
 * `native`, the tagged shorthand. The reader normalizes both into the one
 * scalar declaration; the serializer restates each in its own form, so a
 * shorthand document stays byte-identical and a map (even a single-entry one)
 * never collapses into the active dialect's entry.
 */

import { ValidationError } from "@errors";
import { s } from "@schema";
import { parseSchema, serializeSchema } from "@schema/json";
import {
  MYSQL,
  type NativeTypeDeclaration,
  nativeTypeFor,
  PG,
  SQLITE,
} from "@schema/scalars/native-types";
import { describe, expect, it } from "vitest";

function refusal(input: object): ValidationError {
  try {
    parseSchema(input);
  } catch (thrown) {
    if (thrown instanceof ValidationError) return thrown;
    throw thrown;
  }
  throw new Error("parseSchema accepted a document it must refuse");
}

/** Every issue rendered as `<code> <pointer>`, the pair a reader acts on. */
const issues = (error: ValidationError): string[] =>
  error.issues.map((issue) => `${issue.message.slice(0, 6)} ${issue.path}`);

const withProbe = (field: object) => ({
  version: 1,
  models: {
    user: { fields: { id: { type: "string", id: true }, probe: field } },
  },
});

const declarationOf = (document: object): NativeTypeDeclaration | undefined =>
  parseSchema(document).user?.["~"].state.scalars.probe?.["~"].nativeType;

const perDialect = (declaration: NativeTypeDeclaration | undefined) => ({
  pg: nativeTypeFor(declaration, "pg")?.type,
  mysql: nativeTypeFor(declaration, "mysql")?.type,
  sqlite: nativeTypeFor(declaration, "sqlite")?.type,
});

describe("round trips", () => {
  const schema = () => ({
    user: s.model({
      id: s.string().id(),
      body: s.string({
        pg: PG.STRING.CITEXT,
        mysql: MYSQL.STRING.LONGTEXT,
        sqlite: SQLITE.STRING.TEXT,
      }),
      handle: s.string({ pg: PG.STRING.VARCHAR(80) }).unique(),
      at: s
        .dateTime({
          sqlite: SQLITE.DATETIME.INTEGER,
          pg: PG.DATETIME.TIMESTAMP(3),
        })
        .nullable()
        .map("at_ms"),
      kind: s.enum(["a", "b"], { mysql: MYSQL.STRING.VARCHAR(8) }),
      legacy: s.string(MYSQL.STRING.VARCHAR(80)),
    }),
  });

  it("restates every entry of a map, in dialect order, never collapsing it", () => {
    const fields = serializeSchema(schema()).models.user?.fields;
    expect(fields?.body).toEqual({
      type: "string",
      nativeByDialect: {
        pg: { db: "pg", type: "citext" },
        mysql: { db: "mysql", type: "LONGTEXT" },
        sqlite: { db: "sqlite", type: "TEXT" },
      },
    });
    // A single-entry map keeps its own form rather than becoming `native`.
    expect(fields?.handle).toEqual({
      type: "string",
      nativeByDialect: { pg: { db: "pg", type: "varchar(80)" } },
      unique: true,
    });
    expect(Object.keys(fields?.at ?? {})).toContain("nativeByDialect");
    expect(fields?.at).not.toHaveProperty("native");
    expect(
      JSON.stringify(
        serializeSchema({
          user: s.model({
            id: s.string().id(),
            at: s.dateTime({
              sqlite: SQLITE.DATETIME.INTEGER,
              pg: PG.DATETIME.TIMESTAMP(3),
            }),
          }),
        }).models.user?.fields.at
      )
    ).toBe(
      '{"type":"datetime","nativeByDialect":{"pg":{"db":"pg","type":"timestamp(3)"},"sqlite":{"db":"sqlite","type":"INTEGER"}}}'
    );
  });

  it("keeps a shorthand document byte-identical", () => {
    expect(
      JSON.stringify(serializeSchema(schema()).models.user?.fields.legacy)
    ).toBe('{"type":"string","native":{"db":"mysql","type":"VARCHAR(80)"}}');
  });

  it("parses, serializes and parses again to the same document", () => {
    const document = serializeSchema(schema());
    const text = JSON.stringify(document);
    const again = serializeSchema(parseSchema(JSON.parse(text)));
    expect(JSON.stringify(again)).toBe(text);
    const parsed = parseSchema(JSON.parse(text)).user?.["~"].state.scalars;
    expect(perDialect(parsed?.body?.["~"].nativeType)).toEqual({
      pg: "citext",
      mysql: "LONGTEXT",
      sqlite: "TEXT",
    });
    expect(perDialect(parsed?.at?.["~"].nativeType)).toEqual({
      pg: "timestamp(3)",
      mysql: undefined,
      sqlite: "INTEGER",
    });
    expect(parsed?.at?.["~"].state.nullable).toBe(true);
    expect(parsed?.at?.["~"].state.columnName).toBe("at_ms");
  });

  it("does not alias the scalar's declaration", () => {
    const scalar = s.string({ pg: PG.STRING.CITEXT });
    const document = serializeSchema({
      user: s.model({ id: s.string().id(), body: scalar }),
    });
    const field = document.models.user?.fields.body;
    if (field === undefined || !("nativeByDialect" in field)) {
      throw new Error("the body field carries a map");
    }
    const entry = field.nativeByDialect?.pg;
    if (entry !== undefined) Object.assign(entry, { type: "text" });
    expect(nativeTypeFor(scalar["~"].nativeType, "pg")?.type).toBe("citext");
  });
});

describe("the reader", () => {
  it("normalizes a map into the scalar's declaration", () => {
    expect(
      perDialect(
        declarationOf(
          withProbe({
            type: "int",
            nativeByDialect: {
              mysql: { db: "mysql", type: "SMALLINT" },
              pg: { db: "pg", type: "smallint" },
            },
          })
        )
      )
    ).toEqual({ pg: "smallint", mysql: "SMALLINT", sqlite: undefined });
  });

  it("refuses both spellings on one field", () => {
    expect(
      issues(
        refusal(
          withProbe({
            type: "string",
            native: { db: "pg", type: "citext" },
            nativeByDialect: { mysql: { db: "mysql", type: "LONGTEXT" } },
          })
        )
      )
    ).toEqual(["[J003] /models/user/fields/probe/nativeByDialect"]);
  });

  it("refuses an unknown dialect key beside a real one", () => {
    expect(
      issues(
        refusal(
          withProbe({
            type: "string",
            nativeByDialect: {
              pg: { db: "pg", type: "citext" },
              oracle: { db: "pg", type: "text" },
            },
          })
        )
      )
    ).toEqual(["[J003] /models/user/fields/probe/nativeByDialect/oracle"]);
  });

  it("refuses an entry of another dialect, at its own pointer", () => {
    expect(
      issues(
        refusal(
          withProbe({
            type: "string",
            nativeByDialect: { mysql: { db: "pg", type: "citext" } },
          })
        )
      )
    ).toEqual(["[J004] /models/user/fields/probe/nativeByDialect/mysql/db"]);
  });

  it("refuses an entry outside its dialect's catalog", () => {
    expect(
      issues(
        refusal(
          withProbe({
            type: "string",
            nativeByDialect: {
              pg: { db: "pg", type: "text UNIQUE" },
              sqlite: { db: "sqlite", type: "TEXT" },
            },
          })
        )
      )
    ).toEqual(["[J011] /models/user/fields/probe/nativeByDialect/pg/type"]);
  });

  it("refuses a malformed map and malformed entries", () => {
    expect(
      issues(refusal(withProbe({ type: "string", nativeByDialect: [] })))
    ).toEqual(["[J004] /models/user/fields/probe/nativeByDialect"]);
    expect(
      issues(
        refusal(
          withProbe({
            type: "string",
            nativeByDialect: { pg: "citext", mysql: { db: "mysql" } },
          })
        )
      )
    ).toEqual([
      "[J004] /models/user/fields/probe/nativeByDialect/pg",
      "[J004] /models/user/fields/probe/nativeByDialect/mysql/type",
    ]);
  });

  it("leaves an empty map to the factory's refusal, located at the field", () => {
    const error = refusal(withProbe({ type: "string", nativeByDialect: {} }));
    expect(issues(error)).toEqual(["[J010] /models/user/fields/probe"]);
    expect(error.issues[0]?.message).toContain(
      "A native-type map names at least one dialect"
    );
  });

  it("refuses a map on the two scalars without a native type", () => {
    expect(
      issues(
        refusal(
          withProbe({
            type: "decimal",
            precision: 4,
            scale: 1,
            nativeByDialect: { pg: { db: "pg", type: "text" } },
          })
        )
      )
    ).toEqual(["[J003] /models/user/fields/probe/nativeByDialect"]);
    expect(
      issues(
        refusal(
          withProbe({
            type: "point",
            nativeByDialect: { pg: { db: "pg", type: "text" } },
          })
        )
      )
    ).toEqual(["[J007] /models/user/fields/probe/nativeByDialect"]);
  });
});
