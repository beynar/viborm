/**
 * Suites import src/migrations modules directly, which register no migration
 * driver; this setup registers every dialect, as the `viborm/migrations`
 * entry does. It is a fixture rather than that entry itself because Vitest
 * leaves setup files out of coverage, and the entry is a covered source.
 */

import { registerEveryMigrationDriver } from "@src/migrations/dialects/every";

registerEveryMigrationDriver();
