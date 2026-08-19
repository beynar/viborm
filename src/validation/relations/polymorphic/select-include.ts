import type { AnyModel } from "@schema/model";
import type {
  AnyPolymorphicRelation,
  PolymorphicRelationState,
  PolymorphicToManyRelation,
  PolymorphicToManyState,
  PolymorphicToOneRelation,
  PolymorphicToOneState,
} from "@schema/relation";
import { withOmitProjection } from "@validation/model/args/omit";
import { rejectSelectInclude } from "@validation/model/args/select-include-exclusivity";
import { projectableScalarNames } from "@validation/model/core/projection";
import {
  createSchema,
  fail,
  ok,
  validateSchema,
} from "@validation/primitives/helpers";
import type {
  ObjectOptions,
  ObjectSchema,
} from "@validation/primitives/object";
import v from "@validation/primitives/v";
import type { InferInput, InferOutput, VibSchema } from "@validation/types";
import { isRecord } from "@validation/value-guards";
import { buildToManyNestedNode, defaultSelectionNode } from "../select-include";
import type {
  CoreInputAt,
  CoreOutputAt,
  ExactPolymorphicTargetSchemaGetters,
  PolymorphicSchema,
  PolymorphicTargetSchemaGetters,
} from "./types";
import { polymorphicPublicTypes } from "./types";

type ProjectionInput<Schemas> = Schemas extends () => infer TargetSchemas
  ? TargetSchemas extends {
      readonly core: {
        readonly select: infer Select;
        readonly include: infer Include;
        readonly omit: infer Omit;
      };
    }
    ?
        | true
        | {
            readonly select: InferInput<Select>;
            readonly include?: never;
            readonly omit?: InferInput<Omit>;
          }
        | {
            readonly select?: never;
            readonly include?: InferInput<Include>;
            readonly omit?: InferInput<Omit>;
          }
    : never
  : never;

type ProjectionOutput<Schemas> = Schemas extends () => infer TargetSchemas
  ? TargetSchemas extends {
      readonly core: {
        readonly select: infer Select;
        readonly include: infer Include;
      };
    }
    ?
        | true
        | {
            readonly select?: InferOutput<Select>;
            readonly include?: InferOutput<Include>;
          }
    : never
  : never;

export type PolymorphicProjectionInput<Getters> = {
  readonly [PublicType in keyof Getters]?: ProjectionInput<Getters[PublicType]>;
};

export type PolymorphicProjectionOutput<Getters> = {
  readonly [PublicType in keyof Getters]?: ProjectionOutput<
    Getters[PublicType]
  >;
};

export type PolymorphicSelectSchema<Getters> = PolymorphicSchema<
  boolean | PolymorphicProjectionInput<Getters>,
  boolean | PolymorphicProjectionOutput<Getters>
>;

export type PolymorphicIncludeSchema<Getters> =
  PolymorphicSelectSchema<Getters>;

export function polymorphicSelectFactory<
  State extends PolymorphicRelationState,
  Getters extends PolymorphicTargetSchemaGetters<State>,
>(
  relation:
    | PolymorphicToOneRelation<State & PolymorphicToOneState>
    | PolymorphicToManyRelation<State & PolymorphicToManyState>,
  targetSchemas: ExactPolymorphicTargetSchemaGetters<State, Getters>
): PolymorphicSelectSchema<Getters>;
export function polymorphicSelectFactory(
  relation: AnyPolymorphicRelation,
  targetSchemas: PolymorphicTargetSchemaGetters<PolymorphicRelationState>
): PolymorphicSelectSchema<
  PolymorphicTargetSchemaGetters<PolymorphicRelationState>
>;
export function polymorphicSelectFactory(
  relation: AnyPolymorphicRelation,
  targetSchemas: PolymorphicTargetSchemaGetters<PolymorphicRelationState>
): PolymorphicSelectSchema<
  PolymorphicTargetSchemaGetters<PolymorphicRelationState>
