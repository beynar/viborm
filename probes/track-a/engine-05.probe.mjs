// engine-05 / types-06 (decision 5): the JSON `{ set: v }` envelope means
// "store v" on create, createMany and the create side of upsert, exactly as on
// update; a document whose only key is `set` is written `{ set: { set: v } }`.
import { s } from "viborm";
import { createMigrationClient } from "viborm/migrations";
import { createClient } from "viborm/sqlite3";

export const meta = {
  id: "engine-05",
  title:
    "JSON { set } envelope means 'store v' on create, createMany and upsert-create",
  plan: "track-a/engine-05+types-06",
  needs: [],
  source:
    "docs/architecture/adversarial-review-2026-10-09/evidence/engine/probes/h01-json.mjs; evidence/types/probes/p11-json-set.ts; src/validation/scalars/json.ts:358-380",
};

const doc = s.model({
  id: s.string().id(),
  meta: s.json().nullable(),
});

export default async function probe() {
  const db = createClient({ schema: { doc } });
  const lines = [];
  let ok = true;
  const expect = async (label, id, expected) => {
    const row = await db.doc.findUnique({ where: { id } });
    const got = JSON.stringify(row?.meta);
    const match = got === JSON.stringify(expected);
    ok &&= match;
    lines.push(
      `${label} stored ${got}${match ? "" : ` (expected ${JSON.stringify(expected)})`}`
    );
  };
  try {
    await createMigrationClient(db).push();

    await db.doc.create({ data: { id: "c", meta: { set: ["a", "b"] } } });
    await expect("create {set:[a,b]}", "c", ["a", "b"]);

    await db.doc.createMany({ data: [{ id: "m", meta: { set: 1 } }] });
    await expect("createMany {set:1}", "m", 1);

    const upsert = () =>
      db.doc.upsert({
        where: { id: "u" },
        create: { id: "u", meta: { set: "c" } },
        update: { meta: { set: "u" } },
      });
    await upsert();
    await expect("upsert create-arm {set:'c'}", "u", "c");
    await upsert();
    await expect("upsert update-arm {set:'u'}", "u", "u");

    // The escape for a literal one-key `set` document, on both paths.
    await db.doc.create({ data: { id: "lit", meta: { set: { set: 7 } } } });
    await expect("create {set:{set:7}}", "lit", { set: 7 });
    await db.doc.update({
      where: { id: "lit" },
      data: { meta: { set: { set: 8 } } },
    });
    await expect("update {set:{set:8}}", "lit", { set: 8 });

    return { status: ok ? "pass" : "fail", evidence: lines.join("; ") };
  } finally {
    await db.$disconnect();
  }
}
