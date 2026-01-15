import { PGlite } from "@electric-sql/pglite";
import { VibORM } from "./src/client/client";
import { PGliteDriver } from "./src/drivers/pglite";
import { s } from "./src/schema";

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  email: s.string().unique(),
});

async function main() {
  const pglite = new PGlite();
  const driver = new PGliteDriver({ client: pglite });

  await pglite.exec(`
    CREATE TABLE IF NOT EXISTS "user" (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE
    )
  `);

  const client = VibORM.create({
    schema: { user },
    driver,
    instrumentation: {
      logging: {
        query: true,
        includeParams: false,
        error: true,
      },
    },
  });

  console.log("\n--- findMany ---\n");
  await client.user.findMany({});

  console.log("\n--- create ---\n");
  await client.user.create({
    data: { id: "user-1", name: "Alice", email: "alice@example.com" },
  });

  console.log("\n--- findMany with where ---\n");
  await client.user.findMany({ where: { name: "Alice" } });

  await client.$transaction(async (tx) => {
    await tx.user.findMany({});

    await tx.user.create({
      data: { id: "user-1", name: "Bob", email: "bob@example.com" },
    });
  });

  await driver.disconnect();
}

main();
