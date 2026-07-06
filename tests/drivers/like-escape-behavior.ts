import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { windowUserPostSchema } from "../fixtures/user-post-schema";

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
      await push(client, { force: true });
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
  });
}

function requireClient(client: LikeEscapeClient | undefined): LikeEscapeClient {
  if (!client) {
    throw new Error("Client not initialized");
  }
  return client;
}
