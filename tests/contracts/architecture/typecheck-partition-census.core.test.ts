import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPOSITORY_ROOT } from "@tests/fixtures/repo-paths";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The typecheck-partition census.
 *
 * `scripts/run-typecheck-shards.mjs` is the only thing that typechecks this
 * repository. It cannot run the root tsconfig as one program - that OOMs at the
 * 1280 MB shard heap and hides real errors - so it splits the estate into two
 * hundred-odd shards, each a generated tsconfig over a list of concrete files.
 * A file the shard plan forgets is therefore a file NOTHING typechecks, and the
 * failure is completely silent: every shard is green and the estate is not.
 *
 * That is not hypothetical. `benchmarks/internal/operation.ts` sat outside the
 * plan because the benchmark scan read only the top level of `benchmarks/`,
 * `tests/contracts/contract.ts` sat outside it because the contract shards are
 * built per subdirectory, and `tests/types/relations/debug-relation-type.ts`
 * was in the plan twice - once against the root tsconfig and once against the
 * layer one - which costs a whole program per run.
 *
 * So this census computes the estate the ROOT tsconfig.json intends by reading
 * its own include and exclude patterns, computes the union of every shard's
 * files by calling the runner's own plan, and requires the second to be a
 * partition of the first. It restates neither side: there is no second copy of
 * the include list and no second copy of the shard rules, so nothing here can
 * agree with a stale duplicate.
 *
 * It is a PURE STATIC COMPUTATION. It reads tsconfig.json, walks the source
 * tree and calls `typecheckShardPlan()`. It never spawns tsc and never runs a
 * shard - importing the runner as a module is exactly why the runner guards its
 * own execution behind an invoked-as-a-script check.
 *
 * Falsified: make the benchmark scan non-recursive again, drop
 * `tests/contracts/contract.ts` from the support shard, list any file in two
 * shards, put a glob back into a shard's `include`, give two shards the same
 * name, or add an include pattern to tsconfig.json that no shard covers - each
 * turns exactly one invariant below red and names the offending files.
 */

/** The include dialect tsconfig.json actually uses. Anything richer throws. */
const UNSUPPORTED_GLOB_SYNTAX = /[?[\]{}()!+@]/;
const REGEXP_METACHARACTER = /[.*+?^${}()|[\]\\]/g;
const WILDCARD = /\*/;

type Shard = {
  readonly name: string;
  readonly include: readonly string[];
};

type ShardPlanModule = {
  readonly typecheckShardPlan: () => readonly Shard[];
  readonly fastLaneShards: (plan: readonly Shard[]) => readonly Shard[];
  readonly FAST_LANE_FAMILIES: readonly string[];
};

/**
 * TypeScript's include dialect, narrowed to what this tsconfig uses: `**`
 * spans zero or more path segments and `*` spans part of one. Anything richer
 * throws rather than quietly matching less than TypeScript would - an
 * under-matching census would report a covered file as orphaned, but an
 * over-matching one would report an orphan as covered, and only the second
 * failure direction is silent.
 */
function globToRegExp(pattern: string): RegExp {
  const segments = normalize(pattern).split("/");
  let source = "^";
  for (const [index, segment] of segments.entries()) {
    const isLast = index === segments.length - 1;
    if (UNSUPPORTED_GLOB_SYNTAX.test(segment)) {
      throw new Error(`Unsupported glob syntax in pattern: ${pattern}`);
    }
    if (segment === "**") {
      source += isLast ? "[\\s\\S]*" : "(?:[^/]+/)*";
      continue;
    }
    if (segment.includes("**")) {
      throw new Error(`Unsupported glob syntax in pattern: ${pattern}`);
    }
    source += segment.replace(REGEXP_METACHARACTER, (character) =>
      character === "*" ? "[^/]*" : `\\${character}`
    );
    if (!isLast) source += "/";
  }
  return new RegExp(`${source}$`);
}

function normalize(pattern: string): string {
  return pattern.startsWith("./") ? pattern.slice(2) : pattern;
}

/**
 * An exclude entry with no wildcard names a path: TypeScript drops that file
 * and, when it is a directory, everything beneath it. A wildcard entry is an
 * ordinary include-dialect glob.
 */
