// biome-ignore-all lint/suspicious/noMisplacedAssertion: These are runner admission assertions, not test callbacks.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function git(source, ...arguments_) {
  return execFileSync("git", ["-C", source, ...arguments_], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Prepare private writable inputs; existing bounded launchers retain each lock. */
export function prepareCiLocalShards(
  targetArgument,
  sourceArgument = process.cwd()
) {
  assert(
    targetArgument,
    "Usage: node scripts/prepare-ci-local-shards.mjs <new-target-directory>"
  );
  const source = resolve(sourceArgument);
  const target = resolve(targetArgument);
  assert.equal(
    git(source, "rev-parse", "--show-toplevel"),
    source,
    "Run at the checked-out repository root"
  );
  assert(
    lstatSync(join(source, ".git")).isDirectory(),
    "CI preparation requires an independent checkout, not a Git worktree"
  );
  const targetRelative = relative(source, target);
  assert(
    targetRelative === ".." ||
      targetRelative.startsWith(`..${sep}`) ||
      isAbsolute(targetRelative),
    "Shard outputs must be outside the source checkout"
  );
  assert.equal(
    git(source, "config", "--bool", "core.sparseCheckout"),
    "true",
    "Retain the CI sparse checkout; refuse a full historical-evidence checkout"
  );
  const cone = git(
    source,
    "config",
    "--bool",
    "--default=false",
    "core.sparseCheckoutCone"
  );
  const patterns = readFileSync(
    resolve(
      source,
      git(source, "rev-parse", "--git-path", "info/sparse-checkout")
    ),
    "utf8"
  );
  const head = git(source, "rev-parse", "HEAD");

  // mkdir fails on any pre-existing target; never overwrite or delete user work.
  mkdirSync(target);
  const workspaces = [source];
  const commonDirectories = new Set([
    git(source, "rev-parse", "--path-format=absolute", "--git-common-dir"),
  ]);
  for (const lane of [2, 3, 4]) {
    const workspace = join(target, String(lane));
    execFileSync(
      "git",
      ["clone", "--quiet", "--shared", "--no-checkout", source, workspace],
      {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    git(workspace, "config", "core.sparseCheckout", "true");
    git(workspace, "config", "core.sparseCheckoutCone", cone);
    const patternPath = resolve(
      workspace,
      git(workspace, "rev-parse", "--git-path", "info/sparse-checkout")
    );
    mkdirSync(dirname(patternPath), { recursive: true });
    writeFileSync(patternPath, patterns);
    git(workspace, "checkout", "--quiet", "--detach", head);
    assert.equal(
      git(workspace, "rev-parse", "HEAD"),
      head,
      "Shard revision differs from the checked-out CI revision"
    );
    const commonDirectory = git(
      workspace,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir"
    );
    assert(
      !commonDirectories.has(commonDirectory),
      "Shard Git lock identity must be independent"
    );
    commonDirectories.add(commonDirectory);
    workspaces.push(workspace);
  }
  const temporaryDirectories = [1, 2, 3, 4].map((lane) =>
    join(target, `tmp-${lane}`)
  );
  for (const directory of temporaryDirectories) mkdirSync(directory);
  return { head, workspaces, temporaryDirectories };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    assert.equal(
      process.argv.length,
      3,
      "Pass exactly one new target directory"
    );
    console.log(JSON.stringify(prepareCiLocalShards(process.argv[2])));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
