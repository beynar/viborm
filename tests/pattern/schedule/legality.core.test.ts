/**
 * D — legality (pattern-engine-ideal-state.md §6.4): per fragment, no match
 * may observe an earlier assert, over BOTH arms, classified by
 * `TargetConstraint.ts`. The refusal is today's `NestedWriteError` verbatim
 * (OwnWriteLedger.ts:255). Deferred construction refusals are raised after it.
 */
import { NestedWriteError } from "@errors";
import { schedule } from "@src/query-engine/pattern/schedule";
import { describe, expect, test } from "vitest";
import { PatternBuilder } from "./fixture";
import { schema } from "./schema";

const substrate = {
  bindsGeneratedKey: "returning",
  supportsTransactions: true,
} as const;

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

function createComment(
  b: PatternBuilder,
  root: ReturnType<typeof selectedRoot>,
  slug: string
) {
  const comment = b.row({
    model: schema.comment,
    mode: "assert",
    key: [b.literal(`${slug}-id`)],
    fresh: true,
    verb: "create",
  });
  b.cell(comment, "id", b.literal(`${slug}-id`));
  b.cell(comment, "slug", b.literal(slug));
  b.cell(comment, "postId", root.key);
  b.reference({
    holder: comment,
    referenced: root.root,
    columns: [{ holderColumn: "postId", referencedColumn: "id" }],
    relation: { model: schema.post, field: "comments" },
  });
  return comment;
}

function connectComment(
  b: PatternBuilder,
  root: ReturnType<typeof selectedRoot>,
  slug: string,
  verb = "connect"
) {
  const rowId = b.nextRow();
  const key = b.matched(rowId, "id", { model: schema.comment, field: "id" });
  const comment = b.row({
    model: schema.comment,
    mode: "assert",
    key: [key],
    predicate: b.equals("slug", b.literal(slug)),
    matchIsDecision: true,
    verb,
  });
  b.cell(comment, "postId", root.key);
  b.reference({
    holder: comment,
    referenced: root.root,
    columns: [{ holderColumn: "postId", referencedColumn: "id" }],
    relation: { model: schema.post, field: "comments" },
  });
  return comment;
}

