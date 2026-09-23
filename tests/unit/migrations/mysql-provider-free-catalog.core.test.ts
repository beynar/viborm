import { VibORMErrorCode } from "@src/errors";
import { getMigrationDriver } from "@src/migrations/drivers";
import { describe, expect, test } from "vitest";
import { mysqlEstateDriver } from "./_estate";

function column(
  name: string,
  dataType: string,
  columnType = dataType
): Record<string, unknown> {
  return {
    TABLE_NAME: "order$lines",
    COLUMN_NAME: name,
    DATA_TYPE: dataType,
    COLUMN_TYPE: columnType,
    IS_NULLABLE: "NO",
    COLUMN_DEFAULT: null,
    CHARACTER_MAXIMUM_LENGTH: null,
    NUMERIC_PRECISION: null,
    NUMERIC_SCALE: null,
    SRS_ID: null,
    EXTRA: "",
    COLUMN_COMMENT: "",
  };
}

function foreignKey(
  name: string,
  columnName: string,
  deleteRule: string,
  updateRule: string
): Record<string, unknown> {
  return {
    TABLE_SCHEMA: "billing",
    TABLE_NAME: "order$lines",
    CONSTRAINT_NAME: name,
    COLUMN_NAME: columnName,
    REFERENCED_TABLE_SCHEMA: "billing",
    REFERENCED_TABLE_NAME: "parents",
    REFERENCED_COLUMN_NAME: "id",
    DELETE_RULE: deleteRule,
    UPDATE_RULE: updateRule,
    ORDINAL_POSITION: 1,
  };
}

function catalogDriver(rows: {
  readonly columns?: readonly Record<string, unknown>[];
  readonly primaryKeys?: readonly Record<string, unknown>[];
  readonly indexes?: readonly Record<string, unknown>[];
  readonly foreignKeys?: readonly Record<string, unknown>[];
}) {
  const execution = mysqlEstateDriver({
    namespace: "billing",
    attested: true,
  });
  execution.respond = (sql) => {
    if (sql.includes("information_schema.SCHEMATA")) {
      return [{ SCHEMA_NAME: "billing" }];
    }
    if (sql.includes("information_schema.COLUMNS")) {
      return [...(rows.columns ?? [])];
    }
    if (sql.includes("CONSTRAINT_TYPE = 'PRIMARY KEY'")) {
      return [...(rows.primaryKeys ?? [])];
    }
    if (sql.includes("information_schema.STATISTICS")) {
      return [...(rows.indexes ?? [])];
    }
    if (sql.includes("CONSTRAINT_TYPE = 'FOREIGN KEY'")) {
      return [...(rows.foreignKeys ?? [])];
    }
    if (sql.includes("information_schema.TABLES")) {
      return [{ TABLE_NAME: "order$lines" }];
    }
    return [];
  };
  return execution;
}

