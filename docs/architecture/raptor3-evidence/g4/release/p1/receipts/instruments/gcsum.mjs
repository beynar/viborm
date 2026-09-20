import { readFileSync } from "node:fs";
for (const f of process.argv.slice(2)) {
  const kinds = new Map();
  let last = 0;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const t = /\]\s+(\d+) ms: /.exec(line);
    if (!t) continue;
    const kind = /ms: ([A-Za-z-]+) /.exec(line)?.[1] ?? "?";
    const d = /([\d.]+) \/ ([\d.]+) ms/.exec(line);
    const ms = d ? Number(d[1]) + Number(d[2]) : 0;
    const k = kinds.get(kind) ?? { n: 0, ms: 0 };
    k.n++; k.ms += ms; kinds.set(kind, k);
    last = Math.max(last, Number(t[1]));
  }
  let total = 0;
  const parts = [...kinds].map(([k, v]) => { total += v.ms; return `${k} n=${v.n} ${v.ms.toFixed(2)}ms`; });
  console.log(`${f}: ${parts.join(" | ")} || total_gc=${total.toFixed(2)}ms last_t=${last}ms`);
}
