import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(join(root, "package.json"));
const prisma = createRequire(require.resolve("prisma/config"));
const configRequire = createRequire(prisma.resolve("@prisma/config"));
const { deepmerge } = configRequire("deepmerge-ts");
const left = {};
left.self = left;
const right = {};
right.self = right;
const merged = deepmerge(left, right);
assert.equal(merged.self, merged);
assert.deepEqual(deepmerge({ a: { b: 1 } }, { a: { c: 2 } }), { a: { b: 1, c: 2 } });
const later = { c: 2 };
assert.equal(deepmerge(new Map([["key", { b: 1 }]]), new Map([["key", later]])).get("key"), later);
const esm = await import(configRequire.resolve("deepmerge-ts").replace(/index\.cjs$/, "index.mjs"));
const esmMerged = esm.deepmerge(left, right);
assert.equal(esmMerged.self, esmMerged);
assert.equal(esm.deepmerge(new Map([["key", { b: 1 }]]), new Map([["key", later]])).get("key"), later);
const fixture = mkdtempSync(join(tmpdir(), "viborm-security-config-"));
try {
  writeFileSync(join(fixture, "prisma.config.ts"), 'export default { schema: "fixture.prisma", datasource: { url: "postgresql://fixture:fixture@localhost:1/fixture" } };\n');
  const loaded = await configRequire("./index.js").loadConfigFromFile({ configRoot: fixture });
  assert.equal(loaded.error, undefined);
  assert.ok(loaded.config.schema.endsWith("fixture.prisma"));
  assert.equal(loaded.config.datasource.url, "postgresql://fixture:fixture@localhost:1/fixture");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
const astroRequire = createRequire(realpathSync(join(root, "docs/node_modules/astro/package.json")));
const CachePolicy = astroRequire("http-cache-semantics");
const request = { url: "https://fixture.invalid/value", method: "GET", headers: { host: "fixture.invalid" } };
const staleRequest = { ...request, headers: { ...request.headers, "cache-control": "max-stale=999999" } };
for (const headers of [
  { "set-cookie": "private=value", "cache-control": "max-age=600" },
  { "cache-control": "proxy-revalidate, max-age=600" },
  { "cache-control": "no-cache, max-age=600" },
  { "cache-control": "private, max-age=600" },
  { "cache-control": "no-store, max-age=600" },
]) {
  const policy = new CachePolicy(request, { status: 200, headers }, { shared: true });
  assert.equal(policy.satisfiesWithoutRevalidation(staleRequest), false, JSON.stringify(headers));
  assert.equal(policy.evaluateRequest(staleRequest).response, undefined);
}
for (const headers of [
  { "cache-control": "max-age=0" },
  { "cache-control": "max-age=600" },
  { "cache-control": "public, max-age=0", "set-cookie": "allowed=value" },
  { "cache-control": "immutable, max-age=0", "set-cookie": "allowed=value" },
]) {
  const policy = new CachePolicy(request, { status: 200, headers }, { shared: true });
  assert.equal(policy.satisfiesWithoutRevalidation(staleRequest), true, JSON.stringify(headers));
}
const { sqliteTable, text } = require("drizzle-orm/sqlite-core");
const { drizzle } = require("drizzle-orm/better-sqlite3");
const Database = require("better-sqlite3");
const db = new Database(":memory:");
try {
  const table = sqliteTable('odd"table', { name: text('odd"column') });
  const query = drizzle(db).select().from(table).toSQL();
  assert.ok(query.sql.includes('"odd""table"'));
  assert.ok(query.sql.includes('"odd""column"'));
} finally {
  db.close();
}
console.log("Security dependencies: cyclic merge, v7 Maps, real Prisma loader, HTTP shared-cache refusals/positive controls, and Drizzle identifier escaping passed.");
