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
import type { AnyModel } from "@schema/model";
import {
  createSchemaRegistry,
  type InferInput,
  type ModelStateSchemas,
  type Prettify,
} from "@validation";

type SchemaView<M extends AnyModel> = {
  readonly args: ModelStateSchemas<M>["args"];
  readonly where: ModelStateSchemas<M>["core"]["where"];
  readonly whereUnique: ModelStateSchemas<M>["core"]["whereUnique"];
  readonly whereUniqueExtended: ModelStateSchemas<M>["core"]["whereUniqueExtended"];
  readonly uniqueFilter: ModelStateSchemas<M>["core"]["uniqueFilter"];
  readonly compoundIdFilter: ModelStateSchemas<M>["core"]["compoundIdFilter"];
  readonly compoundConstraintFilter: ModelStateSchemas<M>["core"]["compoundConstraintFilter"];
  readonly create: ModelStateSchemas<M>["core"]["create"];
  readonly update: ModelStateSchemas<M>["core"]["update"];
  readonly select: ModelStateSchemas<M>["core"]["select"];
  readonly include: ModelStateSchemas<M>["core"]["include"];
  readonly orderBy: ModelStateSchemas<M>["core"]["orderBy"];
  readonly scalarFilter: ModelStateSchemas<M>["core"]["scalarFilter"];
  readonly relationFilter: ModelStateSchemas<M>["core"]["relationFilter"];
  readonly scalarCreate: ModelStateSchemas<M>["core"]["scalarCreate"];
  readonly relationCreate: ModelStateSchemas<M>["core"]["relationCreate"];
  readonly scalarUpdate: ModelStateSchemas<M>["core"]["scalarUpdate"];
  readonly relationUpdate: ModelStateSchemas<M>["core"]["relationUpdate"];
};

const createSchemaView = <M extends AnyModel>(
  getSchemas: () => ModelStateSchemas<M>
): SchemaView<M> => ({
  get args() {
    return getSchemas().args;
  },
  get where() {
    return getSchemas().core.where;
  },
  get whereUnique() {
    return getSchemas().core.whereUnique;
  },
  get whereUniqueExtended() {
    return getSchemas().core.whereUniqueExtended;
  },
  get uniqueFilter() {
    return getSchemas().core.uniqueFilter;
  },
  get compoundIdFilter() {
    return getSchemas().core.compoundIdFilter;
  },
  get compoundConstraintFilter() {
    return getSchemas().core.compoundConstraintFilter;
  },
  get create() {
    return getSchemas().core.create;
  },
  get update() {
    return getSchemas().core.update;
  },
  get select() {
    return getSchemas().core.select;
  },
  get include() {
    return getSchemas().core.include;
  },
  get orderBy() {
    return getSchemas().core.orderBy;
  },
  get scalarFilter() {
    return getSchemas().core.scalarFilter;
  },
  get relationFilter() {
    return getSchemas().core.relationFilter;
  },
  get scalarCreate() {
    return getSchemas().core.scalarCreate;
  },
  get relationCreate() {
    return getSchemas().core.relationCreate;
  },
  get scalarUpdate() {
    return getSchemas().core.scalarUpdate;
  },
  get relationUpdate() {
    return getSchemas().core.relationUpdate;
  },
});

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

const schemaRegistry = createSchemaRegistry({
  simple: simpleModel,
  compoundId: compoundIdModel,
  compoundUnique: compoundUniqueModel,
  author: authorModel,
  post: postModel,
});

// Access schemas through SchemaRegistry. The view keeps legacy test ergonomics
// without restoring the old model schema accessor.
export const getSimpleSchemas = () => schemaRegistry.proxy.simple;
export const simpleSchemas = createSchemaView(getSimpleSchemas);
export const compoundIdSchemas = createSchemaView(
  () => schemaRegistry.proxy.compoundId
);
export const compoundUniqueSchemas = createSchemaView(
  () => schemaRegistry.proxy.compoundUnique
);

type AuthorSchemas = ModelStateSchemas<typeof authorModel>;
type PostSchemas = ModelStateSchemas<typeof postModel>;

type Include = Prettify<InferInput<AuthorSchemas["core"]["include"]>>;

type InputFindUnique = Prettify<
  InferInput<AuthorSchemas["args"]["findUnique"]>
>;

export const getAuthorSchemas = () => schemaRegistry.proxy.author;
export const getPostSchemas = () => schemaRegistry.proxy.post;

// Lazy accessor exports
export const authorSchemas = createSchemaView(getAuthorSchemas);

export const postSchemas = createSchemaView(getPostSchemas);

export type AuthorState = (typeof authorModel)["~"]["state"];
export type PostState = (typeof postModel)["~"]["state"];
