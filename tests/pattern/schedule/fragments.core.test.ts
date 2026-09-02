/**
 * D — fragment cuts (pattern-engine-ideal-state.md §6.3): an execution-only
 * binding the substrate cannot bind in place, and a merge outcome that must
 * be observed before its dependents. Cuts are derived, never placed.
 */
import { schedule } from "@src/query-engine/pattern/schedule";
import { describe, expect, test } from "vitest";
import { PatternBuilder } from "./fixture";
import { schema } from "./schema";

function freshRootWithChild(b: PatternBuilder) {
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
  const comment = b.row({
    model: schema.comment,
    mode: "assert",
    key: [b.literal("c1")],
    fresh: true,
    verb: "create",
  });
  b.cell(comment, "id", b.literal("c1"));
  b.cell(comment, "postId", postKey);
  b.reference({
    holder: comment,
    referenced: root,
    columns: [{ holderColumn: "postId", referencedColumn: "id" }],
    relation: { model: schema.post, field: "comments" },
  });
  return { root, comment, postKey };
}

describe("schedule: fragments", () => {
  test("a generated key consumed later cuts a fragment only when the substrate cannot bind it in place", () => {
    const b = new PatternBuilder("create");
    const { root, postKey } = freshRootWithChild(b);
    const pattern = b.build(root);

    const none = schedule(pattern, {
      bindsGeneratedKey: "none",
      supportsTransactions: false,
    });
    expect(none.fragments).toHaveLength(2);
    expect(none.fragments[0]!.boundary).toEqual({
      kind: "executionBinding",
      variable: postKey.id,
      statement: `row ${root.id} assert`,
    });
    expect(none.fragments[0]!.writes.map((n) => n.row)).toEqual([root.id]);
    expect(none.fragments[1]!.writes.map((n) => n.row)).toEqual([1]);
    expect(none.fragments[1]!.boundary).toEqual({ kind: "end" });

    for (const bindsGeneratedKey of [
      "returning",
      "insertId",
      "reselect",
    ] as const) {
      const bound = schedule(pattern, {
        bindsGeneratedKey,
        supportsTransactions: true,
      });
      expect(bound.fragments).toHaveLength(1);
      expect(bound.fragments[0]!.boundary).toEqual({ kind: "end" });
    }
  });

  test("a generated key nobody consumes cuts nothing", () => {
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
    const scheduled = schedule(b.build(root), {
      bindsGeneratedKey: "none",
      supportsTransactions: false,
    });
    expect(scheduled.fragments).toHaveLength(1);
  });

  test("a merge decided by its own write is observed before its arm's dependents", () => {
    const b = new PatternBuilder("createMany");
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
      verb: "createMany",
    });
    b.cell(root, "title", b.literal("t"));
    // skipDuplicates: the root write itself decides the merge; the subtree runs
    // only in the "missing" (inserted) arm.
    const arm = b.arm(root, "missing");
    const comment = b.row({
      model: schema.comment,
      mode: "assert",
      key: [b.literal("c1")],
      fresh: true,
      arm: arm.id,
      verb: "create",
    });
    b.cell(comment, "id", b.literal("c1"));
    b.cell(comment, "postId", postKey);
    b.reference({
      holder: comment,
      referenced: root,
      columns: [{ holderColumn: "postId", referencedColumn: "id" }],
      relation: { model: schema.post, field: "comments" },
    });
    const scheduled = schedule(b.build(root), {
      bindsGeneratedKey: "returning",
      supportsTransactions: true,
    });
    expect(scheduled.fragments).toHaveLength(2);
    expect(scheduled.fragments[0]!.boundary).toEqual({
      kind: "mergeOutcome",
      row: root.id,
    });
    expect(scheduled.fragments[1]!.writes.map((n) => n.row)).toEqual([
      comment.id,
    ]);
  });

  test("matches run first, grouped by dependency level, inside one fragment", () => {
    const b = new PatternBuilder("update");
    const postRow = b.nextRow();
    const postKey = b.matched(postRow, "id", {
      model: schema.post,
      field: "id",
    });
    const root = b.row({
      model: schema.post,
      mode: "assert",
      key: [postKey],
      predicate: b.equals("id", b.literal("p1")),
      verb: "update",
    });
    b.cell(root, "title", b.literal("t"));
    // A correlated child match (update X ∈ N): reads the root's matched key.
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
      verb: "update",
    });
    b.cell(comment, "postId", postKey, "match");
    b.cell(comment, "body", b.literal("edited"));
    b.reference({
      holder: comment,
      referenced: root,
      columns: [{ holderColumn: "postId", referencedColumn: "id" }],
      relation: { model: schema.post, field: "comments" },
    });
    const scheduled = schedule(b.build(root), {
      bindsGeneratedKey: "returning",
      supportsTransactions: true,
    });
    expect(scheduled.fragments).toHaveLength(1);
    expect(
      scheduled.fragments[0]!.matches.map((level) => level.map((n) => n.row))
    ).toEqual([[root.id], [comment.id]]);
    expect(
      scheduled.fragments[0]!.writes.map((n) => `${n.kind}:${n.row}`)
    ).toEqual(["assert:0", "assert:1"]);
  });
});
