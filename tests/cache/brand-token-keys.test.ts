import { MemoryCache } from "@cache/drivers/memory";
import { generateCacheKey } from "@cache/key";
import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { push } from "@migrations";
import { AnyNull, DbNull, JsonNull, s } from "@schema";
import { FIELD_REF_BRAND } from "@schema/field-ref";
import { sql } from "@sql";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";

/**
 * A cache key must separate a BRANDED TOKEN from a user document that merely
 * looks like one.
 *
 * The operand positions of this client accept two different kinds of value: the
 * ordinary data a column holds, and a handful of tokens that stand for
 * something that data cannot say — `DbNull`/`JsonNull`/`AnyNull`, a field
 * reference, an SQL fragment. A JSON column accepts an ARBITRARY object, so
 * every one of those tokens has a legal user-data look-alike, and a serializer
 * that walked `Object.keys` gave the token and the look-alike ONE cache entry:
 * `equals: DbNull` and `equals: { kind: "DbNull" }` are different questions
 * with different answers, and the cached client answered the second with the
 * first's rows — or the first with the second's, depending on which ran first —
 * for the whole TTL.
 *
 * These pin the separation from both ends: a token never keys like a document,
 * two spellings of the SAME query still share one entry, and no JSON value —
 * however it is spelled, including with raw control characters — can forge the
 * reserved namespace the tokens key in.
 */

const keyFor = (operand: unknown) =>
  generateCacheKey("entry", "findMany", {
    where: { meta: { equals: operand } },
  });

