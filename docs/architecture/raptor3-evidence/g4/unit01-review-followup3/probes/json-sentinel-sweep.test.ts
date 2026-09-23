import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { AnyNull, DbNull, JsonNull } from "@schema/json-null";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

/**
 * Third review (repair 3). Finding I asked for the shipped JSON
 * sentinel-with-path sentence, INCLUDING the field name and the sentinel kind.
 * The repair copied it. These probes pin it absolutely on the kind the earlier
 * review did not probe, on a SECOND json column (so the field name cannot be
 * hard-coded or read off the wrong target), under negation and combinators and
 * in a relation scope — and check the shapes that must still ANSWER.
 */
const doc = s
  .model({
    id: s.int().id(),
    profile: s.json().nullable(),
    settings: s.json().nullable(),
    notes: s.toMany(() => note).name("docNotes"),
  })
  .map("fu3_docs");

const note = s
  .model({
    id: s.int().id(),
    docId: s.int().nullable().map("doc_id"),
    payload: s.json().nullable(),
    doc: s
      .toOne(() => doc)
      .fields("docId")
      .references("id")
      .name("docNotes"),
  })
  .map("fu3_notes");

const schema = { doc, note };

function build(): { db: Database.Database; driver: SQLite3Driver } {
  const db = new Database(":memory:");
  db.exec(
    `CREATE TABLE fu3_docs(id INTEGER PRIMARY KEY, profile TEXT, settings TEXT);
     CREATE TABLE fu3_notes(id INTEGER PRIMARY KEY, doc_id INTEGER, payload TEXT);
     INSERT INTO fu3_docs VALUES (1,'{"a":null}','{"b":1}'),(2,NULL,NULL),(3,'null','null');
     INSERT INTO fu3_notes VALUES (1,1,'{"a":null}'),(2,2,NULL);`
  );
  return { db, driver: new SQLite3Driver({ client: db }) };
}

async function bothOutcomes(
  model: "doc" | "note",
  args: Record<string, unknown>
): Promise<{ shipped: unknown; candidate: unknown }> {
  const left = build();
  const right = build();
  const capture = async (run: () => unknown): Promise<unknown> => {
    try {
      return { ok: await run() };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
  try {
    const client = createClient({
      schema,
      driver: left.driver,
    }) as unknown as Record<
      string,
      Record<string, (input: unknown) => unknown>
    >;
    const engine = createCommandEngine({ schema, driver: right.driver });
    return {
      shipped: await capture(() => client[model]!.findMany!(args)),
      candidate: await capture(() => engine.execute(model, "findMany", args)),
    };
  } finally {
    await left.driver.disconnect();
    left.db.close();
    await right.driver.disconnect();
    right.db.close();
  }
}

const agrees = (
  label: string,
  seen: { shipped: unknown; candidate: unknown }
): void => {
  assert.deepEqual(
    seen.candidate,
    seen.shipped,
    `${label}\n  candidate ${JSON.stringify(seen.candidate)}\n  shipped   ${JSON.stringify(seen.shipped)}`
  );
};

const sentence = (field: string, kind: string): string =>
  `JSON filter for field '${field}' cannot combine 'path' with the ${kind} sentinel: the sentinels distinguish the database NULL from the JSON null value of the WHOLE column. Use 'path' with 'equals: null' to test for a JSON null at that path.`;

describe("G4-01 repair 3 review — the JSON sentinel refusal names its own field", () => {
  for (const [kind, sentinel] of [
    ["DbNull", DbNull],
    ["JsonNull", JsonNull],
    ["AnyNull", AnyNull],
  ] as [string, unknown][])
    it(`pins the sentence for ${kind} on the SECOND json column`, async () => {
      const seen = await bothOutcomes("doc", {
        where: {
          AND: [
            { profile: { path: ["a"], equals: null } },
            { settings: { path: ["b"], equals: sentinel } },
          ],
        },
        select: { id: true },
      });
      agrees(`${kind} on settings`, seen);
      assert.deepEqual(seen.candidate, { error: sentence("settings", kind) });
    });

  it("pins the sentence under `not`", async () => {
    const seen = await bothOutcomes("doc", {
      where: { profile: { path: ["a"], not: DbNull } },
      select: { id: true },
    });
    agrees("negated sentinel under a path", seen);
    assert.deepEqual(seen.candidate, { error: sentence("profile", "DbNull") });
  });

  it("pins the sentence under NOT and OR", async () => {
    for (const [label, where] of [
      ["NOT", { NOT: [{ profile: { path: ["a"], equals: JsonNull } }] }],
      [
        "OR",
        {
          OR: [
            { id: 1 },
            { profile: { path: ["a", "b"], equals: JsonNull } },
          ],
        },
      ],
    ] as [string, Record<string, unknown>][]) {
      const seen = await bothOutcomes("doc", { where, select: { id: true } });
      agrees(`${label} sentinel`, seen);
      assert.deepEqual(seen.candidate, {
        error: sentence("profile", "JsonNull"),
      });
    }
  });

  it("pins the sentence in a relation scope, naming the related field", async () => {
    const seen = await bothOutcomes("doc", {
      where: { notes: { some: { payload: { path: ["a"], equals: AnyNull } } } },
      select: { id: true },
    });
    agrees("relation-scoped sentinel", seen);
    assert.deepEqual(seen.candidate, { error: sentence("payload", "AnyNull") });
  });
});

describe("G4-01 repair 3 review — and the JSON shapes that must still answer", () => {
  it("answers an EMPTY path beside a sentinel (no path stated)", async () => {
    for (const [kind, sentinel] of [
      ["DbNull", DbNull],
      ["JsonNull", JsonNull],
      ["AnyNull", AnyNull],
    ] as [string, unknown][]) {
      const seen = await bothOutcomes("doc", {
        where: { profile: { path: [], equals: sentinel } },
        orderBy: { id: "asc" },
        select: { id: true },
      });
      agrees(`empty path with ${kind}`, seen);
    }
  });

  it("answers the whole-column sentinels", async () => {
    for (const [kind, sentinel] of [
      ["DbNull", DbNull],
      ["JsonNull", JsonNull],
      ["AnyNull", AnyNull],
    ] as [string, unknown][]) {
      const seen = await bothOutcomes("doc", {
        where: { profile: { equals: sentinel } },
        orderBy: { id: "asc" },
        select: { id: true },
      });
      agrees(`whole-column ${kind}`, seen);
      assert.ok(
        (seen.candidate as { ok?: unknown }).ok !== undefined,
        `${kind} must answer, saw ${JSON.stringify(seen.candidate)}`
      );
    }
  });

  it("answers a path with a plain `equals: null`", async () => {
    const seen = await bothOutcomes("doc", {
      where: { profile: { path: ["a"], equals: null } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    agrees("path with equals null", seen);
    assert.deepEqual(seen.candidate, { ok: [{ id: 1 }] });
  });
});
