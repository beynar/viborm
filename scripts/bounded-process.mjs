import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

export const DEFAULT_PROCESS_GROUP_RSS_LIMIT_MB = 1536;

/**
 * A ceiling is an object, never a number, and only the frozen instances
 * exported from this module are accepted. Identity IS the allowlist: an
 * arbitrary caller cannot reach a raised ceiling by typing a number, by
 * spelling a flag, by setting an environment variable, or by handing in a
 * look-alike `{ limitMb: 1792 }`. It has to import the named export, so every
 * raise in the repository is one grep away.
 */
export const ORDINARY_PROCESS_GROUP_RSS_CEILING = Object.freeze({
  limitMb: DEFAULT_PROCESS_GROUP_RSS_LIMIT_MB,
  name: "ordinary project",
});

/**
 * The one allowlisted exception, and it is narrow on purpose.
 *
 * A single live PGlite instance floors at 1294 MiB of process-group RSS and one
 * isolated provider file was measured peaking at 1747 MiB, so isolated live
 * PGlite work cannot fit under the ordinary 1536 MiB ceiling however carefully
 * it is written. 1792 MiB clears the measured maximum without leaving room for
 * a second database: the allowance is sized for ONE instance, so a stage that
 * accumulates several in one process is out of scope by construction, not by
 * convention.
 *
 * Nothing else may select it. Typechecks, coverage, package work, `pnpm test`,
 * SQLite, LibSQL, Bun, D1 and every benchmark stay on the ordinary ceiling.
 * The heap contract is untouched: this raises sampled process-group RSS only,
 * because PGlite's WebAssembly memory lives outside the V8 heap that the
 * 768 MiB Vitest heap limit bounds.
 */
export const ISOLATED_PGLITE_PROVIDER_RSS_CEILING = Object.freeze({
  limitMb: 1792,
  name: "isolated live-PGlite provider",
});

const ALLOWLISTED_RSS_CEILINGS = new Set([
  ORDINARY_PROCESS_GROUP_RSS_CEILING,
  ISOLATED_PGLITE_PROVIDER_RSS_CEILING,
]);

/**
 * Resolves the ceiling a bounded process runs under. An explicit `rssLimitMb`
 * may only ever LOWER the selected ceiling - the same one-way rule the
 * `--rss-limit-mb` launcher option obeys - and the selected ceiling itself must
 * be an allowlisted export.
 */
export function resolveProcessGroupRssCeiling({
  rssCeiling = ORDINARY_PROCESS_GROUP_RSS_CEILING,
  rssLimitMb,
} = {}) {
  if (!ALLOWLISTED_RSS_CEILINGS.has(rssCeiling)) {
    throw new Error(
      "rssCeiling must be one of the ceilings exported by bounded-process.mjs; an equivalent object literal is refused so the raised ceiling cannot be selected by an arbitrary caller."
    );
  }
  const limitMb = rssLimitMb ?? rssCeiling.limitMb;
  if (
    !Number.isSafeInteger(limitMb) ||
    limitMb <= 0 ||
    limitMb > rssCeiling.limitMb
  ) {
    throw new Error(
      `rssLimitMb must be a positive integer no greater than the ${rssCeiling.name} ceiling of ${rssCeiling.limitMb} MiB.`
    );
  }
  return Object.freeze({ limitMb, name: rssCeiling.name });
}

/**
 * The one line every bounded launcher prints when a stage ends. It reads the
 * applied ceiling out of the outcome rather than off a caller-side constant, so
 * a reader always sees the ceiling that was actually enforced - including when
 * that ceiling is the PGlite allowance rather than the ordinary one.
 */
export function formatBoundedResourceLine(label, outcome) {
  return `${label}: ${(outcome.wallMs / 1000).toFixed(2)}s wall, ${(outcome.peakGroupRssKb / 1024).toFixed(1)} MiB peak sampled process-group RSS (sampled ceiling ${outcome.rssCeiling.limitMb} MiB, ${outcome.rssCeiling.name}). ${outcome.error ? "Teardown not verified." : "Teardown verified."}`;
}

const RESOURCE_SAMPLE_INTERVAL_MS = 250;
const TERMINATION_GRACE_MS = 1000;
const TEARDOWN_VERIFICATION_MS = 2000;
const WHITESPACE_PATTERN = /\s+/;

