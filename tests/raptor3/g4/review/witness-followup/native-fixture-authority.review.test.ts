/**
 * Independent review probes — the two facts the repaired native fixture now
 * owns a second copy of, and one side effect of borrowing a driver-built pool.
 *
 * Neither cell needs a live provider.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PgDriver } from "@drivers/pg";
import { Pool as PgPool } from "pg";
import { describe, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../../../..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

class PgFactory extends PgDriver {
  own(): Promise<PgPool> {
    return this.getClient() as Promise<PgPool>;
  }
}

/** The fixture's own copy of the rule, lifted from its source. */
function fixtureDateTime(iso: string): string {
  const source = read("tests/raptor3/g4/native/read-envelope-native.test.ts");
  const body = /function nativeDateTime\(iso: string\): string \{([\s\S]*?)\n\}/
    .exec(source)?.[1];
  assert.ok(body, "nativeDateTime is no longer spelled where this probe reads it");
  assert.ok(
    body.includes('liveProvider === "pg"'),
    "nativeDateTime no longer branches on the provider"
  );
  const mysqlArm = body.slice(body.indexOf(":") + 1).trim();
  // eslint-disable-next-line no-new-func
  return new Function("iso", `return ${mysqlArm.replace(/;$/, "")};`)(iso) as string;
}

describe("review probe: the fixture's second copy of a production rule", () => {
  it("spells a datetime exactly as the MySQL adapter's literal does", () => {
    const adapter = new MySQLAdapter();
    for (const iso of [
      "2024-01-15T10:30:00.123Z",
      "1970-01-01T00:00:00.000Z",
      "2030-12-31T23:59:59.000Z",
      "2024-06-30T22:00:00.500Z",
    ]) {
      const literal = adapter.literals.dateTime(iso);
      assert.deepEqual(
        [fixtureDateTime(iso)],
        literal.values,
        `the fixture and the adapter disagree on how ${iso} is stored`
      );
    }
  });
});

describe("review probe: what borrowing a driver-built pool attaches", () => {
  it("leaves no unread background-failure listener on the fixture's pool", async () => {
    // `PgDriver.initClient()` subscribes an error listener whose retained
    // failure is readable only through the driver instance that made it. The
    // fixture discards that instance, so a background pool error is retained
    // by an object nobody reads instead of reaching Node — where, under the
    // pre-repair `new PgPool(options)`, it would have failed the run loudly.
    const pool = await new PgFactory({
      options: { host: "127.0.0.1", port: 1, max: 1 },
    }).own();
    try {
      assert.equal(
        pool.listenerCount("error"),
        0,
        "the borrowed pool carries an error listener the fixture cannot read"
      );
    } finally {
      await pool.end();
    }
  });
});
