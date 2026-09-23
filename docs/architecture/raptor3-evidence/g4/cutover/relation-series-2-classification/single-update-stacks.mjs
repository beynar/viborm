Error.stackTraceLimit = 200;
const root = process.argv[2];
const { createBenchmarkFixture } = await import(
  `${root}/benchmarks/operation-pipeline-fixtures.mjs`
);
const fixture = await createBenchmarkFixture("core", "transactional", "unextended", "sqlite3");
fixture.observeDefaults(true);
const events = [];
const nativePush = Array.prototype.push;
fixture.defaults.push = function (...items) {
  for (const item of items)
    events.push({
      value: item.value,
      frames: new Error("d").stack
        .split("\n").slice(1).map((l) => l.trim())
        .filter((l) => l.includes("/src/query-engine/"))
        .map((l) => l.replace(root + "/", ""))
        .slice(0, 8),
    });
  return nativePush.apply(this, items);
};
await fixture.client.generatedParent.update({
  where: { id: 5000 },
  data: { children: { create: { label: "u" } } },
  select: { id: true },
});
delete fixture.defaults.push;
for (const e of events) console.log(`-- ${e.value}\n   ${e.frames.join("\n   ")}`);
await fixture.driver.disconnect?.();
