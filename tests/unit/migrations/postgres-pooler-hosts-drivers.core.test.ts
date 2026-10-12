/**
 * Every stock PostgreSQL driver that holds a migration session reports the
 * hosts its configuration names, so migration admission refuses Cloudflare
 * Hyperdrive and Neon `-pooler` endpoints whichever way they are configured,
 * and each takes the `migrationSessionAttestation` option that lifts it.
 * Nothing here connects: admission runs before any I/O.
 */

import { BunSQLDriver } from "@drivers/bun-sql";
import type { MigrationSessionAttestation } from "@drivers/driver";
import { PgDriver } from "@drivers/pg";
import { PostgresDriver, vibormTypes } from "@drivers/postgres";
import { Pool as NeonPool } from "@neondatabase/serverless";
import { ClientInitializationError, VibORMErrorCode } from "@src/errors";
import { admitLiveMigrationCapability } from "@src/migrations/admission";
import { getMigrationDriver } from "@src/migrations/drivers";
import { Pool } from "pg";
import postgres from "postgres";
import { describe, expect, test } from "vitest";

const HYPERDRIVE = "4f1c0e4b2a9d4c3e8b7a6f5e4d3c2b1a.hyperdrive.local";
const NEON_POOLER = "ep-quiet-sky-a1b2c3d4-pooler.eu-central-1.aws.neon.tech";
const url = (host: string) => `postgres://app:secret@${host}:5432/app`;

type Configured = PgDriver | PostgresDriver | BunSQLDriver;

interface Attest {
  migrationSessionAttestation?: MigrationSessionAttestation;
}

const configurations: readonly [string, (attest: Attest) => Configured][] = [
  [
    "pg databaseUrl",
    (a) => new PgDriver({ databaseUrl: url(HYPERDRIVE), ...a }),
  ],
  [
    "pg options.connectionString",
    (a) =>
      new PgDriver({ options: { connectionString: url(NEON_POOLER) }, ...a }),
  ],
  [
    "pg options.host",
    (a) => new PgDriver({ options: { host: HYPERDRIVE }, ...a }),
  ],
  [
    "pg supplied Pool",
    (a) =>
      new PgDriver({
        pool: new Pool({ connectionString: url(NEON_POOLER) }),
        ...a,
      }),
  ],
  [
    "Neon WebSocket Pool",
    (a) =>
      new PgDriver({
        pool: new NeonPool({ connectionString: url(NEON_POOLER) }),
        ...a,
      }),
  ],
  [
    "postgres.js databaseUrl",
    (a) => new PostgresDriver({ databaseUrl: url(NEON_POOLER), ...a }),
  ],
  [
    "postgres.js options.host",
    (a) => new PostgresDriver({ options: { host: HYPERDRIVE }, ...a }),
  ],
  [
    "postgres.js supplied client",
    (a) =>
      new PostgresDriver({
        client: postgres(url(NEON_POOLER), { types: vibormTypes }),
        ...a,
      }),
  ],
  [
    "Bun SQL databaseUrl",
    (a) => new BunSQLDriver({ databaseUrl: url(HYPERDRIVE), ...a }),
  ],
  [
    "Bun SQL options.hostname",
    (a) => new BunSQLDriver({ options: { hostname: NEON_POOLER }, ...a }),
  ],
  [
    "Bun SQL supplied client",
    // Bun's SQL exposes its resolved options; nothing here runs a query.
    (a) =>
      new BunSQLDriver({
        client: { options: { hostname: HYPERDRIVE } } as never,
        ...a,
      }),
  ],
];

function admission(driver: Configured): unknown {
  try {
    admitLiveMigrationCapability(
      getMigrationDriver(driver),
      "effectful",
      "apply()"
    );
    return "admitted";
  } catch (error) {
    return error instanceof Error ? Reflect.get(error, "code") : error;
  }
}

describe("stock PostgreSQL drivers report their pooler hosts", () => {
  test.each(
    configurations
  )("%s is refused without the attestation", (_label, make) => {
    expect(admission(make({}))).toBe(VibORMErrorCode.DRIVER_NOT_SUPPORTED);
  });

  test.each(
    configurations
  )("%s is admitted with the attestation", (_label, make) => {
    expect(
      admission(make({ migrationSessionAttestation: "dedicated-session" }))
    ).toBe("admitted");
  });

  test("a direct endpoint needs no attestation", () => {
    expect(
      admission(
        new PgDriver({
          databaseUrl: url("ep-quiet-sky-a1b2c3d4.eu-central-1.aws.neon.tech"),
        })
      )
    ).toBe("admitted");
  });

  test("only the exact attestation literal is accepted", () => {
    for (const value of ["dedicated", true, "Dedicated-Session"]) {
      // A JavaScript caller can write any value; a near miss must not read as
      // an approximate claim.
      const options = Object.defineProperty(
        { databaseUrl: url(HYPERDRIVE) },
        "migrationSessionAttestation",
        { value }
      );
      expect(() => new PgDriver(options)).toThrow(ClientInitializationError);
    }
  });
});
