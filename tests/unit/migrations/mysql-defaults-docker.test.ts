/**
 * The two measured MySQL default gaps, closed at their owners (repair prompt
 * §4).
 *
 * Both were disclosed by R2a and left open by the local closure: an ordinary
 * declaration the estate accepts, that MySQL then refuses or silently changes.
 *
 *   1. A string default carrying a BACKSLASH never reached the database as the
 *      declared value — `escapeValue` doubled `'` and left `\` alone, and
 *      MySQL's DDL reads a backslash as an escape introducer, so
 *      `DEFAULT ('a\b')` stored a BACKSPACE and `DEFAULT ('end\')` did not even
 *      parse. A default carrying a NEWLINE reached the database intact but came
 *      back as `information_schema`'s printed `\n`, which the deparse inverse
 *      did not own, so the column read as a difference on every push.
 *   2. `.dateTime().now()` emitted `CURRENT_TIMESTAMP` while the resolved
 *      column type is `DATETIME(3)`, and MySQL requires the two to agree
 *      (errno 1067, ER_INVALID_DEFAULT): the push failed before any assertion
 *      about the default could be made.
 *
 * The ORACLE for a database default is a RAW INSERT that omits the column: the
 * ORM's own admission-time default would fill it in whatever the DDL says, so
 * only a row the database wrote by itself proves the column carries it. Every
 * cell also repushes unchanged (the default must read back into the spelling
 * the desired side wrote) and then changes the declaration for real.
 *
 * NOTE: requires a running MySQL (docker). Set MYSQL_TEST_CONNECTION_STRING.
 */

import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { introspect } from "@migrations/push/planner";
import { s, TYPES } from "@src/schema";
import { syncLiveSchema as push } from "@tests/fixtures/sync-schema";
import { describe, expect, it } from "vitest";

const CONNECTION = process.env.MYSQL_TEST_CONNECTION_STRING;
const describeIfMySQL = CONNECTION ? describe : describe.skip;

/** The rendered forms a column's declared fractional precision produces. */
const MILLISECONDS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;
const MICROSECONDS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;
const WHOLE_SECONDS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const TEXT_TABLE = "sm_default_text";
const NOW_TABLE = "sm_default_now";
const UNICODE_TABLE = "sm_default_unicode";
const ENUM_TABLE = "tm_default_enum";

function mysqlDriver(): MySQL2Driver {
  if (CONNECTION === undefined) {
    throw new Error("MYSQL_TEST_CONNECTION_STRING is required");
  }
  return new MySQL2Driver({
    databaseUrl: CONNECTION,
    migrationNamespaceAttestation: "non-redirecting",
  });
}

/** The declared values, beside the columns that carry them. */
const DECLARED = {
  backslash: "a\\b",
  trailing: "end\\",
  multiline: "line1\nline2",
  crlf: "win\r\nrow",
  mixed: "a\\'b",
  apostrophe: "it's",
  empty: "",
  keyed: "k\\1",
} as const;

function textSchema(backslash: string) {
  return {
    notes: s
      .model({
        id: s.string().id(),
        // TEXT refuses a literal default, so each of these is carried as
        // MySQL's expression default and comes back through the deparse
        // inverse.
        backslash: s.string().default(backslash),
        trailing: s.string().default(DECLARED.trailing),
        multiline: s.string().default(DECLARED.multiline),
        crlf: s.string().default(DECLARED.crlf),
        mixed: s.string().default(DECLARED.mixed),
        // Retained controls: the apostrophe R2a repaired, and the empty
        // string.
        apostrophe: s.string().default(DECLARED.apostrophe),
        empty: s.string().default(DECLARED.empty),
        // A keyed string is VARCHAR(191), which takes the LITERAL default —
        // the other half of the same DDL spelling, reported by the catalog as
        // the bare value.
        keyed: s.string().unique().default(DECLARED.keyed),
      })
      .map(TEXT_TABLE),
  };
}

