// Runner self-test: a probe may hold more than the ordinary 1536 MiB
// process-group ceiling, up to the PGlite allowance of its own process.
// Like PGlite, it holds Wasm memory, outside the V8 heap.
export const meta = {
  id: "RUNNER-MEMORY",
  title: "A probe between 1536 and 2560 MiB runs to its result",
  plan: "phase-0/M0.1",
  needs: [],
  source: "scripts/probe-corpus.mjs",
};

const MIB = 1024 * 1024;
const TARGET_MIB = 1900;
const ORDINARY_CEILING_MIB = 1536;

export default async function probe() {
  const memory = new WebAssembly.Memory({
    initial: (TARGET_MIB * MIB) / 65_536,
  });
  new Uint8Array(memory.buffer).fill(1);
  // Long enough for several 250 ms samples of every enclosing monitor.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const rssMib = Math.round(process.memoryUsage().rss / MIB);
  return {
    status: rssMib > ORDINARY_CEILING_MIB ? "pass" : "fail",
    evidence: `held ${rssMib} MiB RSS`,
  };
}