> {
  const state = relation["~"].state;
  const schemaGetters = targetSchemas;
  const targetModels = new Map<
    string,
    Parameters<typeof withOmitProjection>[1]
  >();
  for (const { publicType, targetModel } of relation["~"].targetEntries()) {
    targetModels.set(
      publicType,
      targetModel as Parameters<typeof withOmitProjection>[1]
    );
  }
  const entries: Record<string, () => ReturnType<typeof v.union>> = {};
  for (const publicType of polymorphicPublicTypes(state)) {
    const schemas = schemaGetters[publicType]!;
    const target = targetModels.get(publicType)!;
    entries[publicType] = () =>
      v.union([
        v.literal(true),
        v.lazy(() => {
          const targetSchemasAtParse = schemas();
          const targetModel = target;
          const node = withOmitProjection(
            rejectSelectInclude(
              v.object({
                select: () => targetSchemasAtParse.core.select,
                include: () => targetSchemasAtParse.core.include,
                omit: () => targetSchemasAtParse.core.omit,
              })
            ),
            targetModel,
            `polymorphic.${publicType}`
          );
          return v.coerce(node, (value) => {
            if (value.select !== undefined) return value;
            const select: Record<string, true> = {};
            for (const field of projectableScalarNames(targetModel)) {
              select[field] = true;
            }
            return Object.keys(select).length === 0
              ? value
              : { ...value, select };
          });
        }),
      ]);
  }
  return v.union([v.boolean(), v.object(entries)]) as PolymorphicSelectSchema<
    PolymorphicTargetSchemaGetters<PolymorphicRelationState>
  >;
}

export const polymorphicIncludeFactory = polymorphicSelectFactory;

// =============================================================================
// COLLECTION ENVELOPE — cardinality `"many"`
// =============================================================================

/**
 * THE CROSS-BOUNDARY CONTRACT with the query engine, in one place.
 *
 * A validated collection selection is one of exactly three things:
 *
 *  - `true`  — every configured variant, each at its default projection;
 *  - `false` — no key in the result and no relation SQL at all;
 *  - `{ only?, variants? }` — where `only` is a DEDUPED array in DECLARATION
 *    order (never the caller's order) and `variants` maps a public
 *    discriminator to that arm's to-many node.
 *
 * `true` / `false` are preserved VERBATIM rather than desugared into an
 * all-variants envelope: that keeps parity with the to-one factory and with
 * `booleanToSelect`'s `false` contract, and keeps "`{ items: false }` emits no
 * key and no relation SQL" a straight-through fact rather than something the
 * engine has to re-derive from an envelope full of arms.
 *
 * The engine reads `only` and `variants` and NOTHING else. Two keys, both
 * optional, both meaning the same thing when absent as when explicitly
 * `undefined` (the parse boundary's rule).
 */

type ArmProjectionKeys<Getters, PublicType extends keyof Getters> = {
  readonly where?: CoreInputAt<Getters, PublicType, "where">;
  readonly orderBy?:
    | CoreInputAt<Getters, PublicType, "orderBy">
    | readonly CoreInputAt<Getters, PublicType, "orderBy">[];
  readonly take?: number;
  readonly skip?: number;
  readonly cursor?: CoreInputAt<Getters, PublicType, "whereUnique">;
  readonly distinct?: readonly string[];
  readonly omit?: CoreInputAt<Getters, PublicType, "omit">;
};

/**
 * One arm: `true` (that variant at its default projection) or the ordinary
 * to-many node, `select` and `include` mutually exclusive as everywhere else.
 *
 * There is deliberately NO `false` arm. "Do not read this variant" already has
 * a spelling — leaving it out of `only` — and a second spelling of one fact is
 * the shape this codebase refuses.
 */
type ArmInput<Getters, PublicType extends keyof Getters> =
  | true
  | (ArmProjectionKeys<Getters, PublicType> & {
      readonly select: CoreInputAt<Getters, PublicType, "select">;
      readonly include?: never;
    })
  | (ArmProjectionKeys<Getters, PublicType> & {
      readonly select?: never;
      readonly include?: CoreInputAt<Getters, PublicType, "include">;
    });

