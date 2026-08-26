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

// Promise-only public operation shapes require runtime ownership authentication.
const _ordinaryPromiseRequiresRuntimeAuthentication = () =>
  client.$transaction([client.item.count(), Promise.resolve(1)]);
