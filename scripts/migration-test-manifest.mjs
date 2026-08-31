import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const migrationTestRoot = resolve(projectRoot, "tests/unit/migrations");

const localExtendedMigrationTests = Object.freeze([
  "constraint-identity.test.ts",
  "decimal-descriptor-ddl.test.ts",
  "decimal-sqlite-integrity.test.ts",
  "polymorphic-push.test.ts",
  "sqlite-datetime-diff-boundary.test.ts",
  "sqlite-datetime-recreation.test.ts",
  "sqlite-recreation-foreign-key-parent.test.ts",
  "sqlite-recreation-indexes.test.ts",
  "sqlite-unique-constraint.test.ts",
]);

export const MIGRATION_COVERAGE_TESTS = Object.freeze(
  [
    ...readdirSync(migrationTestRoot).filter(
      (file) =>
        file.endsWith(".core.test.ts") && file !== "v1-cli-input.core.test.ts"
    ),
    ...localExtendedMigrationTests,
  ]
    .sort()
    .map((file) => `tests/unit/migrations/${file}`)
);
