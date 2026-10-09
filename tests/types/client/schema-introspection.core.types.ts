import type {
  OperationPayload,
  OperationPayloadSchema,
  OperationResult,
  ValidatedOperationPayload,
} from "@client/exports";
import { s } from "@schema";
import type {
  Model,
  ModelState,
  ModelUpdateState,
  RelationLinks,
} from "@src/index";
import {
  getOperationPayloadSchema,
  renderOperationResultType,
  renderSchemaType,
  validateOperationPayload,
} from "@src/index";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expectTypeOf, test } from "vitest";

// Completed-state materialization must keep legacy annotations link-identical.
const materializationBase = s.model({ id: s.string().id(), value: s.int() });
const materializationInferred = materializationBase.map(
  "materialization_alias"
);
const materializationHeld: Model<
  ModelUpdateState<
    (typeof materializationBase)["~"]["state"],
    { tableName: "materialization_alias" }
  >
> = materializationInferred;
const materializationReference = s.model({
  id: s.string().id(),
  targetId: s.string(),
  target: s
    .toOne(() => materializationInferred)
    .fields("targetId")
    .references("id"),
});
const materializationAliases = {
  held: materializationHeld,
  inferred: materializationInferred,
  reference: materializationReference,
};

// Both placements of extends preserve the indexed cyclic node language.
const extendedModifierParent = s
  .model({
    tenantId: s.string(),
    localId: s.string(),
    secret: s.string(),
    children: s.toMany(() => extendedModifierChild),
  })
  .id(["tenantId", "localId"], { name: "extended_pk" })
  .unique(["tenantId", "secret"], { name: "extended_unique" })
  .omit({ secret: true })
  .index(["tenantId"], { name: "extended_tenant" })
  .extends({ added: s.int() })
  .map("extended_modifier_parent")
  .extends({ tail: s.boolean() });
const extendedModifierChild = s
  .model({
    id: s.string().id(),
    tenantId: s.string(),
    parentId: s.string(),
    parent: s
      .toOne(() => extendedModifierParent)
      .fields("tenantId", "parentId")
      .references("tenantId", "localId"),
  })
  .index(["tenantId", "parentId"], { name: "extended_parent" })
  .map("extended_modifier_child");
const _extendedModifierPayload: OperationPayload<
  "findMany",
  typeof extendedModifierParent
> = {
  include: { children: { include: { parent: true } } },
};
const _genericModifierAssignment = <State extends ModelState>(
  model: Model<State>
) => {
  const mapped: Model<ModelUpdateState<State, { tableName: "generic" }>> =
    model.map("generic");
  const omitted: Model<ModelUpdateState<State, { omit: Record<never, true> }>> =
    model.omit({});
  return { mapped, omitted };
};

const user = s.model({ id: s.string().id(), name: s.string() });
const schema = { user };

type FullModelEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type AssertStateIdentity<Value extends true> = Value;
type _MaterializedLegacyAliases = AssertStateIdentity<
  FullModelEqual<
    RelationLinks<typeof materializationAliases>["reference"]["target"],
    "held" | "inferred"
  >
>;
type _MaterializedWrongAlias = AssertStateIdentity<
  // @ts-expect-error - materialization cannot invent a target key
  FullModelEqual<
    RelationLinks<typeof materializationAliases>["reference"]["target"],
    "held" | "inferred" | "missing"
  >
>;

type FullModelKeys<S, M> = {
  [K in keyof S]-?: FullModelEqual<S[K], M> extends true ? K : never;
}[keyof S];
type FullTargetLinks<S, T> = T extends {
  readonly kind: "model";
  readonly getter: () => infer M;
}
  ? FullModelKeys<S, M>
  : T extends { readonly kind: "variants"; readonly entries: infer E }
    ? {
        [V in keyof E]: E[V] extends { readonly getter: () => infer M }
          ? FullModelKeys<S, M>
          : never;
      }
    : never;
