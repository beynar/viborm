/**
 * Behavior anchors the relation-language cutover has to reproduce (plan §10 A
 * item 4, §11.4.9; rulings D9 and D17).
 *
 * These are not new claims about what the engine SHOULD do. They are exact
 * recordings of what HEAD does today at two places the cutover moves:
 *
 *  1. Ruling D9 deletes the synthetic `manyToMany` carrier that variant
 *     collection writes build to enter ordinary junction code, and derives its
 *     labels from `(slot.field, member.variant)` instead — "same strings, no
 *     synthetic relation". A claim about identical strings needs the strings
 *     written down first, so this file pins the carrier label of every member
 *     and the exact ordered step ids of the plans that consume it.
 *
 *  2. Plan §9.4 makes a mixed-nullability compound foreign key nullable and
 *     disconnectable by clearing only its nullable members. HEAD refuses every
 *     such departure. This file pins WHERE each refusal comes from — the
 *     operation schema for `disconnect`, the write compiler for `set` — because
 *     §11.4.9 asks Package E to turn both into writes that keep `tenantId`.
 *
 * What each assertion uniquely covers, against the suites beside it:
 *  - `polymorphic-write-plan.core.test.ts` owns the claim that collection step
 *    ids carry no `#N` suffix, and the singular-transfer behaviors. It never
 *    states the label strings or a complete ordered id sequence, which is
 *    exactly what a "same strings" promise is falsified by.
 *  - `tests/unit/relations/relation-clearability.core.test.ts` owns the unit
 *    rule that a compound key clears only when EVERY column accepts null. It
 *    says nothing about what a caller then sees; the four anchors below are
 *    that consequence, one per write path §11.4.9 enumerates.
 *  - `parity-e-shared-pk.test.ts` pins the single-column required-FK disconnect
 *    refusal. The tuple here is MIXED: one member could legally be cleared, and
 *    the refusal still names only the member that could not.
 */

import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { variantCarrier } from "@query-engine/context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { isVariantRowCarrier } from "@query-engine/types";
import { s } from "@schema";
import { bindPolymorphicCollectionMember } from "@src/query-engine/builders/polymorphic-collection-mutation";
import { CreateOperation } from "@src/query-engine/write-engine/CreateOperation";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

// =============================================================================
// 1. VARIANT COLLECTION LABELS AND STEP IDS (ruling D9)
// =============================================================================

const collectionSchema = (() => {
  const post = s.model({ id: s.int().id(), title: s.string() });
  const clip = s.model({
    id: s.int().id(),
    title: s.string(),
    // A SINGULAR inverse, so one member of this carrier is `one` and the other
    // is `many` — the member-local cardinality D9 must keep deriving.
    board: s.toOne(() => board),
  });
  const board = s.model({
    id: s.int().id(),
    label: s.string(),
    items: s.toMany(
      { post: () => post, clip: () => clip },
      { values: { post: "anchor.post.v1", clip: "anchor.clip.v1" } }
    ),
  });
  return { post, clip, board };
})();

prepareSchema(collectionSchema);

function collectionEngine(): QueryEngine {
  return new QueryEngine(
    new PlanningDriver("postgresql"),
    createModelRegistry(
      collectionSchema,
      createSchemaRegistry(collectionSchema)
    )
  );
}

function collectionUpdatePlan(data: Record<string, unknown>): string[] {
  return new UpdateOperation(collectionEngine(), collectionSchema.board, {
    where: { id: 1 },
    data,
    select: { id: true },
  })
    .planning()
    .steps.map((step) => step.id);
}

describe("variant collection carrier labels", () => {
  test("every member carries the variant-qualified slot label and its own arity", () => {
    // `${relation}.${publicType}` today; `(slot.field, member.variant)` after
    // the cutover. Both must spell `items.post` / `items.clip`, and the arity
    // must stay MEMBER-LOCAL — `clip` is `one` because its inverse is singular,
    // while the public slot stays a collection for both.
    const scope = scopeFor(new PostgresAdapter(), collectionSchema.board);
    const relation = variantCarrier(scope, "items");
    if (!relation || isVariantRowCarrier(relation)) {
      throw new Error("expected the direct polymorphic collection");
    }
    const labels = relation.edge.members.map((member) => {
      const bound = bindPolymorphicCollectionMember(scope, relation, member);
      return {
        variant: member.variant,
        name: bound.relationRef.name,
        cardinality: bound.cardinality,
      };
    });
    expect(labels).toEqual([
      { variant: "post", name: "items.post", cardinality: "many" },
      { variant: "clip", name: "items.clip", cardinality: "one" },
    ]);
  });
});

