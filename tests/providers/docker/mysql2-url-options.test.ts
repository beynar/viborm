/**
 * What viborm/mysql2 makes of `databaseUrl` beside `options`.
 *
 * - platform-08: the URL fills only the keys it carries and explicit options
 *   win. The per-tenant shape is a URL per tenant plus a password from a
 *   secret; the URL's absent password and default port used to be spread over
 *   `options` as `undefined` and 3306, so that client could never log in.
 * - platform-14: a TLS URL option VibORM cannot honour is refused with VibORM's
 *   own secret-free text instead of "could not parse its databaseUrl"; the URL
 *   parser's own failure, which can carry the URL, stays redacted.
 * - platform-16: an unknown wrapper key is refused at `createClient`.
 *
 * The live half needs a running MySQL (docker): set MYSQL_TEST_CONNECTION_STRING
 * to a URL with a password. The construction half runs without one.
 */

import { inspect } from "node:util";
import {
  createClient,
  MySQL2Driver,
  type MySQL2Options,
} from "@drivers/mysql2";
import { ClientInitializationError } from "@errors";
import { s } from "@schema";
import { describe, expect, it } from "vitest";
import { TEST_CONNECTION_STRING } from "./mysql2-fixtures";

const member = s
  .model({ id: s.string().id(), email: s.string() })
  .map("url_option_members");
const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

async function connects(
  databaseUrl: string,
  options: MySQL2Options
): Promise<number> {
  const db = createClient({ schema: { member }, databaseUrl, options });
  try {
    const rows = await db.$queryRawUnsafe<{ one: number }>("SELECT 1 AS one");
    return Number(rows[0]?.one);
  } finally {
    await db.$disconnect();
  }
}

describeIf("viborm/mysql2 databaseUrl and options", () => {
  const live = new URL(TEST_CONNECTION_STRING ?? "mysql://localhost");
  const secret = decodeURIComponent(live.password);
  const user = decodeURIComponent(live.username);

  it("fills the password from options when the URL carries none", async () => {
    const url = new URL(live);
    url.password = "";
    expect(await connects(url.href, { password: secret })).toBe(1);
  });

  it("lets explicit options win over the keys the URL carries", async () => {
    const url = new URL(live);
    url.password = "not-the-password";
    url.port = "1";
    expect(
      await connects(url.href, {
        port: Number(live.port || 3306),
        password: secret,
        user,
      })
    ).toBe(1);
  });

  it("does not let an explicit undefined erase a URL key", async () => {
    expect(
      await connects(live.href, { password: undefined, port: undefined })
    ).toBe(1);
  });
});

describe("viborm/mysql2 target precedence", () => {
  it("binds options.database over the URL path, like every explicit option", () => {
    const driver = new MySQL2Driver({
      databaseUrl: "mysql://user:pw@host:3306/url_db",
      options: { database: "options_db" },
    });
    expect(driver.adapter.namespace).toBe("options_db");
  });

  it("binds the URL path when options name no database", () => {
    const driver = new MySQL2Driver({
      databaseUrl: "mysql://user:pw@host:3306/url_db",
      options: { database: undefined },
    });
    expect(driver.adapter.namespace).toBe("url_db");
  });
});

describe("viborm/mysql2 construction refusals", () => {
  it.each([
    ["sslmode=prefer", "Unsupported MySQL sslmode"],
    ["ssl-mode=REQUIRED", "Unsupported MySQL TLS URL option"],
    ["sslaccept=strict", "Unsupported MySQL TLS URL option"],
  ])("refuses ?%s with its own reason", (query, reason) => {
    const attempt = () =>
      createClient({
        schema: { member },
        databaseUrl: `mysql://app:pw@127.0.0.1:3307/app?${query}`,
      });
    expect(attempt).toThrow(ClientInitializationError);
    expect(attempt).toThrow(reason);
  });

  it("keeps the URL parser's failure redacted", () => {
    const secret = "hunter2-secret";
    let caught: unknown;
    try {
      createClient({
        schema: { member },
        databaseUrl: `mysql://app:${secret}@127.0.0.1:notaport/app`,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ClientInitializationError);
    expect(caught).toHaveProperty(
      "message",
      'Driver "mysql2" could not parse its databaseUrl.'
    );
    expect(inspect(caught, { depth: 6 })).not.toContain(secret);
  });

  it("refuses a key viborm/mysql2 does not read", () => {
    expect(() =>
      createClient({
        schema: { member },
        // @ts-expect-error -- not a viborm/mysql2 option
        dataDir: "./x.db",
      })
    ).toThrow(
      'viborm/mysql2 does not accept "dataDir"; it accepts schema, skipSchemaValidation, pool, options, databaseUrl, namespace, migrationNamespaceAttestation.'
    );
  });
});
