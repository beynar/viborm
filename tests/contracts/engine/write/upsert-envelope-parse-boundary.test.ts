import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";

import { hydrateSchemaNames, s } from "@schema";
import { openTestPGlite as openBorrowedPGlite } from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * E5-U3 — **the upsert ENVELOPE moves to the parse boundary.**
 *
 * `upsert` was the one write operation with an in-engine front line: a key gate
 * (`assertUpsertKeys`) and three `requireRecord` narrowings, kept deliberately by X2
 * because upsert has no whole-args parse — its arms are handed to `CreateOperation` /
 * `UpdateOperation` sub-ops that parse the RAW payload FRESH, and the update arm's
 * LEGALITY ANALYSES stay deferred to the taken branch (`deferArmLegality`; what exactly
 * that covers is measured and pinned in `upsert-untaken-arm-legality.test.ts`).
 *
 * Both reasons are about the ARMS, and neither is about the ENVELOPE. The envelope is
 * three required keys, five optional ones, and the object-ness of the three — a shape
 * check, and a shape check has one home. This file is that move's behavioral record: the
 * two payloads had NO witness at all before it (the E0 audit measured that), so they are
 * pinned here FIRST, against the engine's own wording, and retargeted in the same commit
 * that moves them.
 */
const envelopeModelSchema = (() => {
  const account = s
    .model({
      id: s.string().id(),
      email: s.string().unique(),
      label: s.string().default("x"),
    })
    .map("e5u3_accounts");
  return { account };
})();

hydrateSchemaNames(envelopeModelSchema);

let client: any;

beforeAll(async () => {
  client = createClient({
    schema: envelopeModelSchema,
    driver: new PGliteDriver({ client: openBorrowedPGlite() }),
  }) as any;
  await syncLiveSchema(client);
}, 120_000);

/** The class change these witnesses record: `UnsupportedOperationError` (V8003, no
 *  prismaCode) → `ValidationError` (P2009), the class every other write op's malformed
 *  envelope already carries. */
async function refusal(run: Promise<unknown>): Promise<any> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error("expected the payload to be refused");
}

describe("E5-U3 the upsert envelope", () => {
  test("a MISSING required key is refused before any I/O", async () => {
    // BASELINE, measured at 79b32ba: `UnsupportedOperationError: upsert arguments
    // require where, create, update (optional select, include, omit, targetWhere,
    // setWhere); received where, create.` — V8003, no prismaCode.
    // RETARGETED: the envelope schema names the ONE key that is missing, and the error
    // is the class a malformed payload has everywhere else.
    const error = await refusal(
      client.account.upsert({
        where: { id: "a1" },
        create: { id: "a1", email: "a1@x" },
      })
    );
    expect(error.constructor.name).toBe("ValidationError");
    expect(error.prismaCode).toBe("P2009");
    expect(error.message).toBe(
      "Validation failed for upsert: Missing required field: update"
    );
    expect(await client.account.count({})).toBe(0);
  }, 120_000);

  test("a NON-OBJECT arm is refused before any I/O", async () => {
    // BASELINE, measured at 79b32ba: `UnsupportedOperationError: 'upsert.update' must
    // be an object.`
    const error = await refusal(
      client.account.upsert({
        where: { id: "a2" },
        create: { id: "a2", email: "a2@x" },
        update: "nope",
      })
    );
    expect(error.constructor.name).toBe("ValidationError");
    expect(error.prismaCode).toBe("P2009");
    expect(error.message).toBe(
      "Validation failed for upsert: Expected object, received string"
    );
    expect(error.issues?.[0]?.path).toBe("update");
    expect(await client.account.count({})).toBe(0);
  }, 120_000);

  test("an ARRAY arm is refused, named as an array", async () => {
    // The leaf's array fact, carried through the envelope: `record` says the same
    // sentence about the same input, so the two object leaves cannot describe it two
    // ways.
    const error = await refusal(
      client.account.upsert({
        where: { id: "a3" },
        create: { id: "a3", email: "a3@x" },
        update: [],
      })
    );
    expect(error.constructor.name).toBe("ValidationError");
    expect(error.message).toBe(
      "Validation failed for upsert: Expected object, received array"
    );
    expect(await client.account.count({})).toBe(0);
  }, 120_000);

  test("an UNKNOWN key is refused — the key gate's other half, unchanged in reach", async () => {
    const error = await refusal(
      client.account.upsert({
        where: { id: "a4" },
        create: { id: "a4", email: "a4@x" },
        update: { label: "y" },
        nonsense: 1,
      })
    );
    expect(error.constructor.name).toBe("ValidationError");
    expect(error.message).toBe(
      "Validation failed for upsert: Unknown key: nonsense"
    );
    expect(await client.account.count({})).toBe(0);
  }, 120_000);

  test("the arms reach the operation BY REFERENCE — the envelope transforms nothing", async () => {
    // The property the whole move rests on, exercised end to end on both branches: the
    // arms are re-parsed by the delegated sub-ops, so a transformed copy here would
    // make the second parse see the first parse's output. The leaf's reference equality
    // is asserted directly in `tests/validation/raw-record.test.ts`; this is the round
    // trip that depends on it. The `createMany` transform this protects — the measured
    // X2 regression — is exercised by `tests/query-engine/nested-create-many.test.ts`.
    const created = await client.account.upsert({
      where: { id: "a5" },
      create: { id: "a5", email: "a5@x" },
      update: { label: "y" },
    });
    expect(created).toMatchObject({ id: "a5", label: "x" });
    const updated = await client.account.upsert({
      where: { id: "a5" },
      create: { id: "a5", email: "a5@x" },
      update: { label: "z" },
    });
    expect(updated).toMatchObject({ id: "a5", label: "z" });
  }, 120_000);

  test("the five optional keys keep their own schemas' answers", async () => {
    // The envelope admits the KEY and owns nothing about the VALUE, so `select`'s own
    // schema still answers for `select`…
    const projection = await refusal(
      client.account.upsert({
        where: { id: "a6" },
        create: { id: "a6", email: "a6@x" },
        update: { label: "y" },
        select: "x",
      })
    );
    expect(projection.message).toBe(
      "Validation failed for upsert: Expected object"
    );
    // …and a non-object `targetWhere`, which the engine ACCEPTS today (measured), is
    // still accepted: the move did not start refusing it.
    await client.account.upsert({
      where: { id: "a7" },
      create: { id: "a7", email: "a7@x" },
      update: { label: "y" },
      targetWhere: "x",
    });
    expect(await client.account.count({ where: { id: "a7" } })).toBe(1);
  }, 120_000);
});
