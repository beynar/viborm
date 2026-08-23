import { s } from "@schema";
import type { AnyModel } from "@schema/model";
import {
  clearableMembership,
  membershipCanBeCleared,
  slotMayBeEmpty,
} from "@schema/relation/clearability";
import { hydrateSchemaNames } from "@src/schema/hydration";
import { SchemaValidator } from "@src/schema/validation";
import type { ResolvedSlot } from "@src/schema/validation/relation-resolution";
import { describe, expect, test } from "vitest";

/**
 * THE TWO FACTS ABOUT EMPTYING A RELATION, and the reason they are still two.
 *
 * `slotMayBeEmpty` is the PUBLIC slot: may this relation return nothing. It is
 * asked PER ENDPOINT, because an owner and its inverse genuinely differ — an
 * owner's slot is empty when its own tuple is, while a non-owner's is empty
 * whenever no referencing row exists.
 *
 * `clearableMembership` is PHYSICAL storage: HOW the membership is emptied while
 * both rows survive. It is one answer PER EDGE, because the columns that record
 * the membership are the same columns whichever end asks to disconnect. It is no
 * longer a boolean: a mixed compound foreign key nulls its nullable members and
 * keeps its required context ones (§8.4, §11.2.14).
 *
 * Neither reads a declared `.optional()` flag on a model-target relation. That
 * flag is gone; emptiness follows from the stored tuple.
 */

/** Resolve one schema and read back the trusted slot for `model.field`. */
function resolved(
  schema: Record<string, AnyModel>,
  modelKey: string,
  field: string
): ResolvedSlot {
  hydrateSchemaNames(schema);
  const resolution = new SchemaValidator().registerAll(schema).resolve();
  if (!resolution.ok) {
    throw new Error(
      `fixture did not resolve: ${resolution.issues.map((issue) => issue.code).join(", ")}`
    );
  }
  const model = schema[modelKey];
  const slot = model && resolution.index.get(model)?.get(field);
  if (!slot) throw new Error(`no resolved slot for ${modelKey}.${field}`);
  return slot;
}

// =============================================================================
// ORDINARY ROW FOREIGN KEYS (§11.2.13, §11.2.14, §11.2.20)
// =============================================================================

/** One owner shape per nullability pattern, over one shared target. */
function ownerSchema(nullable: readonly string[]): Record<string, AnyModel> {
  const scalar = (field: string) =>
    nullable.includes(field) ? s.string().nullable() : s.string();
  const org = s
    .model({
      tenantId: s.string(),
      id: s.string(),
      members: s.toMany(() => member),
    })
    .id(["tenantId", "id"]);
  const member = s.model({
    id: s.string().id(),
    tenantId: scalar("tenantId"),
    orgId: scalar("orgId"),
    org: s
      .toOne(() => org)
      .fields("tenantId", "orgId")
      .references("tenantId", "id"),
  });
  return { org, member };
}

describe("a row foreign key", () => {
  test("an all-non-nullable tuple is required and clears nothing", () => {
    const schema = ownerSchema([]);
    const owner = resolved(schema, "member", "org");

    expect(slotMayBeEmpty(owner)).toBe(false);
    expect(clearableMembership(owner)).toEqual({ kind: "none" });
    expect(membershipCanBeCleared(owner)).toBe(false);
  });

  test("an all-nullable tuple is empty-able and clears every member", () => {
    const schema = ownerSchema(["tenantId", "orgId"]);
    const owner = resolved(schema, "member", "org");

    expect(slotMayBeEmpty(owner)).toBe(true);
    expect(clearableMembership(owner)).toEqual({
      kind: "columns",
      fields: ["tenantId", "orgId"],
    });
  });

  test("a MIXED tuple is valid, empty-able, and clears only its nullable members", () => {
    // §9.4 first truthful-semantics bullet: HEAD required EVERY member to be
    // nullable before it would call the membership clearable. One nullable
    // member is enough to make the whole membership absent, and disconnect
    // keeps the required context member.
    const schema = ownerSchema(["orgId"]);
    const owner = resolved(schema, "member", "org");

    expect(slotMayBeEmpty(owner)).toBe(true);
    expect(clearableMembership(owner)).toEqual({
      kind: "columns",
      fields: ["orgId"],
    });
  });

  test("the tuple order is the declaration's, not the nullable members' order", () => {
    const schema = ownerSchema(["tenantId"]);

    expect(clearableMembership(resolved(schema, "member", "org"))).toEqual({
      kind: "columns",
      fields: ["tenantId"],
    });
  });

  test("the NON-OWNER is always empty-able and clears the same columns", () => {
    // One membership, one set of columns: `org.members.disconnect` nulls
    // exactly what `member.org.disconnect` nulls.
    const schema = ownerSchema(["orgId"]);
    const inverse = resolved(schema, "org", "members");

    expect(slotMayBeEmpty(inverse)).toBe(true);
    expect(clearableMembership(inverse)).toEqual(
      clearableMembership(resolved(schema, "member", "org"))
    );
  });

  test("flipping one scalar changes membership without touching the declaration", () => {
    // §11.2.20: the relation's stored state is identical in both schemas.
    const required = ownerSchema([]);
    const nullable = ownerSchema(["orgId"]);
    // Every DECLARED fact, minus the two things that are necessarily distinct
    // objects (the fresh target getter and the fresh target model).
    const declarationOf = (schema: Record<string, AnyModel>) => {
      const state = schema.member?.["~"].state.relations.org?.["~"].state;
      return {
        kind: state?.kind,
        cardinality: state?.cardinality,
        name: state?.name,
        targetKind: state?.target?.kind,
        foreignKey: state?.foreignKey,
      };
    };

    expect(declarationOf(required)).toEqual(declarationOf(nullable));
    expect(membershipCanBeCleared(resolved(required, "member", "org"))).toBe(
      false
    );
    expect(membershipCanBeCleared(resolved(nullable, "member", "org"))).toBe(
      true
    );
  });
});

