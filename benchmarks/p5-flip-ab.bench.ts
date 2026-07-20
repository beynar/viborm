/**
 * PLAN P5 item 4 — the default-flip A/B benchmark.
 *
 * The escape hatch (`queryEngine: "v1" | "v2"`) lets one process run identical
 * workloads through the frozen V1 runtime and the flipped V2 engine on separate
 * in-memory SQLite databases seeded identically. Ratios are V2 hz / V1 hz
 * (higher = V2 faster). Read the numbers, name the regressions — PERF.md
 * precedent is numbers, not adjectives.
 *
 * Run: pnpm bench -- benchmarks/p5-flip-ab.bench.ts
 */
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { push } from "@migrations";
import { bench, describe } from "vitest";
import { sqliteUserPostSchema } from "../tests/fixtures/user-post-schema";

const makeClient = async (engine: "v1" | "v2") => {
  const driver = new SQLite3Driver({ dataDir: ":memory:" });
  const client = createClient({
    schema: sqliteUserPostSchema,
    driver,
    queryEngine: engine,
  });
  await push(client, { force: true });
  for (let i = 0; i < 200; i++) {
    await driver._executeRaw(
      'INSERT INTO "users" ("id", "name", "email", "age") VALUES (?, ?, ?, ?)',
      [`u_${i}`, `User ${i}`, `u${i}@example.com`, 30]
    );
  }
  return client;
};

const v1 = await makeClient("v1");
const v2 = await makeClient("v2");
let n = 0;

describe("flip A/B: findMany", () => {
  bench("v1 findMany", async () => {
    await v1.user.findMany({ take: 50 });
  });
  bench("v2 findMany", async () => {
    await v2.user.findMany({ take: 50 });
  });
});

describe("flip A/B: findUnique", () => {
  bench("v1 findUnique", async () => {
    await v1.user.findUnique({ where: { id: `u_${n++ % 200}` } });
  });
  bench("v2 findUnique", async () => {
    await v2.user.findUnique({ where: { id: `u_${n++ % 200}` } });
  });
});

describe("flip A/B: scalar update", () => {
  bench("v1 update", async () => {
    await v1.user.update({
      where: { id: `u_${n++ % 200}` },
      data: { age: (n % 40) + 18 },
    });
  });
  bench("v2 update", async () => {
    await v2.user.update({
      where: { id: `u_${n++ % 200}` },
      data: { age: (n % 40) + 18 },
    });
  });
});

describe("flip A/B: updateMany", () => {
  bench("v1 updateMany", async () => {
    await v1.user.updateMany({
      where: { age: { gte: 0 } },
      data: { age: (n++ % 40) + 18 },
    });
  });
  bench("v2 updateMany", async () => {
    await v2.user.updateMany({
      where: { age: { gte: 0 } },
      data: { age: (n++ % 40) + 18 },
    });
  });
});

describe("flip A/B: upsert (update branch)", () => {
  bench("v1 upsert", async () => {
    await v1.user.upsert({
      where: { id: `u_${n++ % 200}` },
      create: { id: "unused", name: "x", email: "x@x.com", age: 1 },
      update: { age: (n % 40) + 18 },
    });
  });
  bench("v2 upsert", async () => {
    await v2.user.upsert({
      where: { id: `u_${n++ % 200}` },
      create: { id: "unused", name: "x", email: "x@x.com", age: 1 },
      update: { age: (n % 40) + 18 },
    });
  });
});