export function parseProcessGroupRssKb(output, processGroupId) {
  let rssKb = 0;
  for (const line of output.split("\n")) {
    const [group, rss] = line.trim().split(WHITESPACE_PATTERN);
    if (Number(group) === processGroupId) rssKb += Number(rss) || 0;
  }
  return rssKb;
}

export function parseLiveProcessGroupMemberCount(output, processGroupId) {
  let members = 0;
  for (const line of output.split("\n")) {
    const [group, state = ""] = line.trim().split(WHITESPACE_PATTERN);
    if (Number(group) === processGroupId && !state.startsWith("Z")) {
      members += 1;
    }
  }
  return members;
}

export function assertBoundedProcessPlatform(platform = process.platform) {
  if (platform === "win32") {
    throw new Error(
      "Bounded verification is unavailable on Windows because process-tree RSS enforcement and teardown cannot be verified."
    );
  }
}

export function nodeOptionsWithHeapLimit(nodeOptions, heapLimitMb) {
  const existing = nodeOptions
    .replace(/--max-old-space-size(?:=|\s+)\d+/g, "")
    .trim();
  return [existing, `--max-old-space-size=${heapLimitMb}`]
    .filter(Boolean)
    .join(" ");
}

/**
 * The command-line and environment path is deliberately NOT ceiling-aware: it
 * is capped at the ordinary ceiling and may only lower it. Raised ceilings are
 * selected in code, by importing a named ceiling, precisely so that no caller
 * can type its way to one.
 */
export function parseRssLimitArgument(arguments_, environment = process.env) {
  const limitArguments = arguments_.filter((value) =>
    value.startsWith("--rss-limit-mb=")
  );
  if (limitArguments.length > 1) {
    throw new Error("--rss-limit-mb may be specified only once.");
  }
  const [argument] = limitArguments;
  const configured =
    argument?.slice("--rss-limit-mb=".length) ??
    environment.VIBORM_PROCESS_GROUP_RSS_MB ??
    String(DEFAULT_PROCESS_GROUP_RSS_LIMIT_MB);
  const rssLimitMb = Number(configured);
  if (
    !Number.isSafeInteger(rssLimitMb) ||
    rssLimitMb <= 0 ||
    rssLimitMb > DEFAULT_PROCESS_GROUP_RSS_LIMIT_MB
  ) {
    throw new Error(
      `--rss-limit-mb must be a positive integer no greater than ${DEFAULT_PROCESS_GROUP_RSS_LIMIT_MB}.`
    );
  }
  return {
    forwardedArguments: arguments_.filter(
      (value) => !value.startsWith("--rss-limit-mb=")
    ),
    rssLimitMb,
  };
}

export function parseHeapLimitArgument(arguments_, { defaultMb, maxMb }) {
  const limitArguments = arguments_.filter((value) =>
    value.startsWith("--heap-limit-mb=")
  );
  if (limitArguments.length > 1) {
    throw new Error("--heap-limit-mb may be specified only once.");
  }
  const [argument] = limitArguments;
  const heapLimitMb = Number(
    argument?.slice("--heap-limit-mb=".length) ?? defaultMb
  );
  if (
    !Number.isSafeInteger(heapLimitMb) ||
    heapLimitMb <= 0 ||
    heapLimitMb > maxMb
  ) {
    throw new Error(
      `--heap-limit-mb must be a positive integer no greater than ${maxMb}.`
    );
  }
  return {
    forwardedArguments: arguments_.filter(
      (value) => !value.startsWith("--heap-limit-mb=")
    ),
    heapLimitMb,
  };
}

export function vitestArgumentsWithSingleWorker(arguments_) {
  return [
    ...arguments_,
    "--maxWorkers=1",
    "--minWorkers=1",
    "--no-file-parallelism",
  ];
}

function processGroupRssKb(processGroupId) {
  if (process.platform === "win32") return 0;
  const sample = spawnSync("ps", ["-axo", "pgid=,rss="], {
    encoding: "utf8",
  });
  if (sample.status !== 0) {
    throw new Error("Cannot read process-group RSS with ps.");
  }
  return parseProcessGroupRssKb(sample.stdout, processGroupId);
}

function isProcessGroupAlive(processGroupId) {
  if (process.platform === "win32") return false;
  const sample = spawnSync("ps", ["-axo", "pgid=,stat="], {
    encoding: "utf8",
  });
  if (sample.status !== 0) {
    throw new Error("Cannot verify process-group teardown with ps.");
  }
  return parseLiveProcessGroupMemberCount(sample.stdout, processGroupId) > 0;
}

