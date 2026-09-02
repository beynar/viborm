import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { NestedWriteError } from "@errors";
import {
  type BoundRelation,
  bindRelation,
} from "@query-engine/builders/relation-data-builder";
import { lookupRelation } from "@query-engine/context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { constructRoutedOperation } from "@query-engine/write-engine/routing";
import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import type { Model } from "@schema/model";
import { resolveSchemaOrThrow } from "@schema/validation/validator";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const team = s.model({
  id: s.string().id(),
  members: s.toMany(() => member),
});

const member = s.model({
  id: s.string().id(),
  teamId: s.string(),
  team: s
    .toOne(() => team)
    .fields("teamId")
    .references("id"),
});

const tenant = s
  .model({
    region: s.string(),
    slug: s.string(),
    memberships: s.toMany(() => membership),
  })
  .id(["region", "slug"]);

const membership = s.model({
  id: s.string().id(),
  tenantRegion: s.string(),
  tenantSlug: s.string(),
  tenant: s
    .toOne(() => tenant)
    .fields("tenantRegion", "tenantSlug")
    .references("region", "slug")
    .onUpdate("cascade"),
});

const user = s.model({
  id: s.string().id(),
  profile: s.toOne(() => profile).name("profile"),
});

const profile = s.model({
  id: s.string().id(),
  userId: s.string().nullable(),
  user: s
    .toOne(() => user)
    .fields("userId")
    .references("id")
    .name("profile")
    .onUpdate("setNull"),
});

const left = s.model({
  id: s.string().id(),
  inverse: s.toOne(() => right).name("edge"),
});

const right = s.model({
  id: s.string().id(),
  leftId: s.string(),
  left: s
    .toOne(() => left)
    .fields("leftId")
    .references("id")
    .name("edge"),
});

const namedParent = s.model({
  id: s.string().id(),
  authored: s.toMany(() => namedPost).name("author"),
  edited: s.toMany(() => namedPost).name("editor"),
});

const namedPost = s.model({
  id: s.string().id(),
  authorId: s.string(),
  editorId: s.string(),
  author: s
    .toOne(() => namedParent)
    .fields("authorId")
    .references("id")
    .name("author"),
  editor: s
    .toOne(() => namedParent)
    .fields("editorId")
    .references("id")
    .name("editor"),
});

const selfNode: Model<any> = s.model({
  id: s.string().id(),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => selfNode)
    .fields("parentId")
    .references("id")
    .name("tree"),
  children: s.toMany(() => selfNode).name("tree"),
});

const organization = s.model({
  id: s.string().id(),
  code: s.string().unique(),
  workers: s.toMany(() => worker),
});

const worker = s.model({
  id: s.string().id(),
  organizationCode: s.string(),
  organization: s
    .toOne(() => organization)
    .fields("organizationCode")
    .references("code"),
});

const article = s.model({
  id: s.string().id(),
  tags: s.toMany(() => tag),
});

const tag = s.model({
  id: s.string().id(),
  articles: s.toMany(() => article),
});

/**
 * The edge with NO inverse, kept out of the prepared schema below. The engine
 * used to meet it at bind time and answer "Cannot determine FK fields"; that
 * sentence is gone with the inverse scanners, and §9.4 makes an ordinary slot
 * without a complete inverse a definition error, so the schema never resolves.
 */
const orphanSource = s.model({
  id: s.string().id(),
  targets: s.toMany(() => orphanTarget),
});

const orphanTarget = s.model({
  id: s.string().id(),
});

const errorOwner: Model<any> = s.model({
  id: s.string().id(),
  code: s.int().unique(),
  kids: s.toMany(() => errorKid),
});

/**
 * The foreign key is well-formed now. It used to pair TWO local fields against
 * ONE reference, so that the relation-key legality refusal could be shown to
 * answer before the engine's "mismatched foreign-key metadata" complaint — and
 * an unequal pair is refused at CONSTRUCTION today (`.references(...)` pairs
 * positionally, V4002, witnessed at
 * `tests/unit/schema-validation/foreign-key-rules.core.test.ts`). There is no
 * later error left to order against; the refusal itself is what stays pinned.
 */