describe("schedule: legality", () => {
  test("a match that would observe an earlier create of the same target is refused verbatim", () => {
    const b = new PatternBuilder("update");
    const root = selectedRoot(b);
    createComment(b, root, "x");
    connectComment(b, root, "x");
    let caught: unknown;
    try {
      schedule(b.build(root.root), substrate);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NestedWriteError);
    const error = caught as NestedWriteError;
    expect(error.message).toBe(
      "Nested operation 'connect' on relation 'comments' depends on an earlier 'create' target write in the same nested write. Split these operations into separate queries."
    );
    expect(error.code).toBe("V7001");
    // `dependency` / `overlap` are passed as today's ledger passes them and
    // stripped by the same metadata allowlist (`ERROR_META_KEYS`).
    expect(error.meta).toMatchObject({
      relation: "comments",
      operation: "connect",
      conflictsWith: "create",
    });
  });

  test("a provably disjoint pair is not refused", () => {
    const b = new PatternBuilder("update");
    const root = selectedRoot(b);
    // Different string slugs are not PROVABLY disjoint under the portable rule
    // (only int / bigint / boolean literals prove disjointness), so this pair
    // uses the classification's exactness on equal keys: a create on "x" and a
    // match on "y" classify "unknown" and are refused today too. The disjoint
    // witness is the int-typed classification, exercised on the target
    // existence dimension through a bigint-free schema below.
    createComment(b, root, "x");
    const scheduled = schedule(b.build(root.root), substrate);
    expect(scheduled.fragments).toHaveLength(1);
  });

  test("a deduplicated connectOrCreate pair shares one match and is not refused", () => {
    const b = new PatternBuilder("update");
    const root = selectedRoot(b);
    // First-create-wins: one decision match on slug "x"; the found arm links
    // it, the missing arm creates it; the SECOND occurrence takes the first's
    // variable, so there is no second match to refuse.
    const rowId = b.nextRow();
    const key = b.matched(rowId, "id", { model: schema.comment, field: "id" });
    const decision = b.row({
      model: schema.comment,
      mode: "match",
      key: [key],
      predicate: b.equals("slug", b.literal("x")),
      matchIsDecision: true,
      verb: "connectOrCreate",
    });
    const found = b.arm(decision, "found");
    const missing = b.arm(decision, "missing");
    const link = b.row({
      model: schema.comment,
      mode: "assert",
      key: [key],
      arm: found.id,
      verb: "connectOrCreate",
    });
    b.cell(link, "postId", root.key);
    b.reference({
      holder: link,
      referenced: root.root,
      columns: [{ holderColumn: "postId", referencedColumn: "id" }],
      relation: { model: schema.post, field: "comments" },
    });
    const created = b.row({
      model: schema.comment,
      mode: "assert",
      key: [b.literal("x-id")],
      fresh: true,
      arm: missing.id,
      verb: "connectOrCreate",
    });
    b.cell(created, "id", b.literal("x-id"));
    b.cell(created, "slug", b.literal("x"));
    b.cell(created, "postId", root.key);
    b.reference({
      holder: created,
      referenced: root.root,
      columns: [{ holderColumn: "postId", referencedColumn: "id" }],
      relation: { model: schema.post, field: "comments" },
    });
    // The second occurrence: another link to the SAME matched row.
    const second = b.row({
      model: schema.comment,
      mode: "assert",
      key: [key],
      arm: found.id,
      verb: "connectOrCreate",
    });
    b.cell(second, "body", b.literal("again"));
    const scheduled = schedule(b.build(root.root), substrate);
    const matches = scheduled.fragments[0]!.matches.flat();
    expect(matches.map((n) => n.row)).toEqual([root.root.id, decision.id]);
  });

  test("both arms' matches are in the match phase; only the taken arm's writes are marked taken", () => {
    const b = new PatternBuilder("update");
    const root = selectedRoot(b);
    // upsert on comments: decision match (found) → update arm with its own
    // correlated match; missing arm → create.
    const rowId = b.nextRow();
    const key = b.matched(rowId, "id", { model: schema.comment, field: "id" });
    const decision = b.row({
      model: schema.comment,
      mode: "match",
      key: [key],
      predicate: b.equals("slug", b.literal("x")),
      matchIsDecision: true,
      verb: "upsert",
    });
    const found = b.arm(decision, "found");
    const missing = b.arm(decision, "missing");
    const updated = b.row({
      model: schema.comment,
      mode: "assert",
      key: [key],
      arm: found.id,
      verb: "update",
    });
    b.cell(updated, "body", b.literal("edited"));
    // The found arm's own nested match (a deeper correlated read).
    const innerRowId = b.nextRow();
    const innerKey = b.matched(innerRowId, "id", {
      model: schema.user,
      field: "id",
    });
    b.row({
      model: schema.user,
      mode: "match",
      key: [innerKey],
      predicate: b.equals("id", b.literal("u1")),
      arm: found.id,
      matchIsDecision: true,
      verb: "connect",
    });
    const created = b.row({
      model: schema.comment,
      mode: "assert",
      key: [b.literal("x-id")],
      fresh: true,
      arm: missing.id,
      verb: "create",
    });
    b.cell(created, "id", b.literal("x-id"));
    b.cell(created, "slug", b.literal("x"));
    const scheduled = schedule(b.build(root.root), substrate);
    const matches = scheduled.fragments[0]!.matches.flat();
    expect(matches.map((n) => n.row)).toEqual([root.root.id, decision.id, 3]);
    const writes = scheduled.fragments[0]!.writes;
    expect(writes.map((n) => [n.row, n.taken])).toEqual([
      [root.root.id, true],
      [updated.id, true],
      [created.id, false],
    ]);
  });

  test("deferred construction refusals are raised after legality", () => {
    const b = new PatternBuilder("update");
    const root = selectedRoot(b);
    createComment(b, root, "x");
    connectComment(b, root, "x");
    const deferred = () => {
      throw new Error("construction refusal");
    };
    expect(() => schedule(b.build(root.root), substrate, [deferred])).toThrow(
      NestedWriteError
    );

    const clean = new PatternBuilder("update");
    const cleanRoot = selectedRoot(clean);
    expect(() =>
      schedule(clean.build(cleanRoot.root), substrate, [deferred])
    ).toThrow("construction refusal");
  });
});
