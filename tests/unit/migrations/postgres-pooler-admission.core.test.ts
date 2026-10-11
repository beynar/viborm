/**
 * PostgreSQL transports that cannot hold the migration lock.
 *
 * A transaction-pooling endpoint — Cloudflare Hyperdrive (`*.hyperdrive.local`)
 * or a Neon `-pooler` host — hands consecutive transactions to whichever server
 * session is free, so a session-scoped advisory lock is held by a backend the
 * migration's DDL may never run on. Admission refuses effectful commands on
 * those hosts, read from the driver's own configuration, before any I/O; the
 * caller's `migrationSessionAttestation: "dedicated-session"` lifts it at their
 * risk. Read-only work stays admitted.
 */

import type { MigrationSessionAttestation } from "@drivers/driver";
import { VibORMErrorCode } from "@src/errors";
import {
  admitLiveMigrationCapability,
  type MigrationLiveRequirement,
} from "@src/migrations/admission";
import { getMigrationDriver } from "@src/migrations/drivers";
import { describe, expect, test } from "vitest";
import { pgEstateDriver, RecordingDriver } from "./_estate";

const HYPERDRIVE = "4f1c0e4b2a9d4c3e8b7a6f5e4d3c2b1a.hyperdrive.local";
const NEON_POOLER = "ep-quiet-sky-a1b2c3d4-pooler.eu-central-1.aws.neon.tech";
const NEON_DIRECT = "ep-quiet-sky-a1b2c3d4.eu-central-1.aws.neon.tech";

/** A pinnable PostgreSQL driver whose configuration names `endpoints`. */
class EndpointPostgres extends RecordingDriver {
  private readonly endpoints: readonly unknown[];

  constructor(
    endpoints: readonly unknown[],
    attestation?: MigrationSessionAttestation
  ) {
    super("postgresql", "pg", pgEstateDriver("public").adapter);
    this.endpoints = endpoints;
    if (attestation !== undefined) {
      Object.defineProperty(this, "migrationSessionAttestation", {
        value: attestation,
      });
    }
  }

  protected override migrationSessionEndpoints(): readonly unknown[] {
    return this.endpoints;
  }
}

/** A PostgreSQL transport with no pinned-session hook (Neon HTTP's shape). */
class UnpinnableEndpointPostgres extends EndpointPostgres {
  constructor(...args: ConstructorParameters<typeof EndpointPostgres>) {
    super(...args);
    Object.defineProperty(this, "pinnedSession", { value: undefined });
  }
}

function admission(
  driver: RecordingDriver,
  requirement: MigrationLiveRequirement
): unknown {
  try {
    admitLiveMigrationCapability(
      getMigrationDriver(driver),
      requirement,
      requirement === "effectful" ? "apply()" : "status()"
    );
    return "admitted";
  } catch (error) {
    return error instanceof Error ? Reflect.get(error, "code") : error;
  }
}

const REFUSED = VibORMErrorCode.DRIVER_NOT_SUPPORTED;

describe("transaction-pooling hosts are refused for effectful migration work", () => {
  test.each([
    ["a Hyperdrive URL", `postgres://app:secret@${HYPERDRIVE}:5432/app`],
    ["a bare Hyperdrive host", HYPERDRIVE],
    ["a Hyperdrive host with a trailing dot", `${HYPERDRIVE}.`],
    [
      "a Neon -pooler URL",
      `postgresql://app:secret@${NEON_POOLER}/app?sslmode=require`,
    ],
    ["a bare Neon -pooler host", NEON_POOLER],
    [
      "a multi-host URL with one pooler",
      `postgres://app@db.example.com:5432,${NEON_POOLER}:5432/app`,
    ],
    // WHATWG URL (pg-connection-string) takes userinfo to the LAST `@`.
    [
      "a URL whose password holds an unencoded @",
      `postgres://app:p@ss@${NEON_POOLER}/app`,
    ],
    // libpq's `host` query parameter overrides the URL's own host.
    [
      "a URL whose host query parameter names a pooler",
      `postgres://db.example.com/app?sslmode=require&host=${HYPERDRIVE}`,
    ],
  ])("%s is refused, reads stay admitted", (_label, endpoint) => {
    const driver = new EndpointPostgres([undefined, endpoint]);
    expect(admission(driver, "effectful")).toBe(REFUSED);
    expect(admission(driver, "read-only")).toBe("admitted");
  });

  test.each([
    ["a direct Neon URL", `postgresql://app:secret@${NEON_DIRECT}/app`],
    ["a direct Neon host", NEON_DIRECT],
    ["an ordinary host", "db.example.com"],
    [
      "a pooler name inside the password",
      `postgres://app:${HYPERDRIVE}@db.example.com/app`,
    ],
    [
      "a pooler name inside the database name",
      `postgres://db.example.com/${NEON_POOLER}`,
    ],
    ["no configured endpoint", undefined],
    ["a non-string configuration value", 5432],
  ])("%s is admitted", (_label, endpoint) => {
    expect(admission(new EndpointPostgres([endpoint]), "effectful")).toBe(
      "admitted"
    );
  });

  test("a driver that names no endpoints is judged by its pinned-session hook alone", () => {
    expect(admission(pgEstateDriver("public"), "effectful")).toBe("admitted");
  });

  test("the dedicated-session attestation lifts the pooler refusal", () => {
    for (const endpoint of [HYPERDRIVE, NEON_POOLER]) {
      expect(
        admission(
          new EndpointPostgres([endpoint], "dedicated-session"),
          "effectful"
        )
      ).toBe("admitted");
    }
  });

  test("the attestation does not lift the refusal of a transport with no session", () => {
    const driver = new UnpinnableEndpointPostgres(
      [NEON_DIRECT],
      "dedicated-session"
    );
    expect(admission(driver, "effectful")).toBe(REFUSED);
    expect(admission(driver, "read-only")).toBe("admitted");
  });

  test("the refusal names the host and the way out", () => {
    try {
      admitLiveMigrationCapability(
        getMigrationDriver(new EndpointPostgres([NEON_POOLER])),
        "effectful",
        "apply()"
      );
      throw new Error("expected the pooler refusal");
    } catch (error) {
      expect(error).toMatchObject({ code: REFUSED });
      expect(String(error)).toContain(NEON_POOLER);
      expect(String(error)).toContain(
        'migrationSessionAttestation: "dedicated-session"'
      );
    }
  });
});