const errorKid: Model<any> = s.model({
  id: s.string().id(),
  ownerA: s.int(),
  owner: s
    .toOne(() => errorOwner)
    .fields("ownerA")
    .references("code"),
});

/**
 * Junction-side pins live on their own hydrated schema: a junction's table and
 * column names derive from MODEL names (`@schema/relation/helpers`), so an
 * unhydrated model would resolve every side as "unknown".
 */
const junctionSchema = (() => {
  const post = s.model({
    id: s.string().id(),
    labels: s.toMany(() => label),
  });

  const label = s.model({
    id: s.string().id(),
    posts: s.toMany(() => post),
  });

  // One self-referential pair with explicit columns on ONE side; the other side
  // must recover the same two columns, swapped.
  const follower: Model<any> = s.model({
    id: s.string().id(),
    follows: s
      .toMany(() => follower)
      .source("followerId")
      .target("followedId"),
    followedBy: s.toMany(() => follower),
  });

  const compoundDoc = s
    .model({
      tenantId: s.string().map("tenant_col"),
      id: s.string().map("doc_id"),
      labels: s.toMany(() => compoundLabel),
    })
    .id(["tenantId", "id"]);

  const compoundLabel = s.model({
    id: s.string().id(),
    docs: s.toMany(() => compoundDoc),
  });

  return { post, label, follower, compoundDoc, compoundLabel };
})();
prepareSchema(junctionSchema);

/** Every valid model above shares one composition root, as a client's would. */
prepareSchema({
  team,
  member,
  tenant,
  membership,
  user,
  profile,
  left,
  right,
  namedParent,
  namedPost,
  selfNode,
  organization,
  worker,
  article,
  tag,
});

const adapter = new PostgresAdapter();

interface ClassificationCase {
  readonly label: string;
  readonly source: Model<any>;
  readonly relationName: string;
  /** The three orthogonal axes, pinned one by one. */
  readonly position: BoundRelation["position"];
  readonly cardinality: BoundRelation["cardinality"];
  readonly membership: BoundRelation["membership"]["kind"];
  readonly foreignFields?: readonly string[];
  readonly referencedFields?: readonly string[];
  readonly onUpdate?: "cascade" | "setNull";
}

const cases: readonly ClassificationCase[] = [
  {
    label: "an explicit FK is parent-held to-one",
    source: member,
    relationName: "team",
    position: "parentHeld",
    cardinality: "one",
    membership: "foreignKey",
    foreignFields: ["teamId"],
    referencedFields: ["id"],
  },
  {
    label: "an unnamed one-to-many inverse is child-held to-many",
    source: team,
    relationName: "members",
    position: "childHeld",
    cardinality: "many",
    membership: "foreignKey",
    foreignFields: ["teamId"],
    referencedFields: ["id"],
  },
  {
    label: "an explicit compound FK is parent-held to-one",
    source: membership,
    relationName: "tenant",
    position: "parentHeld",
    cardinality: "one",
    membership: "foreignKey",
    foreignFields: ["tenantRegion", "tenantSlug"],
    referencedFields: ["region", "slug"],
    onUpdate: "cascade",
  },
  {
    label: "the inverse compound edge is child-held to-many",
    source: tenant,
    relationName: "memberships",
    position: "childHeld",
    cardinality: "many",
    membership: "foreignKey",
    foreignFields: ["tenantRegion", "tenantSlug"],
    referencedFields: ["region", "slug"],
    onUpdate: "cascade",
  },
  {
    label: "a fields-less one-to-one is child-held to-one",
    source: user,
    relationName: "profile",
    position: "childHeld",
    cardinality: "one",
    membership: "foreignKey",
    foreignFields: ["userId"],
    referencedFields: ["id"],
    onUpdate: "setNull",
  },
  {
    label: "a fields-less many-to-one is child-held to-one",
    source: left,
    relationName: "inverse",
    position: "childHeld",
    cardinality: "one",
    membership: "foreignKey",
    foreignFields: ["leftId"],
    referencedFields: ["id"],
  },
  {
    label: "a named inverse selects the matching FK",
    source: namedParent,
    relationName: "edited",
    position: "childHeld",
    cardinality: "many",
    membership: "foreignKey",
    foreignFields: ["editorId"],
    referencedFields: ["id"],
  },
  {
    label: "a self-relation keeps its parent-held position",
    source: selfNode,
    relationName: "parent",
    position: "parentHeld",
    cardinality: "one",
    membership: "foreignKey",
    foreignFields: ["parentId"],
    referencedFields: ["id"],
  },
  {
    label: "a non-primary unique reference keeps the referenced field",
    source: organization,
    relationName: "workers",
    position: "childHeld",
    cardinality: "many",
    membership: "foreignKey",
    foreignFields: ["organizationCode"],
    referencedFields: ["code"],
  },
  {
    label: "many-to-many is a junction without FK direction",
    source: article,
    relationName: "tags",
    position: "junction",
    cardinality: "many",
    membership: "junction",
  },
];

