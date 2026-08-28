import { defineContract } from "@tests/contracts/contract";
import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { windowUserPostSchema } from "@tests/fixtures/user-post-schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

const schema = windowUserPostSchema;

type LikeEscapeClientConfig = VibORMConfig & {
  schema: typeof schema;
  driver: AnyDriver;
};

type LikeEscapeClient = VibORMClient<LikeEscapeClientConfig>;

export interface LikeEscapeBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

/**
 * Executes real SQL for contains/startsWith/endsWith with LIKE wildcard
 * characters (%, _, \) in the search value. These must match literally —
 * an unescaped `%` would match every row, which text-only assertions on
 * generated SQL cannot catch.
 */
export function runLikeEscapeBehavior({
  driverName,
  createDriver,
}: LikeEscapeBehaviorOptions) {
  describe(`${driverName} LIKE wildcard escaping`, () => {
    let client: LikeEscapeClient | undefined;

    beforeEach(async () => {
      client = createClient({
        schema,
        driver: createDriver(),
      });
      await syncLiveSchema(client);
      await client.user.createMany({
        data: [
          { id: "percent", name: "100% organic", email: "p@example.com" },
          { id: "underscore", name: "user_name", email: "u@example.com" },
          { id: "backslash", name: "back\\slash", email: "b@example.com" },
          { id: "plain", name: "plain match", email: "m@example.com" },
          { id: "decoy", name: "1000 units", email: "d@example.com" },
        ],
      });
    });

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    async function findIds(where: Record<string, unknown>) {
      const users = await requireClient(client).user.findMany({ where });
      return users.map((u) => u.id).sort();
    }

    test("contains with literal % matches only literal occurrences", async () => {
      expect(await findIds({ name: { contains: "%" } })).toEqual(["percent"]);
    });

    test("contains with literal _ matches only literal occurrences", async () => {
      expect(await findIds({ name: { contains: "_" } })).toEqual([
        "underscore",
      ]);
    });

    test("contains with literal backslash matches only literal occurrences", async () => {
      expect(await findIds({ name: { contains: "\\" } })).toEqual([
        "backslash",
      ]);
    });

    test("startsWith with literal % does not act as a wildcard", async () => {
      // Unescaped, '100%' would also match '1000 units'
      expect(await findIds({ name: { startsWith: "100%" } })).toEqual([
        "percent",
      ]);
    });

    test("endsWith with literal _ does not act as a wildcard", async () => {
      // Unescaped, '_name' would also match any char followed by 'name'
      expect(await findIds({ name: { endsWith: "_name" } })).toEqual([
        "underscore",
      ]);
    });

    test("insensitive contains with literal % matches only literal occurrences", async () => {
      expect(
        await findIds({ name: { contains: "%", mode: "insensitive" } })
      ).toEqual(["percent"]);
    });

    test("insensitive contains still matches case-insensitively", async () => {
      expect(
        await findIds({ name: { contains: "ORGANIC", mode: "insensitive" } })
      ).toEqual(["percent"]);
    });

    test("plain contains without wildcards still matches", async () => {
      expect(await findIds({ name: { contains: "plain" } })).toEqual(["plain"]);
    });

    test("not-contains with literal % excludes only literal occurrences", async () => {
      expect(await findIds({ name: { not: { contains: "%" } } })).toEqual([
        "backslash",
        "decoy",
        "plain",
        "underscore",
      ]);
    });

    // Decision 7.3 moved default-mode `startsWith` on a plain string column off
    // the `LEFT`/`substr` spelling and onto a per-dialect pattern operator, so
    // the prefix path now runs the user's value through an escaper before the
    // database ever sees it. These probe that escaper on every dialect: each
    // value below is one that an unescaped pattern would answer differently.
    // The seed rows are the ones from `beforeEach`, plus the four here.
    describe("escaped prefix patterns", () => {
      beforeEach(async () => {
        await requireClient(client).user.createMany({
          data: [
            { id: "star", name: "5*7 grid", email: "s@example.com" },
            { id: "question", name: "why? because", email: "q@example.com" },
            { id: "bracket", name: "[draft] title", email: "k@example.com" },
            { id: "mixed", name: "a%b_c\\d end", email: "x@example.com" },
          ],
        });
      });

      test("a percent in the value stays literal", async () => {
        // Unescaped, '50%' is a wildcard after '50' — but nothing here starts
        // with '50' at all, so the decoy is the '100% organic' row that the
        // pattern '%...' would sweep up on a dialect that mishandles it.
        expect(await findIds({ name: { startsWith: "100%" } })).toEqual([
          "percent",
        ]);
        expect(await findIds({ name: { startsWith: "50%" } })).toEqual([]);
      });

      test("an underscore in the value stays literal", async () => {
        // Unescaped, 'user_' would match any 5th character, so 'users' would
        // qualify; escaped, only the literal underscore row does.
        expect(await findIds({ name: { startsWith: "user_" } })).toEqual([
          "underscore",
        ]);
        expect(await findIds({ name: { startsWith: "a_b" } })).toEqual([]);
      });

      test("a trailing escape character in the value stays literal", async () => {
        expect(await findIds({ name: { startsWith: "back\\" } })).toEqual([
          "backslash",
        ]);
      });

      test("a value that is only the escape character stays literal", async () => {
        // The escaper must double this into a well-formed pattern; a raw
        // trailing backslash is a syntax error on PostgreSQL and MySQL.
        expect(await findIds({ name: { startsWith: "\\" } })).toEqual([]);
        expect(await findIds({ name: { contains: "\\" } })).toEqual([
          "backslash",
          "mixed",
        ]);
      });

      test("the empty value matches every row", async () => {
        expect(await findIds({ name: { startsWith: "" } })).toEqual([
          "backslash",
          "bracket",
          "decoy",
          "mixed",
          "percent",
          "plain",
          "question",
          "star",
          "underscore",
        ]);
      });

      test("every wildcard family at once stays literal", async () => {
        expect(await findIds({ name: { startsWith: "a%b_c\\d" } })).toEqual([
          "mixed",
        ]);
        // One character off — proves the pattern is matching the real
        // characters and not wildcarding past them.
        expect(await findIds({ name: { startsWith: "a%b_c\\e" } })).toEqual([]);
      });

      test("SQLite's GLOB metacharacters stay literal on every dialect", async () => {
        // `*`, `?` and `[` mean nothing to LIKE, but they are exactly the
        // wildcards of the GLOB spelling SQLite takes. A dialect-specific
        // escaper that leaked would show up here and nowhere else.
        expect(await findIds({ name: { startsWith: "5*7" } })).toEqual([
          "star",
        ]);
        expect(await findIds({ name: { startsWith: "5*8" } })).toEqual([]);
        expect(await findIds({ name: { startsWith: "why?" } })).toEqual([
          "question",
        ]);
        expect(await findIds({ name: { startsWith: "why!" } })).toEqual([]);
        expect(await findIds({ name: { startsWith: "[draft]" } })).toEqual([
          "bracket",
        ]);
        expect(await findIds({ name: { startsWith: "[dra" } })).toEqual([
          "bracket",
        ]);
      });

      test("the prefix path stays case-sensitive", async () => {
        // The contract `startsWithText` documented and this spelling inherits.
        // A plain `LIKE` would answer both of these on MySQL and SQLite.
        expect(await findIds({ name: { startsWith: "PLAIN" } })).toEqual([]);
        expect(await findIds({ name: { startsWith: "plain" } })).toEqual([
          "plain",
        ]);
      });

      test("insensitive mode is unchanged and still ignores case", async () => {
        // Insensitive mode keeps the fold spelling; this is the complement of
        // the case above, and proves the routing split did not swap them.
        expect(
          await findIds({ name: { startsWith: "PLAIN", mode: "insensitive" } })
        ).toEqual(["plain"]);
        expect(
          await findIds({
            name: { startsWith: "100%", mode: "insensitive" },
          })
        ).toEqual(["percent"]);
        expect(
          await findIds({ name: { startsWith: "5*7", mode: "insensitive" } })
        ).toEqual(["star"]);
      });

      test("endsWith keeps its spelling and its literal wildcards", async () => {
        // 7.3 left `endsWith` alone — no dialect can range an index on a
        // suffix — so this is a guard that the shared escaper did not get
        // wired into it by accident.
        expect(await findIds({ name: { endsWith: "_name" } })).toEqual([
          "underscore",
        ]);
        expect(await findIds({ name: { endsWith: "% organic" } })).toEqual([
          "percent",
        ]);
        expect(await findIds({ name: { endsWith: "GRID" } })).toEqual([]);
      });
    });
  });
}

function requireClient(client: LikeEscapeClient | undefined): LikeEscapeClient {
  if (!client) {
    throw new Error("Client not initialized");
  }
  return client;
}

export const likeEscapeContract = defineContract({
  id: "drivers.like-escape",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runLikeEscapeBehavior,
});