function excludeMatcher(pattern: string): (file: string) => boolean {
  const normalized = normalize(pattern);
  if (!WILDCARD.test(normalized)) {
    return (file) => file === normalized || file.startsWith(`${normalized}/`);
  }
  const expression = globToRegExp(normalized);
  return (file) => expression.test(file);
}

/**
 * The wildcard-free prefix of an include pattern - the directory the walk below
 * starts from. A pattern anchored at the repository root would have to walk
 * node_modules to be answered honestly, so it throws instead of guessing.
 */
function walkRoot(pattern: string): string {
  const literal: string[] = [];
  for (const segment of normalize(pattern).split("/")) {
    if (WILDCARD.test(segment) || UNSUPPORTED_GLOB_SYNTAX.test(segment)) break;
    literal.push(segment);
  }
  if (literal.length === 0) {
    throw new Error(
      `Include pattern "${pattern}" is anchored at the repository root; this census cannot enumerate it without walking node_modules.`
    );
  }
  return literal.join("/");
}

/** Every path under `relativePath`, or the path itself when it is a file. */
function pathsUnder(relativePath: string): string[] {
  const absolute = resolve(REPOSITORY_ROOT, relativePath);
  const stats = statSync(absolute, { throwIfNoEntry: false });
  if (!stats) return [];
  if (!stats.isDirectory()) return [relativePath];
  const found: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    found.push(...pathsUnder(`${relativePath}/${entry.name}`));
  }
  return found;
}