describe("JSON null sentinels vs their look-alike documents", () => {
  test("a sentinel never keys like the document that spells its name", () => {
    for (const token of [DbNull, JsonNull, AnyNull]) {
      // The exact document `Object.keys` used to turn the sentinel into.
      expect(keyFor(token)).not.toBe(keyFor({ kind: token.kind }));
      // …and the other spellings of the same name.
      expect(keyFor(token)).not.toBe(keyFor(token.kind));
      expect(keyFor(token)).not.toBe(keyFor(token.toJSON()));
    }
  });

  test("the three tokens, and the three documents, all stay apart", () => {
    const keys = [
      keyFor(DbNull),
      keyFor(JsonNull),
      keyFor(AnyNull),
      keyFor({ kind: "DbNull" }),
      keyFor({ kind: "JsonNull" }),
      keyFor({ kind: "AnyNull" }),
      keyFor(null),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("equal payloads still share one entry", () => {
    // The other half of the property: separating the token from the document
    // must not separate a query from ITSELF.
    expect(keyFor(DbNull)).toBe(keyFor(DbNull));
    expect(keyFor({ kind: "DbNull" })).toBe(keyFor({ kind: "DbNull" }));
    expect(keyFor({ a: 1, b: [DbNull, 2] })).toBe(
      keyFor({ b: [DbNull, 2], a: 1 })
    );
  });
});

describe("field references vs their look-alike documents", () => {
  const ref = (model: string, field: string) =>
    Object.freeze({
      [FIELD_REF_BRAND]: true as const,
      model,
      field,
      type: "int",
      list: false,
    });

  test("a reference never keys like the document that spells its fields", () => {
    const lookAlike = {
      model: "post",
      field: "likes",
      type: "int",
      list: false,
    };
    expect(keyFor(ref("post", "likes"))).not.toBe(keyFor(lookAlike));
  });

  test("two different references key differently", () => {
    expect(keyFor(ref("post", "likes"))).not.toBe(keyFor(ref("post", "views")));
    expect(keyFor(ref("post", "likes"))).not.toBe(
      keyFor(ref("comment", "likes"))
    );
    // The model and the field are one token, not a concatenation of two.
    expect(keyFor(ref("post", "likes"))).not.toBe(
      keyFor(ref("post:likes", ""))
    );
  });

  test("the same reference keys the same", () => {
    expect(keyFor(ref("post", "likes"))).toBe(keyFor(ref("post", "likes")));
  });
});

describe("SQL fragments vs their look-alike documents", () => {
  test("a fragment never keys like the document that spells its parts", () => {
    const fragment = sql`${1} + ${2}`;
    expect(keyFor(fragment)).not.toBe(
      keyFor({ sql: fragment.toStatement("?"), values: fragment.values })
    );
  });

  /**
   * `isSql` is a duck-type probe on `strings` + `values`, and a JSON column may
   * legally hold exactly that shape — validation admits it on purpose. Keying
   * such a document once threw a bare `TypeError: value.toStatement is not a
   * function` from inside cache key generation, so this pins BOTH halves: the
   * document keys, and it keys as itself.
   */
  test("a document shaped like a fragment keys as data, not as a fragment", () => {
    const lookAlike = { strings: ["", " + ", ""], values: [1, 2] };
    expect(() => keyFor(lookAlike)).not.toThrow();
    expect(keyFor(lookAlike)).toBe(keyFor({ ...lookAlike }));
    expect(keyFor(lookAlike)).not.toBe(keyFor(sql`${1} + ${2}`));
    expect(keyFor(lookAlike)).not.toBe(
      keyFor({ strings: ["", " - ", ""], values: [1, 2] })
    );
  });

  test("two different fragments key differently, equal ones key alike", () => {
    expect(keyFor(sql`${1} + ${2}`)).toBe(keyFor(sql`${1} + ${2}`));
    expect(keyFor(sql`${1} + ${2}`)).not.toBe(keyFor(sql`${1} - ${2}`));
    expect(keyFor(sql`${1} + ${2}`)).not.toBe(keyFor(sql`${1} + ${3}`));
  });

  test("a fragment's bound tokens ride along in the key", () => {
    expect(keyFor(sql`x = ${DbNull}`)).not.toBe(keyFor(sql`x = ${JsonNull}`));
    expect(keyFor(sql`x = ${DbNull}`)).not.toBe(
      keyFor(sql`x = ${{ kind: "DbNull" }}`)
    );
  });
});

describe("the reserved namespace", () => {
  /**
   * The forgery attempt. The tokens key inside a namespace opened by a raw
   * U+001F, and a JSON string may CONTAIN one — but every string this
   * serializer emits goes through `JSON.stringify`, which turns any code point
   * below U+0020 into a printable escape. The byte a user supplies therefore
   * never reaches the output as a byte, and none of these spellings can land on
   * the sentinel's entry.
   */
  test("no JSON value can forge a brand token", () => {
    const sentinelKey = keyFor(DbNull);
    const bodies = [
      "viborm.json-null:DbNull",
      "viborm.field-ref:post:likes",
      "viborm.bigint:1",
    ];
    const wrappers: string[] = [];
    for (let code = 0; code <= 0x9f; code++) {
      wrappers.push(String.fromCharCode(code));
    }
    wrappers.push("\uD800", "\\u001F", "\\u001f", "");

    for (const wrapper of wrappers) {
      for (const body of bodies) {
        const forged = `${wrapper}${body}${wrapper}`;
        expect(keyFor(forged)).not.toBe(sentinelKey);
        // …nor as an object KEY, nor nested where a document can reach.
        expect(keyFor({ [forged]: forged })).not.toBe(sentinelKey);
        expect(keyFor([forged])).not.toBe(sentinelKey);
      }
    }
  });

  test("non-JSON scalars key apart from the strings that spell them", () => {
    // The same rule applied to the values JSON cannot carry: what is not a JSON
    // value does not serialize like one.
    expect(keyFor(10n)).not.toBe(keyFor("10n"));
    expect(keyFor(10n)).not.toBe(keyFor("10"));
    expect(keyFor(10n)).not.toBe(keyFor(10));
    const date = new Date("2024-01-01T00:00:00.000Z");
    expect(keyFor(date)).not.toBe(keyFor(date.toISOString()));
    expect(keyFor(new Uint8Array([1, 2, 3]))).not.toBe(keyFor("base64:AQID"));
    // …and still keys itself the same.
    expect(keyFor(new Uint8Array([1, 2, 3]))).toBe(
      keyFor(new Uint8Array([1, 2, 3]))
    );
    expect(keyFor(date)).toBe(keyFor(new Date(date.getTime())));
  });
});

// =============================================================================
// THE END-TO-END WITNESS
// =============================================================================

const entry = s
  .model({
    id: s.string().id(),
    meta: s.json().nullable(),
    required: s.json(),
  })
  .map("cache_brand_token_entries");

const schema = { entry };

let pglite: PGlite;
let driver: PGliteDriver;

const makeClient = () => createClient({ schema, driver });
const makeCachedClient = (cache: MemoryCache) =>
  createClient({ schema, driver, cache });

const seed = async () => {
  // Written by a CACHELESS client: seeding must not populate anything.
  await makeClient().entry.createMany({
    data: [
      { id: "db", meta: DbNull, required: { r: 1 } },
      { id: "shape", meta: { kind: "DbNull" }, required: { r: 1 } },
    ],
  });
};

beforeAll(async () => {
  pglite = new PGlite();
  driver = new PGliteDriver({ client: pglite });
  await push(createClient({ schema, driver }), { force: true });
});

beforeEach(async () => {
  await pglite.exec(`DELETE FROM "cache_brand_token_entries"`);
});

describe("a cached client answers each question with its own rows", () => {
  test("the sentinel query does not serve the document query's entry", async () => {
    const client = makeCachedClient(new MemoryCache());
    await seed();

    const sentinel = await client
      .$withCache({ ttl: 60_000 })
      .entry.findMany({ where: { meta: { equals: DbNull } } });
    expect(sentinel.map((row) => row.id)).toEqual(["db"]);

    const document = await client
      .$withCache({ ttl: 60_000 })
      .entry.findMany({ where: { meta: { equals: { kind: "DbNull" } } } });
    expect(document.map((row) => row.id)).toEqual(["shape"]);
  });

  test("and the reverse order poisons nothing either", async () => {
    const client = makeCachedClient(new MemoryCache());
    await seed();

    const document = await client
      .$withCache({ ttl: 60_000 })
      .entry.findMany({ where: { meta: { equals: { kind: "DbNull" } } } });
    expect(document.map((row) => row.id)).toEqual(["shape"]);

    const sentinel = await client
      .$withCache({ ttl: 60_000 })
      .entry.findMany({ where: { meta: { equals: DbNull } } });
    expect(sentinel.map((row) => row.id)).toEqual(["db"]);
  });

  test("the cached answers are the uncached ones", async () => {
    const client = makeCachedClient(new MemoryCache());
    const uncached = makeClient();
    await seed();

    for (const operand of [DbNull, { kind: "DbNull" }]) {
      const cached = await client
        .$withCache({ ttl: 60_000 })
        .entry.findMany({ where: { meta: { equals: operand } } });
      const fresh = await uncached.entry.findMany({
        where: { meta: { equals: operand } },
      });
      expect(cached.map((row) => row.id)).toEqual(fresh.map((row) => row.id));
    }
  });

  test("the same question twice is still one cache entry", async () => {
    const client = makeCachedClient(new MemoryCache());
    await seed();

    const first = await client
      .$withCache({ ttl: 60_000 })
      .entry.findMany({ where: { meta: { equals: DbNull } } });
    expect(first.map((row) => row.id)).toEqual(["db"]);

    // A row the cached answer must NOT know about: it is written by a client
    // with no cache of its own, so only a genuine HIT keeps it out of the
    // second answer.
    await makeClient().entry.create({
      data: { id: "sneaky", meta: DbNull, required: { r: 2 } },
    });

    const second = await client
      .$withCache({ ttl: 60_000 })
      .entry.findMany({ where: { meta: { equals: DbNull } } });
    expect(second.map((row) => row.id)).toEqual(["db"]);
  });
});
