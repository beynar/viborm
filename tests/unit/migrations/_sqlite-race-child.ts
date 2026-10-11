/**
 * One SQLite migration runner in its own OS process, for
 * `sqlite-exactly-once.test.ts`. Not a suite.
 *
 * Usage (through jiti, with the repo's aliases in `JITI_ALIAS`):
 *   _sqlite-race-child.ts <db file> <estate dir> <start at, epoch ms> <version>
 *
 * It waits until the start instant so two runners race, applies the estate's
 * head, and prints one `RESULT {...}` line: the outcome, or the error code.
 */

import { createClient } from "@drivers/sqlite3";
import { createMigrationClient } from "@migrations";
import { createFsStorageWriter } from "@migrations/storage/fs";
import { raceSchema } from "./_sqlite-race-schema";

const [file = "", estate = "", startAt = "0", version = "v1"] =
  process.argv.slice(2);
const client = createClient({
  schema: raceSchema(
    version === "column" || version === "rebuild" ? version : "v1"
  ),
  dataDir: file,
});
const migrations = createMigrationClient(client, {
  storage: createFsStorageWriter(estate),
});
while (Date.now() < Number(startAt)) {
  await new Promise((resolve) => setTimeout(resolve, 1));
}
let result: { outcome?: string; code?: unknown; message?: string };
try {
  result = { outcome: (await migrations.apply()).outcome };
} catch (error) {
  result =
    error instanceof Error
      ? { code: Reflect.get(error, "code"), message: error.message }
      : { message: String(error) };
}
process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
await client.$disconnect();
