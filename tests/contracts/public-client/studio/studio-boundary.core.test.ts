import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { REPOSITORY_ROOT, SOURCE_ROOT } from "@tests/fixtures/repo-paths";
import { expect, test } from "vitest";

// The studio adds nothing to an application's bundle: no file outside the
// studio reaches it except the `studio` command, which imports it dynamically,
// and the CLI is no runtime entry's dependency.
const STUDIO_IMPORT =
  /(?:from\s+|import\s*\(\s*)["']([^"']*(?:\/studio\/|viborm:studio-ui)[^"']*)["']/g;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

test("only the studio command imports the studio, and only dynamically", () => {
  const importers: Record<string, string[]> = {};
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const name = relative(REPOSITORY_ROOT, file);
    if (name.startsWith("src/studio/")) continue;
    const found = [...readFileSync(file, "utf8").matchAll(STUDIO_IMPORT)].map(
      (match) => match[0].replace(/\s+/g, " ")
    );
    if (found.length > 0) importers[name] = found;
  }
  expect(importers).toEqual({
    "src/cli/commands/studio.ts": [
      'from "../../studio/port"',
      'import("../../studio/run"',
      'import("viborm:studio-ui"',
    ],
  });
});

test("no package entry is a studio module", () => {
  const config = readFileSync(
    resolve(REPOSITORY_ROOT, "tsdown.config.ts"),
    "utf8"
  );
  const entries = config.slice(
    config.indexOf("entry: {"),
    config.indexOf("format:")
  );
  expect(entries).not.toContain("studio");
});