function signalProcessGroup(child, signal) {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      if (child.exitCode === null) child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return;
    }
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "EPERM" &&
      !isProcessGroupAlive(child.pid)
    ) {
      return;
    }
    throw error;
  }
}

async function waitForProcessGroupExit(processGroupId, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (isProcessGroupAlive(processGroupId)) {
    if (performance.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

async function verifyProcessGroupTeardown(child) {
  if (process.platform === "win32" || child.pid === undefined) return;
  if (await waitForProcessGroupExit(child.pid, 0)) return;
  signalProcessGroup(child, "SIGTERM");
  if (await waitForProcessGroupExit(child.pid, TERMINATION_GRACE_MS)) return;
  signalProcessGroup(child, "SIGKILL");
  if (await waitForProcessGroupExit(child.pid, TEARDOWN_VERIFICATION_MS))
    return;
  throw new Error(
    `Could not verify teardown of process group ${child.pid} after SIGKILL.`
  );
}

export function startBoundedProcess({
  command,
  arguments: commandArguments,
  env = process.env,
  heapLimitMb,
  label,
  rssCeiling = ORDINARY_PROCESS_GROUP_RSS_CEILING,
  rssLimitMb,
  stdio = "inherit",
  wallLimitMs,
}) {
  assertBoundedProcessPlatform();
  const appliedCeiling = resolveProcessGroupRssCeiling({
    rssCeiling,
    rssLimitMb,
  });
  const childEnvironment = { ...env };
  if (heapLimitMb !== undefined) {
    childEnvironment.NODE_OPTIONS = nodeOptionsWithHeapLimit(
      env.NODE_OPTIONS ?? "",
      heapLimitMb
    );
  }

  const child = spawn(command, commandArguments, {
    detached: process.platform !== "win32",
    env: childEnvironment,
    stdio,
  });
  const startedAt = performance.now();
  let peakGroupRssKb = 0;
  let stopReason;
  let forceKill;

  const terminate = (signal = "SIGTERM", reason = "interrupted") => {
    stopReason ??= reason;
    signalProcessGroup(child, signal);
    forceKill ??= setTimeout(
      () => signalProcessGroup(child, "SIGKILL"),
      TERMINATION_GRACE_MS
    );
  };

  const sample = () => {
    if (child.pid === undefined || child.exitCode !== null) return;
    try {
      const rssKb = processGroupRssKb(child.pid);
      peakGroupRssKb = Math.max(peakGroupRssKb, rssKb);
      if (rssKb > appliedCeiling.limitMb * 1024 && stopReason === undefined) {
        process.stderr.write(
          `${label} exceeded its ${appliedCeiling.limitMb} MiB sampled process-group RSS ceiling (${appliedCeiling.name}).\n`
        );
        terminate("SIGTERM", "rss");
      }
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`
      );
      terminate("SIGTERM", "sampling");
    }
  };

  sample();
  const resourceSampler = setInterval(sample, RESOURCE_SAMPLE_INTERVAL_MS);
  const wallLimit = setTimeout(() => {
    process.stderr.write(
      `${label} exceeded its ${(wallLimitMs / 1000).toFixed(0)} second wall limit.\n`
    );
    terminate("SIGTERM", "wall");
  }, wallLimitMs);

  const completion = new Promise((resolve) => {
    let spawnError;
    let finalized = false;
    const finalize = async (code, signal) => {
      if (finalized) return;
      finalized = true;
      clearInterval(resourceSampler);
      clearTimeout(wallLimit);
      if (forceKill) clearTimeout(forceKill);
      try {
        await verifyProcessGroupTeardown(child);
      } catch (error) {
        spawnError ??= error;
      }
      resolve({
        code: spawnError ? 1 : (code ?? (signal ? 1 : 0)),
        error: spawnError,
        peakGroupRssKb,
        rssCeiling: appliedCeiling,
        stopReason,
        wallMs: performance.now() - startedAt,
      });
    };
    child.once("error", async (error) => {
      spawnError = error;
      if (child.pid === undefined) await finalize(null, null);
    });
    // `close` waits for inherited stdio held by descendants. `exit` lets the
    // parent immediately verify and terminate the complete process group.
    child.once("exit", async (code, signal) => {
      await finalize(code, signal);
    });
  });

  return { completion, terminate };
}
