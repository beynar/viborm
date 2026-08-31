import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";

import { s } from "@schema";
import { observeClientOperations } from "@tests/contracts/engine/write/operation-observer";
import {
  closeTestPGlite,
  openTestPGlite as openBorrowedPGlite,
} from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { expect, test } from "vitest";

test("nested update resolves a manyToOne target declared later", async () => {
  const team = s
    .model({
      id: s.string().id(),
      name: s.string(),
      members: s.toMany(() => member),
    })
    .map("forward_team");
  // This declaration order is the regression: member's FK target does not exist yet.
  const member = s
    .model({
      id: s.string().id(),
      name: s.string(),
      teamId: s.string().nullable(),
      team: s
        .toOne(() => team)
        .fields("teamId")
        .references("id"),
      badgeId: s.int().nullable(),
      badge: s
        .toOne(() => badge)
        .fields("badgeId")
        .references("id"),
    })
    .map("forward_member");
  const badge = s
    .model({
      id: s.int().id().increment(),
      code: s.string(),
      members: s.toMany(() => member),
    })
    .map("forward_badge");
  const schema = { team, member, badge };
  const database = openBorrowedPGlite();
  const driver = new PGliteDriver({ client: database });
  const baseClient = createClient({ schema, driver });

  try {
    await syncLiveSchema(baseClient);
    await baseClient.team.create({ data: { id: "t1", name: "t1" } });
    await baseClient.member.create({
      data: { id: "m1", name: "m1", teamId: "t1" },
    });

    const fallbackClient: Record<
      string,
      Record<string, (args: Record<string, unknown>) => unknown>
    > = new Proxy(
      {},
      {
        get: (_target, modelName) => Reflect.get(baseClient, modelName),
      }
    );
    const observed = observeClientOperations({
      schema,
      driver,
    });
    const updateTeam = observed.client.team?.update;
    if (!updateTeam) {
      throw new Error("Observed observed team.update is unavailable");
    }
    await updateTeam({
      where: { id: "t1" },
      data: {
        members: {
          update: {
            where: { id: "m1" },
            data: { name: "m1b", badge: { create: { code: "x" } } },
          },
        },
      },
    });

    await expect(
      baseClient.member.findUnique({ where: { id: "m1" } })
    ).resolves.toMatchObject({
      name: "m1b",
      badgeId: 1,
    });
    await expect(baseClient.badge.findMany()).resolves.toMatchObject([
      { id: 1, code: "x" },
    ]);
    expect(observed.operations).toContainEqual({
      model: "team",
      operation: "update",
      boundary: "production",
    });
  } finally {
    await baseClient.$disconnect();
    await closeTestPGlite(database);
  }
});
