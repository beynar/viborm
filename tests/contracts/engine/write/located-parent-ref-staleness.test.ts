import type { QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import {
  makeClient,
  seed,
} from "@tests/contracts/engine/write/located-parent-ref-fixtures";
import { openTestPGlite as openBorrowedPGlite } from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

/**
 * Rewrites the value of one column in the rows the LOCATE read returns, after the
 * database answered and before the engine consumes it: the deterministic corruption the
 * staleness harness needs for a value that crosses the planning/compile seam.
 * `mode: "wrong"` substitutes another live row's key (the worst case — a value that
 * exists, so no constraint catches it); `mode: "drop"` removes the column entirely (the
 * locate that forgot to select what a Ref promised).
 */
class CorruptLocatePGliteDriver extends PGliteDriver {
  private readonly table: string;
  private readonly column: string;
  private readonly mode: "wrong" | "drop";
  private readonly wrongValue: unknown;
  private armed = true;

  constructor(
    options: ConstructorParameters<typeof PGliteDriver>[0],
    config: {
      table: string;
      column: string;
      mode: "wrong" | "drop";
      wrongValue?: unknown;
    }
  ) {
    super(options);
    this.table = config.table;
    this.column = config.column;
    this.mode = config.mode;
    this.wrongValue = config.wrongValue;
  }

  protected override async execute<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const result = await super.execute<T>(client, sql, params, context);
    const isLocate =
      this.armed &&
      sql.startsWith("SELECT") &&
      sql.includes(this.table) &&
      result.rows.length > 0;
    if (!isLocate) return result;
    this.armed = false;
    return {
      ...result,
      rows: result.rows.map((row) => {
        const next = { ...(row as Record<string, unknown>) };
        if (this.mode === "drop") delete next[this.column];
        else next[this.column] = this.wrongValue;
        return next as T;
      }),
    };
  }
}

/** The executor's typed refusal when a declared `firstRowField` output is absent. */
const UNRESOLVED_REFERENCED_COLUMN = /did not produce row field 'code'/;

/**
 * Staleness injection for the new Ref path (the harness convention of
 * `staleness-injection.test.ts`, one step deeper: that file corrupts committed STATE
 * between planning and the batch; this one corrupts the VALUE that crosses the
 * planning/compile seam, which is what a Ref actually is).
 */
describe("located-parent Ref staleness injection", () => {
  const setupDb = async () => {
    const db = openBorrowedPGlite();
    const stateClient = makeClient(new PGliteDriver({ client: db }));
    await syncLiveSchema(stateClient);
    await seed(stateClient);
    return { db, stateClient };
  };

  test(
    "the created foreign key follows the LOCATE's returned value, not the where",
    { timeout: 30_000 },
    async () => {
      const { db, stateClient } = await setupDb();
      // The corrupted locate hands back the DECOY's id — a value that EXISTS, so no
      // constraint can catch it. This is the PROVENANCE probe: if the create still
      // wrote `accountId: 2` it would be re-deriving the value from the `where` instead
      // of consuming the row the locate acted on, and the wrong-row doctrine would be
      // unenforced (that is precisely how the upsert create-arm bug W4 fixed arose).
      const client = makeClient(
        new CorruptLocatePGliteDriver(
          { client: db },
          {
            table: "n1_ref_accounts",
            column: "id",
            mode: "wrong",
            wrongValue: 1,
          }
        )
      );
      await client.account.update({
        where: { email: "target@x" },
        data: { notes: { create: { id: 300, body: "stale" } } },
      });
      await expect(
        stateClient.note.findUnique({ where: { id: 300 } })
      ).resolves.toEqual({ id: 300, body: "stale", accountId: 1 });
      await stateClient.$disconnect();
    }
  );

  test(
    "a locate value corrupted to a non-existent key fails closed with nothing persisted",
    { timeout: 30_000 },
    async () => {
      const { db, stateClient } = await setupDb();
      const client = makeClient(
        new CorruptLocatePGliteDriver(
          { client: db },
          {
            table: "n1_ref_accounts",
            column: "id",
            mode: "wrong",
            wrongValue: 999,
          }
        )
      );
      await expect(
        client.account.update({
          where: { email: "target@x" },
          data: { notes: { create: { id: 310, body: "orphan" } } },
        })
      ).rejects.toThrow();
      // The stale foreign key never landed: the whole atomic unit rolled back.
      await expect(stateClient.note.findMany()).resolves.toEqual([]);
      await stateClient.$disconnect();
    }
  );

  test(
    "one corrupted member of a COMPOUND reference moves the whole tuple",
    { timeout: 30_000 },
    async () => {
      const db = openBorrowedPGlite();
      const stateClient = makeClient(new PGliteDriver({ client: db }));
      await syncLiveSchema(stateClient);
      await stateClient.owner.create({
        data: { tenantId: "t1", slot: "a", handle: "h-t1-a" },
      });
      await stateClient.owner.create({
        data: { tenantId: "t1", slot: "b", handle: "h-t1-b" },
      });
      // Corrupt ONLY `slot`. `tenantId` is untouched, so a resolution that read
      // one member from the located row and the other from anywhere else would
      // still land on `t1/b`. Landing on `t1/a` is the proof that EVERY member
      // travels from the same located row.
      const client = makeClient(
        new CorruptLocatePGliteDriver(
          { client: db },
          {
            table: "n1_ref_owners",
            column: "slot",
            mode: "wrong",
            wrongValue: "a",
          }
        )
      );
      await client.owner.update({
        where: { handle: "h-t1-b" },
        data: { memos: { create: { id: 500, text: "compound provenance" } } },
      });
      await expect(
        stateClient.memo.findUnique({ where: { id: 500 } })
      ).resolves.toEqual({
        id: 500,
        text: "compound provenance",
        ownerTenant: "t1",
        ownerSlot: "a",
      });
      await stateClient.$disconnect();
    }
  );

  test(
    "a locate row that does not carry the referenced column fails closed at planning",
    { timeout: 30_000 },
    async () => {
      const { db, stateClient } = await setupDb();
      const client = makeClient(
        new CorruptLocatePGliteDriver(
          { client: db },
          { table: "n1_ref_accounts", column: "code", mode: "drop" }
        )
      );
      // Registering the referenced column in `locateFields` makes it a DECLARED
      // `firstRowField` output of the locate — which is what makes an absent value a
      // typed failure during planning (`extractOutput`), before any write, rather than
      // an `undefined` that would reach the INSERT as a NULL foreign key. This pins
      // that the Ref rides a declared output and not a raw row read.
      await expect(
        client.account.update({
          where: { email: "target@x" },
          data: { tickets: { create: { id: 400, subject: "no code" } } },
        })
      ).rejects.toThrow(UNRESOLVED_REFERENCED_COLUMN);
      await expect(stateClient.ticket.findMany()).resolves.toEqual([]);
      await stateClient.$disconnect();
    }
  );
});
