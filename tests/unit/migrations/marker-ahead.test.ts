/**
 * S8 on live PostgreSQL (PGlite): old code against a newer marker.
 *
 * A deployment applies v1 -> v2 from its estate; older code that only holds v1
 * (version skew, or Durable Object storage restored behind Postgres) then
 * starts against that database. Before 1.2.0 `status()` and `apply()` threw
 * V11002 "No path exists" and `verify()` reported V11022 corruption. Now the
 * marker is classified against the old history: `ahead` when its arrival path
 * passes through a state this estate holds, `unknown` when nothing on it does.
 */

import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient } from "@migrations";
import { s } from "@schema";
import type { AnyModel } from "@src/schema/model";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStorage } from "./_estate";

const fields = () => ({
  id: s.string().id(),
  email: s.string().unique(),
  name: s.string(),
  status: s.enum(["trial", "active", "churned"]).default("trial"),
  balance: s.int().default(0),
  score: s.number().nullable(),
  settings: s.json().nullable(),
  country: s.string().default("FR"),
  age: s.int().nullable(),
  verified: s.boolean().default(false),
  notes: s.string().nullable(),
  lastSeenAt: s.dateTime().nullable(),
  deletedAt: s.dateTime().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
});
const v1 = { account: s.model(fields()).map("accounts") };
const v2 = {
  account: s
    .model({ ...fields(), nickname: s.string().nullable() })
    .map("accounts"),
};
const stranger = {
  account: s
    .model({ ...fields(), region: s.string().nullable() })
    .map("accounts"),
};

const AHEAD_REFUSAL = /ahead of this migration history/;
const UNKNOWN_REFUSAL = /unknown to this migration estate/;

let driver: AnyDriver;

function migrationsFor(
  schema: Record<string, AnyModel>,
  storage: MemoryStorage
) {
  return createMigrationClient(createClient({ driver, schema }), { storage });
}

async function markerRow() {
  const result = await driver._executeRaw<{ payload: string }>(
    `SELECT payload FROM "public"."_viborm_migration_state" WHERE singleton = 1`
  );
  return result.rows[0]?.payload;
}

/** The newer deployment: v1 then v2, applied. Returns the v2 state id. */
async function newerDeployment() {
  const storage = new MemoryStorage();
  await migrationsFor(v1, storage).generate({ name: "v1" });
  await migrationsFor(v1, storage).apply();
  const head = await migrationsFor(v2, storage).generate({ name: "v2" });
  await migrationsFor(v2, storage).apply();
  return head.stateId;
}

beforeEach(() => {
  driver = createInMemoryPGliteDriver();
});
afterEach(() => driver.disconnect());

describe("a marker ahead of this history", () => {
  it("is reported by status and verify and follows apply({ ifAhead })", async () => {
    const head = await newerDeployment();
    const before = await markerRow();
    const old = migrationsFor(v1, new MemoryStorage());
    await old.generate({ name: "v1" });

    const status = await old.status();
    expect(status).toMatchObject({
      control: "present",
      markerState: "ahead",
      pending: [],
      unfinished: false,
    });
    expect(status.marker?.stateId).toBe(head);
    await expect(old.verify()).resolves.toEqual({
      ok: false,
      markerState: "ahead",
    });

    const noop = { outcome: "noop", path: [], statements: [] };
    await expect(old.apply({ ifAhead: "noop" })).resolves.toEqual(noop);
    await expect(old.apply({ ifAhead: "noop", dryRun: true })).resolves.toEqual(
      noop
    );
    for (const options of [{ ifAhead: "refuse" as const }, {}]) {
      await expect(old.apply(options)).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_NOT_FOUND,
        message: expect.stringMatching(AHEAD_REFUSAL),
      });
      await expect(old.apply(options)).rejects.toThrow(`names state ${head}`);
    }
    await expect(old.apply({ dryRun: true })).rejects.toMatchObject({
      message: expect.stringMatching(AHEAD_REFUSAL),
    });
    expect(await markerRow()).toBe(before);
  });

  it("calls a marker none of whose path this estate holds unknown, and never no-ops on it", async () => {
    await newerDeployment();
    const other = migrationsFor(stranger, new MemoryStorage());
    await other.generate({ name: "stranger" });

    await expect(other.status()).resolves.toMatchObject({
      markerState: "unknown",
      pending: [],
    });
    await expect(other.verify()).resolves.toEqual({
      ok: false,
      markerState: "unknown",
    });
    await expect(other.apply({ ifAhead: "noop" })).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_NOT_FOUND,
      message: expect.stringMatching(UNKNOWN_REFUSAL),
    });
  });

  it("leaves a marker this history holds unclassified", async () => {
    await newerDeployment();
    const current = new MemoryStorage();
    await migrationsFor(v1, current).generate({ name: "v1" });
    const same = migrationsFor(v2, current);
    await same.generate({ name: "v2" });
    const status = await same.status();
    expect(status).not.toHaveProperty("markerState");
    await expect(same.verify()).resolves.toEqual({ ok: true });
    await expect(same.apply({ ifAhead: "refuse" })).resolves.toMatchObject({
      outcome: "noop",
    });
  });
});
