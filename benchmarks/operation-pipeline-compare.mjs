/**
 * Compare one explicit clean baseline worktree with one explicit clean
 * candidate worktree. Every measurement is a fresh child process and all
 * children run sequentially under the repository test-run lock.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { acquireTestRunLock } from "../scripts/test-run-lock.mjs";
import {
  CROSS_PROVIDER_BASELINE_COMMIT,
  EXTENSION_ARMS,
} from "./operation-pipeline-catalog.mjs";
import {
  gitCommonDirectory,
  PROTOCOL_PATHS,
  protocolIdentity,
} from "./operation-pipeline-protocol.mjs";
import {
  aggregateTarget,
  diagnosticMeasurementCounts,
  evaluateKeepGate,
  isPerOperationMetric,
  parseDeclaredBudgets,
  targetableFields,
  verifyCrossStageSemantics,
} from "./operation-pipeline-report.mjs";

const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const VALUE_ARGUMENTS = new Set([
  "baseline-dir",
  "baseline-commit",
  "baseline-source-commit",
  "candidate-dir",
  "candidate-commit",
  "baseline-arm",
  "candidate-arm",
  "providers",
  "workloads",
  "stages",
  "modes",
  "output",
  "iterations",
  "warmup",
]);
const COORDINATOR_REPOSITORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  ".."
);
const COORDINATOR_WORKER = join(
  COORDINATOR_REPOSITORY,
  "benchmarks/operation-pipeline-worker.mjs"
);
process.chdir(COORDINATOR_REPOSITORY);
const activeChildren = new Set();

function signalProcessGroup(child, signal) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") child.kill(signal);
  else process.kill(-child.pid, signal);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    for (const child of activeChildren) signalProcessGroup(child, "SIGTERM");
    setTimeout(() => {
      for (const child of activeChildren) signalProcessGroup(child, "SIGKILL");
    }, 1000);
  });
}

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(`Usage:
  node benchmarks/operation-pipeline-compare.mjs \\
    --baseline-dir /absolute/clean/worktree \\
	    --baseline-commit <full-sha> [--baseline-source-commit <full-sha>] \\
	    --candidate-dir /absolute/clean/worktree \\
	    --candidate-commit <full-sha> \\
	    [--baseline-arm unextended] [--candidate-arm request] \\
	    [--providers name,name] [--workloads name,name] [--stages name,name] \\
	    [--modes alloc,cpu,retained] [--output /absolute/report.json] \\
	    [--target provider/workload/stage/mode/metric]... \\
	    [--ceiling provider/workload/stage/mode/metric/max-percent]... \\
	    [--budget provider/workload/stage/mode/metric/absolute/max]... \\
	    [--budget provider/workload/stage/mode/metric/percent/max]... \\
	    [--row-scaling provider/one-row-workload/many-row-workload/stage/mode/metric]...

Normal comparisons always use five alternating replicates. Use --smoke only
for a short infrastructure check; smoke output is explicitly invalid for a
performance keep decision. Use --diagnostic with an explicit --workloads
subset for two reduced-count alternating pairs; its output is also never
keep-eligible.
`);
  process.exit(message ? 2 : 0);
}

function parseArguments(argv) {
  const values = {};
  let index = 0;
  while (index < argv.length) {
    const argument = argv[index];
    if (argument === "--help") usage();
    if (argument === "--smoke") {
      values.smoke = true;
      index += 1;
      continue;
    }
    if (argument === "--diagnostic") {
      values.diagnostic = true;
      index += 1;
      continue;
    }
    if (
      argument === "--target" ||
      argument === "--ceiling" ||
      argument === "--budget" ||
      argument === "--row-scaling"
    ) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) {
        usage(`${argument} needs a value`);
      }
      const collection =
        argument === "--target"
          ? "targets"
          : argument === "--ceiling"
            ? "ceilings"
            : argument === "--budget"
              ? "budgets"
              : "rowScalings";
      values[collection] ??= [];
      values[collection].push(value);
      index += 1;
      continue;
    }
    if (!argument.startsWith("--")) usage(`Unexpected argument: ${argument}`);
    const key = argument.slice(2);
    if (!VALUE_ARGUMENTS.has(key)) usage(`Unknown argument: ${argument}`);
    if (Object.hasOwn(values, key)) usage(`Duplicate argument: ${argument}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) usage(`${argument} needs a value`);
    values[key] = value;
    index += 1;
  }
  return values;
}

function git(directory, arguments_) {
  return execFileSync("git", arguments_, {
    cwd: directory,
    encoding: "utf8",
  }).trim();
}

function validateCheckout(
  label,
  directoryArgument,
  expectedCommit,
  extensionArm,
  sourceCommit = expectedCommit
) {
  if (!(directoryArgument && expectedCommit)) {
    usage(`${label} requires both an explicit directory and full commit SHA`);
  }
  if (!isAbsolute(directoryArgument)) {
    usage(`${label} directory must be absolute: ${directoryArgument}`);
  }
  const directory = resolve(directoryArgument);
  const commit = git(directory, ["rev-parse", "HEAD"]);
  if (!FULL_COMMIT_PATTERN.test(expectedCommit)) {
    usage(`${label} commit must be a full 40-character SHA`);
  }
  if (commit !== expectedCommit) {
    throw new Error(`${label} HEAD is ${commit}, expected ${expectedCommit}`);
  }
  if (!FULL_COMMIT_PATTERN.test(sourceCommit)) {
    usage(`${label} source commit must be a full 40-character SHA`);
  }
  if (sourceCommit !== commit) {
    const parent = git(directory, ["rev-parse", `${commit}^`]);
    if (parent !== sourceCommit) {
      throw new Error(
        `${label} protocol overlay must be one direct commit above source ${sourceCommit}`
      );
    }
    const protocolPaths = new Set(PROTOCOL_PATHS);
    const changedPaths = git(directory, [
      "diff",
      "--name-only",
      sourceCommit,
      commit,
    ])
      .split("\n")
      .filter(Boolean);
    const implementationChanges = changedPaths.filter(
      (path) => !protocolPaths.has(path)
    );
    if (implementationChanges.length > 0) {
      throw new Error(
        `${label} protocol overlay changes implementation files:\n${implementationChanges.join("\n")}`
      );
    }
  }
  const dirty = git(directory, ["status", "--porcelain"]);
  if (dirty) throw new Error(`${label} worktree is dirty:\n${dirty}`);
  const worker = join(directory, "benchmarks/operation-pipeline-worker.mjs");
  if (!existsSync(worker))
    throw new Error(`${label} has no Phase 0 benchmark worker`);
  return {
    label,
    directory,
    commit,
    sourceCommit,
    worker,
    extensionArm,
  };
}

function buildCheckout(checkout) {
  rmSync(join(checkout.directory, "dist"), { recursive: true, force: true });
  try {
    execFileSync("pnpm", ["package:build"], {
      cwd: checkout.directory,
      encoding: "utf8",
      timeout: 300_000,
      env: {
        ...process.env,
        NODE_OPTIONS: "--max-old-space-size=2048",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr =
      error instanceof Error && "stderr" in error ? error.stderr : "";
    throw new Error(`${checkout.label} package build failed:\n${stderr}`);
  }
  const commit = git(checkout.directory, ["rev-parse", "HEAD"]);
  const dirty = git(checkout.directory, ["status", "--porcelain"]);
  if (commit !== checkout.commit || dirty) {
    throw new Error(
      `${checkout.label} changed during package build${dirty ? `:\n${dirty}` : ""}`
    );
  }
  if (!existsSync(join(checkout.directory, "dist/index.mjs"))) {
    throw new Error(
      `${checkout.label} package build produced no dist/index.mjs`
    );
  }
}

function splitFilter(value) {
  if (!value) return undefined;
  const selected = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (selected.length === 0) usage("A filter cannot be empty");
  return new Set(selected);
}

function optionalPositiveInteger(name, value) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    usage(`--${name} must be a positive safe integer`);
  }
  return parsed;
}

function parseDeclaredTargets(values, workloads) {
  const targets = values.map((value) => {
    const parts = value.split("/");
    const [provider, workload, stage, mode, metric, ...extra] =
      parts.length === 4 ? ["sqlite3", ...parts] : parts;
    if (!(workload && stage && mode && metric) || extra.length > 0) {
      usage(
        `Invalid --target ${value}; expected provider/workload/stage/mode/metric`
      );
    }
    const definition = workloads[workload];
    if (!definition) throw new Error(`Unknown target workload: ${workload}`);
    if (!definition.stages.includes(stage)) {
      throw new Error(`Target stage ${stage} is not defined for ${workload}`);
    }
    if (!definition.stageKinds[stage]) {
      throw new Error(`Target stage ${stage} has no execution kind`);
    }
    if (!(definition.providers ?? ["sqlite3"]).includes(provider)) {
      throw new Error(`${workload} is not defined for provider ${provider}`);
    }
    const fields = targetableFields(mode);
    if (!fields.includes(metric)) {
      throw new Error(
        `Target metric ${metric} is not measured in ${mode} mode`
      );
    }
    return { provider, workload, stage, mode, metric };
  });
  const keys = targets.map((target) => JSON.stringify(target));
  if (new Set(keys).size !== keys.length) {
    throw new Error("Duplicate --target metric contract");
  }
  return targets;
}

function parseDeclaredCeilings(values, workloads) {
  const ceilings = values.map((value) => {
    const parts = value.split("/");
    const [provider, workload, stage, mode, metric, rawMaximum, ...extra] =
      parts.length === 5 ? ["sqlite3", ...parts] : parts;
    const maximumPercent = Number(rawMaximum);
    if (
      !(workload && stage && mode && metric) ||
      extra.length > 0 ||
      !Number.isFinite(maximumPercent) ||
      maximumPercent < 0
    ) {
      usage(
        `Invalid --ceiling ${value}; expected provider/workload/stage/mode/metric/non-negative-percent`
      );
    }
    const definition = workloads[workload];
    if (!definition) throw new Error(`Unknown ceiling workload: ${workload}`);
    if (!definition.stages.includes(stage)) {
      throw new Error(`Ceiling stage ${stage} is not defined for ${workload}`);
    }
    if (!(definition.providers ?? ["sqlite3"]).includes(provider)) {
      throw new Error(`${workload} is not defined for provider ${provider}`);
    }
    if (!targetableFields(mode).includes(metric)) {
      throw new Error(
        `Ceiling metric ${metric} is not measured in ${mode} mode`
      );
    }
    return { provider, workload, stage, mode, metric, maximumPercent };
  });
  const keys = ceilings.map(({ maximumPercent: _, ...ceiling }) =>
    JSON.stringify(ceiling)
  );
  if (new Set(keys).size !== keys.length) {
    throw new Error("Duplicate --ceiling metric contract");
  }
  return ceilings;
}

function parseRowScalings(values, workloads) {
  const scalings = values.map((value) => {
    const parts = value.split("/");
    const [
      provider,
      oneRowWorkload,
      manyRowWorkload,
      stage,
      mode,
      metric,
      ...extra
    ] = parts.length === 5 ? ["sqlite3", ...parts] : parts;
    if (
      !(oneRowWorkload && manyRowWorkload && stage && mode && metric) ||
      extra.length > 0
    ) {
      usage(
        `Invalid --row-scaling ${value}; expected provider/one-row-workload/many-row-workload/stage/mode/metric`
      );
    }
    const oneDefinition = workloads[oneRowWorkload];
    const manyDefinition = workloads[manyRowWorkload];
    if (!(oneDefinition && manyDefinition)) {
      throw new Error(`Unknown row-scaling workload in ${value}`);
    }
    if (
      oneDefinition.rowsPerOperation !== 1 ||
      manyDefinition.rowsPerOperation <= 1
    ) {
      throw new Error(
        `Row scaling requires one 1-row workload and one many-row workload: ${value}`
      );
    }
    for (const [name, definition] of [
      [oneRowWorkload, oneDefinition],
      [manyRowWorkload, manyDefinition],
    ]) {
      if (!definition.stages.includes(stage)) {
        throw new Error(
          `Row-scaling stage ${stage} is not defined for ${name}`
        );
      }
      if (!(definition.providers ?? ["sqlite3"]).includes(provider)) {
        throw new Error(`${name} is not defined for provider ${provider}`);
      }
    }
    if (!isPerOperationMetric(mode, metric)) {
      throw new Error(
        `Row-scaling metric ${metric} is not a per-operation metric measured in ${mode} mode`
      );
    }
    return {
      provider,
      oneRowWorkload,
      manyRowWorkload,
      stage,
      mode,
      metric,
    };
  });
  const keys = scalings.map((scaling) => JSON.stringify(scaling));
  if (new Set(keys).size !== keys.length) {
    throw new Error("Duplicate --row-scaling contract");
  }
  return scalings;
}

function runChild(
  checkout,
  arguments_,
  environment,
  timeoutMilliseconds,
  executable = process.execPath
) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: checkout.directory,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        ...environment,
        NODE_OPTIONS: `${(process.env.NODE_OPTIONS ?? "")
          .replace(/--max-old-space-size(?:=|\s+)\d+/g, "")
          .trim()} --max-old-space-size=2048`.trim(),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChildren.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    let forceKill;
    const timeout = setTimeout(() => {
      signalProcessGroup(child, "SIGTERM");
      forceKill = setTimeout(() => signalProcessGroup(child, "SIGKILL"), 1000);
      reject(
        new Error(`${checkout.label} worker exceeded its safe time limit`)
      );
    }, timeoutMilliseconds);
    child.once("error", (error) => {
      clearTimeout(timeout);
      clearTimeout(forceKill);
      activeChildren.delete(child);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(forceKill);
      activeChildren.delete(child);
      if (code !== 0) {
        reject(
          new Error(
            `${checkout.label} worker failed (${code ?? signal}):\n${stderr || stdout}`
          )
        );
        return;
      }
      resolvePromise(stdout.trim());
    });
  });
}

function bunIsAvailable() {
  try {
    execFileSync("bun", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function describeCheckout(checkout) {
  const output = await runChild(
    checkout,
    [checkout.worker, "--describe"],
    {},
    30_000
  );
  return JSON.parse(output);
}

function comparableEnvironment(metadata) {
  return {
    clean: metadata.clean,
    lockSha256: metadata.lockSha256,
    runtime: metadata.runtime,
  };
}

function verifyTargetEvidence(
  target,
  targetSamples,
  replicates,
  definition,
  samplingInterval,
  expectedIterations,
  expectedWarmup,
  expectedProtocolHash
) {
  const first = targetSamples[0]?.output;
  if (!first) throw new Error(`No evidence exists for ${target.workload}`);
  const expectedEnvironment = JSON.stringify(
    comparableEnvironment(first.metadata)
  );
  const expectedWitness = JSON.stringify(first.witness);
  const expectedProtocol = {
    ...(first.provider === undefined ? {} : { provider: target.provider }),
    workload: target.workload,
    stage: target.stage,
    mode: target.mode,
    stageKind: definition.stageKinds[target.stage],
    rowsPerOperation: definition.rowsPerOperation,
    iterations: expectedIterations,
    warmupIterations: expectedWarmup,
    allocationSamplingInterval: samplingInterval,
  };
  for (let replicate = 0; replicate < replicates; replicate++) {
    const pair = targetSamples.filter(
      (sample) => sample.replicate === replicate
    );
    if (pair.length !== 2) {
      throw new Error(
        `${target.workload}/${target.stage}/${target.mode} replicate ${replicate + 1} is incomplete`
      );
    }
  }
  for (const sample of targetSamples) {
    const expectedCheckout =
      sample.checkout === "baseline" ? baseline : candidate;
    if (
      sample.output.metadata.commit !== expectedCheckout.commit ||
      sample.output.metadata.clean !== true
    ) {
      throw new Error(
        `${target.workload}/${target.stage}/${target.mode} reported the wrong commit or a dirty checkout`
      );
    }
    if (sample.output.extensionArm !== expectedCheckout.extensionArm) {
      throw new Error(
        `${target.workload}/${target.stage}/${target.mode} reported the wrong extension arm`
      );
    }
    if (typeof sample.output.semanticDigest !== "string") {
      throw new Error(
        `${target.workload}/${target.stage}/${target.mode} omitted its semantic digest`
      );
    }
    if (sample.output.protocol?.sha256 !== expectedProtocolHash) {
      throw new Error(
        `${target.workload}/${target.stage}/${target.mode} ran with a different comparison protocol`
      );
    }
    for (const [field, expected] of Object.entries(expectedProtocol)) {
      if (sample.output[field] !== expected) {
        throw new Error(
          `${target.workload}/${target.stage}/${target.mode} changed protocol field ${field}`
        );
      }
    }
    if (JSON.stringify(sample.output.witness) !== expectedWitness) {
      throw new Error(
        `${target.workload}/${target.stage}/${target.mode} changed SQL, parameters, or statement count`
      );
    }
    if (
      JSON.stringify(comparableEnvironment(sample.output.metadata)) !==
      expectedEnvironment
    ) {
      throw new Error(
        `${target.workload}/${target.stage}/${target.mode} ran in mismatched environments`
      );
    }
  }
}

const arguments_ = parseArguments(process.argv.slice(2));
const workloadFilter = splitFilter(arguments_.workloads);
const diagnosticOnly = arguments_.diagnostic === true;
if (diagnosticOnly && arguments_.smoke === true) {
  usage("--diagnostic and --smoke cannot be combined");
}
if (diagnosticOnly && workloadFilter === undefined) {
  usage("--diagnostic requires an explicit --workloads subset");
}
const providerFilter = splitFilter(arguments_.providers);
const isCrossProviderRun =
  workloadFilter !== undefined &&
  [...workloadFilter].some((workload) => workload.startsWith("provider-"));
const iterationOverride = optionalPositiveInteger(
  "iterations",
  arguments_.iterations
);
const warmupOverride = optionalPositiveInteger("warmup", arguments_.warmup);
const baselineArm = arguments_["baseline-arm"] ?? "unextended";
const candidateArm = arguments_["candidate-arm"] ?? "unextended";
for (const arm of [baselineArm, candidateArm]) {
  if (!EXTENSION_ARMS.includes(arm)) {
    usage(`Unknown extension benchmark arm: ${arm}`);
  }
}
const baseline = validateCheckout(
  "baseline",
  arguments_["baseline-dir"],
  arguments_["baseline-commit"],
  baselineArm,
  arguments_["baseline-source-commit"]
);
if (isCrossProviderRun && baseline.commit !== CROSS_PROVIDER_BASELINE_COMMIT) {
  throw new Error(
    `The cross-provider suite requires baseline ${CROSS_PROVIDER_BASELINE_COMMIT}; received ${baseline.commit}`
  );
}
const candidate = validateCheckout(
  "candidate",
  arguments_["candidate-dir"],
  arguments_["candidate-commit"],
  candidateArm
);
if (baseline.directory === candidate.directory) {
  throw new Error("Baseline and candidate must be separate clean worktrees");
}
if (
  baseline.commit === candidate.commit &&
  baseline.extensionArm === candidate.extensionArm
) {
  throw new Error(
    "Baseline and candidate must differ by commit, extension arm, or both"
  );
}
if (
  isCrossProviderRun &&
  (baseline.extensionArm !== "unextended" ||
    candidate.extensionArm !== "unextended")
) {
  throw new Error("Cross-provider workloads do not accept extension arms");
}
const coordinatorCommonDirectory = gitCommonDirectory(COORDINATOR_REPOSITORY);
const baselineCommonDirectory = gitCommonDirectory(baseline.directory);
const candidateCommonDirectory = gitCommonDirectory(candidate.directory);
if (
  coordinatorCommonDirectory !== baselineCommonDirectory ||
  coordinatorCommonDirectory !== candidateCommonDirectory
) {
  throw new Error(
    "Coordinator, baseline, and candidate must be linked worktrees of the same Git common directory"
  );
}
const coordinatorCommit = git(COORDINATOR_REPOSITORY, ["rev-parse", "HEAD"]);
if (
  isCrossProviderRun &&
  git(COORDINATOR_REPOSITORY, ["status", "--porcelain"])
) {
  throw new Error(
    "The cross-provider measurement protocol must run from a clean coordinator worktree"
  );
}

const releaseLock = acquireTestRunLock(
  "operation-pipeline benchmark comparison"
);
try {
  process.stderr.write("Building baseline checkout...\n");
  buildCheckout(baseline);
  process.stderr.write("Building candidate checkout...\n");
  buildCheckout(candidate);
  const baselineDescription = isCrossProviderRun
    ? JSON.parse(
        await runChild(baseline, [COORDINATOR_WORKER, "--describe"], {}, 30_000)
      )
    : await describeCheckout(baseline);
  const candidateDescription = isCrossProviderRun
    ? baselineDescription
    : await describeCheckout(candidate);
  const coordinatorProtocol = protocolIdentity(COORDINATOR_REPOSITORY);
  if (
    baselineDescription.protocol.sha256 !==
      candidateDescription.protocol.sha256 ||
    baselineDescription.protocol.sha256 !== coordinatorProtocol.sha256
  ) {
    throw new Error(
      `Coordinator, baseline, and candidate protocol hashes differ (${coordinatorProtocol.sha256}, ${baselineDescription.protocol.sha256}, ${candidateDescription.protocol.sha256})`
    );
  }
  if (
    JSON.stringify(baselineDescription) !== JSON.stringify(candidateDescription)
  ) {
    throw new Error("Baseline and candidate benchmark catalogs differ");
  }
  const baselineLock = readFileSync(join(baseline.directory, "pnpm-lock.yaml"));
  const candidateLock = readFileSync(
    join(candidate.directory, "pnpm-lock.yaml")
  );
  if (!baselineLock.equals(candidateLock)) {
    throw new Error("Baseline and candidate pnpm lockfiles differ");
  }

  const stageFilter = splitFilter(
    arguments_.stages ?? (diagnosticOnly ? "full" : undefined)
  );
  const modeFilter = splitFilter(
    arguments_.modes ?? (diagnosticOnly ? "alloc,cpu" : undefined)
  );
  const modes = baselineDescription.modes.filter(
    (mode) => !modeFilter || modeFilter.has(mode)
  );
  if (modeFilter && modes.length !== modeFilter.size) {
    throw new Error("The mode filter contains an unknown mode");
  }
  if (providerFilter) {
    const knownProviders = new Set(
      Object.keys(baselineDescription.providers ?? { sqlite3: {} })
    );
    const unknownProviders = [...providerFilter].filter(
      (provider) => !knownProviders.has(provider)
    );
    if (unknownProviders.length > 0) {
      throw new Error(`Unknown providers: ${unknownProviders.join(", ")}`);
    }
  }
  if (stageFilter) {
    const knownStages = new Set(
      Object.values(baselineDescription.workloads).flatMap(
        (definition) => definition.stages
      )
    );
    const unknownStages = [...stageFilter].filter(
      (selectedStage) => !knownStages.has(selectedStage)
    );
    if (unknownStages.length > 0) {
      throw new Error(`Unknown stages: ${unknownStages.join(", ")}`);
    }
  }

  const targets = [];
  for (const [workload, definition] of Object.entries(
    baselineDescription.workloads
  )) {
    if (workloadFilter && !workloadFilter.has(workload)) continue;
    for (const provider of definition.providers ?? ["sqlite3"]) {
      if (providerFilter && !providerFilter.has(provider)) continue;
      for (const stage of definition.stages) {
        if (stageFilter && !stageFilter.has(stage)) continue;
        for (const mode of modes) {
          targets.push({ provider, workload, stage, mode });
        }
      }
    }
  }
  if (workloadFilter) {
    const known = new Set(Object.keys(baselineDescription.workloads));
    const unknown = [...workloadFilter].filter((name) => !known.has(name));
    if (unknown.length > 0)
      throw new Error(`Unknown workloads: ${unknown.join(", ")}`);
    const unmatched = [...workloadFilter].filter(
      (name) => !targets.some((target) => target.workload === name)
    );
    if (unmatched.length > 0) {
      throw new Error(
        `Selected stages do not apply to workloads: ${unmatched.join(", ")}`
      );
    }
  }
  if (targets.length === 0)
    throw new Error("No benchmark targets matched the filters");
  const declaredTargets = parseDeclaredTargets(
    arguments_.targets ?? [],
    baselineDescription.workloads
  );
  const declaredCeilings = parseDeclaredCeilings(
    arguments_.ceilings ?? [],
    baselineDescription.workloads
  );
  const declaredBudgets = parseDeclaredBudgets(
    arguments_.budgets ?? [],
    baselineDescription.workloads
  );
  const rowScalings = parseRowScalings(
    arguments_.rowScalings ?? [],
    baselineDescription.workloads
  );
  for (const declared of [
    ...declaredTargets,
    ...declaredCeilings,
    ...declaredBudgets,
  ]) {
    if (
      !targets.some(
        (target) =>
          target.workload === declared.workload &&
          target.provider === declared.provider &&
          target.stage === declared.stage &&
          target.mode === declared.mode
      )
    ) {
      throw new Error(
        `Declared target ${declared.provider}/${declared.workload}/${declared.stage}/${declared.mode}/${declared.metric} is excluded by the provider, workload, stage, or mode filters`
      );
    }
  }
  for (const scaling of rowScalings) {
    for (const workload of [scaling.oneRowWorkload, scaling.manyRowWorkload]) {
      if (
        !targets.some(
          (target) =>
            target.provider === scaling.provider &&
            target.workload === workload &&
            target.stage === scaling.stage &&
            target.mode === scaling.mode
        )
      ) {
        throw new Error(
          `Row-scaling evidence ${scaling.provider}/${workload}/${scaling.stage}/${scaling.mode}/${scaling.metric} is excluded by the filters`
        );
      }
    }
  }

  const smoke = arguments_.smoke === true;
  const replicates = smoke ? 1 : diagnosticOnly ? 2 : 5;
  const samples = [];
  for (const target of targets) {
    const diagnosticCounts = diagnosticOnly
      ? diagnosticMeasurementCounts(
          baselineDescription.workloads[target.workload].rowsPerOperation,
          target.mode
        )
      : undefined;
    for (let replicate = 0; replicate < replicates; replicate++) {
      const order =
        replicate % 2 === 0 ? [baseline, candidate] : [candidate, baseline];
      for (const checkout of order) {
        process.stderr.write(
          `${target.provider}/${target.workload}/${target.stage}/${target.mode} replicate ${
            replicate + 1
          }/${replicates}: ${checkout.label}\n`
        );
        const requiresBun =
          baselineDescription.providers?.[target.provider]?.runtime === "bun";
        const useBun = requiresBun && bunIsAvailable();
        const worker = isCrossProviderRun
          ? COORDINATOR_WORKER
          : checkout.worker;
        const output = await runChild(
          checkout,
          useBun ? [worker] : ["--expose-gc", worker],
          {
            VIBORM_BENCH_PROVIDER: target.provider,
            VIBORM_BENCH_WORKLOAD: target.workload,
            VIBORM_BENCH_STAGE: target.stage,
            VIBORM_BENCH_MODE: target.mode,
            VIBORM_BENCH_EXPECTED_COMMIT: checkout.commit,
            VIBORM_BENCH_TARGET_DIRECTORY: checkout.directory,
            VIBORM_BENCH_EXTENSION_ARM: checkout.extensionArm,
            VIBORM_BENCH_SMOKE: smoke ? "1" : "0",
            ...(arguments_.iterations || diagnosticCounts
              ? {
                  VIBORM_BENCH_ITERATIONS:
                    arguments_.iterations ??
                    String(diagnosticCounts.iterations),
                }
              : {}),
            ...(arguments_.warmup || diagnosticCounts
              ? {
                  VIBORM_BENCH_WARMUP_ITERATIONS:
                    arguments_.warmup ??
                    String(diagnosticCounts.warmupIterations),
                }
              : {}),
          },
          smoke ? 120_000 : 600_000,
          useBun ? "bun" : process.execPath
        );
        samples.push({
          ...target,
          replicate,
          checkout: checkout.label,
          output: JSON.parse(output),
        });
      }
    }
  }

  const comparisons = targets.map((target) => {
    const targetSamples = samples.filter(
      (sample) =>
        sample.provider === target.provider &&
        sample.workload === target.workload &&
        sample.stage === target.stage &&
        sample.mode === target.mode
    );
    const definition = baselineDescription.workloads[target.workload];
    const statuses = new Set(
      targetSamples.map((sample) => sample.output.status ?? "measured")
    );
    if (statuses.has("skipped")) {
      if (statuses.size !== 1) {
        throw new Error(
          `${target.provider}/${target.workload}/${target.stage}/${target.mode} mixed measured and skipped samples`
        );
      }
      const reasons = new Set(
        targetSamples.map((sample) => sample.output.reason)
      );
      if (reasons.size !== 1 || reasons.has(undefined)) {
        throw new Error(
          `${target.provider}/${target.workload}/${target.stage}/${target.mode} changed its skip reason across replicates`
        );
      }
      return {
        ...target,
        status: "skipped",
        reason: [...reasons][0],
        workloadShape: definition.providerShape,
      };
    }
    const scaleDivisor = Math.max(1, definition.rowsPerOperation / 20);
    const defaultIterations = smoke
      ? 2
      : target.mode === "retained"
        ? Math.max(20, Math.floor(500 / scaleDivisor))
        : Math.max(50, Math.floor(5000 / scaleDivisor));
    const diagnosticCounts = diagnosticOnly
      ? diagnosticMeasurementCounts(definition.rowsPerOperation, target.mode)
      : undefined;
    const expectedIterations =
      iterationOverride ?? diagnosticCounts?.iterations ?? defaultIterations;
    const expectedWarmup =
      warmupOverride ??
      diagnosticCounts?.warmupIterations ??
      (smoke ? 1 : Math.max(10, Math.ceil(expectedIterations / 5)));
    verifyTargetEvidence(
      target,
      targetSamples,
      replicates,
      definition,
      baselineDescription.allocationSamplingInterval,
      expectedIterations,
      expectedWarmup,
      baselineDescription.protocol.sha256
    );
    return aggregateTarget(target, targetSamples);
  });
  const measuredComparisons = comparisons.filter(
    (comparison) => comparison.status !== "skipped"
  );
  const skippedComparisons = comparisons.filter(
    (comparison) => comparison.status === "skipped"
  );
  const measuredSamples = samples.filter(
    (sample) => (sample.output.status ?? "measured") === "measured"
  );
  verifyCrossStageSemantics(measuredSamples);
  const baselineEnvironment = comparableEnvironment(
    samples.find((sample) => sample.checkout === "baseline").output.metadata
  );
  const candidateEnvironment = comparableEnvironment(
    samples.find((sample) => sample.checkout === "candidate").output.metadata
  );
  const baselineBranch = samples.find(
    (sample) => sample.checkout === "baseline"
  ).output.metadata.branch;
  const candidateBranch = samples.find(
    (sample) => sample.checkout === "candidate"
  ).output.metadata.branch;
  const keepGate = evaluateKeepGate({
    smoke,
    diagnosticOnly,
    hasOverrides:
      iterationOverride !== undefined || warmupOverride !== undefined,
    targets,
    declaredTargets,
    declaredCeilings,
    declaredBudgets,
    rowScalings,
    comparisons: measuredComparisons,
    skippedComparisons,
    workloads: baselineDescription.workloads,
  });
  const report = {
    measurementProtocolValid: !(smoke || diagnosticOnly),
    diagnosticOnly,
    providerCoverageComplete: skippedComparisons.length === 0,
    keepGate,
    generatedAt: new Date().toISOString(),
    protocol: {
      replicates,
      alternatingOrder: true,
      freshProcessPerMeasurement: true,
      sequential: true,
      allocationAndCpuSeparated: true,
      retainedHeapInFreshProcess: true,
      releasedHeapAfterForcedCollection: true,
      peakRssIsProcessLifetimeHighWaterMark: true,
      allocationSamplingInterval:
        baselineDescription.allocationSamplingInterval,
      protocolIdentity: baselineDescription.protocol,
      protocolOwnerCommit: coordinatorCommit,
      declaredTargets,
      declaredCeilings,
      declaredBudgets,
      rowScalings,
      providers: baselineDescription.providers ?? { sqlite3: {} },
      workloads: baselineDescription.workloads,
    },
    baseline: {
      directory: baseline.directory,
      commit: baseline.commit,
      sourceCommit: baseline.sourceCommit,
      extensionArm: baseline.extensionArm,
      branch: baselineBranch,
      environment: baselineEnvironment,
    },
    candidate: {
      directory: candidate.directory,
      commit: candidate.commit,
      sourceCommit: candidate.sourceCommit,
      extensionArm: candidate.extensionArm,
      branch: candidateBranch,
      environment: candidateEnvironment,
    },
    comparisons,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (arguments_.output) {
    if (!isAbsolute(arguments_.output)) {
      throw new Error("--output must be an absolute path");
    }
    writeFileSync(arguments_.output, serialized);
  } else {
    process.stdout.write(serialized);
  }
} finally {
  releaseLock();
}
