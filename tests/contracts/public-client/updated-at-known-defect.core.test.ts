import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, expect, test } from "vitest";

const note = s.model({
  id: s.string().id(),
  label: s.string(),
  touchedAt: s.dateTime().updatedAt(),
});
const schema = { note };

const SEEDED = new Date("2026-01-01T00:00:00.000Z");

const seededOnly: StandardSchemaV1<string, string> = {
  "~standard": {
    version: 1,
    vendor: "updated-at-test",
    validate: (value) =>
      value === SEEDED.toISOString()
        ? { value }
        : { issues: [{ message: "timestamp rejected by custom schema" }] },
  },
};

const guarded = s.model({
  id: s.string().id(),
  touchedAt: s.dateTime().updatedAt().schema(seededOnly),
});
const guardedSchema = { guarded };
let disconnect: (() => Promise<void>) | undefined;

afterEach(async () => {
  await disconnect?.();
  disconnect = undefined;
});

test("an omitted `.updatedAt()` field refreshes on update", async () => {
  const client = createClient({
    schema,
    driver: new SQLite3Driver({ dataDir: ":memory:" }),
  });
  disconnect = () => client.$disconnect();
  await syncLiveSchema(client);
  await client.note.create({
    data: { id: "n1", label: "one", touchedAt: SEEDED },
  });

  const before = Date.now();
  const updated = await client.note.update({
    where: { id: "n1" },
    data: { label: "renamed" },
  });
  const after = Date.now();

  expect(updated.touchedAt.getTime()).toBeGreaterThanOrEqual(before);
  expect(updated.touchedAt.getTime()).toBeLessThanOrEqual(after);
});

test("an automatic update surfaces custom-schema refusal at the field", async () => {
  const client = createClient({
    schema: guardedSchema,
    driver: new SQLite3Driver({ dataDir: ":memory:" }),
  });
  disconnect = () => client.$disconnect();
  await syncLiveSchema(client);
  await client.guarded.create({
    data: { id: "g1", touchedAt: SEEDED.toISOString() },
  });

  await expect(
    client.guarded.update({ where: { id: "g1" }, data: {} })
  ).rejects.toMatchObject({
    name: "ValidationError",
    message: expect.stringContaining("timestamp rejected by custom schema"),
  });
});
