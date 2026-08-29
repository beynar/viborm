/**
 * Neon HTTP and PlanetScale live-capability admission.
 *
 * Effectful V1 verbs must refuse DRIVER_NOT_SUPPORTED before any provider
 * call. Squash is gone. Dry down/reset are read-only in V1 and are not in
 * this matrix.
 */

import { createClient } from "@client/client";
import { NeonHTTPDriver } from "@drivers/neon-http";
import { PGliteDriver } from "@drivers/pglite";
import { PlanetScaleDriver } from "@drivers/planetscale";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient, type WritableMigrations } from "@migrations";
import { applyV1 as apply } from "@migrations/apply-v1";
import {
  downV1 as down,
  statusV1 as status,
  verifyV1 as verify,
} from "@migrations/operators";
import { pushV1 as applyPush, previewPush } from "@migrations/push-v1";
import { resetV1 as reset } from "@migrations/reset-v1";
import { s } from "@schema";
import type { MigrationClient } from "@src/migrations/push/planner";
import { describe, expect, it, vi } from "vitest";
import { MemoryStorage, mysqlEstateDriver } from "./_estate";

const schema = {
  user: s.model({
    id: s.string().id(),
    email: s.string().unique(),
  }),
};

describe("a transport with no interactive session is refused", () => {
  const neonDriver = () =>
    new NeonHTTPDriver({
      databaseUrl: "postgresql://user:pw@example.neon.tech/db",
      namespace: "alpha",
    });

  it("declares no pinned-session capability", () => {
    expect(neonDriver()._canPinSession()).toBe(false);
    expect(new PGliteDriver()._canPinSession()).toBe(true);
  });

  it.each([
    ["apply()", (migrations: WritableMigrations) => migrations.apply()],
    ["down()", (migrations: WritableMigrations) => migrations.down()],
    ["reset()", (migrations: WritableMigrations) => migrations.reset()],
    ["verify()", (migrations: WritableMigrations) => migrations.verify()],
  ])("refuses %s with DRIVER_NOT_SUPPORTED before any provider call", async (_label, run) => {
    const driver = neonDriver();
    const executed = vi.spyOn(driver, "_executeRaw").mockImplementation(() => {
      throw new Error("the refusal did not precede provider work");
    });
    const storage = new MemoryStorage();
    const client = createClient({ schema, driver });
    const migrations = createMigrationClient(client, { storage });
    await migrations.generate({ name: "init" });
    storage.writes.length = 0;

    await expect(run(migrations)).rejects.toMatchObject({
      code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
    });
    expect(executed).not.toHaveBeenCalled();
    expect(storage.writes).toEqual([]);
  });

  it("refuses a non-dry push and admits the dry run", async () => {
    const client = createClient({ schema, driver: neonDriver() });

    await expect(applyPush(client)).rejects.toMatchObject({
      code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
    });

    await expect(previewPush(client)).rejects.not.toMatchObject({
      code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
    });
  });

  it("leaves storage-only and read-only paths alone", async () => {
    const driver = neonDriver();
    const storage = new MemoryStorage();
    const client = createClient({ schema, driver });
    const migrations = createMigrationClient(client, { storage });

    const generated = await migrations.generate({ name: "init" });
    expect(generated.outcome).toBe("published");
    expect((await migrations.check()).ok).toBe(true);
    expect(await migrations.list()).toHaveLength(1);

    await expect(status(client, storage)).rejects.not.toMatchObject({
      code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
    });
  });
});

describe("PlanetScale refuses every effectful verb", () => {
  const planetscaleDriver = () =>
    new PlanetScaleDriver({
      databaseUrl: "mysql://user:pw@example.psdb.cloud/alpha",
      namespace: "alpha",
    });

  const verbs: ReadonlyArray<{
    readonly label: string;
    readonly command: string;
    readonly run: (
      client: MigrationClient,
      storage: MemoryStorage
    ) => Promise<unknown>;
  }> = [
    {
      label: "apply()",
      command: "apply()",
      run: (client, storage) => apply(client, storage),
    },
    {
      label: "down()",
      command: "down()",
      run: (client, storage) => down(client, storage),
    },
    {
      label: "reset()",
      command: "reset()",
      run: (client, storage) => reset(client, storage),
    },
    {
      label: "verify()",
      command: "verify()",
      run: (client, storage) => verify(client, storage),
    },
    {
      label: "push()",
      command: "push()",
      run: (client) => applyPush(client),
    },
    {
      label: "push({ forceReset })",
      command: "push({ forceReset: true })",
      run: (client) => applyPush(client, { forceReset: true }),
    },
  ];

  it.each(
    verbs
  )("refuses $label on the attestation, before any provider statement", async (verb) => {
    const driver = planetscaleDriver();
    const executed = vi.spyOn(driver, "_executeRaw").mockImplementation(() => {
      throw new Error("the refusal did not precede provider work");
    });
    const storage = new MemoryStorage();
    const client = createClient({ schema, driver });
    const migrations = createMigrationClient(client, { storage });
    await migrations.generate({ name: "init" });
    storage.writes.length = 0;

    await expect(verb.run(client, storage)).rejects.toMatchObject({
      code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
      message: expect.stringContaining("non-redirecting"),
      meta: { command: verb.command, driver: "planetscale" },
    });
    expect(executed).not.toHaveBeenCalled();
    expect(storage.writes).toEqual([]);
  });

  it("has no attestation to give, and refuses a session-capable twin alike", async () => {
    expect(planetscaleDriver().migrationNamespaceAttestation).toBeUndefined();

    const capable = mysqlEstateDriver({ namespace: "alpha" });
    expect(capable._canPinSession()).toBe(true);
    const storage = new MemoryStorage();
    const client = { $driver: capable, $schema: schema };
    const migrations = createMigrationClient(client, { storage });
    await migrations.generate({ name: "init" });
    storage.writes.length = 0;

    await expect(down(client, storage)).rejects.toMatchObject({
      code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
      message: expect.stringContaining("non-redirecting"),
    });
    expect(capable.statements).toEqual([]);
    expect(capable.sessions).toEqual([]);
  });
});
