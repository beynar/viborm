import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { push } from "@migrations";
import { hydrateSchemaNames, s } from "@schema";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * E5-U3 — **the upsert ENVELOPE moves to the parse boundary.**
 *
 * `upsert` was the one write operation with an in-engine front line: a key gate
 * (`assertUpsertKeys`) and three `requireRecord` narrowings, kept deliberately by X2
 * because upsert has no whole-args parse — its arms are handed to `CreateOperation` /
 * `UpdateOperation` sub-ops that parse the RAW payload FRESH, and the untaken arm's
 * CONTENT must stay unvalidated (`deferArmLegality`).
 *
 * Both reasons are about the ARMS, and neither is about the ENVELOPE. The envelope is
 * three required keys, five optional ones, and the object-ness of the three — a shape
 * check, and a shape check has one home. This file is that move's behavioral record: the
 * two payloads had NO witness at all before it (the E0 audit measured that), so they are
 * pinned here FIRST, against the engine's own wording, and retargeted in the same commit
 * that moves them.
 */
export const upsertEnvelopeSchema = (() => {
  const account = s
    .model({
      id: s.string().id(),
      email: s.string().unique(),
      label: s.string().default("x"),
    })
    .map("e5u3_accounts");
  return { account };
})();

hydrateSchemaNames(upsertEnvelopeSchema);

let client: any;

beforeAll(async () => {
  client = createClient({
    schema: upsertEnvelopeSchema,
    driver: new PGliteDriver({ client: new PGlite() }),
  }) as any;
  await push(client, { force: true });
}, 120_000);

describe("E5-U3 the upsert envelope", () => {
  test("a MISSING required key is refused before any I/O", async () => {
    // BASELINE (measured at 79b32ba): `UnsupportedOperationError: upsert arguments
    // require where, create, update (optional select, include, omit, targetWhere,
    // setWhere); received where, create.` — the engine's key gate, V8003, no prismaCode.
    await expect(
      client.account.upsert({
        where: { id: "a1" },
        create: { id: "a1", email: "a1@x" },
      })
    ).rejects.toThrow(
      "upsert arguments require where, create, update (optional select, include, omit, targetWhere, setWhere); received where, create."
    );
    expect(await client.account.count({})).toBe(0);
  }, 120_000);

  test("a NON-OBJECT arm is refused before any I/O", async () => {
    // BASELINE (measured at 79b32ba): `UnsupportedOperationError: 'upsert.update' must
    // be an object.`
    await expect(
      client.account.upsert({
        where: { id: "a2" },
        create: { id: "a2", email: "a2@x" },
        update: "nope",
      })
    ).rejects.toThrow("'upsert.update' must be an object.");
    expect(await client.account.count({})).toBe(0);
  }, 120_000);

  test("an ARRAY arm is refused before any I/O", async () => {
    await expect(
      client.account.upsert({
        where: { id: "a3" },
        create: { id: "a3", email: "a3@x" },
        update: [],
      })
    ).rejects.toThrow("'upsert.update' must be an object.");
    expect(await client.account.count({})).toBe(0);
  }, 120_000);
});
