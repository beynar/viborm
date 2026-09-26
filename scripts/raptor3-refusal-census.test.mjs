/**
 * The refusal census's own harness self-test (FC-06).
 *
 * The census answers one question about a tree — which sentences this engine
 * can state, and which of them the old engine did not — so it is tested on a
 * FIXTURE tree that spells the shapes, not on the engine it measures. Each
 * cell writes the shape, runs the real program over it (`--root`), and reads
 * the report the program produced.
 *
 * The shapes are the ones the engine actually uses: a sentence built into a
 * local `const` and handed to the failure owner, a sentence built by the
 * site's own factory and handed to it, a caught value rethrown through it
 * (another owner's sentence, which must stay unread), the owner's own
 * substitution, and the unrelated zero-argument `failure()` of a premise.
 *
 *   node scripts/run-node-safe.mjs 512 60000 scripts/raptor3-refusal-census.test.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const scripts = import.meta.dirname;
const census = join(scripts, "raptor3-refusal-census.mjs");
const ENGINE = "src/query-engine/raptor3";

const write = (root, path, text) => {
  mkdirSync(dirname(resolve(root, path)), { recursive: true });
  writeFileSync(resolve(root, path), text);
};

/** The engine's own invariant owner: the census resolves it by import. */
const INVARIANT_OWNER = `export class EngineInvariantError extends Error {}
export const assertInvariant = (value: unknown, reason: string): void => {
  if (!value) throw new EngineInvariantError(reason);
};
`;

/**
 * The failure owner: it answers the value it is given, and substitutes its own
 * sentence for one internal class. `settle` rethrows a CAUGHT value through
 * it — another owner's sentence, which no cell may attribute to this site.
 */
const FAILURE_OWNER = `import { InvalidScalarResult } from "./query";
export class OperationContext {
  failure(error: unknown, phase: string, member?: object): unknown {
    if (error instanceof InvalidScalarResult)
      return new QueryEngineError(
        \`Driver "\${this.driverName}" answered a malformed \${error.scalarType} scalar for this fixture.\`
      );
    return error;
  }
  settle(member: object): void {
    try {
      this.work();
    } catch (error) {
      throw this.failure(error, "result", member);
    }
  }
}
`;

/**
 * The two carrying shapes, plus the premise's own zero-argument `failure()`,
 * which is a different member and carries nothing.
 */
const EXECUTION = `import { OperationContext } from "../shared/operation-context";
export class CommandExecution {
  runSeries(ctx: OperationContext, member: object): void {
    const failure = new NestedWriteError(
      \`Cannot \${this.kind} relation '\${this.edge}': parent record changed across a committed segment.\`
    );
    if (!this.published) throw ctx.failure(failure, "result", member);
    const exclusive = this.exclusiveMemberMove();
    if (exclusive) throw ctx.failure(exclusive, "planning", member);
    const premise = this.premise();
    if (premise.broken) throw premise.failure();
  }
  private exclusiveMemberMove(): Error | undefined {
    if (this.count < 2) return undefined;
    return new UnsupportedOperationError(
      "The fixture cannot move an exclusive member to two rows at once."
    );
  }
}
`;

/**
 * Sentence builders another layer owns and the engine imports: one returns a
 * single template, which the census reads at the call; the other computes its
 * sentence, which it cannot read, so that call stays sentence-less.
 */
const BUILDERS = `export function emptySelectRefusal(model: { name: string }): string {
  return \`The fixture's '\${model.name}' selection needs at least one field.\`;
}
export function composedRefusal(model: { name: string }): string {
  const name = model.name.toUpperCase();
  return \`The fixture composed '\${name}' before refusing it.\`;
}
`;

/** The engine throwing through the imported builders. */
const PROJECTION = `import { composedRefusal, emptySelectRefusal } from "../../result/result-shape";
export class Queries {
  prepareProjection(model: { name: string }, empty: boolean): void {
    if (empty) throw new QueryEngineError(emptySelectRefusal(model));
    throw new QueryEngineError(composedRefusal(model));
  }
}
`;

/** The old engine's corpus: two of the fixture's sentences are inherited. */
const SHIPPED = `export const messages = {
  parentChanged: (kind: string, edge: string) =>
    \`Cannot \${kind} relation '\${edge}': parent record changed across a committed segment.\`,
  emptySelect: (model: string) =>
    \`The fixture's '\${model}' selection needs at least one field.\`,
};
`;

const git = (root, ...args) =>
  execFileSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.email=harness@example.invalid",
      "-c",
      "user.name=harness",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf8" }
  );

/** A fixture repository with the shapes, committed so it has a corpus. */
const fixture = (owner = FAILURE_OWNER) => {
  const root = mkdtempSync(join(tmpdir(), "raptor3-census-"));
  git(root, "init", "--quiet", "--initial-branch=main");
  write(root, "src/old-engine/messages.ts", SHIPPED);
  write(root, `${ENGINE}/shared/invariant.ts`, INVARIANT_OWNER);
  write(root, `${ENGINE}/shared/operation-context.ts`, owner);
  write(root, `${ENGINE}/commands/execution.ts`, EXECUTION);
  write(root, "src/query-engine/result/result-shape.ts", BUILDERS);
  write(root, `${ENGINE}/shared/query.ts`, PROJECTION);
  git(root, "add", "--all");
  git(root, "commit", "--quiet", "-m", "fixture");
  return root;
};

