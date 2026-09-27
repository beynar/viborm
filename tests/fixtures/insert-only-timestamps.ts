// biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared assertion helpers are invoked only from registered tests.
/**
 * Live cells for issue #47 — a creation timestamp survives an attempted update.
 *
 * Shared by `tests/providers/local/sqlite3-insert-only-timestamps.test.ts` and
 * `tests/providers/local/pglite-insert-only-timestamps.test.ts`. Each cell seeds
 * rows with explicit creation values, attempts to overwrite them through one
 * public update placement, and reads the stored rows back: the attempt must
 * fail with the admission refusal and leave every column — the refused
 * timestamp and the valid key beside it — exactly as seeded.
 */

import type { VibORMClient, VibORMConfig } from "@client/client";
import { ValidationError } from "@errors";
import { s } from "@schema";
import { expect, test } from "vitest";

const ledger = s
  .model({
    id: s.string().id(),
    title: s.string(),
    createdAt: s.dateTime().now(),
    bornOn: s.date().nullable().now(),
    openedAt: s.time().now().map("opened_at"),
    updatedAt: s.dateTime().updatedAt(),
    entries: s.toMany(() => entry),
  })
  .map("ioa_ledgers");

const entry = s
  .model({
    id: s.string().id(),
    body: s.string(),
    createdAt: s.dateTime().now().map("created_at"),
    ledgerId: s.string(),
    ledger: s
      .toOne(() => ledger)
      .fields("ledgerId")
      .references("id"),
  })
  .map("ioa_entries");

export const insertOnlyTimestampSchema = { ledger, entry };

type InsertOnlyClient = VibORMClient<
  VibORMConfig<typeof insertOnlyTimestampSchema>
>;

const CREATED = new Date("2026-01-01T00:00:00.000Z");
const LATER = new Date("2026-02-01T00:00:00.000Z");

const seed = async (client: InsertOnlyClient) => {
  await client.ledger.create({
    data: {
      id: "l1",
      title: "seeded",
      createdAt: CREATED,
      bornOn: CREATED,
      openedAt: "10:30:00",
      updatedAt: CREATED,
      entries: {
        create: [{ id: "e1", body: "seeded", createdAt: CREATED }],
      },
    },
  });
  return snapshot(client);
};

const snapshot = async (client: InsertOnlyClient) => ({
  ledgers: await client.ledger.findMany({ orderBy: { id: "asc" } }),
  entries: await client.entry.findMany({ orderBy: { id: "asc" } }),
});

/** `attempt` is refused by admission and the stored rows are untouched. */
const refusedAndUnchanged = async (
  client: InsertOnlyClient,
  key: string,
  attempt: (client: InsertOnlyClient) => PromiseLike<unknown>
) => {
  const before = await seed(client);
  const outcome = await Promise.resolve(attempt(client)).then(
    () => "resolved",
    (error: unknown) => error
  );
  expect(outcome).toBeInstanceOf(ValidationError);
  expect(outcome).toMatchObject({
    message: expect.stringContaining(`Unknown key: ${key}`),
  });
  expect(await snapshot(client)).toEqual(before);
};

/** Register the cells against a client the caller provisions per test. */
export function insertOnlyTimestampCells(
  getClient: () => InsertOnlyClient
): void {
  test("the seeded creation values are the stored ones", async () => {
    const { ledgers, entries } = await seed(getClient());
    expect(ledgers[0]?.createdAt).toEqual(CREATED);
    expect(ledgers[0]?.bornOn).toEqual(CREATED);
    expect(entries[0]?.createdAt).toEqual(CREATED);
  });

  test("an omitted creation timestamp is generated on create", async () => {
    const client = getClient();
    const before = Date.now();
    const created = await client.ledger.create({
      data: { id: "l2", title: "generated" },
    });
    expect(created.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(created.bornOn).toBeInstanceOf(Date);
    expect(typeof created.openedAt).toBe("string");
  });

  test.each([
    ["createdAt", { createdAt: LATER }],
    ["createdAt", { createdAt: { set: LATER } }],
    ["bornOn", { bornOn: null }],
    ["openedAt", { openedAt: "11:00:00" }],
  ] as const)("root update of %s is refused beside a valid key", async (key, data) =>
    refusedAndUnchanged(getClient(), key, (client) =>
      Reflect.apply(client.ledger.update, client.ledger, [
        { where: { id: "l1" }, data: { title: "overwritten", ...data } },
      ])
    ));

  test("updateMany is refused", async () =>
    refusedAndUnchanged(getClient(), "createdAt", (client) =>
      Reflect.apply(client.ledger.updateMany, client.ledger, [
        { where: {}, data: { title: "overwritten", createdAt: LATER } },
      ])
    ));

  test("upsert's update arm is refused on an existing row", async () =>
    refusedAndUnchanged(getClient(), "createdAt", (client) =>
      Reflect.apply(client.ledger.upsert, client.ledger, [
        {
          where: { id: "l1" },
          create: { id: "l1", title: "created" },
          update: { title: "overwritten", createdAt: LATER },
        },
      ])
    ));

  test("a nested updateMany is refused", async () =>
    refusedAndUnchanged(getClient(), "createdAt", (client) =>
      Reflect.apply(client.ledger.update, client.ledger, [
        {
          where: { id: "l1" },
          data: {
            title: "overwritten",
            entries: {
              updateMany: {
                where: {},
                data: { body: "overwritten", createdAt: LATER },
              },
            },
          },
        },
      ])
    ));

  test("ordinary and `.updatedAt()` assignments still write, leaving the creation values", async () => {
    const client = getClient();
    const before = await seed(client);
    const updated = await client.ledger.update({
      where: { id: "l1" },
      data: { title: "renamed", updatedAt: LATER },
    });
    expect(updated.title).toBe("renamed");
    expect(updated.updatedAt).toEqual(LATER);
    expect(updated.createdAt).toEqual(before.ledgers[0]?.createdAt);
    expect(updated.bornOn).toEqual(before.ledgers[0]?.bornOn);
    expect(updated.openedAt).toEqual(before.ledgers[0]?.openedAt);
  });
}
