import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { REPOSITORY_ROOT, SOURCE_ROOT } from "@tests/fixtures/repo-paths";
import { expect, test } from "vitest";

// The studio is its own package so that `viborm` carries none of it: no
// source of `viborm` imports @viborm/studio or its files.
const STUDIO_IMPORT =
  /(?:from\s+|import\s*\(\s*)["']([^"']*(?:@viborm\/studio|packages\/studio)[^"']*)["']/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

test("no source of viborm imports the studio", () => {
  const importers = sourceFiles(SOURCE_ROOT)
    .filter((file) => STUDIO_IMPORT.test(readFileSync(file, "utf8")))
    .map((file) => relative(REPOSITORY_ROOT, file));
  expect(importers).toEqual([]);
});
