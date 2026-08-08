import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { expect, test } from "vitest";
import {
  booleanNoOpSchema,
  runBooleanNoOpArmBehavior,
} from "@tests/contracts/engine/write/boolean-noop-arm-behavior";

// Both substrates on PGlite; the driver matrix legs run the same module.
runBooleanNoOpArmBehavior({
  name: "PGlite transaction",
  createDriver: () => new PGliteDriver(),
});
runBooleanNoOpArmBehavior({
  name: "PGlite atomic batch",
  createDriver: () => new BatchOnlyPGliteDriver(),
});

// ---------------------------------------------------------------------------
// THE PUBLIC PATH.
//
// The behavior module drives `UpdateOperation` at the operation seam, because the
// MySQL2 batch-forced driver cannot serve a plain `update` through the client at all.
// That leaves one thing unwitnessed there — that the client proxy reaches the same
// answer — so it is witnessed here, once per absorbed family, through
// `await client.<model>.update(...)`: the whole path a user takes.
// ---------------------------------------------------------------------------

test("through the PUBLIC client: `disconnect: false` moves nothing, `true` disconnects", async () => {
  const client: any = createClient({
    schema: booleanNoOpSchema,
    driver: new PGliteDriver(),
  });
  try {
    await push(client, { force: true });
    await client.card.create({ data: { id: 10, face: "face-a" } });
    await client.holder.create({ data: { id: 1, name: "h", cardId: 10 } });

    const noOp = await client.holder.update({
      where: { id: 1 },
      data: { card: { disconnect: false } },
    });
    expect(noOp).toMatchObject({ cardId: 10 });

    const acted = await client.holder.update({
      where: { id: 1 },
      data: { card: { disconnect: true } },
    });
    expect(acted).toMatchObject({ cardId: null });
  } finally {
    await client.$disconnect();
  }
});

test("through the PUBLIC client: an empty nested update writes nothing and needs no target", async () => {
  const client: any = createClient({
    schema: booleanNoOpSchema,
    driver: new PGliteDriver(),
  });
  try {
    await push(client, { force: true });
    await client.holder.create({ data: { id: 1, name: "h" } });
    await client.item.create({
      data: { id: 30, title: "item-a", holderId: 1 },
    });

    await client.holder.update({
      where: { id: 1 },
      data: { items: { update: { where: { id: 30 }, data: {} } } },
    });
    await client.holder.update({
      where: { id: 1 },
      data: { items: { update: { where: { id: 999 }, data: {} } } },
    });
    expect(await client.item.findUnique({ where: { id: 30 } })).toMatchObject({
      title: "item-a",
    });
  } finally {
    // These two are the only PGlite-backed clients in this cohort that were never
    // released AT ALL — not merely released on the success path — so each pass left
    // a live database held for the worker's lifetime.
    await client.$disconnect();
  }
});
