/**
 * platform-07 on the real `bun:sqlite` — RUN BY BUN, NOT BY VITEST.
 *
 * `bun-sqlite-options.test.ts` spawns this file with `bun run` when Bun is on
 * PATH. `bun:sqlite` has no busy-timeout option of its own, so the driver's
 * `options.timeout` is VibORM's: the caller's value is the busy timeout the
 * connection keeps, and 5000 ms applies only when it is absent. Any thrown
 * error exits non-zero, which is the failure signal the spawning test reads.
 */

import { createClient } from "@drivers/bun-sqlite";
import { s } from "@schema";

const note = s.model({ id: s.int().id(), body: s.string() });

async function busyTimeout(timeout: number | undefined): Promise<number> {
  const db = createClient({
    schema: { note },
    ...(timeout === undefined ? {} : { options: { timeout } }),
  });
  try {
    const rows = await db.$queryRawUnsafe<{ timeout: number }>(
      "PRAGMA busy_timeout"
    );
    return Number(rows[0]?.timeout);
  } finally {
    await db.$disconnect();
  }
}

function check(label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
}

check("timeout 1000", await busyTimeout(1000), 1000);
check("timeout 0", await busyTimeout(0), 0);
check("no timeout", await busyTimeout(undefined), 5000);

console.log("busy timeout evidence passed");
