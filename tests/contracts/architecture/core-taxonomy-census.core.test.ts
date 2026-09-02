import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import packageMetadata from "@root/package.json";
import { REPOSITORY_ROOT } from "@tests/fixtures/repo-paths";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The core-taxonomy census.
 *
 * `pnpm test:core` selects `--project='layer-*'`, and both `pnpm test` and
 * `pnpm test:all` run through it. The `extended-local` project — the only other
 * deterministic runnable lane — excludes every `.core.test.ts`. So a core
 * contract that no `layer-*` project selects executes in NO gate at all: it
 * survives only inside the coverage lanes, which are diagnostics and are not
 * required to be green to merge. Fifty-seven contracts sat in exactly that hole
 * (the whole 56-file write core, which only `coverage-write-engine-core` read,
 * plus `public-client/extensions/array-admission.core.test.ts`, which the
 * client layer's per-subdirectory globs never learned about).
 *
 * The hole opened because two enumerations drifted from the tree they describe,
 * so this census restates neither. It loads the layer projects out of
 * `vitest.workspace.ts` and matches their own include patterns against the
 * files on disk, and it reads the `layer-*` selector out of the `test:core`
 * script. Nothing here can agree with a stale copy of the taxonomy, because
 * there is no copy.
 *
 * The partition is enforced from both sides: every `.core.test.ts` lands in
 * exactly one layer project, and the layer projects admit nothing that is not a
 * `.core.test.ts` — a non-core file inside a layer manifest would run twice,
 * once there and once in `extended-local`.
 *
 * This file is admitted through `QUERY_ENGINE_CORE_TESTS` like every other
 * architecture census, so the invariants below cover the census itself.
 *
 * Falsified: drop a layer project's include entry, add a `.core.test.ts` under
 * a directory no layer project globs, list one file in two layer manifests, or
 * point `test:core` at anything but `layer-*` — each turns exactly one of the
 * invariants below red and names the file, pattern, or script at fault.
 */

// `defineWorkspace` is an identity function over the project list, but the real
// `vitest/config` drags the whole Vite Node API into this worker to supply it.
// The stub keeps the census inside the core lane's memory budget; the resolved
// project list is the same either way, so this is a cost control and not a
// correctness dependency.
vi.mock("vitest/config", () => ({
  defineWorkspace: (projects: unknown) => projects,
}));

const CORE_TEST_SUFFIX = ".core.test.ts";
const LAYER_PROJECT_PREFIX = "layer-";
const CORE_PROJECT_SELECTOR = "--project='layer-*'";
const UNSUPPORTED_GLOB_SYNTAX = /[?[\]{}()!+@]/;
const REGEXP_METACHARACTER = /[.*+?^${}()|[\]\\]/g;

type LayerProject = {
  readonly name: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
};

/**
 * The include dialect the workspace actually uses: `**` spans zero or more path
 * segments and `*` spans part of one. Anything richer throws rather than
 * quietly matching less than Vitest would — an under-matching census would
 * report a covered file as orphaned, but an over-matching one would report an
 * orphan as covered, and only the second failure direction is silent.
 */
function globToRegExp(pattern: string): RegExp {
  const segments = (
    pattern.startsWith("./") ? pattern.slice(2) : pattern
  ).split("/");
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

function patternList(value: unknown, description: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${description} is not an array of glob patterns.`);
  }
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(`${description} holds a non-string pattern.`);
    }
  }
  return value as string[];
}

async function loadLayerProjects(): Promise<LayerProject[]> {
  const workspace: unknown = (await import("@root/vitest.workspace")).default;
  if (!Array.isArray(workspace)) {
    throw new Error("vitest.workspace.ts must default-export a project list.");
  }
  const projects: LayerProject[] = [];
  for (const entry of workspace) {
    if (typeof entry !== "object" || entry === null) continue;
    const { test: inlineConfig } = entry as { test?: unknown };
    if (typeof inlineConfig !== "object" || inlineConfig === null) continue;
    const { name, include, exclude } = inlineConfig as {
      name?: unknown;
      include?: unknown;
      exclude?: unknown;
    };
    if (typeof name !== "string" || !name.startsWith(LAYER_PROJECT_PREFIX)) {
      continue;
    }
    projects.push({
      name,
      include: patternList(include, `${name} include`),
      exclude:
        exclude === undefined ? [] : patternList(exclude, `${name} exclude`),
    });
  }
  return projects;
}

function typescriptFilesUnderTests(): string[] {
  const found: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(child);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        found.push(relative(REPOSITORY_ROOT, child).replaceAll("\\", "/"));
      }
    }
  };
  visit(join(REPOSITORY_ROOT, "tests"));
  return found.sort();
}

let layerProjects: LayerProject[] = [];
let testTreeFiles: string[] = [];
let coreTestFiles: string[] = [];
/** Every layer project that selects the file, in workspace order. */
let selectingProjects = new Map<string, string[]>();
/** `<project> :: <pattern>` to the number of files that pattern selects. */
let patternSelectionCounts = new Map<string, number>();

beforeAll(async () => {
  layerProjects = await loadLayerProjects();
  testTreeFiles = typescriptFilesUnderTests();
  coreTestFiles = testTreeFiles.filter((file) =>
    file.endsWith(CORE_TEST_SUFFIX)
  );
  selectingProjects = new Map(testTreeFiles.map((file) => [file, []]));
  patternSelectionCounts = new Map();

  for (const project of layerProjects) {
    const excluded = project.exclude.map(globToRegExp);
    for (const pattern of project.include) {
      const included = globToRegExp(pattern);
      const selected = testTreeFiles.filter(
        (file) =>
          included.test(file) &&
          !excluded.some((expression) => expression.test(file))
      );
      patternSelectionCounts.set(
        `${project.name} :: ${pattern}`,
        selected.length
      );
      for (const file of selected) {
        const owners = selectingProjects.get(file);
        if (owners && !owners.includes(project.name)) {
          owners.push(project.name);
        }
      }
    }
  }
});

describe("core test taxonomy", () => {
  it("runs the trusted core over the layer projects this census reads", () => {
    expect(packageMetadata.scripts["test:core"]).toContain(
      CORE_PROJECT_SELECTOR
    );
    expect(packageMetadata.scripts.test).toContain("test:core");
    expect(layerProjects.length).toBeGreaterThan(0);
    expect(coreTestFiles.length).toBeGreaterThan(0);
  });

  it("selects every core test in exactly one layer project", () => {
    const orphaned: string[] = [];
    const duplicated: string[] = [];
    for (const file of coreTestFiles) {
      const owners = selectingProjects.get(file) ?? [];
      if (owners.length === 0) {
        orphaned.push(file);
      } else if (owners.length > 1) {
        duplicated.push(`${file} -> ${owners.join(", ")}`);
      }
    }

    expect(orphaned).toEqual([]);
    expect(duplicated).toEqual([]);
  });

  it("admits nothing but core tests into the layer projects", () => {
    const foreign = testTreeFiles
      .filter(
        (file) =>
          !file.endsWith(CORE_TEST_SUFFIX) &&
          (selectingProjects.get(file) ?? []).length > 0
      )
      .map((file) => `${file} -> ${selectingProjects.get(file)?.join(", ")}`);

    expect(foreign).toEqual([]);
  });

  it("keeps every layer project and include pattern live", () => {
    const deadPatterns: string[] = [];
    for (const [pattern, count] of patternSelectionCounts) {
      if (count === 0) deadPatterns.push(pattern);
    }
    const emptyProjects = layerProjects
      .filter((project) =>
        project.include.every(
          (pattern) =>
            patternSelectionCounts.get(`${project.name} :: ${pattern}`) === 0
        )
      )
      .map((project) => project.name);

    expect(deadPatterns).toEqual([]);
    expect(emptyProjects).toEqual([]);
  });
});
