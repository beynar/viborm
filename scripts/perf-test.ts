/**
 * Performance Test Script
 *
 * Runs a simple query and logs performance metrics.
 * Captures client instantiation cost as well as query execution.
 *
 * Usage:
 *   bun run scripts/perf-test.ts
 */

import { PGlite } from "@electric-sql/pglite";
import { PGliteDriver } from "../src/drivers/pglite";
import {
  createPerfTracker,
  formatPerfReport,
} from "../src/instrumentation/perf-tracker";

// Import internals to measure each step
import {
  createModelRegistry,
  QueryEngine,
} from "../src/query-engine/query-engine";
import { s } from "../src/schema";
import { hydrateSchemaNames } from "../src/schema/hydration";

async function main() {
  const perf = createPerfTracker();

  // =========================================================================
  // PHASE 1: Schema Definition (this is compile-time, but let's measure it)
  // =========================================================================
  console.log("=== PHASE 1: Schema Definition ===\n");

  perf.start("schema.define");

  const user = s.model({
    id: s.string().id(),
    name: s.string(),
    email: s.string().unique(),
    age: s.int().nullable(),
  });

  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      content: s.string().nullable(),
      published: s.boolean().default(false),
      authorId: s.string(),
      author: s
        .manyToOne(() => user)
        .fields("authorId")
        .references("id"),
    })
    .map("posts");

  const schema = { user, post };

  perf.end("schema.define");

  // =========================================================================
  // PHASE 2: Client Instantiation
  // =========================================================================
  console.log("=== PHASE 2: Client Instantiation ===\n");

  // 2a. Create PGlite instance
  perf.start("client.pglite.create");
  const pglite = new PGlite();
  perf.end("client.pglite.create");

  // 2b. Create driver
  perf.start("client.driver.create");
  const driver = new PGliteDriver({ client: pglite });
  perf.end("client.driver.create");

  // 2c. Hydrate schema names (tsName, sqlName for all models/fields/relations)
  perf.start("client.hydrateSchemaNames");
  hydrateSchemaNames(schema);
  perf.end("client.hydrateSchemaNames");

  // 2d. Create model registry
  perf.start("client.createModelRegistry");
  const registry = createModelRegistry(schema as Record<string, any>);
  perf.end("client.createModelRegistry");

  // 2e. Create query engine
  perf.start("client.createQueryEngine");
  const engine = new QueryEngine(driver, registry);
  perf.end("client.createQueryEngine");

  console.log("Client instantiation breakdown:");
  console.log(formatPerfReport(perf.report()));

  // =========================================================================
  // PHASE 3: Database Setup (one-time)
  // =========================================================================
  console.log("\n=== PHASE 3: Database Setup ===\n");

  perf.reset();
  perf.start("db.createTables");
  await pglite.exec(`
    CREATE TABLE IF NOT EXISTS "user" (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      age INTEGER
    );

    CREATE TABLE IF NOT EXISTS "posts" (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT,
      published BOOLEAN DEFAULT false,
      "authorId" TEXT REFERENCES "user"(id)
    );
  `);
  perf.end("db.createTables");

  perf.start("db.insertTestData");
  await pglite.exec(`
    INSERT INTO "user" (id, name, email, age) VALUES
      ('u1', 'Alice', 'alice@test.com', 30),
      ('u2', 'Bob', 'bob@test.com', 25),
      ('u3', 'Charlie', 'charlie@test.com', 35)
    ON CONFLICT DO NOTHING;

    INSERT INTO "posts" (id, title, content, published, "authorId") VALUES
      ('p1', 'First Post', 'Content 1', true, 'u1'),
      ('p2', 'Second Post', 'Content 2', false, 'u1'),
      ('p3', 'Third Post', 'Content 3', true, 'u2')
    ON CONFLICT DO NOTHING;
  `);
  perf.end("db.insertTestData");

  console.log("Database setup:");
  console.log(formatPerfReport(perf.report()));

  // =========================================================================
  // PHASE 4: First Query (cold - includes lazy initialization)
  // =========================================================================
  console.log("\n=== PHASE 4: First Query (cold) ===\n");

  perf.reset();
  const firstQueryResult = await engine.execute(user, "findMany", {});
  console.log(`Found ${(firstQueryResult as any[]).length} users`);
  console.log(formatPerfReport(perf.report()));

  // =========================================================================
  // PHASE 5: Subsequent Queries (warm - caches populated)
  // =========================================================================
  console.log("\n=== PHASE 5: Subsequent Queries (warm) ===\n");

  // Warm up a bit more
  for (let i = 0; i < 2; i++) {
    await engine.execute(user, "findMany", {});
  }

  // Now measure warm queries
  perf.reset();
  console.log("--- findMany (simple) ---");
  const users = await engine.execute(user, "findMany", {});
  console.log(`Found ${(users as any[]).length} users`);
  console.log(formatPerfReport(perf.report()));

  perf.reset();
  console.log("\n--- findMany (with where) ---");
  const filteredUsers = await engine.execute(user, "findMany", {
    where: { age: { gte: 30 } },
  });
  console.log(`Found ${(filteredUsers as any[]).length} users with age >= 30`);
  console.log(formatPerfReport(perf.report()));

  perf.reset();
  console.log("\n--- findFirst ---");
  const firstUser = await engine.execute(user, "findFirst", {
    where: { name: "Alice" },
  });
  console.log(`Found user: ${(firstUser as any)?.name}`);
  console.log(formatPerfReport(perf.report()));

  perf.reset();
  console.log("\n--- count ---");
  const count = await engine.execute(user, "count", {});
  console.log(`Total users: ${count}`);
  console.log(formatPerfReport(perf.report()));

  // =========================================================================
  // PHASE 6: Batch Performance (10 queries)
  // =========================================================================
  console.log("\n=== PHASE 6: Batch Performance (10 queries) ===\n");

  perf.reset();
  for (let i = 0; i < 10; i++) {
    await engine.execute(user, "findMany", {});
  }
  console.log(formatPerfReport(perf.report()));

  // =========================================================================
  // SUMMARY
  // =========================================================================
  console.log("\n=== SUMMARY ===\n");

  // Re-measure client instantiation from scratch
  const summaryPerf = createPerfTracker();

  summaryPerf.start("total.clientInstantiation");

  summaryPerf.start("instantiation.driver");
  const driver2 = new PGliteDriver({ client: pglite });
  summaryPerf.end("instantiation.driver");

  // Fresh schema for measurement
  const user2 = s.model({
    id: s.string().id(),
    name: s.string(),
    email: s.string().unique(),
    age: s.int().nullable(),
  });
  const schema2 = { user: user2 };

  summaryPerf.start("instantiation.hydrate");
  hydrateSchemaNames(schema2);
  summaryPerf.end("instantiation.hydrate");

  summaryPerf.start("instantiation.registry");
  const registry2 = createModelRegistry(schema2 as Record<string, any>);
  summaryPerf.end("instantiation.registry");

  summaryPerf.start("instantiation.engine");
  const engine2 = new QueryEngine(driver2, registry2);
  summaryPerf.end("instantiation.engine");

  summaryPerf.end("total.clientInstantiation");

  // Run one query
  summaryPerf.start("total.firstQuery");
  await engine2.execute(user2, "findMany", {});
  summaryPerf.end("total.firstQuery");

  console.log("Fresh client + first query:");
  console.log(formatPerfReport(summaryPerf.report()));

  // Cleanup
  await pglite.close();
  console.log("\nDone!");
}

main().catch(console.error);
