import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import { NeonHTTPDriver } from "@drivers/neon-http";
import { s } from "@schema";
import { VibORMErrorCode } from "@src/errors";
import { admitLiveMigrationCapability } from "@src/migrations/admission";
import { getMigrationDriver } from "@src/migrations/drivers";
import { previewPush, pushV1 } from "@src/migrations/push-v1";
import { describe, expect, test } from "vitest";
import {
  mysqlEstateDriver,
  pgEstateDriver,
  RecordingDriver,
  sqliteEstateDriver,
} from "./_estate";

const schema = {
  user: s.model({
    id: s.string().id(),
    email: s.string().unique(),
  }),
};

class UnpinnablePostgres extends RecordingDriver {
  constructor(...args: ConstructorParameters<typeof RecordingDriver>) {
    super(...args);
    // The reservation hook's ABSENCE is the whole capability answer.
    Object.defineProperty(this, "pinnedSession", { value: undefined });
  }
}

describe("migration v1 live admission", () => {
  test("sqlite3 remains effectful", () => {
    const driver = getMigrationDriver(sqliteEstateDriver());
    expect(() =>
      admitLiveMigrationCapability(driver, "effectful", "apply()")
    ).not.toThrow();
  });

  test("D1 refuses effectful work and still admits reads", () => {
    const driver = getMigrationDriver(
      new RecordingDriver("sqlite", "d1", new SQLiteAdapter())
    );
    expect(() =>
      admitLiveMigrationCapability(driver, "read-only", "status()")
    ).not.toThrow();
    try {
      admitLiveMigrationCapability(driver, "effectful", "apply()");
      throw new Error("expected d1 refusal");
    } catch (error) {
      expect(error).toMatchObject({
        code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
      });
    }
  });

  test("an undeclared d1-http driver has no migration binding at all", () => {
    // No stock driver has this name, so it binds only by declaring the
    // SQLite migration capability; undeclared, every command refuses it.
    expect(() =>
      getMigrationDriver(
        new RecordingDriver("sqlite", "d1-http", new SQLiteAdapter())
      )
    ).toThrow(
      expect.objectContaining({ code: VibORMErrorCode.DRIVER_NOT_SUPPORTED })
    );
  });

  test("libsql refuses effectful work", () => {
    const driver = getMigrationDriver(
      new RecordingDriver("sqlite", "libsql", new SQLiteAdapter())
    );
    try {
      admitLiveMigrationCapability(driver, "effectful", "push()");
      throw new Error("expected libsql refusal");
    } catch (error) {
      expect(error).toMatchObject({
        code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
      });
    }
  });

  test("a PostgreSQL transport without a pin hook refuses effectful work", () => {
    const base = pgEstateDriver("public");
    const driver = getMigrationDriver(
      new UnpinnablePostgres("postgresql", "neon-http", base.adapter)
    );
    expect(() =>
      admitLiveMigrationCapability(driver, "read-only", "status()")
    ).not.toThrow();
    try {
      admitLiveMigrationCapability(driver, "effectful", "apply()");
      throw new Error("expected neon-http refusal");
    } catch (error) {
      expect(error).toMatchObject({
        code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
      });
    }
  });

  test("MySQL without a non-redirecting attestation refuses effectful work first", () => {
    const driver = getMigrationDriver(mysqlEstateDriver({ namespace: "app" }));
    try {
      admitLiveMigrationCapability(driver, "effectful", "apply()");
      throw new Error("expected attestation refusal");
    } catch (error) {
      expect(error).toMatchObject({
        code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
      });
    }
  });

  test("dry-run push on Neon HTTP is not DRIVER_NOT_SUPPORTED", async () => {
    const driver = new NeonHTTPDriver({
      databaseUrl: "postgresql://user:pw@example.neon.tech/db",
      namespace: "alpha",
    });
    const client = createClient({ schema, driver });
    await expect(pushV1(client)).rejects.toMatchObject({
      code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
    });
    await expect(previewPush(client)).rejects.not.toMatchObject({
      code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
    });
    await expect(pushV1(client, { dryRun: true })).rejects.not.toMatchObject({
      code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
    });
    await client.$disconnect();
  });

  test("dry-run push is not DRIVER_NOT_SUPPORTED on an unpinnable PostgreSQL transport", () => {
    const base = pgEstateDriver("public");
    const driver = getMigrationDriver(
      new UnpinnablePostgres("postgresql", "neon-http", base.adapter)
    );
    expect(() =>
      admitLiveMigrationCapability(
        driver,
        "read-only",
        "push({ dryRun: true })"
      )
    ).not.toThrow();
    expect(() =>
      admitLiveMigrationCapability(driver, "effectful", "push()")
    ).toThrow();
    try {
      admitLiveMigrationCapability(driver, "effectful", "push()");
    } catch (error) {
      expect(error).toMatchObject({
        code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
      });
    }
  });

  test("attested MySQL without a namespace refuses after capability", () => {
    const driver = getMigrationDriver(mysqlEstateDriver({ attested: true }));
    try {
      admitLiveMigrationCapability(driver, "effectful", "apply()");
      throw new Error("expected unbound MySQL refusal");
    } catch (error) {
      expect(error).toMatchObject({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      });
    }
  });
});
