import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { PGliteDriver } from "@drivers/pglite";
import { NestedWriteError } from "@errors";
import {
  type BoundRelation,
  bindRelation,
} from "@query-engine/builders/relation-data-builder";
import { createQueryScope, getRelationInfo } from "@query-engine/context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { constructRoutedOperation } from "@query-engine/write-engine/routing";
import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const team = s.model({
  id: s.string().id(),
  members: s.oneToMany(() => member),
});

const member = s.model({
  id: s.string().id(),
  teamId: s.string(),
  team: s
    .manyToOne(() => team)
    .fields("teamId")
    .references("id"),
});

const tenant = s.model({
  region: s.string().id(),
  slug: s.string().id(),
  memberships: s.oneToMany(() => membership),
});

const membership = s.model({
  id: s.string().id(),
  tenantRegion: s.string(),
  tenantSlug: s.string(),
  tenant: s
    .manyToOne(() => tenant)
    .fields("tenantRegion", "tenantSlug")
    .references("region", "slug")
    .onUpdate("cascade"),
});

const user = s.model({
  id: s.string().id(),
  profile: s
    .oneToOne(() => profile)
    .name("profile")
    .optional(),
});

const profile = s.model({
  id: s.string().id(),
  userId: s.string(),
  user: s
    .oneToOne(() => user)
    .fields("userId")
    .references("id")
    .name("profile")
    .onUpdate("setNull"),
});

const left = s.model({
  id: s.string().id(),
  inverse: s.manyToOne(() => right).name("edge"),
});

const right = s.model({
  id: s.string().id(),
  leftId: s.string(),
  left: s
    .manyToOne(() => left)
    .fields("leftId")
    .references("id")
    .name("edge"),
});

const namedParent = s.model({
  id: s.string().id(),
  authored: s.oneToMany(() => namedPost).name("author"),
  edited: s.oneToMany(() => namedPost).name("editor"),
});

const namedPost = s.model({
  id: s.string().id(),
  authorId: s.string(),
  editorId: s.string(),
  author: s
    .manyToOne(() => namedParent)
    .fields("authorId")
    .references("id")
    .name("author"),
  editor: s
    .manyToOne(() => namedParent)
    .fields("editorId")
    .references("id")
    .name("editor"),
});

const selfNode: Model<any> = s.model({
  id: s.string().id(),
  parentId: s.string().nullable(),
  parent: s
    .manyToOne(() => selfNode)
    .fields("parentId")
    .references("id")
    .optional()
    .name("tree"),
  children: s.oneToMany(() => selfNode).name("tree"),
});

const organization = s.model({
  id: s.string().id(),
  code: s.string().unique(),
  workers: s.oneToMany(() => worker),
});

const worker = s.model({
  id: s.string().id(),
  organizationCode: s.string(),
  organization: s
    .manyToOne(() => organization)
    .fields("organizationCode")
    .references("code"),
});

const article = s.model({
  id: s.string().id(),
  tags: s.manyToMany(() => tag),
});

const tag = s.model({
  id: s.string().id(),
  articles: s.manyToMany(() => article),
});

const orphanSource = s.model({
  id: s.string().id(),
  targets: s.oneToMany(() => orphanTarget),
});

const orphanTarget = s.model({
  id: s.string().id(),
});

const errorOwner: Model<any> = s.model({
  id: s.string().id(),
  code: s.int().unique(),
  kids: s.oneToMany(() => errorKid),
});

const errorKid: Model<any> = s.model({
  id: s.string().id(),
  ownerA: s.int(),
  ownerB: s.int(),
  owner: s
    .manyToOne(() => errorOwner)
    .fields("ownerA", "ownerB")
    .references("code"),
});

const adapter = new PostgresAdapter();

interface ClassificationCase {
  readonly label: string;
  readonly source: Model<any>;
  readonly relationName: string;
  readonly kind: BoundRelation["kind"];
  readonly foreignFields?: readonly string[];
  readonly referencedFields?: readonly string[];
  readonly onUpdate?: "cascade" | "setNull";
}

