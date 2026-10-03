// biome-ignore-all lint/suspicious/noMisplacedAssertion: diagnostic evidence must reject incorrect results.
/**
 * Post-GC retention diagnostic, not an allocation or throughput benchmark.
 * Run through scripts/run-node-safe.mjs; the coordinator enables GC only in
 * its isolated worker. No application cache or external database is used.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { writeHeapSnapshot } from "node:v8";

const { values } = parseArgs({
  options: {
    "build-dir": { type: "string" },
    output: { type: "string" },
    worker: { type: "boolean", default: false },
    "lifecycle-only": { type: "boolean", default: false },
    "snapshot-prefix": { type: "string" },
  },
});
const entry = fileURLToPath(import.meta.url);
const root = resolve(dirname(entry), "..");
const buildDir = resolve(values["build-dir"] ?? `${root}/dist`);
assert(values.output, "--output is required");

if (values.worker) {
  assert.equal(typeof global.gc, "function");
  const hash = createHash("sha256");
  for (const filename of readdirSync(buildDir, { recursive: true })
    .filter((name) => name.endsWith(".mjs"))
    .sort()) {
    hash.update(filename).update(readFileSync(`${buildDir}/${filename}`));
  }
  const { s } = await import(pathToFileURL(`${buildDir}/schema.mjs`));
  const { createClient, ValidationError } = await import(
    pathToFileURL(`${buildDir}/index.mjs`)
  );
  const { SQLite3Driver } = await import(
    pathToFileURL(`${buildDir}/sqlite3.mjs`)
  );
  assert.equal(typeof ValidationError, "function");

  async function fixture() {
    const user = s
      .model({
        id: s.string().id(),
        name: s.string(),
        posts: s.toMany(() => post),
      })
      .map("users");
    const post = s
      .model({
        id: s.string().id(),
        title: s.string(),
        published: s.boolean(),
        views: s.int(),
        authorId: s.string(),
        author: s
          .toOne(() => user)
          .fields("authorId")
          .references("id"),
      })
      .map("posts");
    const driver = new SQLite3Driver({ dataDir: ":memory:" });
    const client = createClient({ schema: { user, post }, driver });
    try {
      const database = await driver.getClient();
      database.exec(
        "CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL); CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT NOT NULL, published INTEGER NOT NULL, views INTEGER NOT NULL, authorId TEXT NOT NULL)"
      );
      database.transaction(() => {
        const users = database.prepare("INSERT INTO users VALUES (?,?)");
        const posts = database.prepare("INSERT INTO posts VALUES (?,?,?,?,?)");
        for (let i = 0; i < 100; i++) users.run(`u${i}`, `User ${i}`);
        for (let i = 0; i < 1000; i++) {
          posts.run(`p${i}`, `Post ${i}`, i % 2, i, `u${i % 100}`);
        }
      })();
      return { client, driver, database, user, post };
    } catch (error) {
      await driver.disconnect();
      throw error;
    }
  }

  async function collect() {
    // Yield before GC so the previous async frame and WeakRef job have ended.
    await setImmediate();
    global.gc();
    await setImmediate();
    global.gc();
  }

  async function checkpoint(operations, references = []) {
    await collect();
    return {
      operations,
      ...process.memoryUsage(),
      sampledReferences: references.length,
      uncollectedReferences: references.filter(
        (ref) => ref.deref() !== undefined
      ).length,
    };
  }

  async function runOperation(client, index, references) {
    let pending;
    switch (index % 6) {
      case 0:
        pending = client.user.findUnique({
          where: {
            id: index % 12 === 0 ? `absent-${index}` : `u${index % 100}`,
          },
        });
        break;
      case 1:
        pending = client.post.findMany({
          where: { views: { gt: index % 950 }, published: true },
          select:
            Math.floor(index / 6) % 2
              ? { id: true, views: true }
              : { id: true, title: true },
          orderBy: { views: "asc" },
          take: 5,
        });
        break;
      case 2:
        pending = client.post.findMany({ orderBy: { views: "asc" }, take: 20 });
        break;
      case 3:
        pending = client.post.findMany({
          select: { id: true, author: { select: { id: true, name: true } } },
          orderBy: { views: "asc" },
          take: 20,
        });
        break;
      case 4:
        pending = client.user.update({
          where: { id: `u${index % 100}` },
          data: { name: `iteration-${index}` },
        });
        break;
      case 5:
        pending = client.post.findMany({ take: "invalid" });
        break;
      default:
        assert.fail("Unexpected operation index");
    }
    if (references) references.push(new WeakRef(pending));
    if (index % 6 === 5) {
      await assert.rejects(async () => await pending, ValidationError);
      return;
    }
    const answer = await pending;
    if (references && answer !== null) references.push(new WeakRef(answer));
    switch (index % 6) {
      case 0:
        if (index % 12 === 0) assert.equal(answer, null);
        else assert.equal(answer.id, `u${index % 100}`);
        break;
      case 1:
        assert.equal(answer.length, 5);
        break;
      case 2:
        assert.equal(answer.length, 20);
        assert.equal(answer[0].published, false);
        break;
      case 3:
        assert.equal(answer.length, 20);
        assert.equal(answer[0].author.id, "u0");
        break;
      case 4:
        assert.equal(answer.name, `iteration-${index}`);
        break;
      default:
        assert.fail("Unexpected successful operation index");
    }
  }

  async function block(client, start, count) {
    const references = [];
    for (let offset = 0; offset < count; offset++) {
      await runOperation(
        client,
        start + offset,
        offset < 24 ? references : undefined
      );
    }
    return references;
  }

  async function disposedClients(count) {
    const references = [];
    for (let i = 0; i < count; i++) {
      const owned = await fixture();
      try {
        await block(owned.client, 0, 6);
        references.push(
          new WeakRef(owned.client),
          new WeakRef(owned.driver),
          new WeakRef(owned.database),
          new WeakRef(owned.user),
          new WeakRef(owned.post)
        );
      } finally {
        await owned.driver.disconnect();
      }
    }
    return references;
  }

  const report = {
    metadata: {
      node: process.version,
      v8: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0].model,
      buildDir,
      distSha256: hash.digest("hex"),
      harnessSha256: createHash("sha256")
        .update(readFileSync(entry))
        .digest("hex"),
      startedAt: new Date().toISOString(),
    },
    protocol: {
      warmup: 20_000,
      blocks: 10,
      operationsPerBlock: 20_000,
      workload: [
        "unique/missing with varying values",
        "filtered varying projection",
        "20 scalar rows",
        "20 rows with author",
        "bounded update",
        "validation rejection",
      ],
      fixture: "100 users, 1000 posts; no inserts during soak; no extensions",
      gc: "two full explicit GCs, each after an event-loop yield, at each checkpoint only",
    },
    steady: [],
    lifecycle: [],
  };
  if (values["lifecycle-only"]) {
    report.protocol = {
      warmupClients: 50,
      blocks: 10,
      clientsPerBlock: 100,
      operationsPerClient: 6,
    };
    await disposedClients(50);
    report.lifecycle.push(await checkpoint(0));
    if (values["snapshot-prefix"])
      writeHeapSnapshot(`${values["snapshot-prefix"]}-before.heapsnapshot`);
    for (let round = 0; round < 10; round++) {
      const references = await disposedClients(100);
      report.lifecycle.push(await checkpoint((round + 1) * 100, references));
    }
    if (values["snapshot-prefix"])
      writeHeapSnapshot(`${values["snapshot-prefix"]}-after.heapsnapshot`);
  } else {
    const owned = await fixture();
    try {
      await block(owned.client, 0, report.protocol.warmup);
      report.steady.push(await checkpoint(0));
      for (let round = 0; round < report.protocol.blocks; round++) {
        const references = await block(
          owned.client,
          report.protocol.warmup + round * 20_000,
          20_000
        );
        report.steady.push(await checkpoint((round + 1) * 20_000, references));
      }
      const overlap = await Promise.all(
        Array.from({ length: 32 }, (_, i) => block(owned.client, i * 6, 6))
      );
      report.overlap = await checkpoint(192, overlap.flat());
      assert.equal(
        owned.database.prepare("SELECT count(*) AS n FROM users").get().n,
        100
      );
      assert.equal(
        owned.database.prepare("SELECT count(*) AS n FROM posts").get().n,
        1000
      );

      const retained = [];
      report.control = { before: await checkpoint(0) };
      for (let i = 0; i < 500; i++) {
        const pending = owned.client.post.findMany({ take: 100 });
        retained.push(pending);
        await pending;
      }
      report.control.held = await checkpoint(500);
      assert.equal(retained.length, 500);
      retained.length = 0;
      report.control.released = await checkpoint(500);

      await disposedClients(5);
      report.lifecycle.push(await checkpoint(0));
      for (let round = 0; round < 10; round++) {
        const references = await disposedClients(10);
        report.lifecycle.push(await checkpoint((round + 1) * 10, references));
      }
      // Deliberately probe the arbitrary-property memoization boundary separately
      // from valid operations; these accesses execute no database work.
      report.unknownProperties = [await checkpoint(0)];
      for (let round = 0; round < 2; round++) {
        for (let i = round * 10_000; i < (round + 1) * 10_000; i++) {
          // biome-ignore lint/complexity/noVoid: exercise a property read without retaining its answer in the harness.
          void owned.client.user[`unknown_${i}`];
        }
        report.unknownProperties.push(await checkpoint((round + 1) * 10_000));
      }
    } finally {
      await owned.driver.disconnect();
    }
  }
  report.metadata.finishedAt = new Date().toISOString();
  writeFileSync(values.output, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`Retention diagnostic saved to ${values.output}\n`);
} else {
  const child = spawnSync(
    process.execPath,
    ["--expose-gc", entry, ...process.argv.slice(2), "--worker"],
    { stdio: "inherit", timeout: 150_000 }
  );
  assert.equal(child.status, 0, child.error?.message);
}
