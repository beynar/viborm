/**
 * Issue #45 — one scalar, a native type per dialect.
 *
 * The declaration boundary (`admitNativeType`, `native-catalog.ts`) and the one
 * bound-dialect resolver (`nativeTypeFor`, `native-types.ts`). Every scalar
 * factory that takes a native type takes the map; the map is held to its
 * contract at runtime, where TypeScript can be bypassed, and snapshot; the
 * tagged shorthand keeps its historical open contract.
 */

import { ValidationError } from "@errors";
import { s } from "@schema";
import {
  MYSQL,
  NATIVE_DIALECTS,
  type NativeTypeDeclaration,
  nativeTypeFor,
  PG,
  SQLITE,
} from "@schema/scalars/native-types";
import { describe, expect, it } from "vitest";

/** A factory reached without its TypeScript surface, as untyped JS reaches it. */
type Untyped = (declaration: unknown) => {
  readonly "~": { readonly nativeType?: NativeTypeDeclaration | undefined };
};

const untyped = (factory: unknown): Untyped => factory as Untyped;
const untypedEnum = s.enum as unknown as (
  values: string[],
  declaration: unknown
) => ReturnType<Untyped>;

const FACTORIES: readonly (readonly [string, Untyped])[] = [
  ["s.string", untyped(s.string)],
  ["s.int", untyped(s.int)],
  ["s.number", untyped(s.number)],
  ["s.bigInt", untyped(s.bigInt)],
  ["s.boolean", untyped(s.boolean)],
  ["s.dateTime", untyped(s.dateTime)],
  ["s.date", untyped(s.date)],
  ["s.time", untyped(s.time)],
  ["s.json", untyped(s.json)],
  ["s.blob", untyped(s.blob)],
  ["s.vector", untyped(s.vector)],
  ["s.enum", (declaration) => untypedEnum(["a", "b"], declaration)],
];

const ISSUE_MAP = {
  pg: PG.STRING.CITEXT,
  mysql: MYSQL.STRING.LONGTEXT,
  sqlite: SQLITE.STRING.TEXT,
};

const resolved = (declaration: NativeTypeDeclaration | undefined) =>
  Object.fromEntries(
    NATIVE_DIALECTS.map((dialect) => [
      dialect,
      nativeTypeFor(declaration, dialect)?.type,
    ])
  );

/** The refusal, with its builder and path, or a failure naming what happened. */
function refusal(run: () => unknown): {
  builder: string | undefined;
  path: string | undefined;
  message: string;
} {
  try {
    run();
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    const source = error.source;
    return {
      builder: source.kind === "schema-builder" ? source.builder : undefined,
      path: source.kind === "schema-builder" ? source.path : undefined,
      message: error.message,
    };
  }
  throw new Error("expected a ValidationError");
}

describe("nativeTypeFor — the one bound-dialect resolver", () => {
  it("answers the automatic column for no declaration", () => {
    expect(resolved(undefined)).toEqual({
      pg: undefined,
      mysql: undefined,
      sqlite: undefined,
    });
  });

  it("answers a tagged shorthand on its own dialect only", () => {
    expect(resolved(PG.STRING.CITEXT)).toEqual({
      pg: "citext",
      mysql: undefined,
      sqlite: undefined,
    });
    expect(nativeTypeFor(PG.STRING.CITEXT, "pg")).toBe(PG.STRING.CITEXT);
  });

  it("answers each entry of a map, and nothing for an omitted dialect", () => {
    expect(
      resolved({ pg: PG.STRING.CITEXT, sqlite: SQLITE.STRING.TEXT })
    ).toEqual({ pg: "citext", mysql: undefined, sqlite: "TEXT" });
  });
});

