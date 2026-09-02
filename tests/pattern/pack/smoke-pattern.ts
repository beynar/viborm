/**
 * The K4 smoke payload as a hand-written Pattern (§3's sugar rows applied by
 * hand): `post.update({ where: {id: "p1"}, data: { title, author: connect,
 * tags: connect [a, b] }, select: {id} })`.
 *
 * Two construction facts the oracle pins and the fixture spells literally:
 * - a row-held reference whose selector names the referenced column folds the
 *   SELECTOR LITERAL into the holder's cell (today's `toOneFkAssign`), so the
 *   match only proves existence;
 * - a junction row's target cell binds from the target's MATCH (today's
 *   `requireTarget` reads the captured key), not from the selector literal.
 */
import type { Pattern } from "@src/query-engine/pattern/pattern";
import { PatternBuilder } from "@tests/pattern/schedule/fixture";
import { schema } from "@tests/pattern/schedule/schema";

export function smokePattern(): Pattern {
  const b = new PatternBuilder("update");
  const { post, user, tag } = schema;

  const postRowId = b.nextRow();
  const p1 = b.literal("p1", { model: post, field: "id" });
  const postKey = b.matched(postRowId, "id", { model: post, field: "id" });
  const root = b.row({
    model: post,
    mode: "assert",
    key: [postKey],
    predicate: b.equals("id", p1),
    verb: "update",
  });
  b.cell(root, "title", b.literal("t", { model: post, field: "title" }));

  const u1 = b.literal("u1", { model: user, field: "id" });
  const userRowId = b.nextRow();
  const userKey = b.matched(userRowId, "id", { model: user, field: "id" });
  const author = b.row({
    model: user,
    mode: "match",
    key: [userKey],
    predicate: b.equals("id", u1),
    matchIsDecision: true,
    verb: "connect",
  });
  b.cell(root, "authorId", u1);
  b.reference({
    holder: root,
    referenced: author,
    columns: [{ holderColumn: "authorId", referencedColumn: "id" }],
    relation: { model: post, field: "author" },
    nullable: true,
  });

  const tags = ["a", "b"].map((id) => {
    const literal = b.literal(id, { model: tag, field: "id" });
    const rowId = b.nextRow();
    const key = b.matched(rowId, "id", { model: tag, field: "id" });
    const row = b.row({
      model: tag,
      mode: "match",
      key: [key],
      predicate: b.equals("id", literal),
      matchIsDecision: true,
      verb: "connect",
    });
    return { row, key };
  });
  for (const { row, key } of tags) {
    const junction = b.row({
      model: post,
      mode: "assert",
      key: [],
      fresh: true,
      verb: "connect",
      referenceRow: "post_tag",
    });
    b.cell(junction, "postId", postKey);
    b.cell(junction, "tagId", key);
    b.reference({
      holder: junction,
      referenced: root,
      columns: [{ holderColumn: "postId", referencedColumn: "id" }],
      relation: { model: post, field: "tags" },
      onKeyChange: "cascade",
    });
    b.reference({
      holder: junction,
      referenced: row,
      columns: [{ holderColumn: "tagId", referencedColumn: "id" }],
      relation: { model: post, field: "tags" },
      onKeyChange: "cascade",
    });
  }

  b.project({ scalars: ["id"], relations: [], relationCounts: [] });
  return b.build(root);
}
