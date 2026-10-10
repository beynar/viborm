// S8: old code against a newer marker (version skew, or Durable Object storage
// restored behind Postgres). Target: status() reports the marker as ahead of /
// unknown to this estate instead of throwing V11002; apply({ ifAhead: 'noop' })
// returns noop without touching the database, apply({ ifAhead: 'refuse' })
// refuses; verify() reports the state as unknown rather than V11022 corruption.
import { PGlite } from "@electric-sql/pglite";
import { s } from "viborm";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient } from "viborm/pglite";

export const meta = {
  id: "s8-marker-ahead",
  title:
    "Old code against a newer marker: status reports it, apply({ ifAhead }) follows the policy, verify says unknown",
  plan: "phase-1/P/S8",
  needs: [],
  source:
    "code-check/postgres-transports.md#S8; src/migrations/operators.ts:96-104, 139 (status/verify); src/migrations/apply-v1.ts:125-130, 440-446; src/migrations/graph.ts:43-58, 376-419",
};

const AHEAD = /ahead|unknown/i;

const fields = () => ({
  id: s.string().id(),
  email: s.string().unique(),
  name: s.string(),
  status: s.enum(["trial", "active", "churned"]).default("trial"),
  balance: s.int().default(0),
  score: s.number().nullable(),
  settings: s.json().nullable(),
  country: s.string().default("FR"),
  age: s.int().nullable(),
  verified: s.boolean().default(false),
  notes: s.string().nullable(),
  lastSeenAt: s.dateTime().nullable(),
  deletedAt: s.dateTime().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
});
const v1 = { account: s.model(fields()).map("accounts") };
const v2 = {
  account: s
    .model({ ...fields(), nickname: s.string().nullable() })
    .map("accounts"),
};

async function outcome(run) {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return {
      ok: false,
      code: error?.code ?? error?.name,
      message: String(error?.message ?? error),
    };
  }
}
const brief = (r) =>
  r.ok
    ? `ok ${JSON.stringify(r.value).slice(0, 90)}`
    : `${r.code} ${r.message.slice(0, 80)}`;

export default async function probe() {
  const db = new PGlite();
  try {
    // The new deployment's history: v1 -> v2, applied.
    const newStorage = new MemoryEstateStorage();
    const newV1 = createMigrationClient(
      createClient({ client: db, schema: v1 }),
      { storage: newStorage }
    );
    await newV1.generate({ name: "v1" });
    await newV1.apply();
    const newV2 = createMigrationClient(
      createClient({ client: db, schema: v2 }),
      { storage: newStorage }
    );
    await newV2.generate({ name: "v2" });
    await newV2.apply();
    const markerRead = () =>
      db.query(
        `SELECT payload FROM "public"."_viborm_migration_state" WHERE singleton = 1`
      );
    const before = JSON.stringify((await markerRead()).rows);

    // The old code only knows v1.
    const oldStorage = new MemoryEstateStorage();
    const old = createMigrationClient(
      createClient({ client: db, schema: v1 }),
      { storage: oldStorage }
    );
    await old.generate({ name: "v1" });

    const status = await outcome(() => old.status());
    const noop = await outcome(() => old.apply({ ifAhead: "noop" }));
    const refuse = await outcome(() => old.apply({ ifAhead: "refuse" }));
    const verify = await outcome(() => old.verify());
    const untouched = JSON.stringify((await markerRead()).rows) === before;

    const problems = [];
    if (!status.ok) problems.push(`status() threw ${status.code}`);
    else if (!AHEAD.test(JSON.stringify(status.value)))
      problems.push("status() does not report the marker as ahead/unknown");
    if (!noop.ok || noop.value?.outcome !== "noop")
      problems.push(`apply({ ifAhead: 'noop' }) gave ${brief(noop)}`);
    if (refuse.ok) problems.push("apply({ ifAhead: 'refuse' }) did not refuse");
    if (!verify.ok && verify.code === "V11022")
      problems.push("verify() reports V11022 corruption");
    if (!untouched) problems.push("the marker changed");

    const evidence = `status: ${brief(status)}; ifAhead noop: ${brief(noop)}; ifAhead refuse: ${brief(refuse)}; verify: ${brief(verify)}; marker untouched: ${untouched}`;
    return {
      status: problems.length === 0 ? "pass" : "fail",
      evidence:
        problems.length === 0
          ? evidence
          : `${problems.join("; ")} | ${evidence}`,
    };
  } finally {
    await db.close();
  }
}
