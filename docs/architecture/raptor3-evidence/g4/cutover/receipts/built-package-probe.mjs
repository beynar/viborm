/**
 * Stage-1 probe: does the built cutover package answer through the PUBLIC
 * client, and does the benchmark harness's `prepare()` seam still answer?
 */
import { createBenchmarkFixture } from "/private/tmp/viborm-g4-perf-candidate/benchmarks/operation-pipeline-fixtures.mjs";
import { benchmarkOperation } from "/private/tmp/viborm-g4-perf-candidate/benchmarks/operation-pipeline-harness.mjs";

const short = (e) => `${e?.constructor?.name}: ${String(e?.message ?? e).slice(0, 160)}`;
const fixture = await createBenchmarkFixture("core", "direct", "unextended", "sqlite3");
const client = fixture.client;

try {
  const rows = await client.user.findMany({ take: 2 });
  console.log("RESULT public findMany rows =", Array.isArray(rows) ? rows.length : typeof rows);
} catch (e) { console.log("RESULT public findMany threw:", short(e)); }

try {
  const created = await client.user.create({ data: { id: "probe_1", name: "P", email: "p@example.com", age: 30 } });
  console.log("RESULT public create id =", created?.id);
} catch (e) { console.log("RESULT public create threw:", short(e)); }

const operation = client.user.findMany({ take: 2 });
const capability = benchmarkOperation(operation);
try {
  const single = capability.prepare();
  console.log("RESULT benchmark prepare() =", single === undefined ? "undefined" : "PreparedQuery");
} catch (e) { console.log("RESULT benchmark prepare() threw:", short(e)); }
try {
  const batch = await capability.prepareBatch(fixture.driver);
  console.log("RESULT benchmark prepareBatch() =", batch === undefined ? "undefined" : "package");
} catch (e) { console.log("RESULT benchmark prepareBatch() threw:", short(e)); }
try {
  console.log("RESULT buildStatement() =", operation.buildStatement() === undefined ? "undefined" : "Sql");
} catch (e) { console.log("RESULT buildStatement() threw:", short(e)); }

await client.$disconnect?.();
