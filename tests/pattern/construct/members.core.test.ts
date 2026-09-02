/**
 * Per-fragment construction (pattern-engine-ideal-state.md §5 rule 1): a bulk
 * root with relation data constructs ONE pattern per member from the member's
 * RAW row, so a generated default is materialised per member.
 */
import { s } from "@schema";
import { constructMemberPatterns } from "@src/query-engine/pattern/construct";
import { parseValidated } from "@src/query-engine/write-engine/parse-boundary";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { cells, indexOf, rows } from "./harness";

const LITERAL_KEY = /^lit\("/;

const schema = (() => {
  const author = s
    .model({
      id: s.string().id().ulid(),
      name: s.string(),
      books: s.toMany(() => book),
    })
    .map("mb_authors");
  const book = s
    .model({
      id: s.string().id().ulid(),
      title: s.string(),
      authorId: s.string().nullable(),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id"),
    })
    .map("mb_books");
  return { author, book };
})();

describe("member patterns", () => {
  test("createMany with relation data: one pattern per raw row, defaults materialised per member", () => {
    const index = indexOf(schema);
    const schemas = createSchemaRegistry(schema).getModelSchemas(schema.author);
    const raw = [
      { name: "a", books: { create: { title: "x" } } },
      { name: "b", books: { create: { title: "y" } } },
    ];
    const patterns = constructMemberPatterns({
      index,
      model: schema.author,
      operation: "createMany",
      members: raw,
      // The member's own parse boundary: the whole `create` args schema over
      // `{ data: row }`, exactly what a series member is handed today.
      parseMember: (row) =>
        parseValidated(schemas.args.create, { data: row }, "create", ""),
    });
    expect(patterns).toHaveLength(2);
    const keys = patterns.map((p) => rows(p.pattern)[0]!.key[0]);
    expect(keys[0]).toMatch(LITERAL_KEY);
    expect(keys[0]).not.toBe(keys[1]);
    const bookKeys = patterns.map((p) => rows(p.pattern)[1]!.key[0]);
    expect(bookKeys[0]).not.toBe(bookKeys[1]);
    // Each member is a complete create pattern: root, nested book, reference.
    for (const { pattern } of patterns) {
      expect(pattern.operation).toBe("create");
      expect(rows(pattern).map((r) => r.table)).toEqual([
        "mb_authors",
        "mb_books",
      ]);
      expect(cells(pattern, 1).at(-1)?.column).toBe("authorId");
    }
  });

  test("updateMany with relation data: one update pattern per captured root, addressed by its key", () => {
    const index = indexOf(schema);
    const schemas = createSchemaRegistry(schema).getModelSchemas(schema.author);
    const captured = [{ id: "A1" }, { id: "A2" }];
    const data = { books: { create: { title: "z" } } };
    const patterns = constructMemberPatterns({
      index,
      model: schema.author,
      operation: "updateMany",
      members: captured,
      parseMember: (row) => ({
        where: row,
        data: parseValidated(schemas.core.update, data, "updateMany", "data"),
      }),
    });
    expect(patterns.map((p) => rows(p.pattern)[0]!.key)).toEqual([
      ['lit("A1")'],
      ['lit("A2")'],
    ]);
    const bookKeys = patterns.map((p) => rows(p.pattern)[1]!.key[0]);
    expect(bookKeys[0]).not.toBe(bookKeys[1]);
  });
});
