import { createClient } from "@client/client";
import { nestedCreateManySchema } from "@tests/contracts/engine/query/nested-create-many-schema";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { describe, expect, test } from "vitest";

describe("nested createMany validation before execution", () => {
  test("rejects the enclosing membership scalar before provider dispatch", async () => {
    const client = createClient({
      schema: nestedCreateManySchema,
      driver: new PlanningDriver("postgresql"),
    });
    await expect(
      client.user.create({
        data: {
          id: "user-1",
          name: "John",
          posts: {
            createMany: {
              data: [
                {
                  id: "post-1",
                  title: "First Post",
                  // PIN, not a claim: the membership scalar the parent supplies
                  // IS omitted from this schema type — `{ userId }` ALONE is
                  // TS2353 against `VOmit<RequireKeys<Partial<...>>>` — but
                  // BESIDE the two real keys it compiles, at the documented
                  // `data`-level ceiling (AGENTS.md "pin what you cannot key";
                  // the same ceiling is pinned for nested create/update data in
                  // tests/types/client/contextual-typing-gate.core.types.ts, N1).
                  // Measured: `userId: 123` compiles here too, so the key is not
                  // type-checked at this position at all. No `@ts-expect-error`,
                  // so the day `data` becomes keyable this line goes red and
                  // someone deletes the pin. The runtime refusal below is the
                  // executable half of the claim.
                  userId: "user-1",
                },
              ],
            },
          },
        },
      })
    ).rejects.toThrow("Unknown key: userId");
  });
});
