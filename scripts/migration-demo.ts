/**
 * Migration API Demo Script
 *
 * Demonstrates the migration API including:
 * - push() for development
 * - force + resolve combination
 * - Per-column enum resolution
 *
 * Usage:
 *   bun run scripts/migration-demo.ts
 */

import { PGlite } from "@electric-sql/pglite";
import { createClient } from "../src/client/client";
import { PGliteDriver } from "../src/drivers/pglite";
import { createMigrationClient } from "../src/migrations/client";
import { lenientResolver } from "../src/migrations/resolver";
import { s } from "../src/schema";

// =============================================================================
// SCHEMA V1: Initial schema
// =============================================================================

const Status = s.enum(["PENDING", "ACTIVE", "INACTIVE"]);

const userV1 = s.model({
  id: s.string().id(),
  name: s.string(),
  email: s.string().unique(),
  status: Status.default("PENDING"),
});

const postV1 = s.model({
  id: s.string().id(),
  title: s.string(),
  content: s.string().nullable(),
  authorId: s.string(),
});

// =============================================================================
// SCHEMA V2: Modified schema (simulating changes)
// =============================================================================

// Enum with removed value (PENDING removed)
const StatusV2 = s.enum(["ACTIVE", "INACTIVE", "ARCHIVED"]);

const userV2 = s.model({
  id: s.string().id(),
  // Renamed: name -> fullName (ambiguous change)
  fullName: s.string(),
  email: s.string().unique(),
  status: StatusV2.default("ACTIVE"),
  // New column
  createdAt: s.dateTime().now(),
});

const postV2 = s.model({
  id: s.string().id(),
  title: s.string(),
  content: s.string().nullable(),
  authorId: s.string(),
  // New column
  publishedAt: s.dateTime().nullable(),
});

// =============================================================================
// DEMO FUNCTIONS
// =============================================================================

async function demo1_basicPush() {
  console.log("\n" + "=".repeat(60));
  console.log("DEMO 1: Basic Push (Initial Schema)");
  console.log("=".repeat(60) + "\n");

  const db = new PGlite();
  const driver = new PGliteDriver({ client: db });
  const client = createClient({
    driver,
    schema: { user: userV1, post: postV1 },
  });

  const migrations = createMigrationClient(client);

  // Push initial schema
  const result = await migrations.push({ dryRun: true });

  console.log("Operations:");
  for (const op of result.operations) {
    console.log(`  - ${op.type}: ${JSON.stringify(op).slice(0, 80)}...`);
  }

  console.log("\nSQL statements:");
  for (const sql of result.sql) {
    console.log(`  ${sql};`);
  }

  console.log(`\nApplied: ${result.applied}`);

  await driver.disconnect();
}

async function demo2_forceMode() {
  console.log("\n" + "=".repeat(60));
  console.log("DEMO 2: Force Mode (Auto-accept all changes)");
  console.log("=".repeat(60) + "\n");

  const db = new PGlite();
  const driver = new PGliteDriver({ client: db });

  // First, push V1
  const clientV1 = createClient({
    driver,
    schema: { user: userV1, post: postV1 },
  });
  await createMigrationClient(clientV1).push({ force: true });
  console.log("V1 schema pushed.\n");

  // Now push V2 with force mode
  const clientV2 = createClient({
    driver,
    schema: { user: userV2, post: postV2 },
  });
  const migrations = createMigrationClient(clientV2);

  const result = await migrations.push({ force: true, dryRun: true });

  console.log("Operations with force=true:");
  for (const op of result.operations) {
    if (op.type === "alterEnum") {
      console.log(`  - ${op.type}: ${op.enumName}`);
      if (op.addValues?.length)
        console.log(`      add: ${op.addValues.join(", ")}`);
      if (op.removeValues?.length)
        console.log(`      remove: ${op.removeValues.join(", ")}`);
    } else {
      console.log(`  - ${op.type}`);
    }
  }

  await driver.disconnect();
}

