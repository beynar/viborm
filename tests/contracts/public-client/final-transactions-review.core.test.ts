import { createClient } from "@drivers/sqlite3";
import { schema, transactionsReview } from "./final-transactions-review";

transactionsReview("sqlite", () =>
  createClient({ schema, dataDir: ":memory:" })
);