describe("bound relation classification contracts", () => {
  test.each(cases)("$label", (classification) => {
    const scope = scopeFor(adapter, classification.source);
    const relationRef = lookupRelation(scope, classification.relationName);
    if (!relationRef) {
      throw new Error(
        `Expected relation '${classification.relationName}' on the test model.`
      );
    }

    const relation = bindRelation(scope, relationRef);

    expect(relation.position).toBe(classification.position);
    expect(relation.cardinality).toBe(classification.cardinality);
    expect(relation.membership.kind).toBe(classification.membership);
    expect(relation.sourceModel).toBe(classification.source);
    expect(relation.relationRef).toBe(relationRef);

    if (relation.position === "junction") {
      expect(classification.foreignFields).toBeUndefined();
      expect(classification.referencedFields).toBeUndefined();
      return;
    }

    // The binder carries holder/referenced eagerly; this pins them against the
    // position ternary every consumer used to re-run.
    const parentHeld = relation.position === "parentHeld";
    expect(relation.membership.holder).toBe(
      parentHeld ? relation.sourceModel : relation.relationRef.targetModel
    );
    expect(relation.membership.referenced).toBe(
      parentHeld ? relation.relationRef.targetModel : relation.sourceModel
    );

    expect(relation.membership.foreignFields).toEqual(
      classification.foreignFields
    );
    if (relation.membership.kind === "polymorphic") {
      expect([relation.membership.referencedField]).toEqual(
        classification.referencedFields
      );
    } else {
      expect(relation.membership.referencedFields).toEqual(
        classification.referencedFields
      );
      expect(relation.membership.members).toEqual(
        classification.foreignFields?.map((foreignField, index) => ({
          foreignField,
          referencedField: classification.referencedFields?.[index],
        }))
      );
    }
    expect(relation.membership.onUpdate).toBe(classification.onUpdate);
  });

  test("a relation without an inverse never reaches a bind", () => {
    expect(() =>
      resolveSchemaOrThrow({ source: orphanSource, target: orphanTarget })
    ).toThrow("[R002]");
  });

  test("relation-key legality refuses a non-literal write to a referenced field", () => {
    const schema = { owner: errorOwner, kid: errorKid };
    hydrateSchemaNames(schema);
    const engine = new QueryEngine(
      new SqlOnlyDriver(adapter, "postgresql"),
      createModelRegistry(schema, createSchemaRegistry(schema))
    );

    let thrown: unknown;
    try {
      constructRoutedOperation(engine, errorOwner, "update", {
        where: { id: "owner-1" },
        data: {
          code: { increment: 1 },
          kids: { connect: { id: "kid-1" } },
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NestedWriteError);
    if (!(thrown instanceof Error)) {
      throw new Error("Expected update construction to fail.");
    }
    expect(thrown.message).toBe(
      "Cannot update relation key field 'code' with a non-literal operation while mutating relation 'kids'. Use a literal value or '{ set: ... }'."
    );
  });
});

/** The bound junction's MEMBERSHIP — the two sides and the table they join. */
function bindJunctionMembership(source: Model<any>, relationName: string) {
  const scope = scopeFor(adapter, source);
  const relationRef = lookupRelation(scope, relationName);
  if (!relationRef) {
    throw new Error(`Expected relation '${relationName}' on the test model.`);
  }
  const relation = bindRelation(scope, relationRef);
  if (relation.position !== "junction") {
    throw new Error(`Expected relation '${relationName}' to bind a junction.`);
  }
  return relation.membership;
}

describe("bound junction sides", () => {
  test("both sides carry their model, column and referenced field", () => {
    const membership = bindJunctionMembership(junctionSchema.post, "labels");

    expect(membership.table).toBe("label_post");
    expect(membership.source.model).toBe(junctionSchema.post);
    expect(membership.source.members).toEqual([
      { junctionField: "postId", referencedField: "id" },
    ]);
    expect(membership.target.model).toBe(junctionSchema.label);
    expect(membership.target.members).toEqual([
      { junctionField: "labelId", referencedField: "id" },
    ]);
  });

  test("the paired relation reverses the sides and keeps the table", () => {
    const membership = bindJunctionMembership(junctionSchema.label, "posts");

    expect(membership.table).toBe("label_post");
    expect(membership.source.model).toBe(junctionSchema.label);
    expect(membership.source.members).toEqual([
      { junctionField: "labelId", referencedField: "id" },
    ]);
    expect(membership.target.model).toBe(junctionSchema.post);
    expect(membership.target.members).toEqual([
      { junctionField: "postId", referencedField: "id" },
    ]);
  });

  test("a self-relation's two ends reverse orientation on one table", () => {
    const follows = bindJunctionMembership(junctionSchema.follower, "follows");
    const followedBy = bindJunctionMembership(
      junctionSchema.follower,
      "followedBy"
    );

    expect(follows.table).toBe("follower_follower");
    expect(followedBy.table).toBe("follower_follower");
    // Both ends address the same model; only the COLUMN orientation differs, which
    // is the fact a scalar `sourceFieldName` channel used to have to recover.
    expect(follows.source.model).toBe(junctionSchema.follower);
    expect(follows.target.model).toBe(junctionSchema.follower);
    expect(follows.source.members).toEqual([
      { junctionField: "followerId", referencedField: "id" },
    ]);
    expect(follows.target.members).toEqual([
      { junctionField: "followedId", referencedField: "id" },
    ]);
    expect(followedBy.source.members).toEqual([
      { junctionField: "followedId", referencedField: "id" },
    ]);
    expect(followedBy.target.members).toEqual([
      { junctionField: "followerId", referencedField: "id" },
    ]);
  });

  test("classification stays lazy and a compound side binds every ordered member", () => {
    const scope = scopeFor(adapter, junctionSchema.compoundDoc);
    const relationRef = lookupRelation(scope, "labels");
    if (!relationRef) throw new Error("Expected relation 'labels'.");

    const relation = bindRelation(scope, relationRef);
    expect(relation.position).toBe("junction");
    if (relation.position !== "junction") {
      throw new Error("Expected a junction.");
    }

    expect(relation.membership.source.members).toEqual([
      { junctionField: "compounddoc_1", referencedField: "tenantId" },
      { junctionField: "compounddoc_2", referencedField: "id" },
    ]);
    expect(relation.membership.target.members).toEqual([
      { junctionField: "compoundlabelId", referencedField: "id" },
    ]);

    const inverse = bindJunctionMembership(
      junctionSchema.compoundLabel,
      "docs"
    );
    expect(inverse.source.members).toEqual([
      { junctionField: "compoundlabelId", referencedField: "id" },
    ]);
    expect(inverse.target.members).toEqual([
      { junctionField: "compounddoc_1", referencedField: "tenantId" },
      { junctionField: "compounddoc_2", referencedField: "id" },
    ]);
  });
});
