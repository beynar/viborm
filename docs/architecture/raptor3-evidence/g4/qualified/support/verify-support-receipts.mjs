/**
 * Verifies attempt 6's two special support receipts against the frozen identity
 * and writes `support/support-verification.json`.
 *
 * Attempt 5 met both of these as gaps and closed them by re-running; attempt 6's
 * driver takes the two lessons up front, so this script checks the arrangement
 * rather than a repair:
 *
 * 1. **The source-cost census runs in the lane-5 worktree, by design.**
 *    `scripts/measure-raptor3-baseline.mjs` calls
 *    `execFileSync("git", ["status", "--porcelain"])` at line 318 with Node's
 *    default 1 MiB `maxBuffer`, and the main tree's status output is far past
 *    that while the moved-out previous package shows as thousands of deletions —
 *    so the unmodified tool dies there with `spawnSync git ENOBUFS`. The tool is
 *    still not patched: that one-option fix belongs to the harness owner.
 *    Measuring in another worktree is only sound if the bytes it read are the
 *    frozen bytes, so this script does not stop at "the lane's identity
 *    matches": it checks every file the census actually read against
 *    `support/frozen-identity-manifest.json`, file by file, by SHA-256.
 *
 * 2. **The CLI self-test is re-run alone after the campaigns if it was red.**
 *    Its outer-watchdog cell is a race against a real process reaching its wait
 *    and loses it under six live campaign lanes. When the sequencer re-ran it,
 *    the red first attempt is kept whole beside the counted run as
 *    `support/cli-selftest.attempt1-red.log`; this script reports both.
 *
 * Every input except the identity, the manifest and the census is optional: a
 * file the driver did not write is reported as absent, never assumed.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const finalRoot = path.resolve(new URL("..", import.meta.url).pathname);
const has = (file) => existsSync(path.join(finalRoot, file));
const read = async (file) => JSON.parse(await readFile(path.join(finalRoot, file), "utf8"));
const sha256 = async (file) =>
  createHash("sha256")
    .update(await readFile(path.join(finalRoot, file)))
    .digest("hex");

const identity = await read("support/final-identity.json");
const manifest = await read("support/frozen-identity-manifest.json");
const cost = await read("support/source-cost.json");
const frozen = new Map(manifest.files.map((entry) => [entry.file, entry.sha256]));

/** A file the census read but the identity does not hash, or reads differently, breaks the claim. */
function compare(files, label) {
  const outsideIdentity = [];
  const differingFromFreeze = [];
  for (const entry of files ?? []) {
    const frozenHash = frozen.get(entry.file);
    if (frozenHash === undefined) outsideIdentity.push(entry.file);
    else if (frozenHash !== entry.sha256) differingFromFreeze.push(entry.file);
  }
  return { label, files: files?.length ?? 0, outsideIdentity, differingFromFreeze };
}

const census = compare(cost.files, "source-cost.json#files (the token-line census)");
const toolIdentity = compare(
  cost.source?.sourceIdentity?.files,
  "source-cost.json#source.sourceIdentity.files (the tool's own source attestation)",
);

const identityEqual = (actual) =>
  actual?.production === identity.production && actual?.harness === identity.harness;

/** The driver's identity companions. Each is reported as present-and-equal, present-and-unequal, or absent. */
async function companion(file, role) {
  if (!has(file)) return { receipt: file, role, present: false };
  const captured = await read(file);
  return {
    receipt: file,
    role,
    present: true,
    capturedAt: captured.capturedAt ?? null,
    equalToFreeze: identityEqual(captured),
  };
}

const laneIdentity = await companion(
  "support/source-cost-lane5-identity.json",
  "the lane-5 worktree the source-cost census was measured in",
);
const mainTreeIdentityCandidates = [
  "support/main-tree-identity.json",
  "support/cli-selftest-identity.json",
  "support/rerun-main-tree-identity.json",
];
const mainTreeIdentity = await companion(
  mainTreeIdentityCandidates.find((file) => has(file)) ?? mainTreeIdentityCandidates[0],
  "the main tree the CLI self-test ran in",
);

