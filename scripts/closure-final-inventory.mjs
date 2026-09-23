/**
 * What a qualification gate must run, derived from the files that already
 * declare it.
 *
 * The final local closure's gate enumerated its native MySQL lane with a
 * hand-written shell glob (`tests/providers/docker/mysql2*.test.ts` plus
 * `tests/unit/migrations/mysql*docker*.test.ts`). Two files registered in the
 * `provider-mysql2` project match neither spelling, so the lane reported
 * "735 passed" for eleven executed files while the project held thirteen. A
 * second list of the same fact is what made that possible, so this reader adds
 * none: it takes the include patterns from `vitest.workspace.ts` (and the D1
 * config the workspace names), expands them against the test tree, and reports
 * what each project actually registers.
 *
 *   node scripts/closure-final-inventory.mjs providers        # per provider project
 *   node scripts/closure-final-inventory.mjs credential-free  # the gate's unkeyed file stages
 *   node scripts/closure-final-inventory.mjs plan             # every stage, in gate order
 *   node scripts/closure-final-inventory.mjs json             # all of it, machine readable
 *
 * It runs nothing, needs no credentials, and prints no connection string: the
 * native stages are printed as the files they would run, with the environment
 * variable named rather than read.
 *
 * `closure-final-index.mjs` imports `inventory()` for its registered-inventory
 * section, so the index's per-project counts and this command's are one answer.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const INVENTORY_ROOT = resolve(
  fileURLToPath(new URL("..", import.meta.url))
);

/** The workspace files that declare projects. The first names the second. */
const WORKSPACE_FILES = ["vitest.workspace.ts", "vitest.d1.config.ts"];

/**
 * The manifest modules a workspace include list may spread. They are the
 * owners of those lists; this module resolves the identifier to the owner's
 * array rather than restating any path. `closure-final-index.mjs` imports
 * this list rather than keeping a second copy of it.
 */
export const MANIFEST_MODULES = [
  "scripts/raptor3-manifest.mjs",
  "scripts/credential-free-test-manifest.mjs",
  "scripts/client-test-manifest.mjs",
  "scripts/driver-test-manifest.mjs",
  "scripts/migration-test-manifest.mjs",
  "scripts/query-engine-test-manifest.mjs",
];

/**
 * A project whose files need a live database reached by a connection string.
 * The workspace does not state this — nothing does — so it is stated once,
 * here, as the gate's own division of labour: everything else is the
 * credential-free half `pnpm test:all` owns.
 */
const CREDENTIAL_ENVIRONMENT = {
  "provider-mysql2": "MYSQL_TEST_CONNECTION_STRING",
  "provider-pg": "PG_TEST_CONNECTION_STRING",
  "provider-postgres": "PG_TEST_CONNECTION_STRING",
  "provider-transaction-options": "PG_TEST_CONNECTION_STRING",
  "provider-neon-http": "NEON_TEST_CONNECTION_STRING",
  "provider-planetscale": "PLANETSCALE_TEST_CONNECTION_STRING",
};

/* ------------------------------------------------------------------ parsing */

