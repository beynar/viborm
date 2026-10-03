/**
 * Profile one VibORM workload and print the top source locations.
 *   node benchmarks/probe-profile.mjs --dir dist --workload rows20 \
 *     --mode fresh|warm|cold --kind cpu|heap [--count 2000] [--top 40]
 * cpu : self time by source-mapped function.
 * heap: sampled allocation bytes per op by allocating function.
 */
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadViborm, openSeededDatabase, origin } from "./probe.mjs";

const { values: o } = parseArgs({
  strict: false,
  options: {
    dir: { type: "string", default: "dist" },
    workload: { type: "string", default: "rows20" },
    mode: { type: "string", default: "fresh" },
    kind: { type: "string", default: "cpu" },
    count: { type: "string", default: "2000" },
    top: { type: "string", default: "40" },
    out: { type: "string" },
  },
});
const where = ({ url, functionName, lineNumber, columnNumber }) => {
  const at = url.startsWith("file:")
    ? origin(url, undefined, lineNumber, columnNumber) || url.split("/").pop()
    : url || "(native)";
  return `${functionName || "(anon)"}  ${at}`;
};
const make = await loadViborm(resolve(o.dir));
const db = await openSeededDatabase();
const warmClient = o.mode === "warm" ? make(db) : undefined;
const schema = o.mode === "client" ? make.buildSchema() : undefined;
const op = () => (warmClient ?? make(db, schema))[o.workload]();
const session = new Session();
session.connect();
if (o.mode !== "cold") for (let i = 0; i < 300; i++) await op();
const n = o.mode === "cold" ? 1 : Number(o.count);
const tally = new Map();
const add = (key, v) => tally.set(key, (tally.get(key) ?? 0) + v);
const print = (rows, fmt) => {
  for (const [k, v] of [...rows]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Number(o.top)))
    console.log(`${fmt(v)}  ${k}`);
};

if (o.kind === "heap") {
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: 128,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  for (let i = 0; i < n; i++) await op();
  const { profile } = await session.post("HeapProfiler.stopSampling");
  if (o.out) writeFileSync(o.out, JSON.stringify(profile));
  let total = 0;
  const walk = (node) => {
    if (node.selfSize) {
      total += node.selfSize;
      add(where(node.callFrame), node.selfSize);
    }
    for (const child of node.children) walk(child);
  };
  walk(profile.head);
  console.log(`sampled ${(total / n / 1024).toFixed(1)} KiB/op`);
  print(tally, (v) => `${(v / n).toFixed(0).padStart(7)} B`);
} else {
  await session.post("Profiler.enable");
  await session.post("Profiler.setSamplingInterval", { interval: 20 });
  await session.post("Profiler.start");
  for (let i = 0; i < n; i++) await op();
  const { profile } = await session.post("Profiler.stop");
  if (o.out) writeFileSync(o.out, JSON.stringify(profile));
  const counts = new Map();
  for (const s of profile.samples) counts.set(s, (counts.get(s) ?? 0) + 1);
  for (const node of profile.nodes)
    if (counts.has(node.id)) add(where(node.callFrame), counts.get(node.id));
  const total = profile.samples.length;
  const ms = (profile.endTime - profile.startTime) / 1000;
  console.log(`${((ms / n) * 1000).toFixed(1)} µs/op, ${total} samples`);
  print(tally, (v) => `${((v / total) * 100).toFixed(1).padStart(5)}%`);
}
