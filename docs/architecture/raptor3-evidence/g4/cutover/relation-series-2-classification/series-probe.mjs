/**
 * Read-only diagnostic probe for the relation-series-2 divergence.
 *
 * Reproduces the exact contract invocation against one checkout's own
 * benchmark fixture, recording (a) every provider statement in order,
 * (b) every generatedChild.id default evaluation with its source-mapped
 * stack, and (c) the persisted children afterwards.
 *
 * Usage: node --enable-source-maps series-probe.mjs <rootDir> <outJson>
 */

Error.stackTraceLimit = 200;
const root = process.argv[2];
const out = process.argv[3];
if (!root || !out) throw new Error("usage: <rootDir> <outJson>");

const { createBenchmarkFixture } = await import(
  `${root}/benchmarks/operation-pipeline-fixtures.mjs`
);

const fixture = await createBenchmarkFixture(
  "core",
  "transactional",
  "unextended",
  "sqlite3"
);

const interesting = (stack) =>
  stack
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => !line.includes("node:internal"))
    .filter((line) => !line.includes("series-probe.mjs"))
    .slice(0, 40);

const statements = [];
const defaultEvents = [];

fixture.observeDefaults(true);
const defaultStart = fixture.defaults.length;

// The fixture's generator closes over the `defaults` array itself, so
// overriding push on that array observes every recorded evaluation.
const nativePush = Array.prototype.push;
fixture.defaults.push = function (...items) {
  for (const item of items) {
    defaultEvents.push({
      order: defaultEvents.length + 1,
      name: item.name,
      value: item.value,
      statementsSoFar: statements.length,
      stack: interesting(new Error("default").stack),
    });
  }
  return nativePush.apply(this, items);
};

const driver = fixture.driver;
const originals = ["execute", "executeRaw"].map((method) => ({
  method,
  descriptor: Object.getOwnPropertyDescriptor(driver, method),
  execute: driver[method],
}));
for (const original of originals) {
  Object.defineProperty(driver, original.method, {
    configurable: true,
    value: async function (client, sql, params, ...rest) {
      const entry = {
        order: statements.length + 1,
        via: original.method,
        sql,
        params: structuredClone(params ?? []),
        defaultsBefore: fixture.defaults.length - defaultStart,
        stack: interesting(new Error("statement").stack),
      };
      statements.push(entry);
      const response = await original.execute.call(
        this,
        client,
        sql,
        params,
        ...rest
      );
      entry.rows = response.rows?.length ?? 0;
      entry.defaultsAfter = fixture.defaults.length - defaultStart;
      return response;
    },
  });
}

let outcome;
try {
  const value = await fixture.client.generatedParent.updateMany({
    where: { id: { in: [5000, 6000] } },
    data: { children: { create: { label: "series-child" } } },
  });
  outcome = { kind: "success", value };
} catch (failure) {
  outcome = {
    kind: "failure",
    message: failure?.message,
    stack: failure?.stack?.split("\n").slice(0, 12),
  };
} finally {
  fixture.observeDefaults(false);
  for (const { method, descriptor } of originals) {
    if (descriptor) Object.defineProperty(driver, method, descriptor);
    else delete driver[method];
  }
  delete fixture.defaults.push;
}

const children = (
  await driver._executeRaw(
    'SELECT id,parentId,label FROM "bench_generated_children" ORDER BY id'
  )
).rows;
const parents = (
  await driver._executeRaw(
    'SELECT id,label FROM "bench_generated_parents" ORDER BY id'
  )
).rows;

const { writeFileSync } = await import("node:fs");
writeFileSync(
  out,
  `${JSON.stringify(
    {
      root,
      outcome,
      defaultsEvaluated: defaultEvents.length,
      defaults: defaultEvents,
      statementCount: statements.length,
      statements,
      persistedChildren: children.map((row) => ({
        id: row.id,
        parentId: Number(row.parentId),
        label: row.label,
      })),
      persistedParents: parents.map((row) => ({
        id: Number(row.id),
        label: row.label,
      })),
    },
    null,
    1
  )}\n`
);
await driver.disconnect?.();
console.log(
  `${root}: ${defaultEvents.length} defaults, ${statements.length} statements`
);
