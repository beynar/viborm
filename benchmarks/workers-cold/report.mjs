/**
 * Read the measurement Workers' invocations back from Workers Logs and report
 * CPU and wall time per arm × query × (isolate-cold | warm). Each invocation
 * event carries cpuTimeMs/wallTimeMs; the Worker's own log line carries the
 * cold flag; both share $metadata.requestId.
 *
 *   CLOUDFLARE_ACCOUNT_ID=… node benchmarks/workers-cold/report.mjs \
 *     --services viborm-perf-viborm-now,viborm-perf-viborm-before,viborm-perf-drizzle \
 *     --from <ms> --to <ms> [--json out.json]
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({
  options: {
    services: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    json: { type: "string" },
  },
});

function page(service, offset) {
  const body = {
    queryId: `viborm-cold-${service}`,
    timeframe: { from: Number(o.from), to: Number(o.to) },
    view: "events",
    limit: 1000,
    ...(offset ? { offset } : {}),
    parameters: {
      filters: [
        {
          key: "$metadata.service",
          operation: "eq",
          type: "string",
          value: service,
        },
      ],
    },
  };
  const out = execFileSync(
    "cf",
    ["observability", "telemetry", "query", "--body", JSON.stringify(body)],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }
  );
  return JSON.parse(out).events?.events ?? [];
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const h = Math.floor(s.length / 2);
  return s.length ? (s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2) : Number.NaN;
};
const mean = (xs) => xs.reduce((t, x) => t + x, 0) / xs.length;

const rows = [];
for (const service of o.services.split(",")) {
  const invocations = new Map();
  const probes = new Map();
  let offset;
  for (;;) {
    const events = page(service, offset);
    for (const e of events) {
      const id = e.$metadata?.requestId;
      if (!id) continue;
      if (e.$workers?.cpuTimeMs !== undefined) invocations.set(id, e.$workers);
      if (e.source?.probe) probes.set(id, e.source);
    }
    if (events.length < 1000) break;
    offset = events.at(-1).$metadata.id;
  }
  for (const [id, probe] of probes) {
    const inv = invocations.get(id);
    if (inv)
      rows.push({
        service,
        q: probe.q,
        cold: probe.cold,
        cpu: inv.cpuTimeMs,
        wall: inv.wallTimeMs,
      });
  }
}

const groups = new Map();
for (const r of rows) {
  const k = `${r.service}|${r.q}|${r.cold ? "cold" : "warm"}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}
console.log(
  "arm                        query       isolate   n   cpu mean  cpu p50   wall mean  wall p50"
);
for (const [k, rs] of [...groups].sort()) {
  const [service, q, state] = k.split("|");
  const cpu = rs.map((r) => r.cpu);
  const wall = rs.map((r) => r.wall);
  console.log(
    `${service.replace("viborm-perf-", "").padEnd(26)} ${q.padEnd(11)} ${state.padEnd(7)} ${String(rs.length).padStart(3)}  ${mean(cpu).toFixed(2).padStart(7)}  ${median(cpu).toFixed(1).padStart(7)}  ${mean(wall).toFixed(1).padStart(9)}  ${median(wall).toFixed(1).padStart(8)}`
  );
}
if (o.json) writeFileSync(o.json, JSON.stringify(rows));
