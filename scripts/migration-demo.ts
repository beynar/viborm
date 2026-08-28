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
import { push as applyPush, previewPush } from "../src/migrations";
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

function banner(title: string): void {
  const bar = "=".repeat(60);
  console.log(`\n${bar}`);
  console.log(title);
  console.log(`${bar}\n`);
}

async function demo1_basicPush() {
  banner("DEMO 1: Basic Push (Initial Schema)");

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
    console.log(`  - [${op.risk}] ${op.label} (${op.id})`);
  }

  console.log("\nSQL statements:");
  for (const statement of result.statements) {
    console.log(`  ${statement.sql}`);
  }

  console.log(`\nOutcome: ${result.outcome}`);

  await driver.disconnect();
}

async function demo2_forceMode() {
  banner("DEMO 2: Force Mode (Auto-accept all changes)");

  const db = new PGlite();
  const driver = new PGliteDriver({ client: db });

  // First, push V1
  const clientV1 = createClient({
    driver,
    schema: { user: userV1, post: postV1 },
  });
  await applyPush(clientV1);
  console.log("V1 schema pushed.\n");

  // Now preview V2 without generic force
  const clientV2 = createClient({
    driver,
    schema: { user: userV2, post: postV2 },
  });

  const result = await previewPush(clientV2);

  console.log("Operations from previewPush:");
  for (const op of result.operations) {
    console.log(`  - [${op.risk}] ${op.label} (${op.id})`);
  }

  await driver.disconnect();
}

async function demo3_forceWithResolver() {
  banner("DEMO 3: Force + Resolve (Protect specific changes)");

  const db = new PGlite();
  const driver = new PGliteDriver({ client: db });

  // Push V1
  const clientV1 = createClient({
    driver,
    schema: { user: userV1, post: postV1 },
  });
  await applyPush(clientV1);
  console.log("V1 schema pushed.\n");

  // Preview V2 with a resolver (no generic force)
  const clientV2 = createClient({
    driver,
    schema: { user: userV2, post: postV2 },
  });

  console.log("Previewing V2 with a resolver...\n");

  const result = await previewPush(clientV2, {
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

      console.log("  -> Leaving this change for the planner\n");
      return undefined;
    },
  });

  console.log("Final operations:");
  for (const op of result.operations) {
    console.log(`  - [${op.risk}] ${op.label}`);
  }

  await driver.disconnect();
}

async function demo4_enumResolution() {
  banner("DEMO 4: Per-Column Enum Value Resolution");

  const db = new PGlite();
  const driver = new PGliteDriver({ client: db });

  // Push V1
  const clientV1 = createClient({
    driver,
    schema: { user: userV1, post: postV1 },
  });
  await applyPush(clientV1);
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
  for (const statement of result.statements) {
    if (statement.sql.includes("Status") || statement.sql.includes("UPDATE")) {
      console.log(`  ${statement.sql}`);
    }
  }

  await driver.disconnect();
}

async function demo5_builtInResolvers() {
  banner("DEMO 5: Built-in Resolvers");

  const db = new PGlite();
  const driver = new PGliteDriver({ client: db });

  // Push V1
  const clientV1 = createClient({
    driver,
    schema: { user: userV1, post: postV1 },
  });
  await applyPush(clientV1);
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
    console.log(`  - [${op.risk}] ${op.label} (${op.id})`);
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

    banner("All demos completed successfully!");
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
