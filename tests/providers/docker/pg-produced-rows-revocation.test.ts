/**
 * pg Driver Tests — W-P8, a concurrent revocation (permissions plan §4.4, §7, OD-13
 * ruled one statement; §5.4 READ COMMITTED) on a real PostgreSQL server, in a
 * schema of its own (`viborm_permissions_u6_<random>`, dropped after). The row a
 * write produces is judged inside the statement that writes it, so there is
 * no point between a judgement and its write for a revocation to fall into:
 *
 * - committed before the writing statement, a revocation is seen by it, even
 *   inside a transaction that read the grant earlier (READ COMMITTED takes a
 *   snapshot per statement): what an earlier read observed decides nothing;
 * - uncommitted while the statement runs, it neither blocks the statement nor
 *   is seen by it: the write is ordered before the revocation, as one
 *   statement under its own snapshot is.
 *
 * The fixture is tests/contracts/engine/query/produced-row-behavior.ts: ann
 * edits folder 2 through grant 1, and places items there.
 *
 * NOTE: These tests require a running PostgreSQL database
 * (PG_TEST_CONNECTION_STRING).
 */

import { randomBytes } from "node:crypto";
import { PgDriver } from "@drivers/pg";
import { ForbiddenError } from "@errors";
import {
  createProducedRowClient,
  type ProducedRowClient,
  policy,
  seedProducedRows,
} from "@tests/contracts/engine/query/produced-row-behavior";
import { failure } from "@tests/fixtures/failure";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

type Row = Record<string, unknown>;
interface Delegate {
  create(args: object): Promise<Row>;
  findMany(args?: object): Promise<Row[]>;
}
type Governed = Record<string, Delegate> & {
  $transaction<T>(
    body: (tx: Record<string, Delegate>) => Promise<T>
  ): Promise<T>;
};

describeIf(
  "pg Driver: a revocation concurrent with a judged write (W-P8)",
  () => {
    let namespace: string;
    let base: ProducedRowClient;
    let db: Governed;
    /** The revoker: its own connection, its own transaction. */
    let revoker: pg.Client;
    const admin = async (statement: string) => {
      const connection = new pg.Client({
        connectionString: TEST_CONNECTION_STRING,
      });
      await connection.connect();
      try {
        await connection.query(statement);
      } finally {
        await connection.end();
      }
    };
    beforeEach(async () => {
      namespace = `viborm_permissions_u6_${randomBytes(5).toString("hex")}`;
      await admin(`CREATE SCHEMA "${namespace}"`);
      base = createProducedRowClient(
        new PgDriver({ databaseUrl: TEST_CONNECTION_STRING, namespace })
      );
      await syncLiveSchema(base);
      await seedProducedRows(base, true);
      db = base.$extends(policy as never) as unknown as Governed;
      revoker = new pg.Client({ connectionString: TEST_CONNECTION_STRING });
      await revoker.connect();
      await revoker.query(`SET search_path TO "${namespace}"`);
    });
    afterEach(async () => {
      await revoker?.end();
      await base?.$disconnect();
      await admin(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    });
    const titles = async () =>
      (
        await (base as unknown as Record<string, Delegate>).item!.findMany({
          where: { folderId: 2 },
          select: { title: true },
          orderBy: { title: "asc" },
        })
      ).map((row) => row.title);
    const editable = (tx: Record<string, Delegate>) =>
      tx.folder!.findMany({
        where: { id: 2 },
        select: { id: true },
        user: "ann",
      });

    test("a revocation committed before the writing statement refuses it, though the same transaction read the grant before", async () => {
      let before = 0;
      let refused: unknown;
      // The refused statement fails inside the transaction, which PostgreSQL
      // then aborts, as it does after any failed statement.
      await db
        .$transaction(async (tx) => {
          // What a premise read would have taken as the permission.
          before = (await editable(tx)).length;
          await revoker.query(`DELETE FROM "grant" WHERE "id" = 1`);
          refused = await failure(
            tx.item!.create({
              data: { id: 5000, folderId: 2, title: "after revocation" },
              user: "ann",
            })
          );
        })
        .catch(() => undefined);
      expect(before).toBe(1);
      expect(refused).toBeInstanceOf(ForbiddenError);
      expect(await titles()).toEqual(["i2"]);
    });

    test("an uncommitted revocation neither blocks the writing statement nor is seen by it: the write is ordered before it", async () => {
      await revoker.query("BEGIN");
      await revoker.query(`DELETE FROM "grant" WHERE "id" = 1`);
      const created = await db.item!.create({
        data: { id: 5001, folderId: 2, title: "before revocation" },
        user: "ann",
      });
      await revoker.query("COMMIT");
      expect(created).toMatchObject({ title: "before revocation" });
      // The revocation holds from its commit on.
      expect(
        await failure(
          db.item!.create({
            data: { id: 5002, folderId: 2, title: "after commit" },
            user: "ann",
          })
        )
      ).toBeInstanceOf(ForbiddenError);
      expect(await titles()).toEqual(["before revocation", "i2"]);
    });
  }
);
