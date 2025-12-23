/**
 * Model Schema Test Fixtures
 *
 * Simple test models covering all constraint types:
 * - simpleModel: Single-field string ID, basic scalar fields
 * - compoundIdModel: Compound primary key
 * - compoundUniqueModel: Compound unique constraint
 * - authorModel/postModel: OneToMany/ManyToOne relation pair
 */

import { InferTargetSchema } from "@schema/relation/schemas/helpers";
import { s } from "../../src/schema";
import { getModelSchemas } from "../../src/schema/model/schemas";
import { InferInput, InferOutput, safeParse } from "valibot";
import { StandardSchemaV1 } from "@standard-schema";

// =============================================================================
// SIMPLE MODEL (single field ID)
// =============================================================================

export const simpleModel = s.model({
  id: s.string().id(),
  name: s.string(),
  email: s.string().unique(),
  age: s.int().nullable(),
  active: s.boolean().default(true),
});

export const simpleSchemas = getModelSchemas(simpleModel["~"].state);
export type SimpleState = (typeof simpleModel)["~"]["state"];

// =============================================================================
// COMPOUND ID MODEL
// =============================================================================

export const compoundIdModel = s
  .model({
    orgId: s.string(),
    memberId: s.string(),
    role: s.string(),
  })
  .id(["orgId", "memberId"]);

export const compoundIdSchemas = getModelSchemas(compoundIdModel["~"].state);
export type CompoundIdState = (typeof compoundIdModel)["~"]["state"];

// =============================================================================
// COMPOUND UNIQUE MODEL
// =============================================================================

export const compoundUniqueModel = s
  .model({
    id: s.string().id(),
    email: s.string(),
    tenantId: s.string(),
  })
  .unique(["email", "tenantId"]);

export const compoundUniqueSchemas = getModelSchemas(
  compoundUniqueModel["~"].state
);
export type CompoundUniqueState = (typeof compoundUniqueModel)["~"]["state"];

// =============================================================================
// MODELS WITH RELATIONS
// =============================================================================

export const authorModel = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.oneToMany(() => postModel),
});

export const postModel = s.model({
  id: s.string().id(),
  title: s.string(),
  published: s.boolean().default(false),
  authorId: s.string(),
  author: s.manyToOne(() => authorModel),
});

export const authorSchemas = getModelSchemas(authorModel["~"].state);
export const postSchemas = getModelSchemas(postModel["~"].state);
export type AuthorState = (typeof authorModel)["~"]["state"];
export type PostState = (typeof postModel)["~"]["state"];

// RAW TESTS
type AuthorRelation = AuthorState["fields"]["posts"];
type Schemas = AuthorRelation["~"]["schemas"];
const selectSchema = postModel["~"].state.relations.author["~"].schemas.select;
// type T = InferInput<Schemas["select"]>;
type TT = InferTargetSchema<
  AuthorState["fields"]["posts"]["~"]["state"],
  "where"
>;
