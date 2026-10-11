import { env, runInDurableObject } from "cloudflare:test";
import type {
  D1Database,
  DurableObjectNamespace,
  R2Bucket,
} from "@cloudflare/workers-types";
import { createClient } from "@src/client/client";
import { D1Driver } from "@src/drivers/d1";
import { createMigrationClient } from "@src/migrations/client";
import { utf8Bytes } from "@src/migrations/identity";
import { createStorageConformanceSuite } from "@src/migrations/storage/conformance";
import type { MigrationStorageWriter } from "@src/migrations/storage/contract";
import { createDurableObjectStorageWriter } from "@src/migrations/storage/durable-object";
import { createR2StorageWriter } from "@src/migrations/storage/r2";
import { encodeSqlBlob } from "@src/migrations/v1-parse";
import { s } from "@src/schema";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    ESTATE_HISTORY: DurableObjectNamespace;
    HISTORY: R2Bucket;
  }
}

/** One more key than an R2 list page holds. */
const PAST_ONE_R2_PAGE = 1001;

const CASES = createStorageConformanceSuite(() => {
  throw new Error("case names only");
}).map(({ name }) => name);

function inDurableObject<T>(
  run: (storage: MigrationStorageWriter) => Promise<T>
): Promise<T> {
  const stub = env.ESTATE_HISTORY.get(env.ESTATE_HISTORY.newUniqueId());
  return runInDurableObject(stub, (_instance, state) =>
    run(createDurableObjectStorageWriter(state.storage))
  );
}

async function runCase(
  name: string,
  createWriter: () => MigrationStorageWriter
): Promise<void> {
  const testCase = createStorageConformanceSuite(createWriter).find(
    (candidate) => candidate.name === name
  );
  await testCase!.run();
}

it.each(CASES)("Durable Object storage: %s", (name) =>
  inDurableObject((storage) => runCase(name, () => storage)));

it.each(CASES)("R2: %s", (name) =>
  runCase(name, () =>
    createR2StorageWriter(env.HISTORY, { prefix: `${encodeURI(name)}/` })
  ));

async function publishStates(
  storage: MigrationStorageWriter,
  count: number
): Promise<string[]> {
  const ids: string[] = [];
  for (let n = 0; n < count; n += 1) {
    const bytes = utf8Bytes(`{"state":${n}}`);
    const id = encodeSqlBlob(bytes);
    await storage.publishState(id, bytes);
    ids.push(id);
  }
  return ids.sort();
}

it("lists every state past one R2 page", async () => {
  const storage = createR2StorageWriter(env.HISTORY, { prefix: "paged/" });
  const ids = await publishStates(storage, PAST_ONE_R2_PAGE);
  const listed = await createR2StorageWriter(env.HISTORY, {
    prefix: "paged/",
  }).listStates();
  expect(listed).toEqual(ids);
});

it("lists every state past one R2 page from Durable Object storage too", async () => {
  await inDurableObject(async (storage) => {
    const ids = await publishStates(storage, PAST_ONE_R2_PAGE);
    expect(await storage.listStates()).toEqual(ids);
  });
});

function schemaClient(withTitle: boolean) {
  const post = withTitle
    ? s.model({ id: s.string().id(), title: s.string().nullable() })
    : s.model({ id: s.string().id() });
  return createClient({
    driver: new D1Driver({ database: env.DB }),
    schema: { post: post.map("viborm_history_post") },
  });
}

async function generateTwoStates(
  createWriter: () => MigrationStorageWriter
): Promise<{ names: string[]; check: unknown }> {
  for (const [n, withTitle] of [false, true].entries()) {
    const client = schemaClient(withTitle);
    try {
      await createMigrationClient(client, {
        storage: createWriter(),
      }).generate({ name: `history-${n}` });
    } finally {
      await client.$disconnect();
    }
  }
  const client = schemaClient(true);
  try {
    const reader = createMigrationClient(client, { storage: createWriter() });
    return {
      names: (await reader.list()).map(({ name }) => name).sort(),
      check: await reader.check(),
    };
  } finally {
    await client.$disconnect();
  }
}

const TWO_STATES = {
  names: ["history-0", "history-1"],
  check: { ok: true, findings: [] },
};

it("generates a history into Durable Object storage and reads it back", async () => {
  expect(
    await inDurableObject((storage) => generateTwoStates(() => storage))
  ).toEqual(TWO_STATES);
});

it("generates a history into R2 and reads it back", async () => {
  expect(
    await generateTwoStates(() =>
      createR2StorageWriter(env.HISTORY, { prefix: "tenants/42/" })
    )
  ).toEqual(TWO_STATES);
});
