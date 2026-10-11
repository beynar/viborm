/**
 * `viborm/migrations` loads in workerd with NO compatibility flags.
 *
 * The packed package is installed in a consumer, and a Worker that imports the
 * file the installed export map gives `./migrations` under wrangler's
 * conditions (`workerd`, `worker`, `browser`, then `import`, `default`) runs in
 * Miniflare's workerd with `compatibilityFlags: []` — no `nodejs_compat`, so
 * every `node:*` import in the entry's graph is refused at load — and a
 * compatibility date well before any Node-compatibility date, so there is no
 * date floor either. The Worker also imports the Durable Object and R2
 * history storage subpaths, so they load under the same rules. It then
 * runs the exported storage conformance suite, which hashes with the entry's
 * SHA-256, over both in-memory writers.
 *
 * Miniflare is the one the repository's `wrangler` depends on: the provider-d1
 * lane runs the same workerd.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPackedConsumer,
  packedArchive,
  repositoryRoot,
} from "./packed-consumer.mjs";

const COMPATIBILITY_DATE = "2024-01-01";

const WORKER_CONDITIONS = ["workerd", "worker", "browser", "import", "default"];

const HISTORY_BINDINGS = {
  "./migrations/storage/durable-object": "createDurableObjectStorageWriter",
  "./migrations/storage/r2": "createR2StorageWriter",
};

// A named import of a missing export fails when workerd links the Worker.
const worker = (entry, bindings) => `import * as migrations from "${entry}";
${bindings.map(([path, name]) => `import { ${name} } from "${path}";`).join("\n")}

export default {
  async fetch() {
    const bindings = [${bindings.map(([, name]) => name).join(", ")}];
    if (!bindings.every((binding) => typeof binding === "function")) {
      throw new Error("a history storage binding did not load");
    }
    const writers = [
      () => new migrations.MemoryEstateStorage(),
      () =>
        new migrations.ObjectStoreEstateStorage(
          new migrations.MemoryConditionalObjectStore()
        ),
    ];
    let cases = 0;
    for (const writer of writers) {
      for (const conformance of migrations.createStorageConformanceSuite(writer)) {
        await conformance.run();
        cases += 1;
      }
    }
    return new Response(\`ok \${cases}\`);
  },
};
`;

const requireFromRepository = createRequire(
  join(repositoryRoot, "package.json")
);
const { Miniflare } = createRequire(
  requireFromRepository.resolve("wrangler/package.json")
)("miniflare");

const fixtureRoot = mkdtempSync(join(tmpdir(), "viborm-workerd-migrations-"));
let miniflare;
try {
  const consumerRoot = join(fixtureRoot, "consumer");
  createPackedConsumer(
    consumerRoot,
    packedArchive(fixtureRoot),
    "viborm-workerd-migrations",
    []
  );
  const installedRoot = join(consumerRoot, "node_modules", "viborm");
  const { exports } = JSON.parse(
    readFileSync(join(installedRoot, "package.json"), "utf8")
  );
  const entry = (subpath) => {
    const target = WORKER_CONDITIONS.map(
      (condition) => exports[subpath]?.[condition]
    ).find((path) => typeof path === "string");
    if (target === undefined) {
      throw new Error(
        `viborm${subpath.slice(1)} has no Worker-resolvable export`
      );
    }
    return `./node_modules/viborm/${target.slice(2)}`;
  };
  const scriptPath = join(consumerRoot, "worker.mjs");
  writeFileSync(
    scriptPath,
    worker(
      entry("./migrations"),
      Object.entries(HISTORY_BINDINGS).map(([subpath, name]) => [
        entry(subpath),
        name,
      ])
    )
  );

  miniflare = new Miniflare({
    modules: true,
    scriptPath,
    modulesRoot: consumerRoot,
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: [],
  });
  const response = await miniflare.dispatchFetch("http://smoke.invalid/");
  const body = await response.text();
  if (response.status !== 200 || !body.startsWith("ok ")) {
    throw new Error(
      `viborm/migrations failed in workerd (${response.status}): ${body}`
    );
  }
  console.log(`packed viborm/migrations in workerd without flags: ${body}`);
} finally {
  await miniflare?.dispose();
  rmSync(fixtureRoot, { force: true, recursive: true });
}