// Independent original comparator: the cost prefilter must not change its answer.
type FullRelationLinks<S> = {
  [K in keyof S]: S[K] extends {
    readonly "~": { readonly state: { readonly relations: infer R } };
  }
    ? {
        [F in keyof R]: R[F] extends {
          readonly "~": { readonly state: { readonly target: infer T } };
        }
          ? FullTargetLinks<S, T>
          : never;
      }
    : never;
};

const twinA = s.model({ id: s.string().id(), value: s.int() });
const twinB = s.model({ id: s.string().id(), value: s.int() });
const twinOwner = s.model({
  id: s.string().id(),
  twinId: s.string(),
  twin: s
    .toOne(() => twinA)
    .fields("twinId")
    .references("id"),
});
const twins = { twinA, twinB, twinOwner, alias: twinA };
// Matching field trees still reject differences in complete model metadata.
const mappedTwinA = twinA.map("identity_a");
const mappedTwinB = twinA.map("identity_b");
const mappedTwinOwner = s.model({
  id: s.string().id(),
  targetId: s.string(),
  target: s
    .toOne(() => mappedTwinA)
    .fields("targetId")
    .references("id"),
});
const mappedTwins = { mappedTwinA, mappedTwinB, mappedTwinOwner };
declare const unionIdentityTarget: typeof mappedTwinA | typeof mappedTwinB;
const unionIdentityOwner = s.model({
  id: s.string().id(),
  targetId: s.string(),
  target: s
    .toOne(() => unionIdentityTarget)
    .fields("targetId")
    .references("id"),
});
const unionIdentitySchema = {
  mappedTwinA,
  mappedTwinB,
  unionEntry: unionIdentityTarget,
  unionIdentityOwner,
};
const outside = s.model({ code: s.string().id(), outside: s.boolean() });
const outsideOwner = s.model({
  id: s.string().id(),
  outsideCode: s.string(),
  outside: s
    .toOne(() => outside)
    .fields("outsideCode")
    .references("code"),
});
const unlinked = { user, outsideOwner };
const post = s.model({ id: s.string().id(), title: s.string() });
const video = s.model({ id: s.string().id(), duration: s.int() });
const variantOwner = s.model({
  id: s.string().id(),
  subject: s.toOne({ post: () => post, video: () => video }),
  subjects: s.toMany({ post: () => post, video: () => video }),
});
const variants = { post, video, variantOwner };
const ringA = s.model({
  id: s.string().id(),
  parentId: s.string(),
  parent: s
    .toOne(() => ringB)
    .fields("parentId")
    .references("id"),
});
const ringB = s.model({
  id: s.string().id(),
  parentId: s.string(),
  parent: s
    .toOne(() => ringC)
    .fields("parentId")
    .references("id"),
});
const ringC = s.model({
  id: s.string().id(),
  parentId: s.string(),
  parent: s
    .toOne(() => ringA)
    .fields("parentId")
    .references("id"),
});
const ring = { ringA, ringB, ringC };

