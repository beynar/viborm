/** Public type contract for lazy raw transaction operations. */

import { createClient } from "@client/client";
import type { RawOperation } from "@client/raw";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";
import { sql } from "@sql";

const item = s.model({ id: s.string().id(), active: s.boolean() });
const client = createClient({ schema: { item }, driver: new PGliteDriver() });

const rows = client.$queryRaw<{ id: string }>`SELECT id FROM item`;
const affected = client.$executeRaw`UPDATE item SET active = ${false}`;

const _rowsAreRawOperation: RawOperation<{ id: string }[]> = rows;
const _affectedIsRawOperation: RawOperation<number> = affected;
const _rowsRemainPromiseCompatible: Promise<{ id: string }[]> = rows;
const _affectedRemainsPromiseCompatible: Promise<number> = affected;

const _predeclaredTuple: Promise<[number, { id: string }[]]> =
  client.$transaction([affected, rows]);

const _inlineTuple: Promise<[number, number, { id: string }[]]> =
  client.$transaction([
    client.$executeRaw`UPDATE item SET active = ${true}`,
    client.item.count(),
    client.$queryRaw<{ id: string }>`SELECT id FROM item`,
  ]);

// A bare promise is REFUSED at compile time, not merely at runtime.
//
// This pin used to run the other way: RawOperation was declared as
// `interface RawOperation<T> extends Promise<T> {}`, which adds nothing, so the
// array arm was structurally satisfied by any promise and the only thing
// standing between a caller and a crash was array-transaction.ts:174 throwing
// InvalidTransactionInputError. An array member must be an object the
// transaction-operation owner registry recognises, and the type now says so.
const _ordinaryPromiseIsRefused = () =>
  // @ts-expect-error - a bare promise is not a transaction operation
  client.$transaction([client.item.count(), Promise.resolve(1)]);

const _safeFragmentArguments = () => {
  const fragment = sql`SELECT ${1} AS id`;
  const typedRows: RawOperation<{ id: number }[]> = client.$queryRaw<{
    id: number;
  }>(fragment);
  client.$executeRaw(fragment);
  // @ts-expect-error - a fragment already contains its bound values
  client.$queryRaw<{ id: number }>(fragment, 2);
  // @ts-expect-error - fresh fragments cannot take extra values either
  client.$queryRaw(sql`SELECT ${1}`, 2);
  // @ts-expect-error - the execute family has the same fragment contract
  client.$executeRaw(fragment, 2);
  // @ts-expect-error - bare strings belong to the explicit unsafe family
  client.$queryRaw("SELECT 1");
  return typedRows;
};