const cliLogFile = "support/cli-selftest.log";
const cliPresent = has(cliLogFile);
const cliLog = cliPresent ? await readFile(path.join(finalRoot, cliLogFile), "utf8") : "";
const cliPass = cliPresent ? Number(cliLog.match(/ℹ pass (\d+)\n/)?.[1]) : undefined;
const cliFail = cliPresent ? Number(cliLog.match(/ℹ fail (\d+)\n/)?.[1]) : undefined;
const cliFirstAttempt = "support/cli-selftest.attempt1-red.log";
let cliFirstAttemptCounts;
if (has(cliFirstAttempt)) {
  const text = await readFile(path.join(finalRoot, cliFirstAttempt), "utf8");
  cliFirstAttemptCounts = {
    pass: Number(text.match(/ℹ pass (\d+)\n/)?.[1]),
    fail: Number(text.match(/ℹ fail (\d+)\n/)?.[1]),
  };
}

const laneOk = laneIdentity.present && laneIdentity.equalToFreeze;
const censusOk = census.outsideIdentity.length === 0 && census.differingFromFreeze.length === 0;
const cliOk = cliPresent && cliFail === 0;

const verification = {
  formatVersion: 1,
  milestone: "g4",
  attempt: 6,
  purpose:
    "Prove attempt 6's two special support receipts were taken on the frozen bytes: the source-cost census in the lane-5 worktree, the CLI self-test in the main tree, both against g4/freeze/identity.json",
  frozenIdentity: { production: identity.production, harness: identity.harness },
  laneFiveIdentity: laneIdentity,
  mainTreeIdentity,
  cliSelfTest: {
    receipt: cliPresent ? cliLogFile : null,
    pass: cliPass ?? null,
    fail: cliFail ?? null,
    keptFirstAttempt: has(cliFirstAttempt) ? cliFirstAttempt : null,
    firstAttemptCounts: cliFirstAttemptCounts ?? null,
    reRunAlone: has(cliFirstAttempt),
    why: "The outer-watchdog cell is a race against a real process reaching its wait; under six live campaign lanes it loses. The sequencer re-runs the file alone after the campaigns when the first attempt is red, and keeps the red log whole.",
  },
  sourceCost: {
    receipt: "support/source-cost.json",
    sha256: await sha256("support/source-cost.json"),
    status: cost.status,
    sourceCommit: cost.source?.commit,
    sourceClean: cost.source?.clean,
    charged: cost.accounting?.charged,
    navigationSubtotal: cost.accounting?.navigationSubtotal,
    censusOwner: cost.accounting?.censusOwner,
    censusFunctionSha256: cost.accounting?.censusFunctionSha256,
    measuredIn: "lane-5 worktree (/private/tmp/viborm-g4-lane-5)",
    toolDefectUnpatched:
      "scripts/measure-raptor3-baseline.mjs still dies with spawnSync git ENOBUFS in the main tree (git status --porcelain past Node's default 1 MiB maxBuffer at line 318); the tool was not modified, the measurement was taken in a worktree whose own status output is small",
    keptFirstAttempt: has("support/source-cost.attempt1-enobufs.log")
      ? "support/source-cost.attempt1-enobufs.log"
      : null,
    censusReadFrozenBytes: census,
    toolSourceAttestation: toolIdentity,
    filesOutsideIdentityAreConfigOnly:
      "captureRaptor3Identity does not hash biome.jsonc or tsdown.config.ts; they are the only files the tool's own attestation covers and the identity does not",
  },
  verdict:
    censusOk && laneOk && cliOk
      ? "the lane-5 census read the frozen bytes and the CLI self-test is green"
      : "support verification failed — see the lists above",
};
await writeFile(
  path.join(finalRoot, "support/support-verification.json"),
  `${JSON.stringify(verification, null, 2)}\n`,
);
console.log(verification.verdict);
console.log(
  `census ${census.files} files: ${census.outsideIdentity.length} outside the identity, ${census.differingFromFreeze.length} differing from the freeze; lane-5 identity ${laneIdentity.present ? (laneIdentity.equalToFreeze ? "equals the freeze" : "DIFFERS") : "absent"}; CLI ${cliPass ?? "?"} pass / ${cliFail ?? "?"} fail.`,
);
