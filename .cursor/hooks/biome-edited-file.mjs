#!/usr/bin/env node
// Runs the repository's pinned Biome on the edited file only, as CI does on
// changed files. A repository-wide run would rewrite the untouched files the
// tree does not yet format.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const { file_path: filePath } = JSON.parse(readFileSync(0, "utf8"));

if (filePath) {
  const { status } = spawnSync(
    "pnpm",
    ["exec", "biome", "check", "--write", "--no-errors-on-unmatched", filePath],
    { stdio: ["ignore", "inherit", "inherit"] }
  );
  process.exitCode = status ?? 1;
}
