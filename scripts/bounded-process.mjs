import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

export const DEFAULT_PROCESS_GROUP_RSS_LIMIT_MB = 1536;
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
  rssLimitMb = DEFAULT_PROCESS_GROUP_RSS_LIMIT_MB,
  stdio = "inherit",
  wallLimitMs,
}) {
  assertBoundedProcessPlatform();
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
      if (rssKb > rssLimitMb * 1024 && stopReason === undefined) {
        process.stderr.write(
          `${label} exceeded its ${rssLimitMb} MiB sampled process-group RSS ceiling.\n`
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