async function demo3_forceWithResolver() {
  console.log("\n" + "=".repeat(60));
  console.log("DEMO 3: Force + Resolve (Protect specific changes)");
  console.log("=".repeat(60) + "\n");

  const db = new PGlite();
  const driver = new PGliteDriver({ client: db });

  // Push V1
  const clientV1 = createClient({
    driver,
    schema: { user: userV1, post: postV1 },
  });
  await createMigrationClient(clientV1).push({ force: true });
  console.log("V1 schema pushed.\n");

  // Push V2 with force + resolver
  const clientV2 = createClient({
    driver,
    schema: { user: userV2, post: postV2 },
  });
  const migrations = createMigrationClient(clientV2);

  console.log("Pushing V2 with force=true + resolver...\n");

  const result = await migrations.push({
    force: true,
    dryRun: true,
    resolve: async (change) => {
      console.log(`Resolver called for: ${change.type}`);
      console.log(`  Description: ${change.description}\n`);

      // Treat ambiguous column change as rename (preserve data)
      if (change.type === "ambiguous" && change.operation === "renameColumn") {
        console.log("  -> Treating as RENAME (preserving data)\n");
        return change.rename();
      }

      if (change.type === "enumValueRemoval") {
        return change.useNull();
      }

      // Let force handle everything else
      console.log("  -> Letting force handle this\n");
      return undefined;
    },
  });

  console.log("Final operations:");
  for (const op of result.operations) {
    console.log(`  - ${op.type}`);
  }

  await driver.disconnect();
}

async function demo4_enumResolution() {
  console.log("\n" + "=".repeat(60));
  console.log("DEMO 4: Per-Column Enum Value Resolution");
  console.log("=".repeat(60) + "\n");

  const db = new PGlite();
  const driver = new PGliteDriver({ client: db });

  // Push V1
  const clientV1 = createClient({
    driver,
    schema: { user: userV1, post: postV1 },
  });
  await createMigrationClient(clientV1).push({ force: true });
  console.log("V1 schema pushed.\n");

  // Push V2 with custom enum resolution
  const clientV2 = createClient({
    driver,
    schema: { user: userV2, post: postV2 },
  });
  const migrations = createMigrationClient(clientV2);

  console.log("Pushing V2 with enum value mapping...\n");

  const result = await migrations.push({
    dryRun: true,
    resolve: async (change) => {
      if (change.type === "enumValueRemoval") {
        console.log(
          `Enum removal for ${change.tableName}.${change.columnName}:`
        );
        console.log(`  Enum: ${change.enumName}`);
        console.log(`  Removing: ${change.removedValues.join(", ")}`);
        console.log(`  Available: ${change.availableValues.join(", ")}`);
        console.log(`  Nullable: ${change.isNullable}`);

        // Map PENDING to ACTIVE
        console.log("  -> Mapping PENDING to ACTIVE\n");
        return change.mapValues({ PENDING: "ACTIVE" });
      }

      if (change.type === "ambiguous") {
        return change.rename();
      }

      if (change.type === "destructive") {
        return change.proceed();
      }
    },
  });

  console.log("SQL for enum changes:");
  for (const sql of result.sql) {
    if (sql.includes("Status") || sql.includes("UPDATE")) {
      console.log(`  ${sql};`);
    }
  }

  await driver.disconnect();
}

async function demo5_builtInResolvers() {
  console.log("\n" + "=".repeat(60));
  console.log("DEMO 5: Built-in Resolvers");
  console.log("=".repeat(60) + "\n");

  const db = new PGlite();
  const driver = new PGliteDriver({ client: db });

  // Push V1
  const clientV1 = createClient({
    driver,
    schema: { user: userV1, post: postV1 },
  });
  await createMigrationClient(clientV1).push({ force: true });
  console.log("V1 schema pushed.\n");

  // Push V2 with lenientResolver
  const clientV2 = createClient({
    driver,
    schema: { user: userV2, post: postV2 },
  });
  const migrations = createMigrationClient(clientV2);

  console.log(
    "Using lenientResolver (rename ambiguous, proceed destructive, null enums)...\n"
  );

  const result = await migrations.push({
    dryRun: true,
    resolve: lenientResolver,
  });

  console.log("Operations:");
  for (const op of result.operations) {
    if (op.type === "renameColumn") {
      console.log(
        `  - renameColumn: ${op.from} -> ${op.to} in ${op.tableName}`
      );
    } else if (op.type === "alterEnum") {
      console.log(`  - alterEnum: ${op.enumName}`);
    } else {
      console.log(`  - ${op.type}`);
    }
  }

  await driver.disconnect();
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  console.log("VibORM Migration API Demo");
  console.log("========================\n");

  try {
    await demo1_basicPush();
    await demo2_forceMode();
    await demo3_forceWithResolver();
    await demo4_enumResolution();
    await demo5_builtInResolvers();

    console.log("\n" + "=".repeat(60));
    console.log("All demos completed successfully!");
    console.log("=".repeat(60) + "\n");
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