/** Everything except the column whose declared type the change moves. */
function nowFields() {
  return {
    id: s.string().id(),
    micros: s.dateTime(TYPES.MYSQL.DATETIME.DATETIME(6)).now(),
    whole: s.dateTime(TYPES.MYSQL.DATETIME.DATETIME()).now(),
    stamped: s.dateTime(TYPES.MYSQL.DATETIME.TIMESTAMP(3)).now(),
    // `.updatedAt()` declares an ORM generator and NO database default: its
    // declaration does not share the affected rule, and this cell is what
    // keeps it that way.
    touched: s.dateTime().updatedAt(),
    // A resolved type that takes no `CURRENT_TIMESTAMP` at all. The rule is
    // derived from the type, so these carry no database default rather than an
    // expression MySQL refuses.
    day: s.date().now(),
    clock: s.time().now(),
  };
}

function nowSchema() {
  return {
    events: s.model({ ...nowFields(), at: s.dateTime().now() }).map(NOW_TABLE),
  };
}

function widenedNowSchema() {
  return {
    events: s
      .model({
        ...nowFields(),
        at: s.dateTime(TYPES.MYSQL.DATETIME.DATETIME(6)).now(),
      })
      .map(NOW_TABLE),
  };
}

/** The declared Unicode values, beside the columns that carry them. */
const UNICODE_VALUE = "café ☕";
const DECLARED_UNICODE = {
  note: UNICODE_VALUE,
  emoji: "e\u{1F600}nd",
  keyed: UNICODE_VALUE,
} as const;
const CHANGED_UNICODE = "thé ☕☕";

function unicodeSchema(note: string) {
  return {
    notes: s
      .model({
        id: s.string().id(),
        // TEXT refuses a literal default, so this is MySQL's EXPRESSION
        // default — the form whose text the catalog hands back as BYTES.
        note: s.string().default(note),
        // Four bytes to the codepoint, outside the BMP.
        emoji: s.string().default(DECLARED_UNICODE.emoji),
        // A keyed string is VARCHAR(191), which takes the LITERAL default: the
        // control, reported as the bare VALUE and untouched by this repair.
        keyed: s.string().unique().default(DECLARED_UNICODE.keyed),
      })
      .map(UNICODE_TABLE),
  };
}

/** Members carrying every escape MySQL's printer writes, and a Unicode one. */
const ENUM_VALUES = [
  "plain",
  DECLARED.backslash,
  DECLARED.multiline,
  DECLARED.apostrophe,
  UNICODE_VALUE,
];