type ArmOutput<Getters, PublicType extends keyof Getters> = {
  readonly where?: CoreOutputAt<Getters, PublicType, "where">;
  readonly orderBy?: unknown;
  readonly take?: number;
  readonly skip?: number;
  readonly cursor?: CoreOutputAt<Getters, PublicType, "whereUnique">;
  readonly distinct?: readonly string[];
  readonly select?: CoreOutputAt<Getters, PublicType, "select">;
  readonly include?: CoreOutputAt<Getters, PublicType, "include">;
};

export type PolymorphicCollectionProjectionInput<Getters> = {
  readonly only?: readonly Extract<keyof Getters, string>[];
  readonly variants?: {
    readonly [PublicType in keyof Getters]?: ArmInput<Getters, PublicType>;
  };
};

export type PolymorphicCollectionProjectionOutput<Getters> = {
  readonly only?: readonly Extract<keyof Getters, string>[];
  readonly variants?: {
    readonly [PublicType in keyof Getters]?: ArmOutput<Getters, PublicType>;
  };
};

export type PolymorphicCollectionSelectSchema<Getters> = PolymorphicSchema<
  boolean | PolymorphicCollectionProjectionInput<Getters>,
  boolean | PolymorphicCollectionProjectionOutput<Getters>
>;

export type PolymorphicCollectionIncludeSchema<Getters> =
  PolymorphicCollectionSelectSchema<Getters>;

/**
 * `only` — an exact, DEDUPED, declaration-ordered allow-list.
 *
 * `v.enum(publicTypes, { array: true })` already answers membership and element
 * exactness, and it is the schema whose `values` the JSON-schema converter
 * reads. What it does NOT do is dedupe (it is a `Set.has` membership test), so
 * `["post","post"]` would sail through and then quietly cost an extra arm.
 *
 * CANONICALIZATION is not cosmetic. It makes "the allow-list's order never
 * changes result order" structurally true instead of a promise the read builder
 * has to keep, and it collapses `["a","b"]` and `["b","a"]` into ONE cache
 * entry — the cache key preserves array order, so without this the same query
 * spelled two ways compiles and caches twice. Duplicates are refused first, so
 * the canonical form is a pure reorder that loses nothing.
 *
 * `only: []` is accepted: "no variants" is a legal, if unusual, request, and it
 * has an exact result type (`readonly never[]`) and an exact runtime answer (a
 * fresh empty array) — while every arm's integrity facts are still computed.
 */
const onlyAllowList = (
  publicTypes: string[]
): VibSchema<readonly string[], string[]> => {
  const membership = v.enum(publicTypes, { array: true });
  return createSchema<readonly string[], string[]>(
    "polymorphic_only",
    (value) => {
      const result = validateSchema(membership, value);
      if (result.issues) return result;
      const seen = new Set<string>();
      for (const entry of result.value) {
        if (seen.has(entry)) {
          return fail(`Duplicate value in 'only': '${entry}'`);
        }
        seen.add(entry);
      }
      return ok(publicTypes.filter((publicType) => seen.has(publicType)));
    }
  );
};

/**
 * A CROSS-KEY rule, so it cannot live on either entry: naming a variant under
 * `variants` that `only` excludes is a contradiction, and answering it with the
 * arm's own error ("Unknown key") would name the wrong thing.
 *
 * Same shape as `rejectSelectInclude`: re-implement `~standard.validate` over
 * the object schema. It runs AFTER the wrapped schema, so a variant name that is
 * both unknown and outside `only` still gets the accurate "Unknown key" rather
 * than this cross-key message.
 *
 * The pair is read off the RAW payload even though the verdict is only issued
 * for a payload that validated. The two are the same fact: `only` is deduped
 * (a duplicate is refused outright) and reordered into declaration order, so
 * canonicalization cannot change which types the allow-list ADMITS. Reading the
 * raw object is what lets both shape checks below be guards over a value the
 * checker can actually narrow — the wrapped schema's output type is opaque
 * `TEntries`, and re-deciding "is it a record" on a result that has already
 * validated as an object is a guard with nothing left to catch.
 *
 * Parse-boundary only. There is no type-level mirror: the cost of one more
 * conditional inside an already-distributed mapped type is real, and the payoff
 * is a message TypeScript would phrase worse.
 */
