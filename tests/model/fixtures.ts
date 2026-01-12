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
import { getModelSchemas } from "@schema/model/schemas";
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

// Lazy schema creation to avoid circular reference issues
let _simpleSchemas: ReturnType<
  typeof getModelSchemas<(typeof simpleModel)["~"]["state"]>
>;
export const getSimpleSchemas = () => {
  if (!_simpleSchemas) {
    _simpleSchemas = getModelSchemas(simpleModel["~"].state);
  }
  return _simpleSchemas;
};
// Legacy export for backward compatibility
export const simpleSchemas = getModelSchemas(simpleModel["~"].state);

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
    name: s.string(),
  })
  .unique(["email", "tenantId"]);

export const compoundUniqueSchemas = getModelSchemas(
  compoundUniqueModel["~"].state
);
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

// Lazy schema creation to avoid circular reference issues at import time
let _authorSchemas: ReturnType<
  typeof getModelSchemas<(typeof authorModel)["~"]["state"]>
>;
let _postSchemas: ReturnType<
  typeof getModelSchemas<(typeof postModel)["~"]["state"]>
>;

type Include = Prettify<InferInput<(typeof _authorSchemas)["include"]>>;

type InputFindUnique = Prettify<
  InferInput<(typeof _authorSchemas)["args"]["findUnique"]>
>;

export const getAuthorSchemas = () => {
  if (!_authorSchemas) {
    _authorSchemas = getModelSchemas(authorModel["~"].state);
  }
  return _authorSchemas;
};

export const getPostSchemas = () => {
  if (!_postSchemas) {
    _postSchemas = getModelSchemas(postModel["~"].state);
  }
  return _postSchemas;
};

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
