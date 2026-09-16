/**
 * Scaling probe: does the default-evaluation count follow
 *   shipped   = 1 admission + 2 per admitted member-input
 *   candidate = 1 admission + 1 per admitted member-input
 * or does one side skip / mis-attribute a member?
 *
 * Usage: node --enable-source-maps series-scaling.mjs <rootDir>
 */

Error.stackTraceLimit = 50;
const root = process.argv[2];
if (!root) throw new Error("usage: <rootDir>");
const { createBenchmarkFixture } = await import(
  `${root}/benchmarks/operation-pipeline-fixtures.mjs`
);

const cases = [
  { name: "roots-2-single", ids: [5000, 6000], create: { label: "s" } },
  { name: "roots-3-single", ids: [5000, 6000, 10000], create: { label: "s" } },
  {
    name: "roots-2-array-2",
    ids: [5000, 6000],
    create: [{ label: "a" }, { label: "b" }],
  },
  { name: "roots-1-single", ids: [5000], create: { label: "s" } },
  { name: "roots-0-single", ids: [1], create: { label: "s" } },
];

const report = [];
for (const testCase of cases) {
  const fixture = await createBenchmarkFixture(
    "core",
    "transactional",
    "unextended",
    "sqlite3"
  );
  fixture.observeDefaults(true);
  const statements = [];
  const driver = fixture.driver;
  const original = driver.execute;
  const descriptor = Object.getOwnPropertyDescriptor(driver, "execute");
  Object.defineProperty(driver, "execute", {
    configurable: true,
    value: async function (client, sql, params, ...rest) {
      statements.push({
        sql,
        params: structuredClone(params ?? []),
        defaultsBefore: fixture.defaults.length,
      });
      return await original.call(this, client, sql, params, ...rest);
    },
  });
  let outcome;
  try {
    outcome = {
      kind: "success",
      value: await fixture.client.generatedParent.updateMany({
        where: { id: { in: testCase.ids } },
        data: { children: { create: testCase.create } },
      }),
    };
  } catch (failure) {
    outcome = { kind: "failure", message: failure?.message };
  } finally {
    if (descriptor) Object.defineProperty(driver, "execute", descriptor);
    else delete driver.execute;
  }
  const children = (
    await driver._executeRaw(
      "SELECT id,parentId,label FROM \"bench_generated_children\" WHERE label IN ('s','a','b') ORDER BY parentId, id"
    )
  ).rows;
  report.push({
    case: testCase.name,
    outcome,
    defaults: fixture.defaults.map((entry) => entry.value),
    defaultCount: fixture.defaults.length,
    statementCount: statements.length,
    inserts: statements
      .filter((entry) => entry.sql.startsWith("INSERT"))
      .map((entry) => entry.params),
    selects: statements
      .filter((entry) => !entry.sql.startsWith("INSERT"))
      .map((entry) => `${entry.sql} :: ${JSON.stringify(entry.params)}`),
    persisted: children.map((row) => ({
      id: row.id,
      parentId: Number(row.parentId),
      label: row.label,
    })),
  });
  await driver.disconnect?.();
}
console.log(JSON.stringify({ root, report }, null, 1));