const NAME_MARKER =
  /(?:\b(layerProject|providerProject|coverageProject)\(\s*"([^"]+)"|name:\s*"([^"]+)")/g;
const SPREAD_IDENTIFIER = /^\.\.\.([A-Za-z_$][\w$]*)/;
const PROJECT_PREFIX = {
  layerProject: "layer-",
  providerProject: "provider-",
  coverageProject: "coverage-",
};

/**
 * The elements of the array literal that starts at `text[start]`: `"literal"`
 * strings and `...IDENTIFIER` spreads, in source order. Comments inside the
 * array are skipped, which the workspace's include lists do carry.
 */
function readArray(text, start) {
  let depth = 0;
  let index = start;
  const elements = [];
  for (; index < text.length; index += 1) {
    const character = text[index];
    if (character === "[") {
      depth += 1;
      continue;
    }
    if (character === "]") {
      depth -= 1;
      if (depth === 0) break;
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      index = text.indexOf("\n", index);
      if (index === -1) break;
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      index = text.indexOf("*/", index) + 1;
      continue;
    }
    if (character === '"') {
      const end = text.indexOf('"', index + 1);
      elements.push({ kind: "literal", value: text.slice(index + 1, end) });
      index = end;
      continue;
    }
    if (text.startsWith("...", index)) {
      const spread = SPREAD_IDENTIFIER.exec(text.slice(index));
      if (spread) {
        elements.push({ kind: "spread", value: spread[1] });
        index += spread[0].length - 1;
      }
    }
  }
  return elements;
}

/**
 * Every project the workspace declares, in declaration order.
 *
 * A project's name literal is always followed, in source order, by its own
 * include array — both in the helper calls (`providerProject("pg", [ … ])`)
 * and in the inline objects (`name: "raptor3"`, then `include: [ … ]`). The
 * helpers' own definitions spell their names as template literals, so they do
 * not match the name marker and cannot be mistaken for projects.
 */
export function workspaceProjects(root = INVENTORY_ROOT) {
  const projects = [];
  for (const file of WORKSPACE_FILES) {
    const text = readFileSync(resolve(root, file), "utf8");
    NAME_MARKER.lastIndex = 0;
    let marker = NAME_MARKER.exec(text);
    while (marker) {
      const helper = marker[1];
      const project = helper
        ? `${PROJECT_PREFIX[helper]}${marker[2]}`
        : marker[3];
      const includeAt = helper
        ? marker.index + marker[0].length
        : text.indexOf("include:", marker.index);
      const bracket = includeAt === -1 ? -1 : text.indexOf("[", includeAt);
      const next = NAME_MARKER.exec(text);
      const limit = next ? next.index : text.length;
      projects.push(
        bracket === -1 || bracket > limit
          ? { project, source: file, include: [], spreads: [] }
          : (() => {
              const elements = readArray(text, bracket);
              return {
                project,
                source: file,
                include: elements
                  .filter((element) => element.kind === "literal")
                  .map((element) => element.value),
                spreads: elements
                  .filter((element) => element.kind === "spread")
                  .map((element) => element.value),
              };
            })()
      );
      marker = next;
    }
  }
  return projects;
}

/* ------------------------------------------------------------------ the tree */

const TEST_SUFFIX = ".test.ts";

/** Every `*.test.ts` under `tests/`, repository-relative, sorted. */
export function testTreeFiles(root = INVENTORY_ROOT) {
  const testsRoot = resolve(root, "tests");
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(TEST_SUFFIX)) {
        files.push(relative(root, path).replaceAll("\\", "/"));
      }
    }
  };
  if (statSync(testsRoot, { throwIfNoEntry: false })?.isDirectory()) {
    walk(testsRoot);
  }
  return files.sort();
}

const GLOB_SPECIAL = /[.+^${}()|[\]\\]/g;