/** The ONE spelling both snapshot producers write for those members. */
const ENUM_TYPE = `${String.raw`ENUM('plain', 'a\\b', 'line1\nline2', 'it''s', `}'${UNICODE_VALUE}')`;

function enumSchema() {
  return {
    kinds: s
      .model({
        id: s.string().id(),
        kind: s.enum([...ENUM_VALUES]).default(DECLARED.backslash),
      })
      .map(ENUM_TABLE),
  };
}

function widenedEnumSchema() {
  return {
    kinds: s
      .model({
        id: s.string().id(),
        kind: s
          .enum([...ENUM_VALUES, DECLARED.trailing])
          .default(DECLARED.backslash),
      })
      .map(ENUM_TABLE),
  };
}

describeIfMySQL("MySQL declared defaults, at the database's own oracle", () => {
  it("round-trips a backslash, a newline and a CRLF through DDL, catalog and a raw insert", async () => {
    const driver = mysqlDriver();
    const client = createClient({
      schema: textSchema(DECLARED.backslash),
      driver,
    });
    try {
      await driver._executeRaw(`DROP TABLE IF EXISTS \`${TEXT_TABLE}\``);
      expect((await push(client, { force: true })).applied).toBe(true);

      // The DDL spelling is the one the catalog reads back: unchanged
      // declarations plan nothing.
      expect((await push(client, { force: true })).operations).toEqual([]);

      const snapshot = await introspect(client);
      const byName = new Map(
        snapshot.tables
          .find((table) => table.name === TEXT_TABLE)
          ?.columns.map((column) => [column.name, column])
      );
      expect(byName.get("backslash")?.default).toBe(String.raw`('a\\b')`);
      expect(byName.get("trailing")?.default).toBe(String.raw`('end\\')`);
      expect(byName.get("multiline")?.default).toBe(
        String.raw`('line1\nline2')`
      );
      expect(byName.get("crlf")?.default).toBe(String.raw`('win\r\nrow')`);
      expect(byName.get("mixed")?.default).toBe(String.raw`('a\\''b')`);
      expect(byName.get("apostrophe")?.default).toBe("('it''s')");
      expect(byName.get("empty")?.default).toBe("('')");
      expect(byName.get("keyed")?.default).toBe(String.raw`'k\\1'`);

      // THE ORACLE: no ORM admission, so only a default the DDL actually
      // created can fill these columns.
      await driver._executeRaw(
        `INSERT INTO \`${TEXT_TABLE}\` (\`id\`) VALUES ('raw')`
      );
      const rows = await driver._executeRaw<Record<string, string>>(
        `SELECT * FROM \`${TEXT_TABLE}\` WHERE \`id\` = 'raw'`
      );
      expect(rows.rows[0]).toMatchObject(DECLARED);

      // An actual declared change is planned, applied, converges, and the new
      // value is again the database's.
      const changed = createClient({
        schema: textSchema(String.raw`c\d`),
        driver,
      });
      const applied = await push(changed, { force: true });
      expect(applied.applied).toBe(true);
      expect(applied.operations.length).toBeGreaterThan(0);
      expect((await push(changed, { force: true })).operations).toEqual([]);
      // `keyed` is unique and already holds its default from the row above,
      // so this row names its own value; the column under test is still the
      // database's.
      await driver._executeRaw(
        `INSERT INTO \`${TEXT_TABLE}\` (\`id\`, \`keyed\`) VALUES ('changed', 'other')`
      );
      const changedRows = await driver._executeRaw<{ backslash: string }>(
        `SELECT \`backslash\` FROM \`${TEXT_TABLE}\` WHERE \`id\` = 'changed'`
      );
      expect(changedRows.rows[0]?.backslash).toBe(String.raw`c\d`);
    } finally {
      await driver._executeRaw(`DROP TABLE IF EXISTS \`${TEXT_TABLE}\``);
      await client.$disconnect();
    }
  });

  it("spells now() at the resolved column's precision, and nowhere else", async () => {
    const driver = mysqlDriver();
    const client = createClient({ schema: nowSchema(), driver });
    try {
      await driver._executeRaw(`DROP TABLE IF EXISTS \`${NOW_TABLE}\``);
      expect((await push(client, { force: true })).applied).toBe(true);
      expect((await push(client, { force: true })).operations).toEqual([]);

      const snapshot = await introspect(client);
      const byName = new Map(
        snapshot.tables
          .find((table) => table.name === NOW_TABLE)
          ?.columns.map((column) => [column.name, column])
      );
      expect(byName.get("at")?.default).toBe("CURRENT_TIMESTAMP(3)");
      expect(byName.get("micros")?.default).toBe("CURRENT_TIMESTAMP(6)");
      expect(byName.get("whole")?.default).toBe("CURRENT_TIMESTAMP");
      expect(byName.get("stamped")?.default).toBe("CURRENT_TIMESTAMP(3)");
      expect(byName.get("touched")?.default).toBeUndefined();
      expect(byName.get("day")?.default).toBeUndefined();
      expect(byName.get("clock")?.default).toBeUndefined();

      // THE ORACLE: the raw insert omits every generated column and supplies
      // only what carries no database default.
      await driver._executeRaw(
        `INSERT INTO \`${NOW_TABLE}\` (\`id\`, \`touched\`, \`day\`, \`clock\`) VALUES ('raw', '2026-09-21 10:11:12.345', '2026-09-21', '10:11:12.345')`
      );
      const written = await driver._executeRaw<Record<string, string>>(
        `SELECT CAST(\`at\` AS CHAR) AS \`at\`, CAST(\`micros\` AS CHAR) AS \`micros\`, CAST(\`whole\` AS CHAR) AS \`whole\`, CAST(\`stamped\` AS CHAR) AS \`stamped\` FROM \`${NOW_TABLE}\` WHERE \`id\` = 'raw'`
      );
      const row = written.rows[0];
      // The fractional digits ARE the fact: a column whose default did not
      // agree with its precision could not have been created at all, and the
      // rendered value shows the precision the column actually carries.
      expect(row?.at).toMatch(MILLISECONDS);
      expect(row?.micros).toMatch(MICROSECONDS);
      expect(row?.whole).toMatch(WHOLE_SECONDS);
      expect(row?.stamped).toMatch(MILLISECONDS);
      const writtenAt = Date.parse(`${row?.at?.replace(" ", "T")}Z`);
      expect(Math.abs(Date.now() - writtenAt)).toBeLessThan(120_000);

      // An actual declared change: the SAME generator on a wider column type
      // moves the expression with it.
      const changed = createClient({
        schema: widenedNowSchema(),
        driver,
      });
      const applied = await push(changed, { force: true });
      expect(applied.applied).toBe(true);
      expect(applied.operations.length).toBeGreaterThan(0);
      expect((await push(changed, { force: true })).operations).toEqual([]);
      const changedSnapshot = await introspect(changed);
      expect(
        changedSnapshot.tables
          .find((table) => table.name === NOW_TABLE)
          ?.columns.find((column) => column.name === "at")?.default
      ).toBe("CURRENT_TIMESTAMP(6)");
      await driver._executeRaw(
        `INSERT INTO \`${NOW_TABLE}\` (\`id\`, \`touched\`, \`day\`, \`clock\`) VALUES ('changed', '2026-09-21 10:11:12.345', '2026-09-21', '10:11:12.345')`
      );
      const changedRow = await driver._executeRaw<{ at: string }>(
        `SELECT CAST(\`at\` AS CHAR) AS \`at\` FROM \`${NOW_TABLE}\` WHERE \`id\` = 'changed'`
      );
      expect(changedRow.rows[0]?.at).toMatch(MICROSECONDS);
    } finally {
      await driver._executeRaw(`DROP TABLE IF EXISTS \`${NOW_TABLE}\``);
      await client.$disconnect();
    }
  });
  /**
   * Re-expressed for the repaired catalog boundary (repair prompt §3).
   *
   * This cell pinned the fail-closed OUTCOME of the third gap U4 measured:
   * `information_schema.COLUMN_DEFAULT` hands an EXPRESSION default's text back
   * one codepoint per BYTE — the coffee cup `U+2615` arrives as the three
   * codepoints `e2 98 95`, measured on 8.4.11 through this same driver — so the
   * value the inverse reconstructed was not the declared one and the push
   * failed at the final attestation. Those bytes are the literal in the charset
   * MySQL's own deparse NAMES (`_utf8mb4\'…\'`), and that introducer is what
   * the inverse reads them with now, so the declared value comes back. Nothing
   * global is re-decoded: a body that is not those bytes keeps the catalog's
   * text and still refuses the push (pinned provider-free, in
   * `mysql-provider-free-catalog.core`).
   *
   * The LITERAL half of the same declaration is the control: a keyed string is
   * `VARCHAR(191)`, whose default the catalog reports as the bare VALUE, and
   * that half round-tripped before this repair and is untouched by it.
   */
  it("round-trips a Unicode default in both the expression and the literal form", async () => {
    const driver = mysqlDriver();
    const client = createClient({
      schema: unicodeSchema(DECLARED_UNICODE.note),
      driver,
    });
    try {
      await driver._executeRaw(`DROP TABLE IF EXISTS \`${UNICODE_TABLE}\``);
      expect((await push(client, { force: true })).applied).toBe(true);
      expect((await push(client, { force: true })).operations).toEqual([]);

      const snapshot = await introspect(client);
      const byName = new Map(
        snapshot.tables
          .find((table) => table.name === UNICODE_TABLE)
          ?.columns.map((column) => [column.name, column])
      );
      expect(byName.get("note")?.default).toBe(`('${DECLARED_UNICODE.note}')`);
      expect(byName.get("emoji")?.default).toBe(
        `('${DECLARED_UNICODE.emoji}')`
      );
      expect(byName.get("keyed")?.default).toBe(`'${DECLARED_UNICODE.keyed}'`);

      // THE ORACLE: no ORM admission, so only a default the DDL actually
      // created can fill these columns.
      await driver._executeRaw(
        `INSERT INTO \`${UNICODE_TABLE}\` (\`id\`) VALUES ('u1')`
      );
      const rows = await driver._executeRaw<Record<string, string>>(
        `SELECT * FROM \`${UNICODE_TABLE}\` WHERE \`id\` = 'u1'`
      );
      expect(rows.rows[0]).toMatchObject(DECLARED_UNICODE);

      // An actual declared change, in the same non-ASCII alphabet.
      const changed = createClient({
        schema: unicodeSchema(CHANGED_UNICODE),
        driver,
      });
      const applied = await push(changed, { force: true });
      expect(applied.applied).toBe(true);
      expect(applied.operations.length).toBeGreaterThan(0);
      expect((await push(changed, { force: true })).operations).toEqual([]);
      // `keyed` is unique and already holds its default from the row above, so
      // this row names its own value; the column under test is still the
      // database's.
      await driver._executeRaw(
        `INSERT INTO \`${UNICODE_TABLE}\` (\`id\`, \`keyed\`) VALUES ('u2', 'other')`
      );
      const changedRows = await driver._executeRaw<{ note: string }>(
        `SELECT \`note\` FROM \`${UNICODE_TABLE}\` WHERE \`id\` = 'u2'`
      );
      expect(changedRows.rows[0]?.note).toBe(CHANGED_UNICODE);
    } finally {
      await driver._executeRaw(`DROP TABLE IF EXISTS \`${UNICODE_TABLE}\``);
      await client.$disconnect();
    }
  });

  /**
   * The enum half of the same literal boundary (repair prompt §3).
   *
   * An ENUM's members ARE its type, and each member IS a MySQL string literal.
   * Spelled with quote doubling only, `ENUM('a\b')` declared a member holding a
   * BACKSPACE, `ENUM('end\')` did not parse at all, and — once the default
   * beside such a member went through `mysqlStringLiteral` — the two spellings
   * disagreed and MySQL refused the CREATE/MODIFY itself with errno 1067,
   * mid-push (all measured on 8.4.11). One speller, so the member the DDL
   * declares is the member the declaration named, and the catalog's printed
   * escapes are read back through the same table the string inverse reads.
   */
  it("round-trips escaped and Unicode enum members, and the default beside them", async () => {
    const driver = mysqlDriver();
    const client = createClient({ schema: enumSchema(), driver });
    try {
      await driver._executeRaw(`DROP TABLE IF EXISTS \`${ENUM_TABLE}\``);
      expect((await push(client, { force: true })).applied).toBe(true);
      expect((await push(client, { force: true })).operations).toEqual([]);

      const snapshot = await introspect(client);
      const kind = snapshot.tables
        .find((table) => table.name === ENUM_TABLE)
        ?.columns.find((column) => column.name === "kind");
      expect(kind?.type).toBe(ENUM_TYPE);
      expect(kind?.default).toBe(String.raw`'a\\b'`);
      expect(snapshot.enums).toEqual([
        { name: ENUM_TYPE, values: [...ENUM_VALUES] },
      ]);

      // THE ORACLE: the raw insert omits the column, so the member it holds is
      // the one the DDL made the column's default.
      await driver._executeRaw(
        `INSERT INTO \`${ENUM_TABLE}\` (\`id\`) VALUES ('e1')`
      );
      const rows = await driver._executeRaw<{ kind: string }>(
        `SELECT \`kind\` FROM \`${ENUM_TABLE}\` WHERE \`id\` = 'e1'`
      );
      expect(rows.rows[0]?.kind).toBe(DECLARED.backslash);

      // An actual declared change: a member carrying a TRAILING backslash, the
      // value the old spelling could not put into a statement at all.
      const changed = createClient({ schema: widenedEnumSchema(), driver });
      const applied = await push(changed, { force: true });
      expect(applied.applied).toBe(true);
      expect(applied.operations.length).toBeGreaterThan(0);
      expect((await push(changed, { force: true })).operations).toEqual([]);
      await driver._executeRaw(
        `INSERT INTO \`${ENUM_TABLE}\` (\`id\`, \`kind\`) VALUES ('e2', 'end\\\\')`
      );
      const changedRows = await driver._executeRaw<{ kind: string }>(
        `SELECT \`kind\` FROM \`${ENUM_TABLE}\` WHERE \`id\` = 'e2'`
      );
      expect(changedRows.rows[0]?.kind).toBe(DECLARED.trailing);
    } finally {
      await driver._executeRaw(`DROP TABLE IF EXISTS \`${ENUM_TABLE}\``);
      await client.$disconnect();
    }
  });
});
