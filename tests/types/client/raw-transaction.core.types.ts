/** Public type contract for lazy raw transaction operations. */

import { createClient } from "@client/client";
import type { RawOperation } from "@client/raw";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";

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