/** Run the census over a fixture; answer its report and its exit status. */
const run = (root) => {
  const out = join(root, "census.md");
  let status = 0;
  try {
    execFileSync(
      process.execPath,
      [census, "--root", root, "--shipped-rev", "HEAD", "--out", out],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (error) {
    status = error.status ?? 1;
  }
  return { report: readFileSync(out, "utf8"), status };
};

/** The table row a sentence is reported on, or undefined. */
const row = (report, sentence) =>
  report.split("\n").find((line) => line.includes(sentence));

/** The section a line belongs to, by the last heading above it. */
const sectionOf = (report, sentence) => {
  let heading;
  for (const line of report.split("\n")) {
    if (line.startsWith("## ")) heading = line.slice(3);
    if (line.includes(sentence)) return heading;
  }
  return undefined;
};

test("reads the sentence a site built into a local const and handed to the failure owner", () => {
  const root = fixture();
  try {
    const { report, status } = run(root);
    assert.equal(status, 0);
    const line = row(
      report,
      "parent record changed across a committed segment"
    );
    assert(line, "the carried sentence is missing from the report");
    assert(line.includes("commands/execution.ts"), line);
    assert(line.includes("NestedWriteError"), line);
    // Its corpus twin makes it inherited, which is the other half of the read:
    // a sentence the census cannot see is neither inherited nor candidate.
    assert.equal(
      sectionOf(report, "parent record changed"),
      "Inherited sentences"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reads the sentence the site's own factory built and handed to the failure owner", () => {
  const root = fixture();
  try {
    const { report, status } = run(root);
    assert.equal(status, 0);
    const line = row(report, "cannot move an exclusive member");
    assert(line, "the factory's sentence is missing from the report");
    assert(line.includes("UnsupportedOperationError"), line);
    assert.equal(
      sectionOf(report, "cannot move an exclusive member"),
      "Candidate sentences unmatched in the old-engine corpus"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not attribute a caught value to the site that rethrows it through the failure owner", () => {
  const root = fixture();
  try {
    const { report } = run(root);
    const sentenceless = report.slice(
      report.indexOf("## Sites without a sentence")
    );
    assert(
      sentenceless.includes("this.failure"),
      "the rethrow of a caught value must stay a site without a sentence"
    );
    // And nothing invents a sentence for it: the owner's substitution is the
    // owner's, not this site's.
    assert.equal(
      report.split("scalar for this fixture").length - 1,
      1,
      "the owner's sentence must be reported once"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reads the failure owner's own substituted sentence once, at the owner", () => {
  const root = fixture();
  try {
    const { report, status } = run(root);
    assert.equal(status, 0);
    const line = row(report, "scalar for this fixture");
    assert(line, "the owner's substituted sentence is missing");
    assert(line.includes("operation-context.ts"), line);
    assert(!line.includes("execution.ts"), line);
    assert(line.includes("QueryEngineError"), line);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reads the one template an imported sentence builder returns, at the call", () => {
  const root = fixture();
  try {
    const { report, status } = run(root);
    assert.equal(status, 0);
    const line = row(report, "selection needs at least one field");
    assert(line, "the imported builder's sentence is missing from the report");
    assert(line.includes("shared/query.ts"), line);
    assert(line.includes("QueryEngineError"), line);
    assert.equal(
      sectionOf(report, "selection needs at least one field"),
      "Inherited sentences"
    );
    // A builder that computes before it returns is not one template: its
    // call stays a site without a sentence, and nothing invents one.
    assert(!report.includes("composed"), "a computed sentence was invented");
    const sentenceless = report.slice(
      report.indexOf("## Sites without a sentence")
    );
    assert(sentenceless.includes("shared/query.ts"), sentenceless);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not mistake a zero-argument `failure()` member for the failure owner", () => {
  const root = fixture();
  try {
    const { report } = run(root);
    const sentenceless = report.slice(
      report.indexOf("## Sites without a sentence")
    );
    assert(
      sentenceless.includes("premise.failure"),
      "a premise's own `failure()` carries nothing and must stay unread"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses loudly when the declared failure owner is not where the census reads it", () => {
  const moved = FAILURE_OWNER.replace(
    "  failure(error: unknown",
    "  answerFailure(error: unknown"
  ).replace("this.failure(error", "this.answerFailure(error");
  const root = fixture(moved);
  try {
    const { report, status } = run(root);
    assert.equal(status, 1, "a census whose owner moved must exit non-zero");
    assert(
      report.includes(
        "The declared failure owner is not where this census reads it"
      ),
      "the report must say so"
    );
    assert(report.includes("no `failure()` method"), report.slice(0, 900));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the engine's own tree still declares the failure owner the census reads", () => {
  const out = join(
    mkdtempSync(join(tmpdir(), "raptor3-census-tree-")),
    "census.md"
  );
  // The fact here is the declared failure owner, not the inherited/candidate
  // split, so the corpus is HEAD: a shipped revision absent from a shallow
  // clone's history would exit 1 on the corpus instead (`--shipped-rev`).
  const stdout = execFileSync(
    process.execPath,
    [census, "--shipped-rev", "HEAD", "--out", out],
    { encoding: "utf8" }
  );
  const report = readFileSync(out, "utf8");
  assert(
    !report.includes(
      "The declared failure owner is not where this census reads it"
    ),
    stdout
  );
  assert(report.includes("| **total sites** |"), stdout);
  rmSync(dirname(out), { recursive: true, force: true });
});