function stringList(value: unknown, description: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${description} is not an array of strings.`);
  }
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(`${description} holds a non-string entry.`);
    }
  }
  return value as string[];
}

function readRootTsconfig(): { include: string[]; exclude: string[] } {
  const parsed: unknown = JSON.parse(
    readFileSync(join(REPOSITORY_ROOT, "tsconfig.json"), "utf8")
  );
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("tsconfig.json is not an object.");
  }
  const { include, exclude } = parsed as {
    include?: unknown;
    exclude?: unknown;
  };
  return {
    exclude: exclude === undefined ? [] : stringList(exclude, "root exclude"),
    include: stringList(include, "root include"),
  };
}

function asShardList(value: unknown, description: string): Shard[] {
  if (!Array.isArray(value)) {
    throw new Error(`${description} is not an array of shards.`);
  }
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`${description} holds a non-object shard.`);
    }
    const { name, include } = entry as { name?: unknown; include?: unknown };
    if (typeof name !== "string") {
      throw new Error(`${description} holds a shard without a name.`);
    }
    return { include: stringList(include, `shard ${name} include`), name };
  });
}

async function loadShardPlanModule(): Promise<ShardPlanModule> {
  const loaded: Record<string, unknown> = await import(
    "@root/scripts/run-typecheck-shards.mjs"
  );
  const { typecheckShardPlan, fastLaneShards, FAST_LANE_FAMILIES } = loaded;
  if (
    typeof typecheckShardPlan !== "function" ||
    typeof fastLaneShards !== "function"
  ) {
    throw new Error(
      "scripts/run-typecheck-shards.mjs must export typecheckShardPlan and fastLaneShards."
    );
  }
  return {
    FAST_LANE_FAMILIES: stringList(FAST_LANE_FAMILIES, "FAST_LANE_FAMILIES"),
    fastLaneShards: (plan) =>
      asShardList(fastLaneShards(plan), "the fast lane selection"),
    typecheckShardPlan: () =>
      asShardList(typecheckShardPlan(), "the shard plan"),
  };
}

/**
 * The fast lane is a deliberately small slice of the plan. Twenty shards at ~9s
 * would already be three minutes, which `pnpm test` cannot spend before it even
 * reaches the runtime core, so the agreed ceiling is well under that.
 */
const FAST_LANE_SHARD_CEILING = 12;

let includePatterns: string[] = [];
/** Every file the root tsconfig intends, repository-relative. */
let estate = new Set<string>();
/** Include pattern to the number of files it selects. */
const selectionCounts = new Map<string, number>();
let plan: Shard[] = [];
let fastLane: Shard[] = [];
let fastLaneFamilies: string[] = [];
/** Every file a shard lists, to the shards that list it. */
let owners = new Map<string, string[]>();

beforeAll(async () => {
  const { include, exclude } = readRootTsconfig();
  includePatterns = include;
  const excluded = exclude.map(excludeMatcher);
  estate = new Set<string>();
  for (const pattern of include) {
    const expression = globToRegExp(pattern);
    let selected = 0;
    for (const file of pathsUnder(walkRoot(pattern))) {
      if (!expression.test(file)) continue;
      if (excluded.some((matches) => matches(file))) continue;
      estate.add(file);
      selected += 1;
    }
    selectionCounts.set(pattern, selected);
  }

  const shardPlan = await loadShardPlanModule();
  plan = [...shardPlan.typecheckShardPlan()];
  fastLane = [...shardPlan.fastLaneShards(plan)];
  fastLaneFamilies = [...shardPlan.FAST_LANE_FAMILIES];

  owners = new Map<string, string[]>();
  for (const shard of plan) {
    for (const file of shard.include) {
      const listed = owners.get(file);
      if (listed) listed.push(shard.name);
      else owners.set(file, [shard.name]);
    }
  }
});

describe("typecheck shard partition", () => {
  it("reads a live estate off tsconfig.json and a live plan off the runner", () => {
    const deadPatterns = includePatterns.filter(
      (pattern) => (selectionCounts.get(pattern) ?? 0) === 0
    );

    expect(includePatterns.length).toBeGreaterThan(0);
    expect(estate.size).toBeGreaterThan(0);
    expect(plan.length).toBeGreaterThan(0);
    expect(deadPatterns).toEqual([]);
  });

  it("puts every file the root tsconfig intends into a shard", () => {
    const orphaned = [...estate].filter((file) => !owners.has(file)).sort();

    expect(orphaned).toEqual([]);
  });

  it("puts no file into more than one shard", () => {
    const duplicated = [...owners]
      .filter(([, shards]) => shards.length > 1)
      .map(([file, shards]) => `${file} -> ${shards.join(", ")}`)
      .sort();

    expect(duplicated).toEqual([]);
  });

  it("lists nothing the root tsconfig does not intend", () => {
    const strays = [...owners]
      .filter(([file]) => !estate.has(file))
      .map(([file, shards]) => `${file} -> ${shards.join(", ")}`)
      .sort();

    expect(strays).toEqual([]);
  });

  it("holds concrete file paths so a shard that does not fit can be split", () => {
    // The runner halves a failing shard's `include` array. A glob is
    // indivisible: a shard that bottoms out at one pattern covering many files
    // can never be made to fit, which is how the provider shard used to fail
    // outright instead of splitting.
    const patterns = plan
      .flatMap((shard) =>
        shard.include.map((file) => ({ file, name: shard.name }))
      )
      .filter(
        ({ file }) => WILDCARD.test(file) || UNSUPPORTED_GLOB_SYNTAX.test(file)
      )
      .map(({ name, file }) => `${name} :: ${file}`);

    expect(patterns).toEqual([]);
  });

  it("gives every shard its own name", () => {
    // Each shard's name is its generated tsconfig's filename. Two shards
    // sharing a name share a file: the second write wins, so one shard is
    // typechecked twice and the other's files are never typechecked at all,
    // and the partition above cannot see it.
    const seen = new Set<string>();
    const collisions: string[] = [];
    for (const { name } of plan) {
      if (seen.has(name)) collisions.push(name);
      seen.add(name);
    }

    expect(collisions).toEqual([]);
  });

  it("keeps --fast a small, real subset of the same plan", () => {
    const planNames = new Set(plan.map((shard) => shard.name));
    const outside = fastLane
      .map((shard) => shard.name)
      .filter((name) => !planNames.has(name));

    expect(fastLaneFamilies.length).toBeGreaterThan(0);
    expect(fastLane).toHaveLength(fastLaneFamilies.length);
    expect(outside).toEqual([]);
    // The production shard is the agreed floor of the fast lane.
    expect(fastLane.map((shard) => shard.name)).toContain("production");
    expect(fastLane.length).toBeLessThanOrEqual(FAST_LANE_SHARD_CEILING);
    expect(fastLane.length).toBeLessThan(plan.length);
  });
});
