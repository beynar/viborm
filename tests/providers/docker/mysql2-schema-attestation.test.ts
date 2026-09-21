/**
 * R2a — the final push attestation, on the two facts MySQL spells its own way.
 *
 * `push()` ends by introspecting what it just created and comparing that
 * snapshot's fingerprint with the desired schema's. The comparison is the
 * estate's proof that the database holds what the schema declared, so the two
 * snapshots have to speak ONE vocabulary. MySQL does not hand its own back:
 *
 *   - an ENUM's values ARE its type, and `information_schema` prints its own
 *     rendering of them (`enum('a','b')`, and an enum identity of its own
 *     invention), not the estate's `ENUM('a', 'b')`;
 *   - a literal default is reported as the bare VALUE, with the quotes DDL
 *     required stripped off;
 *   - a TEXT, BLOB, JSON or GEOMETRY column refuses a literal default outright
 *     (errno 1101), so a default declared on one has to be carried as MySQL's
 *     expression default, `DEFAULT ('value')`.
 *
 * Before this unit the estate declared defaults the emitter silently dropped
 * and named enums twice, so every push of a schema carrying either one ended
 * in `MIGRATION_DRIFT` — 150 cells of the native MySQL inventory never reached
 * their own body.
 *
 * The cells below are the whole boundary: the initial push, a repeated no-op
 * push, an actual change, and — the fact the fingerprint stands for — a row
 * written by RAW SQL, which the ORM's admission-time defaults cannot reach.
 *
 * NOTE: requires a running MySQL (docker). Set MYSQL_TEST_CONNECTION_STRING.
 */

import { createClient } from "@client/client";
import { introspect } from "@migrations/push/planner";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { beforeEach, describe, expect, test } from "vitest";
import {
  createMySQL2Driver,
  dropEveryLiveTable,
  TEST_CONNECTION_STRING,
} from "./mysql2-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

/** An enum column, a TEXT default, a keyed-string default, and a JSON list. */
const account = s
  .model({
    id: s.string().id(),
    role: s.enum(["admin", "member", "guest"]).default("member"),
    note: s.string().default("unset"),
    code: s.string().unique().default("none"),
    tags: s.string().array(),
  })
  .map("attest_accounts");

/** The same model with one value added and one default changed. */
const widenedAccount = s
  .model({
    id: s.string().id(),
    role: s.enum(["admin", "member", "guest", "auditor"]).default("member"),
    note: s.string().default("changed"),
    code: s.string().unique().default("none"),
    tags: s.string().array(),
  })
  .map("attest_accounts");

/**
 * An apostrophe in a declared default: ordinary data, and the one character
 * MySQL's deparse of an expression default escapes. The TEXT column takes the
 * expression default, the keyed one the literal — both have to read back.
 */
const quoted = s
  .model({
    id: s.string().id(),
    note: s.string().default("it's"),
    code: s.string().unique().default("it's"),
  })
  .map("attest_quoted");

/** A backslash: the character MySQL's DDL reads as an escape introducer. */
const backslashed = s
  .model({
    id: s.string().id(),
    note: s.string().default("a\\b"),
  })
  .map("attest_backslashed");