// =============================================================================
// ORDINARY JUNCTIONS
// =============================================================================

describe("an ordinary junction", () => {
  test("is always empty-able and clears by deleting its membership row", () => {
    const post = s.model({ id: s.string().id(), tags: s.toMany(() => tag) });
    const tag = s.model({ id: s.string().id(), posts: s.toMany(() => post) });
    const schema = { post, tag };

    for (const [modelKey, field] of [
      ["post", "tags"],
      ["tag", "posts"],
    ] as const) {
      const slot = resolved(schema, modelKey, field);
      expect(slotMayBeEmpty(slot)).toBe(true);
      expect(clearableMembership(slot)).toEqual({ kind: "junctionRow" });
    }
  });
});

// =============================================================================
// THE FOUR VARIANT CELLS (§11.3.14)
// =============================================================================

/** Row carrier × (required | optional) × (to-one | to-many) inverse. */
function rowCarrierSchema(
  optional: boolean,
  inverse: "one" | "many"
): Record<string, AnyModel> {
  const post = s.model({
    id: s.string().id(),
    subject:
      inverse === "one"
        ? s.toOne(() => comment).name("subject")
        : s.toMany(() => comment).name("subject"),
  });
  const carrier = s.toOne({ post: () => post }).name("subject");
  const comment = s.model({
    id: s.string().id(),
    subject: optional ? carrier.optional() : carrier,
  });
  return { post, comment };
}

describe("a row-held variant carrier", () => {
  test.each([
    ["one"],
    ["many"],
  ] as const)("with an optional carrier and a to-%s inverse, both ends clear its column pair", (inverse) => {
    const schema = rowCarrierSchema(true, inverse);
    const carrier = resolved(schema, "comment", "subject");
    const bound = resolved(schema, "post", "subject");

    expect(slotMayBeEmpty(carrier)).toBe(true);
    expect(slotMayBeEmpty(bound)).toBe(true);
    expect(clearableMembership(carrier)).toEqual({
      kind: "columns",
      fields: ["subject_type", "subject_id"],
    });
    // The inverse is a VIEW over the same storage, so it gets the same answer.
    expect(clearableMembership(bound)).toEqual(clearableMembership(carrier));
  });

  test.each([
    ["one"],
    ["many"],
  ] as const)("with a REQUIRED carrier and a to-%s inverse, neither end exposes disconnect", (inverse) => {
    const schema = rowCarrierSchema(false, inverse);
    const carrier = resolved(schema, "comment", "subject");
    const bound = resolved(schema, "post", "subject");

    expect(slotMayBeEmpty(carrier)).toBe(false);
    // The two ends genuinely differ: the carrier's own `(type, id)` pair is
    // NOT NULL, but no row is obliged to point AT this post, so the inverse
    // slot is empty-able even though the membership itself cannot be cleared.
    expect(slotMayBeEmpty(bound)).toBe(true);
    expect(clearableMembership(carrier)).toEqual({ kind: "none" });
    expect(membershipCanBeCleared(bound)).toBe(false);
  });
});

/** Member-junction carrier × (to-one | to-many) inverse. */
function memberJunctionSchema(
  inverse: "one" | "many"
): Record<string, AnyModel> {
  const book = s.model({
    id: s.string().id(),
    shelf:
      inverse === "one"
        ? s.toOne(() => shelf).name("items")
        : s.toMany(() => shelf).name("items"),
  });
  const shelf = s.model({
    id: s.string().id(),
    items: s.toMany({ book: () => book }).name("items"),
  });
  return { book, shelf };
}

describe("a member-junction variant carrier", () => {
  test.each([
    ["one"],
    ["many"],
  ] as const)("clears by deleting membership for a to-%s inverse", (inverse) => {
    const schema = memberJunctionSchema(inverse);
    const carrier = resolved(schema, "shelf", "items");
    const bound = resolved(schema, "book", "shelf");

    expect(slotMayBeEmpty(carrier)).toBe(true);
    expect(slotMayBeEmpty(bound)).toBe(true);
    expect(clearableMembership(carrier)).toEqual({ kind: "junctionRow" });
    expect(clearableMembership(bound)).toEqual({ kind: "junctionRow" });
  });
});
