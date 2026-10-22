import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@client/client";
import { s } from "@schema";
import { VibORMErrorCode } from "@src/errors";
import { createMigrationClient } from "@src/migrations/client";
import { loadMigrationGraph } from "@src/migrations/graph";
import { createFsStorageWriter } from "@src/migrations/storage/fs-estate";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { describe, expect, test } from "vitest";

function schema(extra: boolean) {
  return {
    entity: s.model({
      id: s.string().id(),
      title: s.string(),
      payload: s.string(),
      count: s.int().default(0),
      ...(extra ? { note: s.string().nullable() } : {}),
    }),
  };
}

describe("incremental snapshots on filesystem and live SQLite", () => {
  test("generate, apply, verify, no-op push, down and reapply use authenticated reconstructed schemas", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viborm-incremental-"));
    const driver = createInMemorySQLite3Driver();
    const initial = createClient({ schema: schema(false), driver });
    const next = createClient({ schema: schema(true), driver });
    const storage = createFsStorageWriter(directory);
    const rootMigrations = createMigrationClient(initial, { storage });
    const nextMigrations = createMigrationClient(next, { storage });
    try {
      const root = await rootMigrations.generate({ name: "root" });
      await rootMigrations.apply();
      await initial.entity.create({
        data: { id: "one", title: "retained", payload: "value" },
      });
      const preview = await nextMigrations.generate({
        name: "next",
        dryRun: true,
      });
      const generated = await nextMigrations.generate({ name: "next" });
      expect(generated.stateId).toBe(preview.stateId);
      const graph = await loadMigrationGraph(storage);
      const manifest = graph.states.get(generated.stateId!)!;
      expect(manifest.snapshotArtifactHash).toBeDefined();
      expect(
        readFileSync(
          join(directory, "snapshots", `${manifest.snapshotArtifactHash}.json`),
          "utf8"
        )
      ).toContain('"snapshot-delta-1"');
      expect(await nextMigrations.check()).toEqual({ ok: true, findings: [] });
      await nextMigrations.apply();
      expect(await nextMigrations.verify()).toEqual({ ok: true });
      expect(
        await next.entity.findUnique({ where: { id: "one" } })
      ).toMatchObject({ title: "retained", note: null });
      expect((await nextMigrations.push()).operations).toEqual([]);
      await nextMigrations.down();
      expect((await rootMigrations.status()).marker?.stateId).toBe(
        root.stateId
      );
      expect(await rootMigrations.verify()).toEqual({ ok: true });
      await nextMigrations.apply();
      expect(await nextMigrations.verify()).toEqual({ ok: true });
      expect(
        await next.entity.findUnique({ where: { id: "one" } })
      ).toMatchObject({ title: "retained", note: null });
    } finally {
      await initial.$disconnect();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a corrupted base on disk refuses before creating migration control tables", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "viborm-incremental-corrupt-")
    );
    const client = createClient({
      schema: schema(false),
      driver: createInMemorySQLite3Driver(),
    });
    const changed = createClient({
      schema: schema(true),
      driver: client.$driver,
    });
    const storage = createFsStorageWriter(directory);
    try {
      const root = await createMigrationClient(client, { storage }).generate({
        name: "root",
      });
      const migrations = createMigrationClient(changed, { storage });
      await migrations.generate({ name: "next" });
      writeFileSync(
        join(directory, "snapshots", `${root.snapshotHash}.json`),
        "{}"
      );
      await expect(migrations.apply()).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
      });
      const tables = await client.$driver._executeRaw<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
      );
      expect(tables.rows).toEqual([]);
    } finally {
      await client.$disconnect();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
