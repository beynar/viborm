/**
 * An estate written by the published viborm@1.4.3, whose snapshot deltas are
 * all `snapshot-delta-1`, still checks and applies on this engine, and the
 * next state stores a keyed `snapshot-delta-2` against a 1.4.3 delta.
 *
 * `tests/fixtures/migrations/estate-1.4.3` holds the bytes 1.4.3 wrote; it is
 * excluded from formatting, since its files are addressed by their hashes.
 * The models below must stay exactly those it generated, version 0 to 3.
 */

import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";
import { createMigrationClient } from "@src/migrations/client";
import { loadMigrationGraph } from "@src/migrations/graph";
import { createFsStorageWriter } from "@src/migrations/storage/fs-estate";
import { expect, test } from "vitest";

const FIXTURE = join(
  import.meta.dirname,
  "../../fixtures/migrations/estate-1.4.3"
);

function schema(version: number) {
  const levels = version >= 2 ? ["low", "mid", "high"] : ["low", "high"];
  return {
    author: s
      .model({
        id: s.string().id(),
        name: s.string(),
        email: s.string().unique(),
      })
      .map("fx_author"),
    ...(version >= 4
      ? {
          badge: s
            .model({ id: s.string().id(), title: s.string() })
            .map("fx_badge"),
        }
      : {}),
    gadget: s
      .model({
        id: s.string().id(),
        price: s.int().default(version >= 3 ? 1 : 0),
        level: s.enum(levels).map("fx_level"),
      })
      .map("fx_gadget"),
    zebra: s
      .model({
        id: s.string().id(),
        label: s.string().nullable(),
        ...(version >= 4 ? { mane: s.string().nullable() } : {}),
        stripes: s.int(),
      })
      .map("fx_zebra"),
    comment: s
      .model({
        id: s.string().id(),
        body: s.string(),
        authorId: s.string(),
        createdAt: s.dateTime().now(),
      })
      .map("fx_comment"),
  };
}

function format(directory: string, file: string): unknown {
  return JSON.parse(readFileSync(join(directory, "snapshots", file), "utf8"))
    .format;
}

test("a 1.4.3 estate of delta-1 artifacts applies, and its next state is a keyed delta-2", async () => {
  const directory = mkdtempSync(join(tmpdir(), "viborm-estate-143-"));
  cpSync(FIXTURE, directory, { recursive: true });
  const driver = new PGliteDriver();
  try {
    const storage = createFsStorageWriter(directory);
    const formats = readdirSync(join(directory, "snapshots")).map((file) =>
      format(directory, file)
    );
    expect(formats.sort()).toEqual([
      "snapshot-delta-1",
      "snapshot-delta-1",
      "snapshot-delta-1",
      undefined,
    ]);

    const current = createMigrationClient(
      createClient({ schema: schema(3), driver }),
      { storage }
    );
    expect(await current.check()).toEqual({ ok: true, findings: [] });
    await current.apply();
    expect(await current.verify()).toEqual({ ok: true });
    expect((await current.push({ dryRun: true })).operations).toEqual([]);

    const next = createMigrationClient(
      createClient({ schema: schema(4), driver }),
      { storage }
    );
    const generated = await next.generate({ name: "insert-badge-and-mane" });
    const graph = await loadMigrationGraph(storage);
    const manifest = graph.states.get(generated.stateId!)!;
    const artifact = `${manifest.snapshotArtifactHash}.json`;
    const delta = JSON.parse(
      readFileSync(join(directory, "snapshots", artifact), "utf8")
    );
    expect(delta.format).toBe("snapshot-delta-2");
    expect(format(directory, `${delta.baseArtifactHash}.json`)).toBe(
      "snapshot-delta-1"
    );
    expect(delta.changes.map((change: { op: string }) => change.op)).toEqual([
      "insert",
      "insert",
    ]);
    expect(await next.check()).toEqual({ ok: true, findings: [] });
    await next.apply();
    expect(await next.verify()).toEqual({ ok: true });
  } finally {
    await driver.disconnect();
    rmSync(directory, { recursive: true, force: true });
  }
});
