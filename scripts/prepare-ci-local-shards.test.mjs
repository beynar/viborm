// biome-ignore-all lint/style/noDoneCallback: node:test provides TestContext for owned fixture cleanup.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { prepareCiLocalShards } from "./prepare-ci-local-shards.mjs";

const existingTarget = /EEXIST/;
const ownedWorkspace = /already owns this workspace/;
const insideSource = /outside the source/;
const sparseCheckout = /sparse checkout/;

function fixture(context, shallow = false) {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "viborm-ci-shards-"))
  );
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  let source = join(directory, "source");
  mkdirSync(join(source, "scripts"), { recursive: true });
  mkdirSync(join(source, "docs/architecture/raptor3-evidence"), {
    recursive: true,
  });
  copyFileSync(
    new URL("./test-run-lock.mjs", import.meta.url),
    join(source, "scripts/test-run-lock.mjs")
  );
  writeFileSync(join(source, "package.json"), '{"name":"ci-fixture"}\n');
  writeFileSync(join(source, "docs/package.json"), '{"name":"docs-fixture"}\n');
  writeFileSync(
    join(source, "docs/architecture/raptor3-evidence/archive.txt"),
    "excluded archive"
  );
  writeFileSync(join(source, ".gitignore"), "node_modules\n.env\n");
  const git = (...arguments_) =>
    execFileSync("git", ["-C", source, ...arguments_], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture"
  );
  if (shallow) {
    writeFileSync(join(source, "revision.txt"), "second revision");
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "second fixture revision"
    );
    const clone = join(directory, "shallow");
    execFileSync(
      "git",
      [
        "clone",
        "--quiet",
        "--depth=1",
        "--no-checkout",
        pathToFileURL(source).href,
        clone,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    source = clone;
  }
  execFileSync(
    "git",
    ["-C", source, "sparse-checkout", "set", "--no-cone", "--stdin"],
    {
      input: "/*\n!/docs/architecture/raptor3-evidence/\n",
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  git("checkout", "--quiet", "--detach", "HEAD");
  writeFileSync(join(source, ".env"), "FAKE_UNCOPIED_FIXTURE=1\n");
  return { directory, source, target: join(directory, "lanes"), git };
}

test("depth-one CI source preserves exact sparse source and private tmp/output paths", (context) => {
  const { source, target, git } = fixture(context, true);
  assert.equal(git("rev-parse", "--is-shallow-repository"), "true");
  assert.equal(git("rev-list", "--count", "HEAD"), "1");
  const result = prepareCiLocalShards(target, source);
  assert.equal(result.head, git("rev-parse", "HEAD"));
  assert.deepEqual(result.workspaces, [
    source,
    ...[2, 3, 4].map((lane) => join(target, String(lane))),
  ]);
  for (const workspace of result.workspaces.slice(1)) {
    assert(
      !existsSync(
        join(workspace, "docs/architecture/raptor3-evidence/archive.txt")
      )
    );
    assert(!existsSync(join(workspace, ".env")));
    assert.equal(
      readFileSync(join(workspace, "package.json"), "utf8"),
      readFileSync(join(source, "package.json"), "utf8")
    );
    assert(!existsSync(join(workspace, "node_modules")));
  }
  writeFileSync(join(result.workspaces[1], "lane-output.txt"), "lane two only");
  for (const workspace of [source, ...result.workspaces.slice(2)]) {
    assert(!existsSync(join(workspace, "lane-output.txt")));
  }
  for (const directory of result.temporaryDirectories)
    assert(existsSync(directory));
  assert.throws(() => prepareCiLocalShards(target, source), existingTarget);
  assert.equal(
    readFileSync(join(source, ".env"), "utf8"),
    "FAKE_UNCOPIED_FIXTURE=1\n"
  );
});

test("independent lanes acquire locks while the same lane still refuses", async (context) => {
  const { source, target } = fixture(context);
  const { workspaces } = prepareCiLocalShards(target, source);
  const owner = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import { acquireTestRunLock } from "./scripts/test-run-lock.mjs"; const release = acquireTestRunLock("fixture owner"); process.send("ready"); process.once("message", () => { release(); process.exit(0); });',
    ],
    { cwd: workspaces[1], stdio: ["ignore", "pipe", "pipe", "ipc"] }
  );
  try {
    await once(owner, "message", { signal: AbortSignal.timeout(5000) });
    const probe = (workspace) =>
      spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          'import { acquireTestRunLock } from "./scripts/test-run-lock.mjs"; acquireTestRunLock("fixture probe")();',
        ],
        { cwd: workspace, encoding: "utf8", timeout: 5000 }
      );
    const same = probe(workspaces[1]);
    assert.equal(same.status, 1);
    assert.match(same.stderr, ownedWorkspace);
    for (const workspace of [workspaces[0], ...workspaces.slice(2)])
      assert.equal(probe(workspace).status, 0);
    const exit = once(owner, "exit");
    owner.send("release");
    assert.equal((await exit)[0], 0);
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      const exit = once(owner, "exit");
      owner.kill("SIGTERM");
      await exit;
    }
  }
});

test("unsafe preparation boundaries refuse before creating outputs", (context) => {
  const { source, target, git } = fixture(context);
  assert.throws(
    () => prepareCiLocalShards(join(source, "..inside"), source),
    insideSource
  );
  assert(!existsSync(join(source, "..inside")));
  git("config", "--worktree", "core.sparseCheckout", "false");
  assert.throws(() => prepareCiLocalShards(target, source), sparseCheckout);
  assert(!existsSync(target));
});
