import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
// biome-ignore lint/performance/noNamespaceImport: census reads the public barrel
import * as migrations from "@src/migrations";
import { describe, expect, test } from "vitest";

function collectTypescript(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        walk(path);
      } else if (entry.endsWith(".ts")) {
        files.push(path);
      }
    }
  };
  walk(root);
  return files;
}

const sources = collectTypescript(
  new URL("../../../src/migrations", import.meta.url).pathname
).map((path) => ({ path, text: readFileSync(path, "utf8") }));

describe("migration v1 public census", () => {
  test("public barrel does not export retired owners", () => {
    expect("squash" in migrations).toBe(false);
    expect("MigrationContext" in migrations).toBe(false);
    expect("journal" in migrations).toBe(false);
    expect("diff" in migrations).toBe(false);
    expect("serializeModels" in migrations).toBe(false);
    expect("MigrationStorageDriver" in migrations).toBe(false);
    expect("createFsStorageDriver" in migrations).toBe(false);
    expect("parseStatements" in migrations).toBe(false);
  });

  test("retired journal owners are gone", () => {
    expect("applyPush" in migrations).toBe(false);
    expect("PushResult" in migrations).toBe(false);
    expect(
      existsSync(
        new URL("../../../src/migrations/push/reset.ts", import.meta.url)
          .pathname
      )
    ).toBe(false);
  });

  test("public barrel exports the V1 nouns", () => {
    expect(typeof migrations.createMigrationClient).toBe("function");
    expect(typeof migrations.generate).toBe("function");
    expect(typeof migrations.apply).toBe("function");
    expect(typeof migrations.push).toBe("function");
    expect(typeof migrations.previewPush).toBe("function");
    expect(typeof migrations.checkEstate).toBe("function");
    expect(typeof migrations.createFsStorageWriter).toBe("function");
    expect(typeof migrations.status).toBe("function");
    expect(typeof migrations.reset).toBe("function");
  });

  test("V1 source forbids journal, delimiter, and path-level storage owners", () => {
    const forbidden = [
      "STATEMENT_BREAKPOINT",
      "parseStatements(",
      'split(";\\n")',
      "latest snapshot",
      "MigrationJournal",
      "createFsStorageDriver",
      "export { MigrationContext",
      "generateCreateTrackingTable",
      "generateInsertMigration",
      "generateSelectAppliedMigrations",
      "generateDeleteMigration",
      "generateTrackingTableProbe",
      "isMissingTrackingTable",
      "export const applyPush",
    ];
    for (const file of sources) {
      for (const token of forbidden) {
        expect(
          file.text.includes(token),
          `${file.path} contains ${token}`
        ).toBe(false);
      }
    }
  });
});
