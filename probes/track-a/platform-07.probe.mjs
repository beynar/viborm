// platform-07: viborm/sqlite3 applies its 5000 ms busy_timeout default only
// when the caller's better-sqlite3 `timeout` option is absent, as libsql
// already does. (bun-sqlite has the same fix but needs the Bun runtime.)
import { join } from "node:path";
import { s } from "viborm";
import { createClient } from "viborm/sqlite3";

export const meta = {
  id: "platform-07",
  title: "sqlite3 honours the caller's busy timeout; 5000 ms only when absent",
  plan: "track-a/platform-07",
  needs: [],
  source:
    "docs/architecture/adversarial-review-2026-10-09/lanes/platform.md platform-07 (probes/p08b.out); src/drivers/sqlite3/index.ts:189-196",
};

const note = s.model({ id: s.int().id(), body: s.string() });

async function busyTimeout(dataDir, options) {
  const db = createClient({
    schema: { note },
    dataDir,
    ...(options ? { options } : {}),
  });
  try {
    const [row] = await db.$queryRawUnsafe("PRAGMA busy_timeout");
    return Number(Object.values(row)[0]);
  } finally {
    await db.$disconnect();
  }
}

export default async function probe(ctx) {
  const supplied = await busyTimeout(join(ctx.tmpDir, "a.db"), {
    timeout: 1000,
  });
  const absent = await busyTimeout(join(ctx.tmpDir, "b.db"));
  return {
    status: supplied === 1000 && absent === 5000 ? "pass" : "fail",
    evidence: `options {timeout: 1000} -> PRAGMA busy_timeout=${supplied}; no timeout -> ${absent}`,
  };
}
