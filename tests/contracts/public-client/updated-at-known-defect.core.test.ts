/**
 * KNOWN DEFECT: `.updatedAt()` does not refresh on an update that omits it.
 *
 * The datetime guide used to promise "update to current timestamp on every
 * update". Today `.updatedAt()` installs a current-time default on create and
 * leaves the field updatable; nothing in admission, the query engine or the
 * migration drivers reads the `updatedAt` generator. These cells document that
 * behaviour on a live SQLite3 client. They are NOT a contract: the first two
 * assertions of the second cell record the defect and must be inverted by the
 * fix.
 *
 * Acceptance conditions for the fix: an update that omits the field moves it
 * to the statement's time on every provider, `updateMany` and nested updates
 * included; an update that names the field keeps the named value; create keeps
 * its current default and an explicit create value.
 */

import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";

const note = s.model({
  id: s.string().id(),
  label: s.string(),
  touchedAt: s.dateTime().updatedAt(),
});
const schema = { note };

const SEEDED = new Date("2026-01-01T00:00:00.000Z");
const NAMED = new Date("2026-02-01T00:00:00.000Z");

describe("known defect: `.updatedAt()` on update", () => {
  let disconnect: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await disconnect?.();
    disconnect = undefined;
  });

  async function world() {
    const client = createClient({
      schema,
      driver: new SQLite3Driver({ dataDir: ":memory:" }),
    });
    disconnect = () => client.$disconnect();
    await syncLiveSchema(client);
    return client;
  }

  test("create defaults the field to the current time, and keeps an explicit value", async () => {
    const client = await world();
    const before = Date.now();
    const defaulted = await client.note.create({
      data: { id: "n1", label: "one" },
    });
    expect(defaulted.touchedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const explicit = await client.note.create({
      data: { id: "n2", label: "two", touchedAt: SEEDED },
    });
    expect(explicit.touchedAt).toEqual(SEEDED);
  });

  test("documents the defect: an update that omits the field leaves it unchanged", async () => {
    const client = await world();
    await client.note.create({
      data: { id: "n1", label: "one", touchedAt: SEEDED },
    });

    const omitted = await client.note.update({
      where: { id: "n1" },
      data: { label: "renamed" },
    });
    // DEFECT: the fix must move this to the statement's time.
    expect(omitted.touchedAt).toEqual(SEEDED);
    await client.note.updateMany({
      where: { id: "n1" },
      data: { label: "renamed again" },
    });
    // DEFECT: the fix must move this to the statement's time.
    await expect(
      client.note.findUniqueOrThrow({ where: { id: "n1" } })
    ).resolves.toMatchObject({ touchedAt: SEEDED });

    const named = await client.note.update({
      where: { id: "n1" },
      data: { touchedAt: NAMED },
    });
    // Contract that the fix keeps: a named value wins.
    expect(named.touchedAt).toEqual(NAMED);
  });
});
