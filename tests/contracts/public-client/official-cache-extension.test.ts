import { createClient } from "@drivers/pglite";
import { s } from "@src/index";
import { afterEach, describe, expect, it } from "vitest";

const item = s.model({ id: s.string().id(), name: s.string() });
const schema = { item };
const clients: Array<{ $disconnect(): Promise<void> }> = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

describe("official cache PGlite wrapper", () => {
  it("does not read removed cache config accessors", () => {
    const reads = { cache: 0, cacheVersion: 0, waitUntil: 0 };
    const config = Object.defineProperties(
      { schema, dataDir: "memory://" },
      Object.getOwnPropertyDescriptors({
        get cache() {
          reads.cache += 1;
          throw new Error("removed cache accessor was read");
        },
        get cacheVersion() {
          reads.cacheVersion += 1;
          throw new Error("removed cacheVersion accessor was read");
        },
        get waitUntil() {
          reads.waitUntil += 1;
          throw new Error("removed waitUntil accessor was read");
        },
      })
    );

    const client = Reflect.apply(createClient, undefined, [config]);
    clients.push(client);

    expect(reads).toEqual({ cache: 0, cacheVersion: 0, waitUntil: 0 });
  });
});
