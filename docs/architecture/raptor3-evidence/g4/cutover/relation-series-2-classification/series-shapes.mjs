/**
 * Shape probe: the same generated default under the single-record `update`
 * shape that G2's adjudicated record measured, under `create`, and under a
 * malformed nested payload (does dropping legacy's second parse drop a
 * refusal?).
 *
 * Usage: node --enable-source-maps series-shapes.mjs <rootDir>
 */

Error.stackTraceLimit = 50;
const root = process.argv[2];
if (!root) throw new Error("usage: <rootDir>");
const { createBenchmarkFixture } = await import(
  `${root}/benchmarks/operation-pipeline-fixtures.mjs`
);

const cases = [
  {
    name: "update-single-nested-create",
    run: (client) =>
      client.generatedParent.update({
        where: { id: 5000 },
        data: { children: { create: { label: "u" } } },
        select: { id: true },
      }),
  },
  {
    name: "create-parent-nested-create",
    run: (client) =>
      client.generatedParent.create({
        data: { label: "p", children: { create: { label: "c" } } },
        select: { id: true },
      }),
  },
  {
    name: "updateMany-nested-create-malformed",
    run: (client) =>
      client.generatedParent.updateMany({
        where: { id: { in: [5000, 6000] } },
        data: { children: { create: { label: 42 } } },
      }),
  },
  {
    name: "updateMany-nested-create-unknown-key",
    run: (client) =>
      client.generatedParent.updateMany({
        where: { id: { in: [5000, 6000] } },
        data: { children: { create: { label: "x", nope: 1 } } },
      }),
  },
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
  let statementCount = 0;
  const driver = fixture.driver;
  const original = driver.execute;
  const descriptor = Object.getOwnPropertyDescriptor(driver, "execute");
  Object.defineProperty(driver, "execute", {
    configurable: true,
    value: async function (...args) {
      statementCount += 1;
      return await original.apply(this, args);
    },
  });
  let outcome;
  try {
    outcome = { kind: "success", value: await testCase.run(fixture.client) };
  } catch (failure) {
    outcome = {
      kind: "failure",
      name: failure?.name,
      message: failure?.message,
      path: failure?.path ?? failure?.meta?.path,
      issues: failure?.issues?.map?.((issue) => ({
        path: issue.path,
        code: issue.code,
        message: issue.message,
      })),
    };
  } finally {
    if (descriptor) Object.defineProperty(driver, "execute", descriptor);
    else delete driver.execute;
  }
  const children = (
    await driver._executeRaw(
      "SELECT id,parentId,label FROM \"bench_generated_children\" WHERE label IN ('u','c','x') ORDER BY id"
    )
  ).rows;
  report.push({
    case: testCase.name,
    outcome,
    defaults: fixture.defaults.map((entry) => entry.value),
    defaultCount: fixture.defaults.length,
    statementCount,
    persisted: children.map((row) => ({
      id: row.id,
      parentId: Number(row.parentId),
      label: row.label,
    })),
  });
  await driver.disconnect?.();
}
console.log(JSON.stringify({ root, report }, null, 1));
