import { describeRecursivePageAliases } from "@tests/contracts/public-client/recursive-page-aliases-behavior";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";

describeRecursivePageAliases("PGlite", createInMemoryPGliteDriver);