describeIf("MySQL2 schema attestation", () => {
  beforeEach(dropEveryLiveTable);

  test("pushes an enum-and-default schema and converges on a second push", async () => {
    const client = createClient({
      schema: { account },
      driver: createMySQL2Driver(),
    });
    const first = await syncLiveSchema(client);
    expect(first.applied).toBe(true);

    // The attestation the first push already made, restated from the outside:
    // introspection and the desired schema agree, so nothing is left to do.
    const second = await syncLiveSchema(client);
    expect(second.operations).toEqual([]);
    expect(second.sql).toEqual([]);

    const snapshot = await introspect(client);
    const table = snapshot.tables.find((t) => t.name === "attest_accounts");
    const byName = new Map(table?.columns.map((c) => [c.name, c]));
    expect(byName.get("role")?.type).toBe("ENUM('admin', 'member', 'guest')");
    expect(byName.get("role")?.default).toBe("'member'");
    // TEXT refuses a literal default, so the estate carries it as MySQL's
    // expression default — and reads it back in that same spelling.
    expect(byName.get("note")?.type).toBe("TEXT");
    expect(byName.get("note")?.default).toBe("('unset')");
    // A keyed string is VARCHAR(191), which takes the literal. The catalog
    // spells a parameterized type in its own case; `normalizeType` is what
    // reconciles that, and it is not what this cell is about.
    expect(byName.get("code")?.type).toBe("varchar(191)");
    expect(byName.get("code")?.default).toBe("'none'");
    expect(snapshot.enums).toEqual([
      {
        name: "ENUM('admin', 'member', 'guest')",
        values: ["admin", "member", "guest"],
      },
    ]);

    await client.$disconnect();
  });

  test("the declared defaults are the DATABASE's, not admission's", async () => {
    const client = createClient({
      schema: { account },
      driver: createMySQL2Driver(),
    });
    await syncLiveSchema(client);

    // Raw SQL: no ORM admission, so only a default the DDL actually created
    // can fill these three columns.
    await client.$executeRawUnsafe(
      "INSERT INTO `attest_accounts` (`id`, `tags`) VALUES ('a1', '[]')"
    );
    const rows = await client.$queryRawUnsafe<{
      role: string;
      note: string;
      code: string;
    }>(
      "SELECT `role`, `note`, `code` FROM `attest_accounts` WHERE `id` = 'a1'"
    );
    expect(rows[0]).toMatchObject({
      role: "member",
      note: "unset",
      code: "none",
    });

    await client.$disconnect();
  });

  test("an actual change is planned, applied and then converges", async () => {
    const before = createClient({
      schema: { account },
      driver: createMySQL2Driver(),
    });
    await syncLiveSchema(before);
    await before.$disconnect();

    const after = createClient({
      schema: { account: widenedAccount },
      driver: createMySQL2Driver(),
    });
    const changed = await syncLiveSchema(after);
    expect(changed.applied).toBe(true);
    expect(changed.operations.length).toBeGreaterThan(0);

    const snapshot = await introspect(after);
    const table = snapshot.tables.find((t) => t.name === "attest_accounts");
    const byName = new Map(table?.columns.map((c) => [c.name, c]));
    expect(byName.get("role")?.type).toBe(
      "ENUM('admin', 'member', 'guest', 'auditor')"
    );
    expect(byName.get("note")?.default).toBe("('changed')");

    const settled = await syncLiveSchema(after);
    expect(settled.operations).toEqual([]);

    await after.$disconnect();
  });

  test("an apostrophe survives MySQL's deparse of an expression default", async () => {
    const client = createClient({
      schema: { quoted },
      driver: createMySQL2Driver(),
    });
    expect((await syncLiveSchema(client)).applied).toBe(true);

    // `information_schema` escapes the expression TWICE — MySQL prints the
    // string literal `'it\'s'`, the catalog prints that expression — so the
    // TEXT column is reported as the characters `_utf8mb4\'it\\\'s\'`
    // (measured on this server, 8.4.11). Read back into the spelling the
    // desired side wrote, there is nothing to do on the second push; read
    // back as the catalog spells it, this column would be re-planned and the
    // push would then FAIL at the final attestation with MIGRATION_DRIFT.
    const second = await syncLiveSchema(client);
    expect(second.operations).toEqual([]);
    expect(second.sql).toEqual([]);

    const snapshot = await introspect(client);
    const byName = new Map(
      snapshot.tables
        .find((t) => t.name === "attest_quoted")
        ?.columns.map((c) => [c.name, c])
    );
    expect(byName.get("note")?.default).toBe("('it''s')");
    expect(byName.get("code")?.default).toBe("'it''s'");

    // The VALUE is the database's, and it is the declared one: raw SQL, so
    // no admission-time default can supply it.
    await client.$executeRawUnsafe(
      "INSERT INTO `attest_quoted` (`id`) VALUES ('q1')"
    );
    const rows = await client.$queryRawUnsafe<{ note: string; code: string }>(
      "SELECT `note`, `code` FROM `attest_quoted` WHERE `id` = 'q1'"
    );
    expect(rows[0]).toMatchObject({ note: "it's", code: "it's" });

    await client.$disconnect();
  });

  test("a backslash in a declared default reaches the database intact", async () => {
    const client = createClient({
      schema: { backslashed },
      driver: createMySQL2Driver(),
    });

    // Re-expressed for the repaired DDL spelling (repair prompt §4.1). This
    // cell pinned the fail-closed OUTCOME of a defect: `escapeValue` doubled
    // `'` and left `\` alone, MySQL's DDL read the backslash as an escape
    // introducer, and the column it created carried `a<BS>` — so the inverse
    // succeeded on that body, reconstructed a value that is not the declared
    // one, and the push failed at the final attestation with MIGRATION_DRIFT.
    // The spelling is now MySQL's own (`mysqlStringLiteral`), so the
    // attestation the push makes is the ordinary one, and what it attests is
    // the DECLARED value. The wider matrix — a newline, a CRLF, a trailing
    // backslash, the literal-default half, a declared change — is
    // `tests/unit/migrations/mysql-defaults-docker.test.ts`.
    expect((await syncLiveSchema(client)).applied).toBe(true);
    const second = await syncLiveSchema(client);
    expect(second.operations).toEqual([]);
    expect(second.sql).toEqual([]);

    const snapshot = await introspect(client);
    const byName = new Map(
      snapshot.tables
        .find((t) => t.name === "attest_backslashed")
        ?.columns.map((c) => [c.name, c])
    );
    expect(byName.get("note")?.default).toBe(String.raw`('a\\b')`);

    // The VALUE is the database's: raw SQL, so no admission-time default can
    // supply it.
    await client.$executeRawUnsafe(
      "INSERT INTO `attest_backslashed` (`id`) VALUES ('b1')"
    );
    const rows = await client.$queryRawUnsafe<{ note: string }>(
      "SELECT `note` FROM `attest_backslashed` WHERE `id` = 'b1'"
    );
    expect(rows[0]?.note).toBe(String.raw`a\b`);

    await client.$disconnect();
  });
});