describe("declaration links preserve full model identity", () => {
  test("retains the final exact comparator after a weaker negative projection", () => {
    expectTypeOf<RelationLinks<typeof mappedTwins>>().toEqualTypeOf<
      FullRelationLinks<typeof mappedTwins>
    >();
    expectTypeOf<
      RelationLinks<typeof mappedTwins>["mappedTwinOwner"]["target"]
    >().toEqualTypeOf<"mappedTwinA">();
    // @ts-expect-error - identical field keys do not establish complete model identity
    const _wrongMap: RelationLinks<
      typeof mappedTwins
    >["mappedTwinOwner"]["target"] = "mappedTwinB";
    expectTypeOf<RelationLinks<typeof unionIdentitySchema>>().toEqualTypeOf<
      FullRelationLinks<typeof unionIdentitySchema>
    >();
    expectTypeOf<
      RelationLinks<typeof unionIdentitySchema>["unionIdentityOwner"]["target"]
    >().toEqualTypeOf<"unionEntry">();
  });

  test("preserves identical aliases and separate identical model types", () => {
    expectTypeOf<RelationLinks<typeof twins>>().toEqualTypeOf<
      FullRelationLinks<typeof twins>
    >();
    expectTypeOf<
      RelationLinks<typeof twins>["twinOwner"]["twin"]
    >().toEqualTypeOf<"twinA" | "twinB" | "alias">();
    // @ts-expect-error - a different model cannot join the exact target-key union
    const _wrong: RelationLinks<typeof twins>["twinOwner"]["twin"] =
      "twinOwner";
  });

  test("leaves an out-of-schema target unresolved", () => {
    expectTypeOf<RelationLinks<typeof unlinked>>().toEqualTypeOf<
      FullRelationLinks<typeof unlinked>
    >();
    expectTypeOf<
      RelationLinks<typeof unlinked>["outsideOwner"]["outside"]
    >().toEqualTypeOf<never>();
  });

  test("preserves both variant cardinalities", () => {
    expectTypeOf<RelationLinks<typeof variants>>().toEqualTypeOf<
      FullRelationLinks<typeof variants>
    >();
    expectTypeOf<
      RelationLinks<typeof variants>["variantOwner"]["subject"]["post"]
    >().toEqualTypeOf<"post">();
    expectTypeOf<
      RelationLinks<typeof variants>["variantOwner"]["subjects"]["video"]
    >().toEqualTypeOf<"video">();
  });

  test("preserves a genuine cycle of singular slots", () => {
    expectTypeOf<RelationLinks<typeof ring>>().toEqualTypeOf<
      FullRelationLinks<typeof ring>
    >();
  });
});

describe("schema introspection public types", () => {
  test("returns the exact operation payload schema type", () => {
    const findManySchema = getOperationPayloadSchema(
      schema,
      "user",
      "findMany"
    );
    expectTypeOf(findManySchema).toEqualTypeOf<
      OperationPayloadSchema<"findMany", typeof user>
    >();
    expectTypeOf<
      StandardSchemaV1.InferInput<typeof findManySchema>
    >().toEqualTypeOf<OperationPayload<"findMany", typeof user>>();
    expectTypeOf<
      StandardSchemaV1.InferOutput<typeof findManySchema>
    >().toEqualTypeOf<
      ValidatedOperationPayload<"findMany", typeof user> | undefined
    >();

    const findUniqueOrThrowSchema = getOperationPayloadSchema(
      schema,
      "user",
      "findUniqueOrThrow"
    );
    expectTypeOf(findUniqueOrThrowSchema).toEqualTypeOf<
      OperationPayloadSchema<"findUniqueOrThrow", typeof user>
    >();
  });

  test("returns normalized operation output types", () => {
    const payload: unknown = { where: { id: "user-1" } };
    const validated = validateOperationPayload(
      schema,
      "user",
      "findUniqueOrThrow",
      payload
    );

    expectTypeOf(validated).toEqualTypeOf<
      ValidatedOperationPayload<"findUniqueOrThrow", typeof user>
    >();
    expectTypeOf(
      renderOperationResultType(schema, "user", "findMany", {})
    ).toEqualTypeOf<string>();
    expectTypeOf(renderSchemaType(schema)).toEqualTypeOf<string>();

    const validatedExist = validateOperationPayload(
      schema,
      "user",
      "exist",
      {}
    );
    expectTypeOf(validatedExist).not.toHaveProperty("select");

    expectTypeOf<
      OperationResult<"count", typeof user, { select: Record<never, never> }>
    >().toEqualTypeOf<number>();
  });

  test("keeps model and operation names exact", () => {
    const _unknownModel = () =>
      validateOperationPayload(
        schema,
        // @ts-expect-error - "missing" is not a model in this schema
        "missing",
        "findMany",
        {}
      );
    const _unknownOperation = () =>
      validateOperationPayload(
        schema,
        "user",
        // @ts-expect-error - "findEverything" is not a public operation
        "findEverything",
        {}
      );
    const _unknownSchemaOperation = () =>
      getOperationPayloadSchema(
        schema,
        "user",
        // @ts-expect-error - "findEverything" is not a public operation
        "findEverything"
      );
    const _unknownSchemaModel = () =>
      getOperationPayloadSchema(
        schema,
        // @ts-expect-error - "missing" is not a model in this schema
        "missing",
        "findMany"
      );
  });
});