const cases: readonly ClassificationCase[] = [
  {
    label: "an explicit FK is parent-held to-one",
    source: member,
    relationName: "team",
    kind: "parentHeldToOne",
    foreignFields: ["teamId"],
    referencedFields: ["id"],
  },
  {
    label: "an unnamed one-to-many inverse is child-held to-many",
    source: team,
    relationName: "members",
    kind: "childHeldToMany",
    foreignFields: ["teamId"],
    referencedFields: ["id"],
  },
  {
    label: "an explicit compound FK is parent-held to-one",
    source: membership,
    relationName: "tenant",
    kind: "parentHeldToOne",
    foreignFields: ["tenantRegion", "tenantSlug"],
    referencedFields: ["region", "slug"],
    onUpdate: "cascade",
  },
  {
    label: "the inverse compound edge is child-held to-many",
    source: tenant,
    relationName: "memberships",
    kind: "childHeldToMany",
    foreignFields: ["tenantRegion", "tenantSlug"],
    referencedFields: ["region", "slug"],
    onUpdate: "cascade",
  },
  {
    label: "a fields-less one-to-one is child-held to-one",
    source: user,
    relationName: "profile",
    kind: "childHeldToOne",
    foreignFields: ["userId"],
    referencedFields: ["id"],
    onUpdate: "setNull",
  },
  {
    label: "a fields-less many-to-one is child-held to-one",
    source: left,
    relationName: "inverse",
    kind: "childHeldToOne",
    foreignFields: ["leftId"],
    referencedFields: ["id"],
  },
  {
    label: "a named inverse selects the matching FK",
    source: namedParent,
    relationName: "edited",
    kind: "childHeldToMany",
    foreignFields: ["editorId"],
    referencedFields: ["id"],
  },
  {
    label: "a self-relation keeps its parent-held position",
    source: selfNode,
    relationName: "parent",
    kind: "parentHeldToOne",
    foreignFields: ["parentId"],
    referencedFields: ["id"],
  },
  {
    label: "a non-primary unique reference keeps the referenced field",
    source: organization,
    relationName: "workers",
    kind: "childHeldToMany",
    foreignFields: ["organizationCode"],
    referencedFields: ["code"],
  },
  {
    label: "many-to-many is a junction without FK direction",
    source: article,
    relationName: "tags",
    kind: "junction",
  },
];

describe("bound relation classification", () => {
  test.each(cases)("$label", (classification) => {
    const scope = createQueryScope(adapter, classification.source);
    const relationInfo = getRelationInfo(scope, classification.relationName);
    if (!relationInfo) {
      throw new Error(
        `Expected relation '${classification.relationName}' on the test model.`
      );
    }

    const relation = bindRelation(scope, relationInfo);

    expect(relation.kind).toBe(classification.kind);
    expect(relation.sourceModel).toBe(classification.source);
    expect(relation.relationInfo).toBe(relationInfo);

    if (relation.kind === "junction") {
      expect(classification.foreignFields).toBeUndefined();
      expect(classification.referencedFields).toBeUndefined();
      return;
    }

    expect(relation.foreignFields).toEqual(classification.foreignFields);
    expect(relation.referencedFields).toEqual(classification.referencedFields);
    expect(relation.onUpdate).toBe(classification.onUpdate);
  });

  test("a relation without an inverse keeps the existing direction error", () => {
    const scope = createQueryScope(adapter, orphanSource);
    const relationInfo = getRelationInfo(scope, "targets");
    if (!relationInfo) throw new Error("Expected relation 'targets'.");

    expect(() => bindRelation(scope, relationInfo)).toThrow(
      "Cannot determine FK fields for relation 'targets'. Define the inverse relation with .fields([...]) or use explicit FK fields."
    );
  });

  test("relation-key legality still answers before mismatched FK arity", () => {
    const schema = { owner: errorOwner, kid: errorKid };
    hydrateSchemaNames(schema);
    const engine = new QueryEngine(
      new PGliteDriver(),
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
    expect(thrown.message).not.toContain("mismatched foreign-key metadata");
  });
});
