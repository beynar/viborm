// engine-06: push compares against the live database, which keeps no
// polymorphic history, so before effects it must probe the stored
// discriminator values and refuse a stored-value change that would orphan
// rows (generate already refuses it with V11010). The refusal is data-driven:
// a value change that orphans no stored row must still push.
import Database from "better-sqlite3";
import { s } from "viborm";
import { createMigrationClient } from "viborm/migrations";
import { createClient } from "viborm/sqlite3";

export const meta = {
  id: "engine-06",
  title: "push refuses a polymorphic stored-value change on a populated table",
  plan: "track-a/engine-06",
  needs: [],
  source:
    "docs/architecture/adversarial-review-2026-10-09/evidence/engine/probes/h09-poly-evolution.mjs; src/migrations/differ.ts:724-748; src/migrations/push-plan.ts:171-176",
};

const ROWS = 10_000;

const schemaFor = (postValue, videoValue = "video.v1") => {
  const post = s.model({
    id: s.string().id(),
    title: s.string(),
    body: s.string(),
    status: s.enum(["draft", "published"]).default("draft"),
    createdAt: s.dateTime().now(),
    updatedAt: s.dateTime().updatedAt(),
    reactions: s.toMany(() => reaction).name("target"),
  });
  const video = s.model({
    id: s.string().id(),
    title: s.string(),
    seconds: s.int(),
    createdAt: s.dateTime().now(),
    updatedAt: s.dateTime().updatedAt(),
    reactions: s.toMany(() => reaction).name("target"),
  });
  const reaction = s.model({
    id: s.string().id(),
    kind: s.enum(["like", "love", "laugh"]),
    weight: s.int().default(1),
    meta: s.json().nullable(),
    createdAt: s.dateTime().now(),
    updatedAt: s.dateTime().updatedAt(),
    target: s
      .toOne(
        { post: () => post, video: () => video },
        { values: { post: postValue, video: videoValue } }
      )
      .name("target"),
  });
  return { post, video, reaction };
};

export default async function probe() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const before = createClient({ schema: schemaFor("post.v1"), client: sqlite });
  await createMigrationClient(before).push();
  await before.post.create({ data: { id: "p1", title: "t", body: "b" } });
  await before.reaction.create({
    data: {
      id: "r0",
      kind: "like",
      target: { connect: { type: "post", where: { id: "p1" } } },
    },
  });
  // Clone the ORM-written row to reach a realistic table size.
  const template = sqlite
    .prepare(`SELECT * FROM "reaction" WHERE "id" = 'r0'`)
    .get();
  const columns = Object.keys(template);
  const insert = sqlite.prepare(
    `INSERT INTO "reaction" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
  );
  sqlite.transaction(() => {
    for (let i = 1; i < ROWS; i++)
      insert.run(...columns.map((c) => (c === "id" ? `r${i}` : template[c])));
  })();
  const discriminator = columns.find((c) => template[c] === "post.v1");
  const count = (value) =>
    sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM "reaction" WHERE "${discriminator}" = ?`
      )
      .get(value).n;

  // Control: an unchanged schema over the same populated table stays a no-op.
  const same = createClient({ schema: schemaFor("post.v1"), client: sqlite });
  const control = (await createMigrationClient(same).push()).outcome;
  // Data-dependent control: no reaction stores 'video.v1', so changing it
  // orphans nothing and push must go through.
  let unused;
  try {
    const videoOnly = schemaFor("post.v1", "video.v2");
    const pushed = createClient({ schema: videoOnly, client: sqlite });
    unused = `pushed (${(await createMigrationClient(pushed).push()).outcome})`;
  } catch (error) {
    unused = `refused ${error?.code ?? error?.name}`;
  }

  const after = createClient({
    schema: schemaFor("post.v2", "video.v2"),
    client: sqlite,
  });
  let pushed;
  let refusal;
  try {
    const result = await createMigrationClient(after).push();
    pushed = `push resolved outcome=${result.outcome} operations=${result.operations.length}`;
  } catch (error) {
    refusal = error;
    pushed = `push refused ${error?.code ?? error?.name}: ${String(error?.message).slice(0, 200)}`;
  }
  // Refused, the rows keep their meaning under the schema they were written
  // with; pushed (1.1.0), the new schema can no longer read them.
  const reader = refusal ? same : after;
  let read;
  try {
    const row = await reader.reaction.findUnique({
      where: { id: "r0" },
      include: { target: true },
    });
    read = `read include target ok (${row?.target ? "target present" : "target null"})`;
  } catch (error) {
    read = `read include target threw ${error?.code ?? error?.name}: ${String(error?.message).slice(0, 120)}`;
  }
  const untouched = count("post.v1") === ROWS;
  const named =
    refusal?.code === "V11010" || String(refusal?.message).includes("post.v1");
  const evidence = `${ROWS} reactions stored '${discriminator}'='post.v1' (${count("post.v1")} after); unchanged-schema push ${control}; unused video.v1->v2 ${unused}; ${pushed}; ${read}`;
  sqlite.close();
  return {
    status:
      control === "noop" && unused.startsWith("pushed") && named && untouched
        ? "pass"
        : "fail",
    evidence,
  };
}