describe("variant collection step ids", () => {
  test("connect plans one target read per variant plus the singular slot capture", () => {
    expect(
      collectionUpdatePlan({
        items: {
          connect: [
            { type: "post", where: { id: 10 } },
            { type: "clip", where: { id: 20 } },
          ],
        },
      })
    ).toEqual(["board.locate", "post.find", "clip.find", "clip.slot.owners"]);
  });

  test("connect compiles one membership write per variant, then the root read", () => {
    const operation = new UpdateOperation(
      collectionEngine(),
      collectionSchema.board,
      {
        where: { id: 1 },
        data: {
          items: {
            connect: [
              { type: "post", where: { id: 10 } },
              { type: "clip", where: { id: 20 } },
            ],
          },
        },
        select: { id: true },
      }
    );
    const known: Record<string, unknown> = {};
    for (const step of operation.planning().steps) {
      known[`${step.id}.rows`] =
        step.id === "board.locate"
          ? [{ id: 1 }]
          : step.id === "post.find"
            ? [{ id: 10 }]
            : step.id === "clip.find"
              ? [{ id: 20 }]
              : // The singular slot is observed EMPTY, which is the arm that
                // writes without a vacate.
                [];
    }
    expect(
      operation.compile(known).steps.map((step) => `${step.kind}:${step.id}`)
    ).toEqual([
      "write:post.connect",
      "write:clip.connect",
      "read:board.select",
    ]);
  });

  test("set, disconnect and nested create keep their own plan shapes", () => {
    expect(
      collectionUpdatePlan({
        items: { set: [{ type: "post", where: { id: 10 } }] },
      })
    ).toEqual(["board.locate", "post.find"]);
    expect(
      collectionUpdatePlan({
        items: { disconnect: [{ type: "clip", where: { id: 20 } }] },
      })
    ).toEqual(["board.locate"]);
    expect(
      collectionUpdatePlan({
        items: { create: [{ type: "post", data: { id: 30, title: "t" } }] },
      })
    ).toEqual(["board.locate"]);
  });

  test("a root create routes its variant connect through the same member ids", () => {
    expect(
      new CreateOperation(collectionEngine(), collectionSchema.board, {
        data: {
          id: 1,
          label: "l",
          items: { connect: [{ type: "clip", where: { id: 20 } }] },
        },
        select: { id: true },
      })
        .planning()
        .steps.map((step) => step.id)
    ).toEqual(["clip.find", "clip.slot.owners"]);
  });
});

// =============================================================================
// 2. MIXED-NULLABILITY COMPOUND FOREIGN KEY (plan §9.4, §11.4.9)
// =============================================================================

const compoundSchema = (() => {
  const author = s
    .model({
      tenantId: s.string(),
      id: s.string(),
      posts: s.toMany(() => post),
    })
    .id(["tenantId", "id"]);
  const post = s.model({
    id: s.string().id(),
    // The context member is REQUIRED and the parent member is NULLABLE: the
    // membership can be absent, yet clearing it must not clear the tenant.
    tenantId: s.string(),
    authorId: s.string().nullable(),
    author: s
      .toOne(() => author)
      .fields("tenantId", "authorId")
      .references("tenantId", "id"),
  });
  return { author, post };
})();

prepareSchema(compoundSchema);

function compoundEngine(): QueryEngine {
  return new QueryEngine(
    new PlanningDriver("postgresql"),
    createModelRegistry(compoundSchema, createSchemaRegistry(compoundSchema))
  );
}

const AUTHOR_WHERE = { tenantId_id: { tenantId: "t1", id: "a1" } };

/** The `SET` list of the first UPDATE in a compiled plan's SQL. */
function setClauseOf(sql: string): string {
  const update = sql
    .split("\n")
    .find((statement) => statement.startsWith("UPDATE"));
  if (!update) throw new Error("expected an UPDATE statement");
  return update.slice(update.indexOf(" SET "), update.indexOf(" WHERE "));
}

/** Every planning step answered with one plausible row. */
function knownRows(ids: readonly string[]): Record<string, unknown> {
  const known: Record<string, unknown> = {};
  for (const id of ids) {
    known[`${id}.rows`] = [{ id: "p1", tenantId: "t1", authorId: "a1" }];
  }
  return known;
}

