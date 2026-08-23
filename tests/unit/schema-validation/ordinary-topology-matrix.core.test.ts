import { s } from "@schema";
import { type AnyModel, getModelKeyCatalog } from "@schema/model";
import { hydrateSchemaNames } from "@src/schema/hydration";
import { SchemaValidator, validateSchema } from "@src/schema/validation";
import {
  type ResolvedRelationEdge,
  resolvedEdges,
} from "@src/schema/validation/relation-resolution";
import { describe, expect, it } from "vitest";

/**
 * THE ORDINARY TOPOLOGY MATRIX (plan §6.3; falsifiers §11.2.1-5, 16).
 *
 * `relation-topology-matrix.core.test.ts` beside this one pins the VERDICT each
 * cell receives. This file pins what the gate DERIVES for the cells it accepts:
 * which endpoint owns the foreign key, whether that key is unique, and whether a
 * junction exists — the four cells of the §6.3 table, read off the trusted edge
 * rather than off a declared topology name that no longer exists.
 */

function edgesOf(schema: Record<string, AnyModel>): ResolvedRelationEdge[] {
  hydrateSchemaNames(schema);
  const resolution = new SchemaValidator().registerAll(schema).resolve();
  if (!resolution.ok) {
    throw new Error(
      `fixture did not resolve: ${resolution.issues.map((i) => i.code).join(", ")}`
    );
  }
  return [...resolvedEdges(resolution.index)];
}

function soleEdge(schema: Record<string, AnyModel>): ResolvedRelationEdge {
  const edges = edgesOf(schema);
  const [edge] = edges;
  if (edges.length !== 1 || !edge) {
    throw new Error(`expected exactly one edge, got ${edges.length}`);
  }
  return edge;
}

/** one/one, one/many, many/one, many/many over one pair of models. */
function pair(
  left: "one" | "many",
  right: "one" | "many",
  ownerSide: "alpha" | "beta" | "none",
  uniqueScalar = false
): { alpha: AnyModel; beta: AnyModel } {
  const leftSlot = () =>
    ownerSide === "alpha"
      ? s
          .toOne(() => beta_)
          .fields("betaId")
          .references("id")
      : left === "one"
        ? s.toOne(() => beta_)
        : s.toMany(() => beta_);
  const rightSlot = () =>
    ownerSide === "beta"
      ? s
          .toOne(() => alpha_)
          .fields("alphaId")
          .references("id")
      : right === "one"
        ? s.toOne(() => alpha_)
        : s.toMany(() => alpha_);
  const scalar = () => (uniqueScalar ? s.string().unique() : s.string());
  const alpha_: AnyModel = s.model({
    id: s.string().id(),
    ...(ownerSide === "alpha" ? { betaId: scalar() } : {}),
    other: leftSlot(),
  });
  const beta_: AnyModel = s.model({
    id: s.string().id(),
    ...(ownerSide === "beta" ? { alphaId: scalar() } : {}),
    other: rightSlot(),
  });
  return { alpha: alpha_, beta: beta_ };
}

describe("§6.3 one|one", () => {
  it("puts a UNIQUE foreign key on the single owner", () => {
    const schema = pair("one", "one", "alpha");
    const edge = soleEdge(schema);

    expect(edge.kind).toBe("foreignKey");
    if (edge.kind !== "foreignKey") return;
    expect(edge.owner.source).toBe(schema.alpha);
    expect(edge.unique).toBe(true);
    expect(edge.reference.members).toEqual([
      { foreignField: "betaId", referencedField: "id" },
    ]);
  });

  it("derives that uniqueness even when no unique key is declared", () => {
    // §9.4: the paired to-one slots ARE the uniqueness statement. Declaring the
    // scalar unique as well changes nothing about the edge.
    expect(soleEdge(pair("one", "one", "alpha", true))).toMatchObject({
      kind: "foreignKey",
      unique: true,
    });
  });

  it("adds no unique SELECTOR for the constraint it derived", () => {
    // §11.2.6. The physical constraint comes from the pair, so it is not a
    // declared model key and no `whereUnique` selector can name it: the
    // catalog reads declared keys only. Declaring the same scalar unique
    // admits the selector — and changes no DDL byte, which the relation-DDL
    // corpus pins as `one-to-one-derived-unique` beside
    // `one-to-one-declared-unique`.
    const derived = pair("one", "one", "alpha");
    expect(soleEdge(derived)).toMatchObject({
      kind: "foreignKey",
      unique: true,
    });
    expect(getModelKeyCatalog(derived.alpha).addressableKeys).toEqual([
      { kind: "primary", fields: ["id"] },
    ]);

    const declared = pair("one", "one", "alpha", true);
    expect(getModelKeyCatalog(declared.alpha).addressableKeys).toEqual([
      { kind: "primary", fields: ["id"] },
      { kind: "unique", fields: ["betaId"] },
    ]);
  });

  it("refuses zero and two owners", () => {
    const zero = pair("one", "one", "none");
    hydrateSchemaNames(zero);
    expect(validateSchema(zero).errors.map((i) => i.code)).toEqual(["FK004"]);

    const alphaOwner = s.model({
      id: s.string().id(),
      betaId: s.string().unique(),
      other: s
        .toOne(() => beta)
        .fields("betaId")
        .references("id"),
    });
    const beta = s.model({
      id: s.string().id(),
      alphaId: s.string().unique(),
      other: s
        .toOne(() => alphaOwner)
        .fields("alphaId")
        .references("id"),
    });
    const two = { alpha: alphaOwner, beta };
    hydrateSchemaNames(two);
    expect(validateSchema(two).errors.map((i) => i.code)).toEqual(["CM003"]);
  });
});

