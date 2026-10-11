/**
 * The Durable Object and R2 history bindings over Node stand-ins: the
 * Durable Object SQL API over a Map, and an R2 bucket whose put
 * checks its condition and writes in one step and whose list pages at two
 * keys. The real bindings run the same suite in Miniflare (provider-d1).
 *
 * Two hosted R2 behaviours Miniflare lacks (hosted check 2026-10-11): a put
 * that loses a race for one key may throw error 10058 instead of returning
 * `null`, storing nothing, and a listing pages short of its limit (485, 485,
 * 31 keys of 1,001) while it reports `truncated`.
 */

import type { DurableObjectStorage, R2Bucket } from "@cloudflare/workers-types";
import { utf8Bytes } from "@src/migrations/identity";
import { createStorageConformanceSuite } from "@src/migrations/storage/conformance";
import type { MigrationStorageWriter } from "@src/migrations/storage/contract";
import { createDurableObjectStorageWriter } from "@src/migrations/storage/durable-object";
import {
  type ObjectStoreConditionalPut,
  ObjectStoreEstateStorage,
} from "@src/migrations/storage/object-store";
import { createR2StorageWriter } from "@src/migrations/storage/r2";
import { encodeSqlBlob } from "@src/migrations/v1-parse";
import { expect, test } from "vitest";

const R2_PAGE = 2;
const R2_CONTENTION = new Error(
  "put: Reduce your concurrent request rate for the same object. (10058)"
);

/**
 * The binding's four statements over a Map. `exec` is synchronous, as the
 * Durable Object SQL API is, so the conditional insert checks and writes in
 * one step.
 */
function durableObjectStorage(): DurableObjectStorage {
  const rows = new Map<string, ArrayBuffer>();
  const exec = (query: string, ...bindings: unknown[]) => {
    const statement = query.split(" ", 1)[0];
    if (statement === "INSERT") {
      const [key, bytes] = bindings as [string, ArrayBuffer];
      if (rows.has(key)) return { toArray: () => [] };
      rows.set(key, bytes);
      return { toArray: () => [{ key }] };
    }
    if (statement === "SELECT" && query.includes("bytes")) {
      const bytes = rows.get(bindings[0] as string);
      return { toArray: () => (bytes ? [{ bytes: bytes.slice(0) }] : []) };
    }
    if (statement === "SELECT") {
      const prefix = bindings[1] as string;
      const keys = [...rows.keys()].filter((key) => key.startsWith(prefix));
      return { toArray: () => keys.sort().map((key) => ({ key })) };
    }
    return { toArray: () => [] };
  };
  return { sql: { exec } } as unknown as DurableObjectStorage;
}

/**
 * `contended`: a conditional put on a present key throws 10058, as hosted R2
 * may to a racing loser; `refused` keys throw it whether present or not.
 */
function r2Bucket(
  objects = new Map<string, Uint8Array>(),
  {
    contended = false,
    refused = new Set<string>(),
    pageSize = R2_PAGE,
  }: {
    readonly contended?: boolean;
    readonly refused?: ReadonlySet<string>;
    readonly pageSize?: number;
  } = {}
): R2Bucket {
  return {
    async put(
      key: string,
      value: Uint8Array,
      options?: { onlyIf?: { etagDoesNotMatch?: string } }
    ) {
      await Promise.resolve();
      if (refused.has(key)) throw R2_CONTENTION;
      if (options?.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) {
        if (contended) throw R2_CONTENTION;
        return null;
      }
      objects.set(key, value.slice());
      return { key };
    },
    async get(key: string) {
      const bytes = objects.get(key);
      return bytes ? { arrayBuffer: async () => bytes.slice().buffer } : null;
    },
    async head(key: string) {
      return objects.has(key) ? { key } : null;
    },
    async list({ prefix, cursor }: { prefix: string; cursor?: string }) {
      const keys = [...objects.keys()]
        .filter((key) => key.startsWith(prefix) && !(cursor && key <= cursor))
        .sort();
      const page = keys.slice(0, pageSize);
      const truncated = keys.length > page.length;
      return {
        objects: page.map((key) => ({ key })),
        truncated,
        cursor: truncated ? page.at(-1) : undefined,
      };
    },
  } as unknown as R2Bucket;
}

async function failingCases(
  createWriter: () => MigrationStorageWriter
): Promise<string[]> {
  const failures: string[] = [];
  for (const testCase of createStorageConformanceSuite(createWriter)) {
    await testCase.run().catch(() => failures.push(testCase.name));
  }
  return failures;
}

test("the Durable Object binding passes the conformance suite", async () => {
  expect(
    await failingCases(() =>
      createDurableObjectStorageWriter(durableObjectStorage())
    )
  ).toEqual([]);
});

test("the R2 binding passes the conformance suite across listing pages", async () => {
  expect(await failingCases(() => createR2StorageWriter(r2Bucket()))).toEqual(
    []
  );
});