/** Vitest's include patterns, as the subset this tree uses: `**`, `*`, `?`. */
function globToRegExp(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const rest = pattern.slice(index);
    if (rest.startsWith("**/")) {
      source += "(?:.*/)?";
      index += 2;
    } else if (rest.startsWith("**")) {
      source += ".*";
      index += 1;
    } else if (pattern[index] === "*") source += "[^/]*";
    else if (pattern[index] === "?") source += "[^/]";
    else source += pattern[index].replace(GLOB_SPECIAL, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/* --------------------------------------------------------------- the answer */

async function manifestSymbols(root) {
  const lists = new Map();
  const cells = new Map();
  for (const module of MANIFEST_MODULES) {
    const exported = await import(resolve(root, module));
    for (const [name, value] of Object.entries(exported)) {
      if (
        Array.isArray(value) &&
        value.every((item) => typeof item === "string")
      ) {
        lists.set(name, value);
      } else if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length > 0 &&
        Object.values(value).every((count) => typeof count === "number")
      ) {
        for (const [file, count] of Object.entries(value)) {
          const existing = cells.get(file);
          if (existing) existing.maps.push(name);
          else cells.set(file, { cells: count, maps: [name] });
        }
      }
    }
  }
  return { lists, cells };
}

/**
 * The registered inventory: every project, the files its patterns reach in
 * this tree, and the cells the declared-cell maps declare for them.
 *
 * `declaredCells` is a per-FILE number. A file registered in more than one
 * project executes once per project, so a stage's reported test total is
 * project executions — files × projects — and this reader keeps the two
 * apart instead of reporting either as the other.
 */
export async function inventory(root = INVENTORY_ROOT) {
  const { lists, cells } = await manifestSymbols(root);
  const tree = testTreeFiles(root);
  const unresolvedSpreads = [];
  const projects = workspaceProjects(root).map((project) => {
    const patterns = [...project.include];
    for (const spread of project.spreads) {
      const list = lists.get(spread);
      if (list) patterns.push(...list);
      else unresolvedSpreads.push({ project: project.project, spread });
    }
    const matchers = patterns.map(globToRegExp);
    const files = tree.filter((file) =>
      matchers.some((matcher) => matcher.test(file))
    );
    const declared = files.reduce(
      (total, file) => total + (cells.get(file)?.cells ?? 0),
      0
    );
    const named = patterns.filter(
      (pattern) => !(pattern.includes("*") || tree.includes(pattern))
    );
    return {
      project: project.project,
      source: project.source,
      patterns: patterns.length,
      spreads: project.spreads,
      credentialEnvironment: CREDENTIAL_ENVIRONMENT[project.project],
      files,
      declaredCells: declared,
      declaredCellsKnownFor: files.filter((file) => cells.has(file)).length,
      registeredButAbsent: named,
    };
  });

  const projectsByFile = new Map();
  for (const project of projects) {
    for (const file of project.files) {
      const entry = projectsByFile.get(file) ?? [];
      entry.push(project.project);
      projectsByFile.set(file, entry);
    }
  }

  return {
    root,
    projects,
    tree,
    lists,
    unresolvedSpreads,
    declaredCells: cells,
    projectsByFile,
    unregistered: tree.filter((file) => !projectsByFile.has(file)),
  };
}

/**
 * A directory's files as the gate runs them: the executions a stage performs
 * (one per project the file is registered in) and the cells declared for the
 * files themselves. 527 is the first number; it is not 527 declared cases.
 */
export function stageTotals(files, current) {
  let executions = 0;
  let executedCells = 0;
  let declared = 0;
  const unknown = [];
  for (const file of files) {
    const projects = current.projectsByFile.get(file) ?? [];
    const cells = current.declaredCells.get(file);
    executions += projects.length;
    if (cells) {
      declared += cells.cells;
      executedCells += cells.cells * projects.length;
    } else unknown.push(file);
  }
  return {
    files: files.length,
    filesWithDeclaredCells: files.length - unknown.length,
    projectExecutions: executions,
    declaredCells: declared,
    executedCells,
    filesWithoutDeclaredCells: unknown,
  };
}

/* -------------------------------------------------------------------- stages */

const PARITY_DIRECTORY = "tests/raptor3/g4/parity/";
const CONFORMANCE_PREFIX =
  "tests/contracts/engine/query/nested-write-conformance-";

const projectFiles = (current, name) =>
  current.projects.find((project) => project.project === name)?.files ?? [];

/**
 * The gate's stages, in the order the integrator's script runs them, with a
 * file list for every stage that would otherwise be enumerated by hand.
 *
 * A `runner-mode` stage names a `scripts/run-raptor3.mjs` mode, and that
 * script's own mode table is the owner of its files AND asserts its declared
 * counts, so a mode cannot silently omit a file and none is restated here. A
 * `files` stage is where the omission happened, so those are derived.
 */
export function gatePlan(current) {
  const parity = current.tree.filter(
    (file) =>
      file.startsWith(PARITY_DIRECTORY) &&
      !projectFiles(current, "raptor3-provider").includes(file)
  );
  const pglitePins = projectFiles(current, "raptor3-provider").filter((file) =>
    file.startsWith(PARITY_DIRECTORY)
  );
  const conformance = current.tree.filter((file) =>
    file.startsWith(CONFORMANCE_PREFIX)
  );
  const stage = (name, kind, extra = {}) => ({ name, kind, ...extra });
  return [
    stage("typecheck", "command", {
      command: "node scripts/run-typecheck.mjs",
    }),
    stage("fixed", "command", {
      command: 'pnpm test:all --only "Raptor 3 fixed"',
      owner:
        "scripts/credential-free-test-manifest.mjs RAPTOR3_FIXED_LOCAL_TESTS",
    }),
    stage("parity", "files", {
      command: "node scripts/run-vitest-safe.mjs run <files>",
      files: parity,
      totals: stageTotals(parity, current),
      note: "run credential-free in thirds; the PGlite-backed parity pins are their own stage",
    }),
    stage("conformance", "files", {
      command: "node <shared-family launcher> <file>",
      files: conformance,
      totals: stageTotals(conformance, current),
      note: "one file per invocation",
    }),
    ...["g2-baseline", "g2-contracts", "g1-compare"].map((mode) =>
      stage(mode, "runner-mode", {
        command: `node scripts/run-raptor3.mjs ${mode}`,
      })
    ),
    stage("transport-smoke", "runner-mode", {
      command: "node scripts/run-raptor3.mjs g3-generated-transport-smoke",
    }),
    stage("transaction-array", "runner-mode", {
      command: "node scripts/run-raptor3.mjs g3-transaction-array",
    }),
    stage("pglite-provider", "files", {
      command:
        "node <shared-family launcher> <files> --project raptor3-provider",
      files: pglitePins,
      totals: stageTotals(pglitePins, current),
    }),
    stage("census", "command", {
      command: "node scripts/raptor3-refusal-census.mjs",
    }),
    stage("build", "command", { command: "pnpm package:build" }),
    stage("campaign-receipts", "command", {
      command:
        "node scripts/run-node-safe.mjs 512 60000 scripts/raptor3-campaign-receipts.test.mjs",
    }),
    stage("coverage-policy", "command", {
      command: "pnpm test:coverage:policy",
    }),
    ...["provider-mysql2", "provider-pg"].map((project) => {
      const files = projectFiles(current, project);
      return stage(`native ${project}`, "files", {
        command: `<${CREDENTIAL_ENVIRONMENT[project]}> node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=${project} <file>`,
        credentialEnvironment: CREDENTIAL_ENVIRONMENT[project],
        files,
        totals: stageTotals(files, current),
        note: "one file per invocation; the whole registered project, not a hand-written glob",
      });
    }),
  ];
}

/**
 * The other half of the omission question, grouped by project.
 *
 * `unregistered` answers "is this file in a project". It cannot see the failure
 * this module exists to prevent, which is a file a project DOES register and no
 * stage runs: the two omitted native files were registered throughout, and a
 * witness appended to a manifest list that no stage names would be registered
 * too and just as unrun.
 *
 * A stage covers a file either by naming it — a `files` stage, enumerated
 * here — or by running the list its `owner` holds, resolved through the same
 * manifest symbols the include spreads use. A `runner-mode` stage's files are
 * owned AND count-asserted by `scripts/run-raptor3.mjs`'s mode table, which
 * this reader deliberately does not restate, so those files are not counted as
 * covered and the report says so rather than implying the gate skips them.
 */
export function stageCoverage(current, plan) {
  const coveringStages = new Map();
  // An owner symbol this reader cannot resolve is reported, never treated as a
  // stage that covers nothing: a renamed manifest export would otherwise turn
  // its files into silent omissions — the false-sentence class this command
  // exists to surface.
  const unresolvedOwners = [];
  for (const stage of plan) {
    const ownerSymbol = stage.owner?.split(" ").at(-1);
    if (stage.owner && !stage.files && !current.lists.has(ownerSymbol))
      unresolvedOwners.push({ stage: stage.name, owner: stage.owner });
    const files =
      stage.files ??
      (stage.owner ? (current.lists.get(ownerSymbol) ?? []) : []);
    for (const file of files) {
      const stages = coveringStages.get(file) ?? [];
      if (!stages.includes(stage.name)) stages.push(stage.name);
      coveringStages.set(file, stages);
    }
  }
  const projects = current.projects.map((project) => {
    const byStage = new Map();
    const uncovered = [];
    for (const file of project.files) {
      const stages = coveringStages.get(file);
      if (stages) {
        for (const name of stages)
          byStage.set(name, (byStage.get(name) ?? 0) + 1);
      } else uncovered.push(file);
    }
    return {
      project: project.project,
      files: project.files.length,
      stages: [...byStage].map(([stage, files]) => ({ stage, files })),
      uncovered: uncovered.length,
    };
  });
  const covered = [...current.projectsByFile.keys()].filter((file) =>
    coveringStages.has(file)
  ).length;
  return {
    projects,
    unresolvedOwners,
    registered: current.projectsByFile.size,
    covered,
    uncovered: current.projectsByFile.size - covered,
  };
}

/* --------------------------------------------------------------------- CLI */

const COMMANDS = new Set(["providers", "credential-free", "plan", "json"]);

/**
 * Files, executions and cells kept apart in words as well as in the object.
 * A stage's reported test total is executed cells across project executions;
 * the declared count is per distinct file, and only for the files a
 * declared-cell map names.
 */
function describeTotals(totals) {
  return [
    `${totals.files} file(s)`,
    `${totals.projectExecutions} project execution(s)`,
    `${totals.declaredCells} declared cell(s) across ${totals.filesWithDeclaredCells} of ${totals.files} file(s)`,
    `${totals.executedCells} executed cell(s) from those files`,
  ].join(", ");
}

function formatFiles(files, current) {
  return files.map((file) => {
    const cells = current.declaredCells.get(file);
    const projects = current.projectsByFile.get(file) ?? [];
    return `    ${file}${cells ? ` — ${cells.cells} declared cell(s)` : " — no declared-cell map"}${projects.length > 1 ? `, in ${projects.length} projects` : ""}`;
  });
}

function reportProviders(current, lines) {
  lines.push("## Provider projects (registered by `vitest.workspace.ts`)", "");
  for (const project of current.projects) {
    if (!project.project.startsWith("provider-")) continue;
    lines.push(
      `- \`${project.project}\` (${project.source}): ${project.files.length} file(s), ${project.declaredCells} declared cell(s)${project.credentialEnvironment ? `, needs ${project.credentialEnvironment}` : ", credential-free"}`,
      ...formatFiles(project.files, current)
    );
    if (project.registeredButAbsent.length > 0) {
      lines.push(
        `    ! registered but absent from the tree: ${project.registeredButAbsent.join(", ")}`
      );
    }
  }
  lines.push("");
}

function reportCredentialFree(current, lines) {
  const plan = gatePlan(current);
  lines.push("## Credential-free file stages the gate runs", "");
  for (const stage of plan) {
    if (stage.kind !== "files" || stage.credentialEnvironment) continue;
    lines.push(
      `- \`${stage.name}\`: ${describeTotals(stage.totals)}`,
      ...formatFiles(stage.files, current)
    );
  }
  lines.push("");
}

function reportPlan(current, lines) {
  const plan = gatePlan(current);
  lines.push("## Gate plan", "");
  for (const stage of plan) {
    const totals = stage.totals ? ` — ${describeTotals(stage.totals)}` : "";
    lines.push(`- \`${stage.name}\` (${stage.kind})${totals}`);
    lines.push(`    ${stage.command}`);
    if (stage.owner) lines.push(`    file list owned by ${stage.owner}`);
    if (stage.note) lines.push(`    ${stage.note}`);
    if (stage.files) lines.push(...formatFiles(stage.files, current));
  }
  lines.push("");
  const coverage = stageCoverage(current, plan);
  lines.push(
    `## Stage coverage of the ${coverage.registered} registered file(s), by project`,
    "",
    `Of them ${coverage.covered} are covered by a stage whose file list this plan`,
    `holds and ${coverage.uncovered} by none. A \`runner-mode\` stage's files belong to`,
    "`scripts/run-raptor3.mjs`'s own mode table, which asserts its counts and is",
    "not restated here, so the files those modes run are counted as covered by no",
    "enumerated stage. A project with no covering stage is not a defect by itself —",
    "this gate is the closure gate, not the whole estate — but a file that JOINS a",
    "project the gate does run and no stage's list is exactly the omission this",
    "plan exists to show.",
    ""
  );
  for (const project of coverage.projects) {
    const covered = project.stages
      .map((entry) => `${entry.stage} ${entry.files}`)
      .join(", ");
    lines.push(
      `- \`${project.project}\`: ${project.files} file(s); covered by ${covered === "" ? "none" : covered}; covered by no enumerated stage: ${project.uncovered}`
    );
  }
  lines.push("");
  if (current.unregistered.length > 0) {
    lines.push(
      `## ${current.unregistered.length} test file(s) in the tree that NO workspace project registers`,
      "",
      ...current.unregistered.map((file) => `- ${file}`),
      ""
    );
  }
  if (coverage.unresolvedOwners.length > 0) {
    lines.push(
      "## Stage owners this reader could not resolve",
      "",
      ...coverage.unresolvedOwners.map(
        (entry) => `- ${entry.stage}: file list owned by ${entry.owner}`
      ),
      ""
    );
  }
  if (current.unresolvedSpreads.length > 0) {
    lines.push(
      "## Include spreads this reader could not resolve",
      "",
      ...current.unresolvedSpreads.map(
        (entry) => `- ${entry.project}: ...${entry.spread}`
      ),
      ""
    );
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const command = process.argv[2] ?? "plan";
  if (!COMMANDS.has(command)) {
    process.stderr.write(
      `closure-final-inventory: unknown command "${command}"; expected one of ${[...COMMANDS].join(", ")}\n`
    );
    process.exit(2);
  }
  const current = await inventory();
  if (command === "json") {
    process.stdout.write(
      `${JSON.stringify(
        {
          projects: current.projects,
          stages: gatePlan(current),
          unregistered: current.unregistered,
          unresolvedSpreads: current.unresolvedSpreads,
        },
        null,
        2
      )}\n`
    );
  } else {
    const lines = [];
    if (command === "providers") reportProviders(current, lines);
    if (command === "credential-free") reportCredentialFree(current, lines);
    if (command === "plan") reportPlan(current, lines);
    process.stdout.write(`${lines.join("\n")}\n`);
  }
}
