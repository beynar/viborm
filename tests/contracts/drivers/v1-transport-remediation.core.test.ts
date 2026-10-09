import { normalizeDriverError } from "@drivers/error-mapping";
import { PostgresDriver, vibormTypes } from "@drivers/postgres";
import { parseMySQLUrl } from "@drivers/shared/mysql-utils";
import { convertValuesForSQLite } from "@drivers/shared/sqlite-utils";
import { isRetryableError } from "@errors";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

describe("V1 provider boundary regressions", () => {
  it.each([
    "null",
    "false",
    "42",
  ])("refuses ssl=%s when the URL requires verified TLS", (ssl) => {
    expect(() =>
      parseMySQLUrl(`mysql://localhost/db?sslmode=require&ssl=${ssl}`)
    ).toThrow("requires a TLS configuration");
  });

  it("retains an explicit TLS profile and supplies TLS when sslmode alone requires it", () => {
    expect(
      parseMySQLUrl("mysql://localhost/db?sslmode=verify-full").ssl
    ).toEqual({});
    expect(
      parseMySQLUrl("mysql://localhost/db?sslmode=require&ssl=Amazon%20RDS").ssl
    ).toBe("Amazon RDS");
  });

  it("preserves MySQL TLS/options and decodes URL credentials exactly once", () => {
    const options = parseMySQLUrl(
      "mysql://user%40tenant:p%25%2Fword@localhost/app%5Fdb?ssl=%7B%22rejectUnauthorized%22%3Atrue%7D&connectTimeout=4200"
    );
    expect(options).toMatchObject({
      user: "user@tenant",
      password: "p%/word",
      database: "app_db",
      ssl: { rejectUnauthorized: true },
      connectTimeout: 4200,
    });
    expect(() =>
      parseMySQLUrl("mysql://localhost/db?sslaccept=strict")
    ).toThrow("TLS");
    expect(() =>
      parseMySQLUrl("mysql://localhost/db?sslmode=prefer")
    ).toThrow();
  });

  it("preserves native PostgreSQL URL TLS and rejects unsafe supplied temporal setup", async () => {
    const unsafe = postgres("postgres://fixture:fixture@localhost/db", {
      max: 1,
    });
    expect(() => new PostgresDriver({ client: unsafe })).toThrow(
      "temporal parsers"
    );
    await unsafe.end();
    const safe = postgres(
      "postgres://fixture:fixture@localhost/db?sslmode=require",
      { max: 1, types: vibormTypes }
    );
    const driver = new PostgresDriver({ client: safe });
    expect(safe.options.ssl).toBe("require");
    await driver._disconnect();
    await safe.end();
  });

  it("maps Bun SQL SQLSTATE and connection/lock timeout signals to their public families", () => {
    expect(
      normalizeDriverError(
        { code: "ERR_POSTGRES_SERVER_ERROR", errno: "23505" },
        { driverName: "bun-sql", dialect: "postgresql" }
      )
    ).toMatchObject({
      name: "UniqueConstraintError",
      meta: { providerCode: "23505" },
    });
    const connection = normalizeDriverError(
      { code: "ECONNREFUSED" },
      { driverName: "pg" }
    );
    expect(connection).toMatchObject({ name: "ConnectionError" });
    expect(isRetryableError(connection)).toBe(true);
    const credentials = normalizeDriverError(
      { code: "28P01" },
      { driverName: "pg" }
    );
    expect(credentials).toMatchObject({ name: "ClientInitializationError" });
    expect(isRetryableError(credentials)).toBe(false);
    const timeout = normalizeDriverError(
      { code: "ER_LOCK_WAIT_TIMEOUT", errno: 1205 },
      { driverName: "mysql2" }
    );
    expect(timeout).toMatchObject({ code: "V2002" });
    expect(isRetryableError(timeout)).toBe(true);
  });

  it("encodes raw SQLite Date parameters as ISO timestamps", () => {
    expect(
      convertValuesForSQLite([new Date("2026-10-08T12:34:56.789Z")])
    ).toEqual(["2026-10-08T12:34:56.789Z"]);
  });
});