test("an R2 put that loses with 10058 is a lost put-if-absent", async () => {
  expect(
    await failingCases(() =>
      createR2StorageWriter(
        r2Bucket(undefined, {
          contended: true,
        })
      )
    )
  ).toEqual([]);
  const objects = new Map<string, Uint8Array>();
  const winner = createR2StorageWriter(r2Bucket(objects));
  const loser = createR2StorageWriter(r2Bucket(objects, { contended: true }));
  const bytes = utf8Bytes("SELECT 1;");
  const id = encodeSqlBlob(bytes);
  expect(await winner.publishSql(id, bytes)).toEqual({ outcome: "created" });
  expect(await loser.publishSql(id, bytes)).toEqual({ outcome: "identical" });
  await expect(
    loser.publishSql(id, utf8Bytes("SELECT 2;"))
  ).rejects.toMatchObject({ code: "V11022" });
});

test("an R2 put refused with 10058 where no object exists stays an error", async () => {
  const bytes = utf8Bytes("SELECT 1;");
  const id = encodeSqlBlob(bytes);
  const writer = createR2StorageWriter(
    r2Bucket(undefined, { refused: new Set([`sql/${id}.sql`]) })
  );
  await expect(writer.publishSql(id, bytes)).rejects.toBe(R2_CONTENTION);
});

test("an R2 listing follows truncated pages shorter than their limit", async () => {
  const objects = new Map<string, Uint8Array>();
  const writer = createR2StorageWriter(r2Bucket(objects, { pageSize: 485 }), {
    prefix: "tenants/1/",
  });
  const ids = Array.from({ length: 1001 }, (_, index) => {
    const bytes = utf8Bytes(`state ${index}`);
    return { bytes, id: encodeSqlBlob(bytes) };
  });
  for (const { bytes, id } of ids) await writer.publishState(id, bytes);
  expect(await writer.listStates()).toEqual(ids.map(({ id }) => id).sort());
});

test("R2 estates under different prefixes share a bucket apart", async () => {
  const objects = new Map<string, Uint8Array>();
  const first = createR2StorageWriter(r2Bucket(objects), {
    prefix: "tenants/1/",
  });
  const second = createR2StorageWriter(r2Bucket(objects), {
    prefix: "tenants/10/",
  });
  const ids = ["one", "two", "three"].map((label) => {
    const bytes = utf8Bytes(label);
    return { bytes, id: encodeSqlBlob(bytes) };
  });
  for (const { bytes, id } of ids) await first.publishState(id, bytes);

  expect(await first.listStates()).toEqual(ids.map(({ id }) => id).sort());
  expect(await second.listStates()).toEqual([]);
  expect(await second.readState(ids[0]!.id)).toBeNull();
  expect([...objects.keys()].every((key) => key.startsWith("tenants/1/"))).toBe(
    true
  );
});

/** A strong in-memory store with one operation broken. */
function brokenStore(
  broken: (
    objects: Map<string, Uint8Array>
  ) => Partial<ObjectStoreConditionalPut>
): () => MigrationStorageWriter {
  const objects = new Map<string, Uint8Array>();
  const store: ObjectStoreConditionalPut = {
    putIfAbsent: async (key, bytes) => {
      if (objects.has(key)) return "exists";
      objects.set(key, bytes);
      return "created";
    },
    get: async (key) => objects.get(key) ?? null,
    list: async (prefix) =>
      [...objects.keys()].filter((key) => key.startsWith(prefix)),
    ...broken(objects),
  };
  return () => new ObjectStoreEstateStorage(store);
}

test.each([
  {
    store: "creates by get-then-put across an await",
    broken: brokenStore((objects) => ({
      async putIfAbsent(key, bytes) {
        const exists = objects.has(key);
        await Promise.resolve();
        if (exists) return "exists";
        objects.set(key, bytes);
        return "created";
      },
    })),
    failing: [
      "concurrent identical creates report created exactly once",
      "concurrent conflicting creates keep one winner and refuse the rest",
    ],
  },
  {
    store: "lists nothing and reads absent keys as empty bytes",
    broken: brokenStore((objects) => ({
      get: async (key) => objects.get(key) ?? new Uint8Array(),
      list: async () => [],
    })),
    failing: [
      "absent artifacts read as null",
      "published artifacts are listed as soon as publish returns",
      "a listed state's snapshot and SQL are already readable (manifest last)",
    ],
  },
  {
    store: "lists a state whose snapshot it cannot read",
    broken: brokenStore((objects) => ({
      get: async (key) =>
        key.startsWith("snapshots/") ? null : (objects.get(key) ?? null),
    })),
    failing: [
      "a listed state's snapshot and SQL are already readable (manifest last)",
    ],
  },
])("the suite refuses a store that $store", async ({ broken, failing }) => {
  expect(await failingCases(broken)).toEqual(failing);
});