describe("provider-free MySQL catalog reconstruction", () => {
  test("reconstructs catalog-only type, enum, key, and action vocabulary", async () => {
    const execution = catalogDriver({
      columns: [
        {
          ...column("id", "int", "int unsigned"),
          EXTRA: "DEFAULT_GENERATED auto_increment",
        },
        {
          ...column("label", "varchar"),
          CHARACTER_MAXIMUM_LENGTH: 63,
          IS_NULLABLE: "YES",
        },
        {
          ...column("code", "char"),
          CHARACTER_MAXIMUM_LENGTH: 3,
        },
        {
          ...column("amount", "decimal"),
          NUMERIC_PRECISION: 10,
          NUMERIC_SCALE: 2,
        },
        {
          ...column("units", "decimal"),
          NUMERIC_PRECISION: 8,
          NUMERIC_SCALE: null,
        },
        column(
          "sta$tus",
          "enum",
          String.raw`enum('a,b', 'it''s', 'back\\slash')`
        ),
        column("unparsed", "enum", "enum(not-quoted)"),
        { ...column("location", "point"), SRS_ID: undefined },
        { ...column("target", "point"), SRS_ID: "4326" },
      ],
      primaryKeys: [
        {
          TABLE_NAME: "order$lines",
          CONSTRAINT_NAME: "PRIMARY",
          COLUMN_NAME: "code",
          ORDINAL_POSITION: 2,
        },
        {
          TABLE_NAME: "order$lines",
          CONSTRAINT_NAME: "PRIMARY",
          COLUMN_NAME: "id",
          ORDINAL_POSITION: 1,
        },
      ],
      indexes: [
        {
          TABLE_NAME: "order$lines",
          INDEX_NAME: "geo_idx",
          COLUMN_NAME: "target",
          NON_UNIQUE: 1,
          INDEX_TYPE: "RTREE",
          SEQ_IN_INDEX: 1,
        },
        {
          TABLE_NAME: "order$lines",
          INDEX_NAME: "odd_idx",
          COLUMN_NAME: "code",
          NON_UNIQUE: 0,
          INDEX_TYPE: "ODD",
          SEQ_IN_INDEX: 2,
        },
        {
          TABLE_NAME: "order$lines",
          INDEX_NAME: "odd_idx",
          COLUMN_NAME: "id",
          NON_UNIQUE: 0,
          INDEX_TYPE: "ODD",
          SEQ_IN_INDEX: 1,
        },
        {
          TABLE_NAME: "order$lines",
          INDEX_NAME: "set_null_fk",
          COLUMN_NAME: "label",
          NON_UNIQUE: 1,
          INDEX_TYPE: "BTREE",
          SEQ_IN_INDEX: 1,
        },
      ],
      foreignKeys: [
        foreignKey("set_null_fk", "label", "SET NULL", "RESTRICT"),
        foreignKey("set_default_fk", "code", "SET DEFAULT", "CASCADE"),
        foreignKey("fallback_fk", "id", "NO ACTION", "NO ACTION"),
      ],
    });
    const driver = getMigrationDriver(execution);

    const snapshot = await driver.introspect((sql, params) =>
      execution._executeRaw(sql, params)
    );

    // The enum's identity read `order$lines$sta$tus$enum` at the base: a name
    // derived here and nowhere else, so it never equalled the one the DESIRED
    // snapshot registers (`serializer.ts` takes that from
    // `getEnumColumnType`), and every enum-bearing MySQL schema carried two
    // enum definitions that could not match — which is what the final push
    // attestation refused. Re-expressed for the decided MySQL qualification
    // (final-closure handoff §1, "MySQL"): MySQL has no standalone enum
    // object, so the inline type IS the identity, spelled once by
    // `mysqlEnumType` and read back through it here.
    // Re-expressed for the consolidated member spelling (repair prompt §3): a
    // member IS a MySQL string literal, so the backslash is spelled the way
    // MySQL reads it back as one. The quote-doubling rule declared a BACKSPACE
    // member instead, and disagreed with the default beside it.
    expect(snapshot.enums).toEqual([
      {
        name: String.raw`ENUM('a,b', 'it''s', 'back\\slash')`,
        values: ["a,b", "it's", "back\\slash"],
      },
    ]);
    expect(snapshot.tables[0]?.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "id",
          type: "int unsigned",
          autoIncrement: true,
        }),
        expect.objectContaining({ name: "label", type: "VARCHAR(63)" }),
        expect.objectContaining({ name: "code", type: "CHAR(3)" }),
        expect.objectContaining({
          name: "amount",
          type: "DECIMAL(10,2)",
          decimal: { precision: 10, scale: 2 },
        }),
        expect.objectContaining({
          name: "units",
          type: "DECIMAL(8)",
          decimal: { precision: 8, scale: 0 },
        }),
        expect.objectContaining({
          name: "sta$tus",
          type: String.raw`ENUM('a,b', 'it''s', 'back\\slash')`,
        }),
        // A COLUMN_TYPE that parses to no values is not an enum MySQL could
        // have created; it stays exactly as the catalog spelled it.
        expect.objectContaining({ name: "unparsed", type: "enum(not-quoted)" }),
        expect.objectContaining({ name: "location", type: "POINT" }),
        expect.objectContaining({ name: "target", type: "POINT SRID 4326" }),
      ])
    );
    expect(snapshot.tables[0]?.primaryKey).toEqual({
      columns: ["id", "code"],
      name: "PRIMARY",
    });
    expect(snapshot.tables[0]?.indexes).toEqual([
      {
        name: "geo_idx",
        columns: ["target"],
        unique: false,
        type: "spatial",
      },
      {
        name: "odd_idx",
        columns: ["id", "code"],
        unique: true,
        type: undefined,
      },
    ]);
    expect(snapshot.tables[0]?.foreignKeys).toEqual([
      expect.objectContaining({
        name: "set_null_fk",
        onDelete: "setNull",
        onUpdate: "restrict",
      }),
      expect.objectContaining({
        name: "set_default_fk",
        onDelete: "setDefault",
        onUpdate: "cascade",
      }),
      expect.objectContaining({
        name: "fallback_fk",
        onDelete: "noAction",
        onUpdate: "noAction",
      }),
    ]);
  });

  // Measured on MySQL 8.4.11: a column declared `DEFAULT ('it''s')` is
  // reported by `information_schema` as the characters `_utf8mb4\'it\\\'s\'`
  // — the literal escaped once by MySQL printing it, once more by the catalog
  // printing that expression. The desired side spells that column `('it''s')`,
  // so an apostrophe in a default on TEXT, BLOB, JSON or GEOMETRY (the storage
  // classes that take an expression default) is only comparable if the two
  // layers are undone here. Untranslated, the column is re-planned on every
  // push and the push then FAILS at the final attestation with
  // MIGRATION_DRIFT.
  test("undoes both layers of MySQL's deparse, and keeps what it cannot", async () => {
    const execution = catalogDriver({
      columns: [
        {
          ...column("quoted", "text"),
          COLUMN_DEFAULT: String.raw`_utf8mb4\'it\\\'s\'`,
          EXTRA: "DEFAULT_GENERATED",
        },
        {
          ...column("plain", "text"),
          COLUMN_DEFAULT: String.raw`_utf8mb4\'plain\'`,
          EXTRA: "DEFAULT_GENERATED",
        },
        {
          ...column("multiline", "text"),
          COLUMN_DEFAULT: String.raw`_utf8mb4\'line1\\nline2\'`,
          EXTRA: "DEFAULT_GENERATED",
        },
        {
          ...column("backslash", "text"),
          COLUMN_DEFAULT: String.raw`_utf8mb4\'a\\\\b\'`,
          EXTRA: "DEFAULT_GENERATED",
        },
        {
          ...column("controls", "text"),
          COLUMN_DEFAULT: String.raw`_utf8mb4\'a\\rb\\0c\\Zd\'`,
          EXTRA: "DEFAULT_GENERATED",
        },
        {
          ...column("unowned", "text"),
          COLUMN_DEFAULT: String.raw`_utf8mb4\'tab\\there\'`,
          EXTRA: "DEFAULT_GENERATED",
        },
        {
          ...column("stamped", "datetime"),
          COLUMN_DEFAULT: "CURRENT_TIMESTAMP(3)",
          EXTRA: "DEFAULT_GENERATED",
        },
        {
          ...column("literal", "varchar"),
          CHARACTER_MAXIMUM_LENGTH: 10,
          COLUMN_DEFAULT: "it's",
        },
      ],
    });
    const driver = getMigrationDriver(execution);

    const snapshot = await driver.introspect((sql, params) =>
      execution._executeRaw(sql, params)
    );
    const byName = new Map(
      snapshot.tables[0]?.columns.map((col) => [col.name, col])
    );

    expect(byName.get("quoted")?.default).toBe("('it''s')");
    expect(byName.get("plain")?.default).toBe("('plain')");
    expect(byName.get("literal")?.default).toBe("'it''s'");
    // Re-expressed for the repaired inverse (repair prompt §4.1): the escapes
    // MySQL's printer writes — `\n`, `\r`, `\0`, `\Z` and the doubled
    // backslash — are the table the DDL spelling writes, read backwards, so a
    // value carrying any of them round-trips into the spelling the desired
    // side wrote instead of keeping the catalog's text.
    expect(byName.get("multiline")?.default).toBe(String.raw`('line1\nline2')`);
    expect(byName.get("backslash")?.default).toBe(String.raw`('a\\b')`);
    expect(byName.get("controls")?.default).toBe(String.raw`('a\rb\0c\Zd')`);
    // An escape OUTSIDE that table is not one this server printed for a value
    // the estate spelled (a tab is printed raw, measured), so the body is not
    // translated at all: the catalog text stays EXACTLY as read, keeps reading
    // as a difference, and refuses the push instead of calling two defaults
    // equal that nobody proved equal.
    expect(byName.get("unowned")?.default).toBe(
      String.raw`_utf8mb4\'tab\\there\'`
    );
    // Not a string literal at all, and not this inverse's business.
    expect(byName.get("stamped")?.default).toBe("CURRENT_TIMESTAMP(3)");
  });

  /**
   * What `information_schema` hands back for an EXPRESSION default: MySQL's
   * deparse of the expression, then the BYTES of that text, one per codepoint
   * (measured on 8.4.11 — the server's own `HEX(COLUMN_DEFAULT)` carries the
   * expansion, while `SHOW CREATE TABLE` prints the true text).
   */
  function catalogBytes(deparsed: string): string {
    return [...new TextEncoder().encode(deparsed)]
      .map((byte) => String.fromCharCode(byte))
      .join("");
  }

  const CAFE = "caf\u00e9 \u2615";

  test("reads an expression default's bytes back through its introducer, or keeps the text", async () => {
    const execution = catalogDriver({
      columns: [
        {
          ...column("unicode", "text"),
          COLUMN_DEFAULT: catalogBytes(`_utf8mb4\\'${CAFE}\\'`),
          EXTRA: "DEFAULT_GENERATED",
        },
        {
          ...column("astral", "text"),
          COLUMN_DEFAULT: catalogBytes("_utf8mb4\\'e\u{1F600}nd\\'"),
          EXTRA: "DEFAULT_GENERATED",
        },
        {
          ...column("escaped", "text"),
          COLUMN_DEFAULT: catalogBytes(`_utf8mb4\\'${CAFE}\\\\n\\\\\\\\x\\'`),
          EXTRA: "DEFAULT_GENERATED",
        },
        {
          ...column("ascii", "text"),
          COLUMN_DEFAULT: catalogBytes("_utf8mb4\\'plain\\'"),
          EXTRA: "DEFAULT_GENERATED",
        },
        // NOT a byte sequence: a transport that already decoded the text
        // hands back `2615`, which no byte can be — and whose low byte `15` is
        // a valid UTF-8 character, so no later check would catch it.
        {
          ...column("not_bytes", "text"),
          COLUMN_DEFAULT: "_utf8mb4\\'x\u2615\\'",
          EXTRA: "DEFAULT_GENERATED",
        },
        // Every codepoint IS a byte and the bytes are not valid UTF-8: a body
        // that already sits in the Latin-1 range, which is exactly what a
        // blanket re-decode would corrupt.
        {
          ...column("invalid", "text"),
          COLUMN_DEFAULT: "_utf8mb4\\'caf\u00e9\\'",
          EXTRA: "DEFAULT_GENERATED",
        },
        // A charset outside the UTF-8 family is read with ITS OWN rule: in
        // latin1 the two bytes `c3 a9` ARE the two characters `\u00c3\u00a9`,
        // and reading them as UTF-8 would say `\u00e9` — a different value.
        // The introducer is frozen in the stored expression at CREATE time, so
        // the session that WROTE the column decides what arrives here, and this
        // body reaches an ordinary utf8mb4 connection (measured,
        // `closure-repair-2/t3/receipts/probe-frozen-introducer.log`).
        {
          ...column("other_charset", "text"),
          COLUMN_DEFAULT: "_latin1\\'\u00c3\u00a9\\'",
          EXTRA: "DEFAULT_GENERATED",
        },
        // MySQL's latin1 is Windows-1252: byte 0x93 is U+201C there, not the
        // C1 control ISO-8859-1 would make of it.
        {
          ...column("cp1252_latin1", "text"),
          COLUMN_DEFAULT: "_latin1\\'\u0093hi\\'",
          EXTRA: "DEFAULT_GENERATED",
        },
        // The same charset carrying a pure-ASCII value — the ordinary body of
        // a column some other tool created.
        {
          ...column("ascii_latin1", "text"),
          COLUMN_DEFAULT: "_latin1\\'plain\\'",
          EXTRA: "DEFAULT_GENERATED",
        },
        // A charset the table does NOT read: in cp1251 these same bytes are
        // two Cyrillic letters, so neither reading is that charset's and both
        // would be a guess.
        {
          ...column("unowned_charset", "text"),
          COLUMN_DEFAULT: "_cp1251\\'\u00c3\u00a9\\'",
          EXTRA: "DEFAULT_GENERATED",
        },
        // A value whose first character is U+FEFF: these bytes are a VALUE,
        // not a document with a byte-order mark.
        {
          ...column("bom", "text"),
          COLUMN_DEFAULT: catalogBytes("_utf8mb4\\'\ufeffx\\'"),
          EXTRA: "DEFAULT_GENERATED",
        },
      ],
    });
    const driver = getMigrationDriver(execution);

    const snapshot = await driver.introspect((sql, params) =>
      execution._executeRaw(sql, params)
    );
    const byName = new Map(
      snapshot.tables[0]?.columns.map((col) => [col.name, col])
    );

    // Repair prompt §3: the introducer names the encoding of the bytes the
    // catalog spells one per codepoint, so the value comes back in the
    // spelling the desired side wrote instead of one codepoint per byte.
    expect(byName.get("unicode")?.default).toBe(`('${CAFE}')`);
    expect(byName.get("astral")?.default).toBe("('e\u{1F600}nd')");
    expect(byName.get("escaped")?.default).toBe(
      `('${CAFE}${String.raw`\n\\x`}')`
    );
    // UTF-8 decoding is the identity on an ASCII body.
    expect(byName.get("ascii")?.default).toBe("('plain')");
    // Read with the charset the introducer NAMES: for a single-byte one that
    // is the catalog's text itself, which is what this boundary returned for
    // EVERY introducer before it consulted them at all.
    expect(byName.get("ascii_latin1")?.default).toBe("('plain')");
    expect(byName.get("other_charset")?.default).toBe("('\u00c3\u00a9')");
    expect(byName.get("cp1252_latin1")?.default).toBe("('\u201chi')");
    // A leading U+FEFF is part of the value, not a mark the reader eats.
    expect(byName.get("bom")?.default).toBe("('\ufeffx')");
    // Fail-closed, each on the ONE fact the other two admit: the catalog's
    // text is kept, reads as a difference, and refuses the push.
    expect(byName.get("not_bytes")?.default).toBe("_utf8mb4\\'x\u2615\\'");
    expect(byName.get("invalid")?.default).toBe("_utf8mb4\\'caf\u00e9\\'");
    expect(byName.get("unowned_charset")?.default).toBe(
      "_cp1251\\'\u00c3\u00a9\\'"
    );
  });

  test("reads an enum's printed members back through the same table", async () => {
    const printed = `enum('a\\\\b','line1\\nline2','it''s','${CAFE}','p\u001aq')`;
    const execution = catalogDriver({
      columns: [
        {
          ...column("kind", "enum", printed),
          COLUMN_DEFAULT: "a\\b",
        },
        column("unowned_member", "enum", String.raw`enum('tab\there')`),
      ],
    });
    const driver = getMigrationDriver(execution);

    const snapshot = await driver.introspect((sql, params) =>
      execution._executeRaw(sql, params)
    );
    const byName = new Map(
      snapshot.tables[0]?.columns.map((col) => [col.name, col])
    );

    // Repair prompt §3: a member IS a string literal, so the catalog's printed
    // escapes are undone through the same table the string inverse reads and
    // the members are re-spelled through the one literal speller. Reading `\n`
    // as the letter `n` — what skipping the backslash did — made the live type
    // a type MySQL never created.
    const expected = `${String.raw`ENUM('a\\b', 'line1\nline2', 'it''s', `}'${CAFE}'${String.raw`, 'p\Zq')`}`;
    expect(byName.get("kind")?.type).toBe(expected);
    expect(snapshot.enums).toEqual([
      {
        name: expected,
        values: ["a\\b", "line1\nline2", "it's", CAFE, "p\u001aq"],
      },
    ]);
    // The enum column's own default is a LITERAL one, reported as the bare
    // value, and it is spelled by the same literal speller as its member.
    expect(byName.get("kind")?.default).toBe(String.raw`'a\\b'`);
    // An escape MySQL's printer does not write (a tab is printed raw,
    // measured) is not one this inverse owns: the COLUMN_TYPE stays exactly as
    // read and no enum identity is registered for it.
    expect(byName.get("unowned_member")?.type).toBe(
      String.raw`enum('tab\there')`
    );
  });
});

describe("coverage low value", () => {
  test.each([
    [-1],
    [4_294_967_296],
    ["not-a-number"],
  ])("refuses the structurally impossible catalog SRID %s", async (srid) => {
    const execution = catalogDriver({
      columns: [{ ...column("location", "point"), SRS_ID: srid }],
    });
    const driver = getMigrationDriver(execution);

    await expect(
      driver.introspect((sql, params) => execution._executeRaw(sql, params))
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { type: "invalid-catalog-srid" },
    });
  });
});