describe("§6.3 one|many and many|one", () => {
  it.each([
    ["alpha", "alpha", "beta"],
    ["beta", "beta", "alpha"],
  ] as const)("puts a NON-UNIQUE foreign key on the %s (the `one`) endpoint", (_label, ownerSide, manySide) => {
    const schema = pair(
      ownerSide === "alpha" ? "one" : "many",
      ownerSide === "beta" ? "one" : "many",
      ownerSide
    );
    const edge = soleEdge(schema);

    expect(edge.kind).toBe("foreignKey");
    if (edge.kind !== "foreignKey") return;
    expect(edge.owner.source).toBe(schema[ownerSide]);
    expect(edge.unique).toBe(false);
    expect(edge.endpoints.map((slot) => slot.source)).toContain(
      schema[manySide]
    );
  });

  it("refuses a physically unique foreign key facing a remote to-many", () => {
    const schema = pair("one", "many", "alpha", true);
    hydrateSchemaNames(schema);

    expect(validateSchema(schema).errors.map((i) => i.code)).toEqual(["FK009"]);
  });

  it("reads that uniqueness from a DECLARED unique index too", () => {
    // A compound-capable spelling: `.index([...], { unique: true })` claims no
    // per-scalar flag, so a reading that only consulted the addressable keys
    // would accept the very contradiction the scalar spelling above refuses.
    const beta_: AnyModel = s.model({
      id: s.string().id(),
      alphas: s.toMany(() => alpha_),
    });
    const alpha_: AnyModel = s
      .model({
        id: s.string().id(),
        betaId: s.string(),
        other: s
          .toOne(() => beta_)
          .fields("betaId")
          .references("id"),
      })
      .index(["betaId"], { unique: true });
    const schema = { alpha: alpha_, beta: beta_ };
    hydrateSchemaNames(schema);

    expect(validateSchema(schema).errors.map((i) => i.code)).toEqual(["FK009"]);
  });

  it("does not read local partial uniqueness as a cardinality claim", () => {
    const beta_: AnyModel = s.model({
      id: s.string().id(),
      alphas: s.toMany(() => alpha_),
    });
    const alpha_: AnyModel = s
      .model({
        id: s.string().id(),
        betaId: s.string(),
        other: s
          .toOne(() => beta_)
          .fields("betaId")
          .references("id"),
      })
      .index(["betaId"], { unique: true, where: "betaId IS NOT NULL" });
    const schema = { alpha: alpha_, beta: beta_ };

    expect(
      validateSchema(schema).errors.map((issue) => issue.code)
    ).not.toContain("FK009");
  });
});

describe("§6.3 many|many", () => {
  it("derives one junction and no row foreign key", () => {
    const schema = pair("many", "many", "none");
    const edges = edgesOf(schema);

    expect(edges).toHaveLength(1);
    expect(edges[0]?.kind).toBe("junction");
    expect(edges.filter((edge) => edge.kind === "foreignKey")).toEqual([]);
  });

  it("expands both sides of that junction from the row keys", () => {
    const schema = pair("many", "many", "none");
    const edge = soleEdge(schema);

    if (edge.kind !== "junction") throw new Error("wrong kind");
    expect(edge.topology.table).toBe("alpha_beta");
    expect(edge.topology.source.members).toEqual([
      { junctionField: "alphaId", referencedField: "id" },
    ]);
    expect(edge.topology.target.members).toEqual([
      { junctionField: "betaId", referencedField: "id" },
    ]);
  });

  it("refuses a junction whose TARGET-side model has no row key", () => {
    // The junction stores both row keys, so either side missing one refuses the
    // edge. The target side is asked separately from the source side, and a
    // resolver that only read the first would emit a half-expanded table.
    const alpha_: AnyModel = s.model({
      id: s.string().id(),
      others: s.toMany(() => beta_),
    });
    const beta_: AnyModel = s.model({
      id: s.string(),
      others: s.toMany(() => alpha_),
    });
    const schema = { alpha: alpha_, beta: beta_ };
    hydrateSchemaNames(schema);

    expect(validateSchema(schema).errors.map((i) => i.code)).toContain("JT002");
  });
});
