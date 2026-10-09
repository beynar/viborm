import { createClient } from "@drivers/sqlite3";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { expect, test, vi } from "vitest";

/**
 * Typed statements on a timestamped, priced SQLite model cost what their own
 * SQL costs. 1.0.0 scanned the whole table for noncanonical DateTime text
 * before every statement (two 147 KB statements per findUnique on this shape),
 * so point operations grew linearly with the table; and a decimal column
 * wrapped every statement, reads included, in a catalog read plus
 * BEGIN IMMEDIATE, a storage assertion and COMMIT. Medians are bounded well
 * above an index lookup and far below one scan of 100k rows.
 */
const post = s
  .model({
    id: s.int().id(),
    title: s.string(),
    body: s.string(),
    views: s.int(),
    published: s.boolean(),
    price: s.decimal({ precision: 10, scale: 2 }),
    publishedAt: s.dateTime().nullable(),
    createdAt: s.dateTime().now(),
    updatedAt: s.dateTime().updatedAt(),
  })
  .map("scale_post")
  .index(["createdAt"]);

const BATCH = 1000;
const SAMPLES = 7;
const MEDIAN_MS = 25;
const MAX_STATEMENT_CHARS = 2048;
const EPOCH = Date.UTC(2026, 0, 1);

const row = (id: number) => ({
  id,
  title: `post ${id}`,
  body: `body of post ${id} `.repeat(8),
  views: id % 997,
  published: id % 2 === 0,
  price: `${id % 1000}.${String(id % 100).padStart(2, "0")}`,
  publishedAt: id % 3 === 0 ? null : new Date(EPOCH + id * 60_000),
  createdAt: new Date(EPOCH + id * 1000),
});

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

test.each([
  1000, 10_000, 100_000,
])("operations on a timestamped decimal model send only their own statement at %i rows", async (rows) => {
  const handle = new Database(":memory:");
  const client = createClient({ client: handle, schema: { post } });
  try {
    await syncLiveSchema(client);
    for (let start = 1; start <= rows; start += BATCH)
      await client.post.createMany({
        data: Array.from({ length: BATCH }, (_, offset) => row(start + offset)),
      });
    // A spied prepare also bypasses the driver's statement cache, so every
    // statement that reaches SQLite is recorded; transaction control is exec.
    const prepare = vi.spyOn(handle, "prepare");
    const exec = vi.spyOn(handle, "exec");
    const operations: Record<string, (sample: number) => Promise<unknown>> = {
      findUnique: (sample) =>
        client.post.findUnique({ where: { id: sample * 13 + 1 } }),
      findManyRange: (sample) =>
        client.post.findMany({
          where: {
            createdAt: {
              gte: new Date(EPOCH + (sample * 100 + 1) * 1000),
              lt: new Date(EPOCH + (sample * 100 + 11) * 1000),
            },
          },
        }),
      findManyDecimal: (sample) =>
        client.post.findMany({
          where: { price: { gte: `${sample}.00`, lt: `${sample}.02` } },
          take: 10,
        }),
      count: (sample) =>
        client.post.count({ where: { price: { gt: `${sample * 100}` } } }),
      update: (sample) =>
        client.post.update({
          where: { id: sample * 13 + 2 },
          data: { title: "edited", price: "12.34" },
        }),
      create: (sample) => client.post.create({ data: row(rows + 1 + sample) }),
      delete: (sample) =>
        client.post.delete({ where: { id: rows + 1 + sample } }),
    };
    for (const [name, operation] of Object.entries(operations)) {
      const timings: number[] = [];
      for (let sample = 0; sample < SAMPLES; sample += 1) {
        prepare.mockClear();
        exec.mockClear();
        const started = performance.now();
        const result = await operation(sample);
        timings.push(performance.now() - started);
        expect(result, name).toBeTruthy();
        expect(exec, name).not.toHaveBeenCalled();
        const statements = prepare.mock.calls.map(([source]) => source);
        expect(statements, name).toHaveLength(1);
        expect(statements[0]?.length, name).toBeLessThan(MAX_STATEMENT_CHARS);
        expect(statements[0], name).not.toContain("sqlite_schema");
      }
      expect(median(timings), name).toBeLessThan(MEDIAN_MS);
    }
    expect(
      await client.post.count({
        where: { createdAt: { gte: new Date(EPOCH + 1000) } },
      })
    ).toBe(rows);
  } finally {
    await client.$disconnect();
    handle.close();
  }
}, 120_000);
