import { createClient } from "@drivers/pglite";
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import {
  schema,
  transactionsReview,
} from "../../contracts/public-client/final-transactions-review";

// One Wasm Postgres for the file, its tables made again for each test.
let shared: ReturnType<typeof openTestPGlite> | undefined;

transactionsReview("pglite", () => {
  shared ??= openTestPGlite();
  return createClient({ schema, client: shared });
});