export const rejectVariantsOutsideOnly = <
  TEntries,
  TOpts extends ObjectOptions | undefined,
>(
  schema: ObjectSchema<TEntries, TOpts>
): ObjectSchema<TEntries, TOpts> => {
  const standard = schema["~standard"];
  const validate: typeof standard.validate = (value) => {
    if (!isRecord(value)) return standard.validate(value);
    const only = value.only;
    const variants = value.variants;
    // An absent `only` leaves `variants` unconstrained, and a malformed pair is
    // the wrapped schema's refusal to phrase, not this rule's.
    if (!(Array.isArray(only) && isRecord(variants))) {
      return standard.validate(value);
    }
    const result = standard.validate(value);
    if (result.issues) return result;
    const allowed = new Set<unknown>(only);
    const stray = Object.keys(variants).find(
      (publicType) => !allowed.has(publicType)
    );
    if (stray === undefined) return result;
    return {
      issues: [
        {
          message: `Variant '${stray}' is not in 'only'`,
          path: ["variants", stray],
        },
      ],
    };
  };

  return {
    ...schema,
    parse: validate,
    "~standard": {
      version: standard.version,
      vendor: standard.vendor,
      validate,
      get types() {
        return standard.types;
      },
      get jsonSchema() {
        return standard.jsonSchema;
      },
    },
  };
};

export function polymorphicCollectionSelectFactory<
  State extends PolymorphicRelationState,
  Getters extends PolymorphicTargetSchemaGetters<State>,
>(
  relation: PolymorphicToManyRelation<State & PolymorphicToManyState>,
  targetSchemas: ExactPolymorphicTargetSchemaGetters<State, Getters>
): PolymorphicCollectionSelectSchema<Getters>;
export function polymorphicCollectionSelectFactory(
  relation: AnyPolymorphicRelation,
  targetSchemas: PolymorphicTargetSchemaGetters<PolymorphicRelationState>
): PolymorphicCollectionSelectSchema<
  PolymorphicTargetSchemaGetters<PolymorphicRelationState>
>;
export function polymorphicCollectionSelectFactory(
  relation: AnyPolymorphicRelation,
  targetSchemas: PolymorphicTargetSchemaGetters<PolymorphicRelationState>
): PolymorphicCollectionSelectSchema<
  PolymorphicTargetSchemaGetters<PolymorphicRelationState>
> {
  const state = relation["~"].state;
  const publicTypes = polymorphicPublicTypes(state);
  const targetModels = new Map<string, AnyModel>();
  for (const { publicType, targetModel } of relation["~"].targetEntries()) {
    // `targetModel` is declared `unknown` on purpose — the entry is a HOSTILE
    // boundary until the polymorphic definition gate has run. Schema
    // construction happens after that gate (it is what materializes the member
    // topology this factory's arms read), so re-checking here would be a second
    // guard over an invariant that already has an owner.
    targetModels.set(publicType, targetModel as AnyModel);
  }

  const armEntries: Record<string, () => VibSchema<unknown, unknown>> = {};
  for (const publicType of publicTypes) {
    const schemas = targetSchemas[publicType]!;
    const target = targetModels.get(publicType)!;
    armEntries[publicType] = () =>
      v.union([
        // A bare `true` desugars to the SAME shape a spelled-out arm parses to,
        // so the engine sees one arm shape rather than two.
        v.coerce(v.literal(true), () => defaultSelectionNode(target)),
        v.lazy(() =>
          buildToManyNestedNode({
            targetModel: target,
            label: `polymorphic.${publicType}`,
            core: () => schemas().core,
            scalarNames: Object.keys(target["~"].state.scalars),
          })
        ),
      ]);
  }

  const envelope = rejectVariantsOutsideOnly(
    v.object({
      only: onlyAllowList(publicTypes),
      variants: v.object(armEntries),
    })
  );

  return v.union([v.boolean(), envelope]) as PolymorphicCollectionSelectSchema<
    PolymorphicTargetSchemaGetters<PolymorphicRelationState>
  >;
}

export const polymorphicCollectionIncludeFactory =
  polymorphicCollectionSelectFactory;
