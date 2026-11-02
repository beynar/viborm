import { describeRecursivePageAliases } from "@tests/contracts/public-client/recursive-page-aliases-behavior";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";

describeRecursivePageAliases("SQLite", createInMemorySQLite3Driver);