describe("every native-typed factory takes the map", () => {
  it.each(
    FACTORIES
  )("%s stores a map that selects per dialect", (_name, factory) => {
    const scalar = factory(ISSUE_MAP);
    expect(resolved(scalar["~"].nativeType)).toEqual({
      pg: "citext",
      mysql: "LONGTEXT",
      sqlite: "TEXT",
    });
  });

  it.each(
    FACTORIES
  )("%s refuses an unknown dialect beside a real one", (name, factory) => {
    expect(
      refusal(() => factory({ pg: PG.STRING.TEXT, oracle: PG.STRING.TEXT }))
    ).toEqual({
      builder: name,
      path: "nativeType.oracle",
      message: expect.stringContaining(
        "'oracle' is not a dialect: a native-type map names only pg, mysql, sqlite"
      ),
    });
  });

  it("keeps decimal and point without a native-type argument", () => {
    expect(
      s.decimal({ precision: 4, scale: 1 })["~"].nativeType
    ).toBeUndefined();
    expect(s.point()["~"].nativeType).toBeUndefined();
  });
});

describe("a map entry", () => {
  it("admits a parameterized constant of its own dialect", () => {
    const scalar = s.string({
      pg: PG.STRING.VARCHAR(80),
      mysql: MYSQL.STRING.VARCHAR(80),
    });
    const stamp = s.dateTime({
      pg: PG.DATETIME.TIMESTAMP(3),
      mysql: MYSQL.DATETIME.DATETIME(6),
      sqlite: SQLITE.DATETIME.INTEGER,
    });
    const bytes = s.blob({ mysql: MYSQL.BLOB.VARBINARY(255) });
    const bits = s.string({ pg: PG.STRING.VARBIT() });
    expect(resolved(scalar["~"].nativeType)).toEqual({
      pg: "varchar(80)",
      mysql: "VARCHAR(80)",
      sqlite: undefined,
    });
    expect(resolved(stamp["~"].nativeType)).toEqual({
      pg: "timestamp(3)",
      mysql: "DATETIME(6)",
      sqlite: "INTEGER",
    });
    expect(resolved(bytes["~"].nativeType).mysql).toBe("VARBINARY(255)");
    expect(resolved(bits["~"].nativeType).pg).toBe("varbit");
  });

  const refused: readonly (readonly [string, unknown, string, string])[] = [
    [
      "another dialect's constant",
      { mysql: PG.STRING.CITEXT },
      "nativeType.mysql",
      "The 'mysql' entry must be a MYSQL native type",
    ],
    [
      "another dialect's parameterized constant",
      { pg: MYSQL.STRING.VARCHAR(80) },
      "nativeType.pg",
      "The 'pg' entry must be a PG native type",
    ],
    [
      "an entry that is not an object",
      { sqlite: "TEXT" },
      "nativeType.sqlite",
      "The 'sqlite' entry must be a SQLITE native type",
    ],
    [
      "an entry without a type",
      { sqlite: { db: "sqlite" } },
      "nativeType.sqlite",
      "The 'sqlite' entry must be a SQLITE native type",
    ],
    [
      "an explicitly undefined entry",
      { pg: undefined },
      "nativeType.pg",
      "The 'pg' entry must be a PG native type",
    ],
    [
      "an empty map",
      {},
      "nativeType",
      "A native-type map names at least one dialect",
    ],
    [
      "a map whose entries are only inherited",
      Object.create({ pg: PG.STRING.CITEXT }),
      "nativeType",
      "A native-type map names at least one dialect",
    ],
    [
      "a tagged native type beside a dialect key",
      { db: "pg", type: "text", mysql: MYSQL.STRING.LONGTEXT },
      "nativeType.mysql",
      "A tagged native type ('db: pg') cannot also carry a 'mysql' entry",
    ],
    [
      "a tagged native type of an unknown dialect",
      { db: "oracle", type: "text" },
      "nativeType",
      "A tagged native type is `{ db, type }`",
    ],
    [
      "a tagged native type without a type",
      { db: "pg" },
      "nativeType",
      "A tagged native type is `{ db, type }`",
    ],
    [
      "a tagged native type with a misspelled type",
      { db: "pg", typ: "citext" },
      "nativeType",
      "A tagged native type is `{ db, type }`",
    ],
    [
      "a tagged native type whose type is not a string",
      { db: "pg", type: 5 },
      "nativeType",
      "A tagged native type is `{ db, type }`",
    ],
    [
      "a type without a dialect tag",
      { type: "text" },
      "nativeType.type",
      "'type' is not a dialect",
    ],
    [
      "a declaration that is not an object",
      "citext",
      "nativeType",
      "A native type is a `{ db, type }` constant or a map of them by dialect",
    ],
    [
      "null",
      null,
      "nativeType",
      "A native type is a `{ db, type }` constant or a map of them by dialect",
    ],
  ];

  it.each(
    refused
  )("refuses %s at the factory", (_case, declaration, path, message) => {
    expect(refusal(() => untyped(s.string)(declaration))).toEqual({
      builder: "s.string",
      path,
      message: expect.stringContaining(message),
    });
  });

  it("ignores an inherited entry beside an own one", () => {
    const map = Object.create({ pg: PG.STRING.CITEXT });
    map.mysql = MYSQL.STRING.LONGTEXT;
    expect(resolved(untyped(s.string)(map)["~"].nativeType)).toEqual({
      pg: undefined,
      mysql: "LONGTEXT",
      sqlite: undefined,
    });
  });
});

