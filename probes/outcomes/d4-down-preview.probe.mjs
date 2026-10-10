// D4 step 7 (absorbs platform-12): the down preview shows the rollback SQL
// it would run, and the refusal down itself would raise. 1.1.0's
// down({ dryRun: true }) returns only { path, preview: true }: no SQL, and a
// clean preview for an irreversible edge that the real down then refuses.
import Database from "better-sqlite3";
import { s, sql } from "viborm";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient } from "viborm/sqlite3";

export const meta = {
  id: "D4-down-preview",
  title:
    "down({ dryRun }) shows the rollback SQL and the refusal down would raise",
  plan: "phase-2/D4 step 7 (platform-12)",
  needs: [],
  source:
    "adversarial-review-2026-10-09 platform-12; completion-plan-2026-10/code-check/track-a.md (platform-12); src/migrations/operators.ts:290-321",
};

const DROP_LINE_ITEM = /DROP TABLE\s+"lineItem"/;

// Every string inside the preview, unescaped (a JSON dump escapes the quotes).
const strings = (value) => {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(strings);
  }
  return [];
};

const invoice = s.model({
  id: s.string().id(),
  number: s.string().unique(),
  customerEmail: s.string(),
  status: s.enum(["draft", "sent", "paid", "void"]).default("draft"),
  amountCents: s.int(),
  metadata: s.json().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
});
const lineItem = s.model({
  id: s.string().id(),
  invoiceId: s.string(),
  sku: s.string(),
  quantity: s.int(),
  unitCents: s.int(),
  createdAt: s.dateTime().now(),
});

export default async function probe() {
  const db = new Database(":memory:");
  const storage = new MemoryEstateStorage();
  const v1 = createClient({ client: db, schema: { invoice } });
  const v2 = createClient({ client: db, schema: { invoice, lineItem } });
  try {
    const m1 = createMigrationClient(v1, { storage });
    await m1.generate({ name: "invoices" });
    await m1.apply();
    const m2 = createMigrationClient(v2, { storage });
    await m2.generate({ name: "line-items" });
    await m2.apply();

    const schemaPreview = await m2.down({ steps: 1, dryRun: true });
    const showsSql = strings(schemaPreview).some((text) =>
      DROP_LINE_ITEM.test(text)
    );

    const at = (await m2.show({ name: "line-items" })).stateId;
    await m2.generate({
      name: "normalize-sku",
      manualMigration: {
        transitions: [
          {
            from: at,
            execution: "transactional",
            up: [sql.raw(`UPDATE "lineItem" SET "sku" = upper("sku")`)],
            rollback: { kind: "irreversible", reason: "sku case is lost" },
          },
        ],
      },
    });
    await m2.apply();
    let preview;
    try {
      preview = await m2.down({ steps: 1, dryRun: true });
    } catch (error) {
      preview = `throws ${error.code}`;
    }
    let real;
    try {
      await m2.down({ steps: 1 });
      real = "ran";
    } catch (error) {
      real = `${error.code}`;
    }
    const showsRefusal =
      real !== "ran" && strings(preview).some((text) => text.includes(real));
    return {
      status: showsSql && showsRefusal ? "pass" : "fail",
      evidence: `schema rollback preview ${showsSql ? "shows" : "lacks"} DROP TABLE "lineItem": ${JSON.stringify(schemaPreview).slice(0, 120)}; irreversible edge: preview ${JSON.stringify(preview).slice(0, 120)}, real down ${real}`,
    };
  } finally {
    await v1.$disconnect();
    await v2.$disconnect();
    db.close();
  }
}
