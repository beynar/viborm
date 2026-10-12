/**
 * The two provider-free halves of the driver option boundary.
 *
 * - platform-16: `refuseUnknownDriverConfigKeys`, the one rule every driver's
 *   `createClient` applies to keys it does not read.
 * - platform-08 / platform-14: `parseMySQLUrl` returns only the keys the URL
 *   carries, and refuses a TLS request it cannot honour with VibORM's own
 *   secret-free text as a `ClientInitializationError`.
 */

import { refuseUnknownDriverConfigKeys } from "@drivers/shared/driver-options";
import { parseMySQLUrl } from "@drivers/shared/mysql-utils";
import { ClientInitializationError } from "@errors";
import { describe, expect, it } from "vitest";

const SQLITE_KEYS = { client: true, dataDir: true, options: true } as const;

describe("refuseUnknownDriverConfigKeys", () => {
  it("admits the client keys and the driver's own keys", () => {
    expect(() =>
      refuseUnknownDriverConfigKeys(
        { schema: {}, skipSchemaValidation: true, dataDir: "x", options: {} },
        "sqlite3",
        SQLITE_KEYS
      )
    ).not.toThrow();
  });

  it("names the first unknown key, with the driver's hint or its key list", () => {
    const hinted = () =>
      refuseUnknownDriverConfigKeys(
        { schema: {}, databaseUrl: "file:./x.db" },
        "sqlite3",
        SQLITE_KEYS,
        { databaseUrl: "pass the database file as dataDir" }
      );
    expect(hinted).toThrow(ClientInitializationError);
    expect(hinted).toThrow(
      'viborm/sqlite3 does not accept "databaseUrl"; pass the database file as dataDir.'
    );
    expect(() =>
      refuseUnknownDriverConfigKeys(
        { schema: {}, url: "x" },
        "sqlite3",
        SQLITE_KEYS
      )
    ).toThrow(
      'viborm/sqlite3 does not accept "url"; it accepts schema, skipSchemaValidation, client, dataDir, options.'
    );
  });

  it("refuses a present key whatever its value", () => {
    expect(() =>
      refuseUnknownDriverConfigKeys(
        { schema: {}, databaseUrl: undefined },
        "sqlite3",
        SQLITE_KEYS
      )
    ).toThrow('does not accept "databaseUrl"');
  });

  it("reads own keys only", () => {
    const inherited = Object.create({ databaseUrl: "file:./x.db" });
    inherited.schema = {};
    expect(() =>
      refuseUnknownDriverConfigKeys(inherited, "sqlite3", SQLITE_KEYS)
    ).not.toThrow();
  });
});

describe("parseMySQLUrl", () => {
  it("returns only the keys the URL carries", () => {
    expect(parseMySQLUrl("mysql://db.internal/app")).toEqual({
      host: "db.internal",
      database: "app",
    });
    expect(parseMySQLUrl("mysql://tenant@db.internal:3310")).toEqual({
      host: "db.internal",
      port: 3310,
      user: "tenant",
    });
  });

  it.each([
    ["sslmode=prefer", "Unsupported MySQL sslmode"],
    ["ssl-mode=REQUIRED", "Unsupported MySQL TLS URL option"],
    ["sslaccept=strict", "Unsupported MySQL TLS URL option"],
    ["sslmode=require&ssl=null", "MySQL sslmode requires a TLS configuration"],
  ])("refuses ?%s as a ClientInitializationError", (query, reason) => {
    const attempt = () => parseMySQLUrl(`mysql://app:pw@localhost/db?${query}`);
    expect(attempt).toThrow(ClientInitializationError);
    expect(attempt).toThrow(reason);
  });
});
