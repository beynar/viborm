import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { NotFoundError, VibORMErrorCode } from "@errors";

import { updateFamilySchema } from "@tests/contracts/engine/write/update-family-behavior";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

import { openTestPGlite as openBorrowedPGlite } from "@tests/fixtures/pglite-lifecycle";


async function boot(batchOnly: boolean) {
  const db = openBorrowedPGlite();
  const driver = batchOnly
    ? new BatchOnlyPGliteDriver({ client: db })
    : new PGliteDriver({ client: db });
  const client = createClient({ schema: updateFamilySchema, driver });
  await syncLiveSchema(client);
  await client.user.create({ data: { id: 1, email: "root@x", count: 1 } });
  await client.post.create({
    data: { id: 1, title: "t", slug: "s", userId: 1 },
  });
  return client;
}

/** The rejection's identity as one comparable value. */
async function rejection(act: PromiseLike<unknown>) {
  const error = await act.then(
    () => undefined,
    (caught: unknown) => caught
  );
  if (!(error instanceof NotFoundError)) {
    return { isNotFoundError: false };
  }
  return {
    isNotFoundError: true,
    name: error.name,
    message: error.message,
    code: error.code,
  };
}

describe("PLAN Phase 6.2 — the batch-mode fold answers what the row is", () => {
  test("the folded batch update returns the mutated row, projection and all", async () => {
    const batchClient = await boot(true);
    const txClient = await boot(false);

    const args = {
      where: { email: "root@x" },
      data: { count: { increment: 4 } },
      select: { email: true, count: true },
    };
    // The fold's only source of a result is the UPDATE's own RETURNING clause —
    // there is no terminal read left to answer from. Drop the clause and this is
    // what fails.
    const folded = await batchClient.user.update(args);
    expect(folded).toEqual({ email: "root@x", count: 5 });
    // ...and it is the SAME answer the transaction substrate gives for the same
    // payload against the same starting state, which is the property that has to
    // hold whatever each substrate folds.
    expect(folded).toEqual(await txClient.user.update(args));
  });

  test("a PK the SET rewrote comes back from the fold, not from a stale read", async () => {
    const client = await boot(true);
    // The seeded post holds a foreign key to user 1; drop it so the identity is
    // free to move, since what this test is about is the ANSWER, not the cascade.
    await client.post.delete({ where: { id: 1 } });
    expect(
      await client.user.update({
        where: { email: "root@x" },
        data: { id: 42 },
        select: { id: true, email: true },
      })
    ).toEqual({ id: 42, email: "root@x" });
  });
});

describe("PLAN Phase 6.2 — the fold's NotFoundError is unchanged", () => {
  test("the batch fold, the transaction fold and the terminal-read path agree", async () => {
    const batchClient = await boot(true);
    const txClient = await boot(false);

    const missing = { where: { email: "absent@x" }, data: { count: 2 } };

    // Batch: the in-unit presence guard aborts the atomic unit — there is no JS
    // postcondition on this substrate, so the guard is what answers.
    const batchFold = await rejection(batchClient.user.update(missing));
    // Transaction: the folded step's `affectedRows(1, notFound)` fires in JS
    // after the single round-trip.
    const txFold = await rejection(txClient.user.update(missing));
    // Neither substrate folds an `include`: the locate read's postcondition
    // fires at planning, before any write.
    const terminalRead = await rejection(
      txClient.user.update({ ...missing, include: { posts: true } })
    );

    expect(batchFold).toEqual({
      isNotFoundError: true,
      name: "NotFoundError",
      message: "No user record found for update",
      code: VibORMErrorCode.RECORD_NOT_FOUND,
    });
    expect(txFold).toEqual(batchFold);
    expect(terminalRead).toEqual(batchFold);
  });

  test("the guard aborts BEFORE the write, leaving the table untouched", async () => {
    const client = await boot(true);
    // A selector whose filter half excludes the row: the guard finds nothing, so
    // the batch aborts and the UPDATE beside it never lands. Without the guard
    // the batch would commit an UPDATE that matched zero rows and report success.
    await expect(
      client.user.update({
        where: { email: "root@x", count: 999 },
        data: { count: 7 },
      })
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(
      await client.user.findUnique({
        where: { email: "root@x" },
        select: { count: true },
      })
    ).toEqual({ count: 1 });
  });
});
