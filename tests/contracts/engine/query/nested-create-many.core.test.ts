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
                  // @ts-expect-error The parent supplies this membership scalar.
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
