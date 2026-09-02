/**
 * D — dataflow order on hand-written patterns (pattern-engine-ideal-state.md
 * §6.2): use-after-bind, a reference written after its referent exists, the
 * read-before-rebind anti-dependency, the cascade pseudo-statement and the
 * occupied-slot premise, with the payload-order tie-break.
 */
import { type Node, schedule } from "@src/query-engine/pattern/schedule";
import { describe, expect, test } from "vitest";
import { PatternBuilder } from "./fixture";
import { schema } from "./schema";

const substrate = {
  bindsGeneratedKey: "returning",
  supportsTransactions: true,
} as const;

function describeOrder(order: readonly Node[]): string[] {
  return order.map((node) => `${node.kind}:${node.row}`);
}

function selectedRoot(b: PatternBuilder) {
  const rowId = b.nextRow();
  const key = b.matched(rowId, "id", { model: schema.post, field: "id" });
  const root = b.row({
    model: schema.post,
    mode: "assert",
    key: [key],
    predicate: b.equals("id", b.literal("p1")),
    verb: "update",
  });
  b.cell(root, "title", b.literal("t"));
  return { root, key };
}

describe("schedule: dataflow order", () => {
  test("parent-held create: the target row is written before the root that references it", () => {
    const b = new PatternBuilder("update");
    const { root } = selectedRoot(b);
    const userRow = b.nextRow();
    const userKey = b.returned(userRow, "id", {
      model: schema.user,
      field: "id",
    });
    const user = b.row({
      model: schema.user,
      mode: "assert",
      key: [userKey],
      fresh: true,
      verb: "create",
    });
    b.cell(user, "name", b.literal("n"));
    b.cell(root, "authorId", userKey);
    b.reference({
      holder: root,
      referenced: user,
      columns: [{ holderColumn: "authorId", referencedColumn: "id" }],
      relation: { model: schema.post, field: "author" },
    });
    const scheduled = schedule(b.build(root), substrate);
    expect(describeOrder(scheduled.order)).toEqual([
      "match:0",
      "assert:1",
      "assert:0",
    ]);
    expect(scheduled.binders.get(userKey.id)?.row).toBe(user.id);
  });

  test("child-held create: the root is written before the child that references it", () => {
    const b = new PatternBuilder("update");
    const { root, key } = selectedRoot(b);
    const comment = b.row({
      model: schema.comment,
      mode: "assert",
      key: [b.literal("c1")],
      fresh: true,
      verb: "create",
    });
    b.cell(comment, "id", b.literal("c1"));
    b.cell(comment, "body", b.literal("hi"));
    b.cell(comment, "postId", key);
    b.reference({
      holder: comment,
      referenced: root,
      columns: [{ holderColumn: "postId", referencedColumn: "id" }],
      relation: { model: schema.post, field: "comments" },
    });
    const scheduled = schedule(b.build(root), substrate);
    expect(describeOrder(scheduled.order)).toEqual([
      "match:0",
      "assert:0",
      "assert:1",
    ]);
  });

  test("junction: both endpoints are written before the junction row", () => {
    const b = new PatternBuilder("create");
    const postRow = b.nextRow();
    const postKey = b.returned(postRow, "id", {
      model: schema.post,
      field: "id",
    });
    const root = b.row({
      model: schema.post,
      mode: "assert",
      key: [postKey],
      fresh: true,
      verb: "create",
    });
    b.cell(root, "title", b.literal("t"));
    const tagRow = b.nextRow();
    const tagKey = b.returned(tagRow, "id", { model: schema.tag, field: "id" });
    const tag = b.row({
      model: schema.tag,
      mode: "assert",
      key: [tagKey],
      fresh: true,
      verb: "create",
    });
    b.cell(tag, "label", b.literal("l"));
    // Payload order puts the junction row between its endpoints on purpose:
    // dataflow, not position, must place it last.
    const junction = b.row({
      model: schema.post,
      mode: "assert",
      key: [],
      fresh: true,
    });
    b.cell(junction, "postId", postKey);
    b.cell(junction, "tagId", tagKey);
    b.reference({
      holder: junction,
      referenced: root,
      columns: [{ holderColumn: "postId", referencedColumn: "id" }],
      relation: { model: schema.post, field: "tags" },
    });
    b.reference({
      holder: junction,
      referenced: tag,
      columns: [{ holderColumn: "tagId", referencedColumn: "id" }],
      relation: { model: schema.post, field: "tags" },
    });
    const scheduled = schedule(b.build(root), substrate);
    expect(describeOrder(scheduled.order)).toEqual([
      "assert:0",
      "assert:1",
      "assert:2",
    ]);
  });

  test("key transition with cascade: dependents write the old key before the root and nothing after it", () => {
    const b = new PatternBuilder("update");
    const rootRow = b.nextRow();
    const k = b.matched(rootRow, "id", { model: schema.post, field: "id" });
    const kNext = b.literal("p2", { model: schema.post, field: "id" });
    const root = b.row({
      model: schema.post,
      mode: "assert",
      key: [k],
      newKey: [kNext],
      predicate: b.equals("id", b.literal("p1")),
      verb: "update",
    });
    b.cell(root, "id", kNext);
    // A connected child asserting the post-transition key over a cascading edge.
    const commentRow = b.nextRow();
    const commentKey = b.matched(commentRow, "id", {
      model: schema.comment,
      field: "id",
    });
    const comment = b.row({
      model: schema.comment,
      mode: "assert",
      key: [commentKey],
      predicate: b.equals("id", b.literal("c1")),
      matchIsDecision: true,
      verb: "connect",
    });
    const cell = b.cell(comment, "postId", kNext);
    b.reference({
      holder: comment,
      referenced: root,
      columns: [{ holderColumn: "postId", referencedColumn: "id" }],
      relation: { model: schema.post, field: "comments" },
      onKeyChange: "cascade",
    });
    b.project({ scalars: ["id"], relations: [], relationCounts: [] });
    const scheduled = schedule(b.build(root), substrate);
    expect(describeOrder(scheduled.order)).toEqual([
      "match:0",
      "match:1",
      "assert:1",
      "assert:0",
      "cascade:0",
      "terminal:0",
    ]);
    const childWrite = scheduled.order.find(
      (n) => n.kind === "assert" && n.row === comment.id
    )!;
    // The one holder cell is rewritten to the OLD key (the database carries it).
    expect(childWrite.cells).toHaveLength(1);
    expect(childWrite.cells[0]!.column).toBe(cell.column);
    expect(childWrite.cells[0]!.value.id).toBe(k.id);
    expect(childWrite.cascadeCarried).toHaveLength(1);
    // No second assert of that cell exists anywhere after the root.
    const afterRoot = scheduled.order.slice(
      scheduled.order.findIndex(
        (n) => n.kind === "assert" && n.row === root.id
      ) + 1
    );
    expect(afterRoot.filter((n) => n.kind === "assert")).toEqual([]);
    // The terminal reads the NEW key, which the root's own statement binds.
    const terminal = scheduled.order.at(-1)!;
    expect(terminal.consumes).toEqual([kNext.id]);
    expect(scheduled.binders.get(kNext.id)?.row).toBe(root.id);
  });

  test("key transition without cascade: an unreferenced premise precedes the root and the dependent follows it", () => {
    const b = new PatternBuilder("update");
    const rootRow = b.nextRow();
    const k = b.matched(rootRow, "id", { model: schema.post, field: "id" });
    const kNext = b.literal("p2", { model: schema.post, field: "id" });
    const root = b.row({
      model: schema.post,
      mode: "assert",
      key: [k],
      newKey: [kNext],
      predicate: b.equals("id", b.literal("p1")),
      verb: "update",
    });
    b.cell(root, "id", kNext);
    const commentRow = b.nextRow();
    const commentKey = b.matched(commentRow, "id", {
      model: schema.comment,
      field: "id",
    });
    const comment = b.row({
      model: schema.comment,
      mode: "assert",
      key: [commentKey],
      predicate: b.equals("id", b.literal("c1")),
      matchIsDecision: true,
      verb: "connect",
    });
    b.cell(comment, "postId", kNext);
    b.reference({
      holder: comment,
      referenced: root,
      columns: [{ holderColumn: "postId", referencedColumn: "id" }],
      relation: { model: schema.post, field: "comments" },
      onKeyChange: "restrict",
    });
    const scheduled = schedule(b.build(root), substrate);
    expect(describeOrder(scheduled.order)).toEqual([
      "match:0",
      "match:1",
      "unreferenced:0",
      "assert:0",
      "assert:1",
    ]);
    const premise = scheduled.order.find((n) => n.kind === "unreferenced")!;
    expect(premise.premise).toEqual({
      kind: "unreferenced",
      row: root.id,
      raceable: false,
    });
    // The dependent consumes k′, bound by the root's assert (use-after-bind).
    expect(scheduled.binders.get(kNext.id)?.row).toBe(root.id);
  });

  test("tie-break: independent writes keep payload order", () => {
    const b = new PatternBuilder("update");
    const { root, key } = selectedRoot(b);
    // Two child-held connects; neither depends on the root's write.
    for (const id of ["c1", "c2"]) {
      const rowId = b.nextRow();
      const childKey = b.matched(rowId, "id", {
        model: schema.comment,
        field: "id",
      });
      const child = b.row({
        model: schema.comment,
        mode: "assert",
        key: [childKey],
        predicate: b.equals("id", b.literal(id)),
        matchIsDecision: true,
        verb: "connect",
      });
      b.cell(child, "postId", key);
      b.reference({
        holder: child,
        referenced: root,
        columns: [{ holderColumn: "postId", referencedColumn: "id" }],
        relation: { model: schema.post, field: "comments" },
      });
    }
    const scheduled = schedule(b.build(root), substrate);
    // The raw dataflow order interleaves independent matches and writes by
    // payload position; the fragment's match phase hoists the matches (§6.3).
    expect(describeOrder(scheduled.order)).toEqual([
      "match:0",
      "assert:0",
      "match:1",
      "assert:1",
      "match:2",
      "assert:2",
    ]);
    expect(
      scheduled.fragments[0]!.matches.map((level) => level.map((n) => n.row))
    ).toEqual([[0, 1, 2]]);
    expect(describeOrder(scheduled.fragments[0]!.writes)).toEqual([
      "assert:0",
      "assert:1",
      "assert:2",
    ]);
  });
});
