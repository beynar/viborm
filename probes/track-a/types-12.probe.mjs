// types-12: float defaults at or above 1e21 converge on PostgreSQL: push
// applies them and a second push plans nothing (float catalog literals are
// normalized with Number(), not BigInt()).
import { s } from "viborm";
import { createMigrationClient } from "viborm/migrations";
import { createClient } from "viborm/pglite";

export const meta = {
  id: "types-12",
  title:
    "Exponent float defaults (1e21, -1e21, 1e300, MAX_VALUE) push and converge on Postgres",
  plan: "track-a/types-12",
  needs: [],
  source:
    "docs/architecture/adversarial-review-2026-10-09/evidence/types/probes/p12b-pg-literal-bisect.ts; src/migrations/push-fingerprint.ts:268,303-371",
};

const metric = s
  .model({
    id: s.int().id(),
    control: s.number().default(-0.5),
    big: s.number().default(1e21),
    negative: s.number().default(-1e21),
    huge: s.number().default(1e300),
    max: s.number().default(Number.MAX_VALUE),
  })
  .map("metric");

const COLUMN_NAME = /"columnName":"([^"]+)"/g;

export default async function probe() {
  const db = createClient({ schema: { metric } });
  try {
    let first;
    try {
      first = (await createMigrationClient(db).push()).outcome;
    } catch (error) {
      const message = String(error?.message);
      const drifted = [...message.matchAll(COLUMN_NAME)].map((m) => m[1]);
      return {
        status: "fail",
        evidence: `push threw ${error?.code ?? error?.name} (drifted columns: ${drifted.join(", ") || "?"}): ${message.slice(0, 220)}`,
      };
    }
    const again = await createMigrationClient(db).push({ dryRun: true });
    const pending = again.operations.length;
    const row = await db.metric.create({ data: { id: 1 } });
    const values = [row.big, row.negative, row.huge, row.max];
    const exact =
      JSON.stringify(values) ===
      JSON.stringify([1e21, -1e21, 1e300, Number.MAX_VALUE]);
    return {
      status: pending === 0 && exact ? "pass" : "fail",
      evidence: `push ${first}; re-push dry-run pending=${pending}; defaults read back ${JSON.stringify(values)}`,
    };
  } finally {
    await db.$disconnect();
  }
}