describe("the map is a snapshot", () => {
  it("does not follow the caller's map or its entries after construction", () => {
    const entry = { db: "pg" as const, type: "varchar(80)" };
    const map: { pg?: typeof entry; mysql?: typeof MYSQL.STRING.TEXT } = {
      pg: entry,
    };
    const scalar = s.string(map);
    entry.type = "text UNIQUE";
    map.mysql = MYSQL.STRING.TEXT;
    map.pg = undefined;
    expect(resolved(scalar["~"].nativeType)).toEqual({
      pg: "varchar(80)",
      mysql: undefined,
      sqlite: undefined,
    });
    const stored = scalar["~"].nativeType;
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(nativeTypeFor(stored, "pg"))).toBe(true);
    expect(stored).not.toBe(map);
  });

  it("is carried by identity through every modifier chain", () => {
    const chains = [
      s.string(ISSUE_MAP),
      s.string(ISSUE_MAP).nullable().array().map("c"),
      s.string(ISSUE_MAP).uuid("p").id().unique(),
      s.string(ISSUE_MAP).default("x"),
    ];
    const stored = chains[0]?.["~"].nativeType;
    for (const chain of chains.slice(1)) {
      expect(resolved(chain["~"].nativeType)).toEqual(resolved(stored));
    }
    const base = s.dateTime({ sqlite: SQLITE.DATETIME.REAL });
    const declaration = base["~"].nativeType;
    for (const derived of [
      base.nullable(),
      base.array(),
      base.now(),
      base.updatedAt(),
      base.withoutTimezone(),
      base.default("2026-01-01T00:00:00.000Z"),
      base.map("at"),
      base.unique(),
    ]) {
      expect(derived["~"].nativeType).toBe(declaration);
    }
    const kind = s.enum(["a", "b"], { pg: PG.STRING.TEXT });
    expect(kind.name("kind").nullable()["~"].nativeType).toBe(
      kind["~"].nativeType
    );
  });
});

describe("the tagged shorthand keeps its historical contract", () => {
  it("is stored as given, custom spellings included", () => {
    const custom = { db: "pg" as const, type: 'text COLLATE "C"' };
    expect(s.string(custom)["~"].nativeType).toBe(custom);
    expect(s.string(PG.STRING.CITEXT)["~"].nativeType).toBe(PG.STRING.CITEXT);
  });

  it("keeps unrelated extra keys and an inherited tag", () => {
    const annotated = { db: "mysql" as const, type: "TEXT", note: "legacy" };
    expect(s.string(annotated)["~"].nativeType).toBe(annotated);
    const inherited = Object.create(SQLITE.DATETIME.INTEGER);
    expect(
      resolved(untyped(s.dateTime)(inherited)["~"].nativeType).sqlite
    ).toBe("INTEGER");
  });
});
