/** Public command falsifiers; each child uses the existing bounded launcher. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  assertRaptor3Identity,
  captureRaptor3Identity,
  G0_RESOURCES,
  RAPTOR3_ROOT,
} from "./raptor3-manifest.mjs";

const directory = mkdtempSync(join(tmpdir(), "viborm-raptor3-cli-"));
const identity = captureRaptor3Identity();
const commands = [];
let gateDirectory;

function execute(entry, args, environment = {}) {
  const outcome = spawnSync(process.execPath, [entry, ...args], {
    cwd: RAPTOR3_ROOT,
    env: {
      ...process.env,
      VIBORM_RAPTOR3_REPLAY_PATH: "",
      VIBORM_RAPTOR3_SPECIMEN: "",
      VIBORM_RAPTOR3_EVIDENCE_DIRECTORY: "",
      ...environment,
    },
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  commands.push({
    entry,
    args,
    environment,
    status: outcome.status,
    signal: outcome.signal,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
  });
  assert.ifError(outcome.error);
  assert.equal(
    outcome.signal,
    null,
    "The command did not return a controlled exit"
  );
  return outcome;
}

function run(args, environment) {
  return execute("scripts/run-raptor3.mjs", args, environment);
}

function pass(outcome) {
  assert.equal(outcome.status, 0, `${outcome.stdout}\n${outcome.stderr}`);
}

function fail(outcome, reason) {
  assert.notEqual(outcome.status, 0, "A required command falsifier passed");
  assert.match(`${outcome.stdout}\n${outcome.stderr}`, reason);
  assert.doesNotMatch(outcome.stdout, /contract gate verified/);
}

before(() => {
  const outcome = run(["g0"]);
  pass(outcome);
  gateDirectory = outcome.stdout.match(/Evidence: (.+)/)?.[1];
  assert(gateDirectory, "The passing command omitted its evidence directory");
  const attempt = JSON.parse(
    readFileSync(join(gateDirectory, "attempt.json"), "utf8")
  );
  assert.equal(attempt.mode, "g0");
  assert.deepEqual(attempt.identity, identity);
  assert.deepEqual(attempt.resourceBounds, G0_RESOURCES);
});

after(() => {
  writeFileSync(
    join(directory, "commands.json"),
    JSON.stringify(
      {
        identity,
        gateDirectory,
        commands,
      },
      null,
      2
    )
  );
  process.stdout.write(`Raptor 3 CLI command evidence: ${directory}\n`);
  assertRaptor3Identity(identity);
});

test("the same replay command accepts saved fixed, cut/fault and clock corpora", () => {
  for (const file of [
    "corpus.json",
    "cut-evidence.json",
    "clock-evidence.json",
  ]) {
    const path = join(gateDirectory, file);
    const outcome = run(["replay", path]);
    pass(outcome);
    const replayDirectory = outcome.stdout.match(/Evidence: (.+)/)?.[1];
    assert(replayDirectory);
    const receipt = JSON.parse(
      readFileSync(join(replayDirectory, "verified.json"), "utf8")
    );
    assert.equal(receipt.replayInput.path, path);
    assert.match(receipt.replayInput.sha256, /^[a-f0-9]{64}$/);
  }
});

test("the command refuses filtering, missing required cases and profiles", () => {
  fail(run(["g0", "--testNamePattern=absent"]), /cannot be filtered/);
  for (const specimen of ["missing-case", "missing-profile"]) {
    fail(
      run(["g0"], { VIBORM_RAPTOR3_SPECIMEN: specimen }),
      /Missing.*G0 (case|profile)/
    );
  }
});

test("saved evidence with a stale identity, empty corpus or malformed wire fails", () => {
  const corpus = JSON.parse(
    readFileSync(join(gateDirectory, "corpus.json"), "utf8")
  );
  const specimens = [
    {
      name: "stale",
      envelope: {
        ...corpus,
        identity: { ...corpus.identity, production: "stale" },
      },
      reason: /Stale Raptor/,
    },
    {
      name: "empty",
      envelope: { ...corpus, records: ["array", []] },
      reason: /too_small|Too small/,
    },
    {
      name: "malformed",
      envelope: { ...corpus, records: ["unknown-wire-tag", []] },
      reason: /Unknown evidence wire tag/,
    },
  ];
  for (const specimen of specimens) {
    const path = join(directory, `${specimen.name}.json`);
    writeFileSync(path, JSON.stringify(specimen.envelope));
    fail(run(["replay", path]), specimen.reason);
  }
});

test("the outer watchdog terminates an operation that actually reached its wait", () => {
  const outcome = run(["g0"], {
    VIBORM_RAPTOR3_SPECIMEN: "nontermination",
  });
  fail(
    outcome,
    new RegExp(`exceeded its ${G0_RESOURCES.wallMs / 1000} second wall limit`)
  );
  assert.match(outcome.stdout, /G0 nontermination: public operation completed/);
  assert.match(outcome.stderr, /Teardown verified/);
});

test("the outer watchdog terminates a public call awaiting a queued provider reply", () => {
  const outcome = run(["g0", "--wall-limit-ms=10000"], {
    VIBORM_RAPTOR3_SPECIMEN: "transport-nontermination",
  });
  fail(outcome, /exceeded its 10 second wall limit/);
  assert.match(
    outcome.stdout,
    /G1 nontermination: public operation awaits queued provider reply/
  );
  assert.match(outcome.stderr, /Teardown verified/);
});

test("completed G2 progress survives watchdog termination without becoming qualifying evidence", () => {
  const outcome = run(["g0", "--wall-limit-ms=30000"], {
    VIBORM_RAPTOR3_SPECIMEN: "campaign-progress-nontermination",
  });
  fail(outcome, /exceeded its 30 second wall limit/);
  const progressDirectory = outcome.stdout.match(
    /G2 nontermination: verified cells persisted at (.+)/
  )?.[1];
  assert(
    progressDirectory,
    "The child must verify cells before its deliberate wait"
  );
  assert.match(outcome.stderr, /Teardown verified/);
  const progress = JSON.parse(
    readFileSync(
      join(progressDirectory, "generated-campaign-progress.json"),
      "utf8"
    )
  );
  assertRaptor3Identity(progress.identity, identity);
  assert.equal(progress.qualifying, false);
  assert.equal(progress.status, "incomplete");
  assert.equal(progress.firstSeed, 2000);
  assert.equal(progress.seedCount, 1);
  assert.deepEqual(
    progress.completed.map(({ seed, profile }) => ({ seed, profile })),
    [
      { seed: 2000, profile: "sqlite-interactive" },
      { seed: 2000, profile: "sqlite-atomic-batch" },
    ]
  );
  assert.equal(progress.replays, 6);
  for (const file of ["generated-campaign.json", "verified.json"])
    assert.equal(existsSync(join(progressDirectory, file)), false);
});

test("the command refuses a filtered G4 mode and an off-boundary G4 child", () => {
  fail(
    run(["g4-read-contracts", "--testNamePattern=absent"]),
    /cannot be filtered/
  );
  fail(run(["g4-seed-batch", "19999"]), /exact frozen boundary/);
  fail(run(["g4-transport-seed-batch", "20000"]), /exact frozen boundary/);
  fail(run(["g4-seeds", "20000"]), /cannot be filtered/);
  fail(
    run(["g4-unit01-author", "--testNamePattern=absent"]),
    /cannot be filtered/
  );
  fail(run(["g4-unit01-review", "83"]), /cannot be filtered/);
  fail(
    run(["g4-unit02-author", "--testNamePattern=absent"]),
    /cannot be filtered/
  );
  fail(run(["g4-unit02-mysql-contracts", "5"]), /cannot be filtered/);
});

test("the G4 write lanes own their own range and take no subject", () => {
  // The write lanes run the G3 generator on fresh seeds. Two things must hold
  // from the command line: a child cannot start inside an already-qualified
  // range, and the read campaign's `--subject` flag is refused here rather
  // than silently ignored - there is one subject, the candidate.
  fail(run(["g4-write-seed-batch", "74999"]), /exact frozen boundary/);
  fail(run(["g4-write-seed-batch", "8000"]), /exact frozen boundary/);
  fail(run(["g4-write-transport-seed-batch", "75000"]), /exact frozen boundary/);
  fail(run(["g4-write-transport-seed-batch", "125000"]), /exact frozen boundary/);
  fail(
    run(["g4-write-seeds", "--subject=shipped"]),
    /Subject selection applies only/
  );
  fail(
    run(["g4-write-seed-batch", "75000", "--subject=candidate"]),
    /Subject selection applies only/
  );
  fail(run(["g4-write-seeds", "75000"]), /cannot be filtered/);
});

test("a G4 campaign subject comes from the command, never from the shell", () => {
  // An inherited VIBORM_RAPTOR3_G4_SUBJECT used to decide what a child ran and
  // which receipt assertion the runner then applied, so a whole campaign could
  // be an oracle-validation run that still printed "verified".
  const leaked = run(["g4-seed-batch", "20000"], {
    VIBORM_RAPTOR3_G4_SUBJECT: "shipped",
  });
  const diagnostics = `${leaked.stdout}\n${leaked.stderr}`.match(
    /(?:diagnostics|Evidence): (.+)/
  )?.[1];
  assert(diagnostics, "the child did not report its evidence directory");
  const attempt = JSON.parse(
    readFileSync(join(diagnostics, "attempt.json"), "utf8")
  );
  assert.equal(
    attempt.subject,
    "candidate",
    "an inherited subject changed what the child ran"
  );
  assert.equal(attempt.qualifying, true);
  assert.doesNotMatch(leaked.stdout, /subject shipped/);

  // Asked for by name, the oracle-validation lane runs and says so everywhere
  // the runner writes: stdout, verified.json and the child receipt.
  const asked = run(["g4-seed-batch", "20000", "--subject=shipped"], {
    VIBORM_RAPTOR3_G4_SUBJECT: "candidate",
  });
  pass(asked);
  assert.match(asked.stdout, /subject shipped, NOT qualifying — oracle validation/);
  const evidence = asked.stdout.match(/Evidence: (.+)/)?.[1];
  assert(evidence, "the passing command omitted its evidence directory");
  const verified = JSON.parse(
    readFileSync(join(evidence, "verified.json"), "utf8")
  );
  assert.equal(verified.subject, "shipped");
  assert.equal(verified.qualifying, false);
  const receipt = JSON.parse(
    readFileSync(join(evidence, "generated-campaign.json"), "utf8")
  );
  assert.equal(receipt.subject, "shipped");
  assert.equal(receipt.qualifying, false);
  assert.equal(receipt.status, "oracle-validation");
  assert.equal(receipt.seedCount, 100);
  fail(
    run(["g4-seed-batch", "20000", "--subject=oracle"]),
    /Subject is candidate or shipped/
  );
  fail(run(["g0", "--subject=shipped"]), /Subject selection applies only/);
});

test("test:all cannot replace the required lane through inherited specimen variables", () => {
  const outcome = execute(
    "scripts/run-credential-free-tests.mjs",
    ["--only", "Raptor 3"],
    {
      VIBORM_RAPTOR3_SPECIMEN: "nontermination",
      VIBORM_RAPTOR3_REPLAY_PATH: join(directory, "does-not-exist.json"),
      VIBORM_RAPTOR3_EVIDENCE_DIRECTORY: join(directory, "does-not-exist"),
    }
  );
  pass(outcome);
  assert.doesNotMatch(
    outcome.stdout,
    /G0 nontermination: public operation completed/
  );
});
