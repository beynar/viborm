/**
 * Model Schema Test Fixtures
 *
 * Simple test models covering all constraint types:
 * - simpleModel: Single-field string ID, basic scalar fields
 * - compoundIdModel: Compound primary key
 * - compoundUniqueModel: Compound unique constraint
 * - authorModel/postModel: OneToMany/ManyToOne relation pair
 */

import { s } from "@schema";
import type { InferInput, Prettify } from "@validation";

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

// Access schemas via model["~"].schemas (lazy loaded)
export const getSimpleSchemas = () => simpleModel["~"].schemas;
// Legacy export for backward compatibility
export const simpleSchemas = simpleModel["~"].schemas;

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

export const compoundIdSchemas = compoundIdModel["~"].schemas;
export type CompoundIdState = (typeof compoundIdModel)["~"]["state"];

// =============================================================================
// COMPOUND UNIQUE MODEL
// =============================================================================

export const compoundUniqueModel = s
  .model({
    id: s.string().id(),
    email: s.string(),
    tenantId: s.string(),
    name: s.string(),
  })
  .unique(["email", "tenantId"]);

export const compoundUniqueSchemas = compoundUniqueModel["~"].schemas;
export type CompoundUniqueState = (typeof compoundUniqueModel)["~"]["state"];

// =============================================================================
// MODELS WITH RELATIONS (use lazy initialization)
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
  author: s.manyToOne(() => authorModel).optional(),
});

// Access schemas via model["~"].schemas (lazy loaded internally)
type AuthorSchemas = (typeof authorModel)["~"]["schemas"];
type PostSchemas = (typeof postModel)["~"]["schemas"];

type Include = Prettify<InferInput<AuthorSchemas["include"]>>;

type InputFindUnique = Prettify<
  InferInput<AuthorSchemas["args"]["findUnique"]>
>;

export const getAuthorSchemas = () => authorModel["~"].schemas;
export const getPostSchemas = () => postModel["~"].schemas;

// Lazy accessor exports
export const authorSchemas = {
  get args() {
    return getAuthorSchemas().args;
  },
  get where() {
    return getAuthorSchemas().where;
  },
  get whereUnique() {
    return getAuthorSchemas().whereUnique;
  },
  get create() {
    return getAuthorSchemas().create;
  },
  get update() {
    return getAuthorSchemas().update;
  },
  get select() {
    return getAuthorSchemas().select;
  },
  get include() {
    return getAuthorSchemas().include;
  },
  get orderBy() {
    return getAuthorSchemas().orderBy;
  },
  get scalarFilter() {
    return getAuthorSchemas().scalarFilter;
  },
  get relationFilter() {
    return getAuthorSchemas().relationFilter;
  },
  get scalarCreate() {
    return getAuthorSchemas().scalarCreate;
  },
  get relationCreate() {
    return getAuthorSchemas().relationCreate;
  },
  get scalarUpdate() {
    return getAuthorSchemas().scalarUpdate;
  },
  get relationUpdate() {
    return getAuthorSchemas().relationUpdate;
  },
};

export const postSchemas = {
  get args() {
    return getPostSchemas().args;
  },
  get where() {
    return getPostSchemas().where;
  },
  get whereUnique() {
    return getPostSchemas().whereUnique;
  },
  get create() {
    return getPostSchemas().create;
  },
  get update() {
    return getPostSchemas().update;
  },
  get select() {
    return getPostSchemas().select;
  },
  get include() {
    return getPostSchemas().include;
  },
  get orderBy() {
    return getPostSchemas().orderBy;
  },
  get scalarFilter() {
    return getPostSchemas().scalarFilter;
  },
  get relationFilter() {
    return getPostSchemas().relationFilter;
  },
  get scalarCreate() {
    return getPostSchemas().scalarCreate;
  },
  get relationCreate() {
    return getPostSchemas().relationCreate;
  },
  get scalarUpdate() {
    return getPostSchemas().scalarUpdate;
  },
  get relationUpdate() {
    return getPostSchemas().relationUpdate;
  },
};

export type AuthorState = (typeof authorModel)["~"]["state"];
export type PostState = (typeof postModel)["~"]["state"];