describe("mixed-nullability compound foreign key", () => {
  // RE-PINNED (§9.4, §11.4.9). HEAD offered no `disconnect` at all here,
  // because clearability answered ONE boolean for the whole tuple and a mixed
  // key answered `false`. The owner returns the exact ordered NULLABLE SUBSET
  // now, so the verb exists on both sides of the edge and clearing it writes
  // only `authorId`.
  test("both sides publish disconnect and clear only the nullable member", () => {
    const direct = new UpdateOperation(compoundEngine(), compoundSchema.post, {
      where: { id: "p1" },
      data: { author: { disconnect: true } },
      select: { id: true },
    });
    const directPlan = direct.planning();
    const directSql = direct
      .compile(knownRows(directPlan.steps.map((step) => step.id)))
      .steps.flatMap((step) =>
        "statement" in step && step.statement
          ? [step.statement.toStatement("$n")]
          : []
      )
      .join("\n");
    expect(setClauseOf(directSql)).toContain('"authorId" = NULL');
    expect(setClauseOf(directSql)).not.toContain("tenantId");

    const inverse = new UpdateOperation(
      compoundEngine(),
      compoundSchema.author,
      {
        where: AUTHOR_WHERE,
        data: { posts: { disconnect: { id: "p1" } } },
        select: { tenantId: true },
      }
    );
    const inversePlan = inverse.planning();
    const inverseSql = inverse
      .compile(knownRows(inversePlan.steps.map((step) => step.id)))
      .steps.flatMap((step) =>
        "statement" in step && step.statement
          ? [step.statement.toStatement("$n")]
          : []
      )
      .join("\n");
    expect(setClauseOf(inverseSql)).toContain('"authorId" = NULL');
    expect(setClauseOf(inverseSql)).not.toContain("tenantId");
  });

  // RE-PINNED (§9.4, §11.4.9). HEAD refused this at compile with a sentence
  // naming `tenantId`; §9.4 keeps the sentence's premise ("only `tenantId`
  // blocks a full clear") and drops its conclusion. A departure now writes the
  // orphan-null over the NULLABLE SUBSET, so `tenantId` survives it.
  test("a set departure nulls only the nullable member and keeps the context", () => {
    const operation = new UpdateOperation(
      compoundEngine(),
      compoundSchema.author,
      {
        where: AUTHOR_WHERE,
        data: { posts: { set: [{ id: "p1" }] } },
        select: { tenantId: true },
      }
    );
    // The PLAN SHAPE moves with the rule: HEAD read the departing rows first so
    // it could refuse naming them (`post.departing`), and a clearable membership
    // needs no such read — the departure is one correlated bulk UPDATE.
    const planning = operation.planning();
    expect(planning.steps.map((step) => step.id)).toEqual([
      "author.locate",
      "post.find",
    ]);
    const known: Record<string, unknown> = {};
    for (const step of planning.steps) {
      known[`${step.id}.rows`] =
        step.id === "author.locate"
          ? [{ tenantId: "t1", id: "a1" }]
          : [{ id: "p9", tenantId: "t1", authorId: "a1" }];
    }
    const orphanNull = operation
      .compile(known)
      .steps.flatMap((step) =>
        "statement" in step && step.statement
          ? [step.statement.toStatement("$n")]
          : []
      )
      .filter((statement) => statement.startsWith("UPDATE"))
      .join("\n");
    // The SET clause names the nullable member and nothing else; `tenantId`
    // survives, and appears only in the membership predicate that locates the
    // departing rows.
    const setClause = orphanNull.slice(
      orphanNull.indexOf(" SET "),
      orphanNull.indexOf(" WHERE ")
    );
    expect(setClause).toContain('"authorId" = NULL');
    expect(setClause).not.toContain("tenantId");
    expect(orphanNull).toContain('"tenantId"');
  });

  test("the deletion the refusal recommends is available", () => {
    // The escape hatch named in that sentence has to exist, or the refusal
    // leaves a caller with no way to remove a member at all.
    expect(
      new UpdateOperation(compoundEngine(), compoundSchema.author, {
        where: AUTHOR_WHERE,
        data: { posts: { delete: [{ id: "p1" }] } },
      })
        .planning()
        .steps.map((step) => step.id)
    ).toEqual(["author.locate", "post.find"]);
  });
});
