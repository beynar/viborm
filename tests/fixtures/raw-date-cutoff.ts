import { deepStrictEqual, strictEqual } from "node:assert/strict";
import type { RawSurface } from "@client/raw";

/** The public raw-SQL documentation's Date cutoff must compare stored ISO text. */
export async function qualifyRawDateCutoff(
  client: RawSurface,
  integer: (value: number) => number | bigint = (value) => value
): Promise<void> {
  await client.$executeRaw`CREATE TABLE raw_date_cutoff (id INTEGER PRIMARY KEY, active INTEGER NOT NULL, last_seen TEXT NOT NULL)`;
  const before = new Date("2026-10-07T23:59:59.999Z");
  const cutoff = new Date("2026-10-08T00:00:00.000Z");
  const after = new Date("2026-10-08T00:00:00.001Z");
  await client.$executeRaw`INSERT INTO raw_date_cutoff VALUES (1, 1, ${before}), (2, 1, ${cutoff})`;
  await client.$executeRawUnsafe(
    "INSERT INTO raw_date_cutoff VALUES (3, 1, ?)",
    after
  );
  deepStrictEqual(
    await client.$queryRaw<{
      id: number | bigint;
    }>`SELECT id FROM raw_date_cutoff WHERE last_seen < ${cutoff} ORDER BY id`,
    [{ id: integer(1) }]
  );
  strictEqual(
    await client.$executeRaw`UPDATE raw_date_cutoff SET active = ${false} WHERE last_seen < ${cutoff}`,
    1
  );
  deepStrictEqual(
    await client.$queryRawUnsafe<{
      id: number | bigint;
      active: number | bigint;
      last_seen: string;
    }>("SELECT id, active, last_seen FROM raw_date_cutoff ORDER BY id"),
    [
      { id: integer(1), active: integer(0), last_seen: before.toISOString() },
      { id: integer(2), active: integer(1), last_seen: cutoff.toISOString() },
      { id: integer(3), active: integer(1), last_seen: after.toISOString() },
    ]
  );
}
