/**
 * The Durable Object and R2 history bindings over Node stand-ins: the
 * Durable Object SQL API over a Map, and an R2 bucket whose put
 * checks its condition and writes in one step and whose list pages at two
 * keys. The real bindings run the same suite in Miniflare (provider-d1).
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

function r2Bucket(objects = new Map<string, Uint8Array>()): R2Bucket {
  return {
    async put(
      key: string,
      value: Uint8Array,
      options?: { onlyIf?: { etagDoesNotMatch?: string } }
    ) {
      await Promise.resolve();
      if (options?.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) {
        return null;
      }
      objects.set(key, value.slice());
      return { key };
    },
    async get(key: string) {
      const bytes = objects.get(key);
      return bytes ? { arrayBuffer: async () => bytes.slice().buffer } : null;
    },
    async list({ prefix, cursor }: { prefix: string; cursor?: string }) {
      const keys = [...objects.keys()]
        .filter((key) => key.startsWith(prefix) && !(cursor && key <= cursor))
        .sort();
      const page = keys.slice(0, R2_PAGE);
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
