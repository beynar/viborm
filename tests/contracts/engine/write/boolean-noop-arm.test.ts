import {
  booleanNoOpSchema,
  runBooleanNoOpArmBehavior,
} from "@tests/contracts/engine/write/boolean-noop-arm-behavior";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { expect, test } from "vitest";

// Both substrates on PGlite; the driver matrix legs run the same module. Each leg
// takes a private SCHEMA on the worker's ONE PGlite instead of a database of its own.
runBooleanNoOpArmBehavior({
  name: "PGlite transaction",
  pgliteMode: "transaction",
});
runBooleanNoOpArmBehavior({
  name: "PGlite atomic batch",
  pgliteMode: "atomicBatch",
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

/**
 * The public witnesses take a private SCHEMA on the same worker-wide PGlite the legs
 * above run on, emptied before each test, so neither of them opens a database.
 */
const getFamily = usePGliteSchemaFamily(booleanNoOpSchema);

test("through the PUBLIC client: `disconnect: false` moves nothing, `true` disconnects", async () => {
  const client: any = getFamily().client;
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
});

test("through the PUBLIC client: an empty nested update writes nothing and needs no target", async () => {
  // These two used to build a PGlite each and release neither, so every pass left two
  // live databases held for the worker's lifetime. The schema family owns the one
  // database and the connection to it now, and empties these tables between tests.
  const client: any = getFamily().client;
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
});
