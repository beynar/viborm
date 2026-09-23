/** Isolate the per-member cost of the `in` list of 100 ids, shapes only. */
import { performance } from "node:perf_hooks";
const N = 100;
const ids = Array.from({ length: N }, (_, i) => `user_${i}`);
const FIELD_REF_BRAND = Symbol.for("viborm.fieldRef");
const isFieldRef = (value) => {
  if (typeof value !== "object" || value === null) return false;
  const payload = value[FIELD_REF_BRAND];
  return typeof payload === "object" && payload !== null;
};
class Sql {
  constructor(rawStrings, rawValues) { this.rawStrings = rawStrings; this.rawValues = rawValues; this.projection = undefined; this.statements = undefined; }
}
const sql = (strings, ...values) => new Sql(strings, values);
const cases = {
  "freeze box x100": () => { const out = []; for (const v of ids) out.push(Object.freeze({ kind: "value", value: v })); return out.length; },
  "plain box x100": () => { const out = []; for (const v of ids) out.push({ kind: "value", value: v }); return out.length; },
  "isFieldRef x100": () => { let n = 0; for (const v of ids) if (!isFieldRef(v)) n++; return n; },
  "sql`${v}` x100": () => { const out = []; for (const v of ids) out.push(sql`${v}`); return out.length; },
  "freeze array of 100": () => Object.freeze(ids.slice()).length,
};
const reps = Number(process.argv[2] ?? 20000);
const out = {};
for (const pass of [0, 1, 2]) {
  for (const [name, fn] of Object.entries(cases)) {
    let sink = 0;
    for (let i = 0; i < 2000; i++) sink += fn();
    const c0 = process.cpuUsage(); const w0 = performance.now();
    for (let i = 0; i < reps; i++) sink += fn();
    const cpu = process.cpuUsage(c0); const wall = performance.now() - w0;
    if (pass > 0) (out[name] ??= []).push({ cpu: +((cpu.user + cpu.system) / reps).toFixed(3), wall: +((wall * 1000) / reps).toFixed(3), sink });
  }
}
console.log(JSON.stringify(out, null, 1));
