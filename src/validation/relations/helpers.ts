import type { AnyModel } from "@schema/model";
import type { RelationState } from "@schema/relation";
import type {
  ForeignKeyOf,
  JunctionFactsOf,
  JunctionModelOf,
  RelationsOf,
  TargetGetter,
  TargetModelOf,
} from "@schema/relation/static-membership";
import type { ResolvedSlot } from "@schema/validation/relation-resolution";
import type { ModelSchemas } from "@validation/model";
import { createSchema, fail, ok, validateSchema } from "../primitives/helpers";
import v, { type V } from "../primitives/v";
import type { VibSchema } from "../types";
import { isRecord } from "../value-guards";

/**
 * The one model a MODEL-target relation names. A variant target names several,
 * and its schema families reach them through their own entry map instead.
 */
export type TargetModel<S extends RelationState> =
  TargetGetter<S> extends () => infer T
    ? T extends AnyModel
      ? T
      : never
    : never;

export type GetTargetSchemas<S extends RelationState> = ModelSchemas<
  TargetModel<S>
>;

type CreateSchemaGetter<S extends RelationState> = (
  state: S
) => () => GetTargetSchemas<S>;

export type SchemaGetter<S extends RelationState> = ReturnType<
  CreateSchemaGetter<S>
>;

/**
 * The schemas of the declared model holding a slot's junction, where one does:
 * `$through` reads, filters and writes that model's scalars through them.
 */
export type JunctionSchemas = (() => ModelSchemas<AnyModel>) | undefined;

/**
 * The scalars of a link row a `$through` filter may test: each field's own
 * filter, and nothing else, so a relation inside it is an unknown key.
 */
export type LinkFilterSchema<M extends AnyModel> = V.Object<
  V.FromObject<ModelSchemas<M>["scalars"], "filter">["entries"]
>;

/** A target's `where` with `$through` beside it, the input it adds and no more. */
export type WhereWithLinkFilter<
  Where extends VibSchema<any, any>,
  M extends AnyModel,
> = VibSchema<
  Where[" vibInferred"]["0"] & {
    $through?: LinkFilterSchema<M>[" vibInferred"]["0"];
  },
  Where[" vibInferred"]["1"]
>;

/** The declared model holding a slot's junction, where one does. */
export const junctionModelOf = (
  resolved: ResolvedSlot
): AnyModel | undefined =>
  resolved.edge.kind === "junction"
    ? resolved.edge.topology.declared?.model
    : undefined;

/**
 * A target's `where` as a slot reads it: the target's own, shared by every slot
 * reaching that model, and with `$through` beside it on a declared junction,
 * where a walk says `link` instead of the link row's filter. A thunk, because
 * the target's schemas are built only once something asks.
 */
export const whereWithLinkFilter = (
  own: () => VibSchema<any, any>,
  junctionSchemas: JunctionSchemas,
  link: () => VibSchema<any, any> = () =>
    v.object(
      v.fromObject(junctionSchemas!().scalars as never, "filter").entries
    )
): (() => VibSchema<any, any>) => {
  if (!junctionSchemas) return own;
  let linked: VibSchema<any, any> | undefined;
  return () => {
    linked ??= (own() as V.Object<any, any>).extend({ $through: link() });
    return linked;
  };
};

/**
 * A nested write's target with its link values beside it: whatever the target's
 * own schema is, split on `$through` so that schema reads exactly what it reads
 * on any other slot. The identity on a slot with no declared junction.
 *
 * What a `$through` may write: each stated column through its own create schema
 * (`.schema()`, type conversion, a nullable's null), the columns it does not
 * state left out, so an existing link keeps them and a new one takes its
 * defaults. A member column belongs to the two sides and a relation is no
 * column, so both are refused by name.
 */
export const withLinkWrite = (
  resolved: ResolvedSlot,
  junctionSchemas: JunctionSchemas
) => {
  const { edge } = resolved;
  if (!(junctionSchemas && edge.kind === "junction"))
    return <Schema>(schema: Schema) => schema;
  const { source, target, declared } = edge.topology;
  const members = new Set(
    [...source.members, ...target.members].map((member) => member.junctionField)
  );
  const modelScalars = declared!.model["~"].state.scalars;
  const link = createSchema("object", (value) => {
    if (!isRecord(value)) return fail("$through must be an object");
    const scalars = junctionSchemas().scalars as Record<
      string,
      { readonly create: VibSchema }
    >;
    const admitted: Record<string, unknown> = {};
    for (const [field, given] of Object.entries(value)) {
      if (given === undefined) continue;
      if (!Object.hasOwn(scalars, field))
        return fail(`$through.${field} is not a column of the junction model`);
      if (members.has(modelScalars[field]!["~"].state.columnName ?? field))
        return fail(
          `$through.${field} is filled from the two rows the link joins, and cannot be written`
        );
      const result = validateSchema(scalars[field]!.create, given);
      if (result.issues)
        return {
          issues: result.issues.map((issue) => ({
            ...issue,
            path: ["$through", field, ...(issue.path ?? [])],
          })),
        };
      admitted[field] = result.value;
    }
    return ok(admitted);
  });
  return <Schema>(schema: Schema) =>
    createSchema("object", (value) => {
      if (!(isRecord(value) && Object.hasOwn(value, "$through")))
        return validateSchema(schema as VibSchema, value);
      const { $through, ...rest } = value;
      const own = validateSchema(schema as VibSchema, rest);
      // A key spelled `undefined` reads as absent, as on every other object.
      if (own.issues || $through === undefined) return own;
      const written = validateSchema(link, $through);
      if (written.issues) return written;
      return ok({ ...(own.value as object), $through: written.value });
    }) as unknown as Schema;
};

/**
 * The columns a `$through` may name: the junction model's scalars but the two
 * sides' own. The sides are the to-ones `.source()` / `.target()` named, else
 * the to-ones aimed at either endpoint, read here and not from the resolved
 * edge, which types cannot reach.
 */
type LinkMemberFields<Facts, M, Source, Target> = {
  [K in keyof RelationsOf<M>]: ForeignKeyOf<RelationsOf<M>[K]> extends {
    readonly fields: infer Fields extends readonly string[];
  }
    ? Facts extends { readonly source: string; readonly target: string }
      ? K extends Facts["source"] | Facts["target"]
        ? Fields[number]
        : never
      : TargetModelOf<RelationsOf<M>[K]> extends Source | Target
        ? Fields[number]
        : never
    : never;
}[keyof RelationsOf<M>];

type LinkScalars<M extends AnyModel> = ModelSchemas<M>["scalars"];
type LinkEntries<M extends AnyModel> = V.FromObject<
  LinkScalars<M>,
  "create"
>["entries"];

/** A scalar with neither a default nor a null to stand on, as `create` reads it. */
type RequiredLinkKeys<M extends AnyModel> = {
  [K in keyof M["~"]["state"]["scalars"]]: M["~"]["state"]["scalars"][K]["~"]["state"]["optional"] extends true
    ? never
    : K;
}[keyof M["~"]["state"]["scalars"]];

/** What `$through` may state, the keys a create requires required here too. */
type LinkWriteInput<M extends AnyModel, Members> = {
  [K in Exclude<keyof LinkEntries<M>, Members | RequiredLinkKeys<M>>]?: V.Input<
    LinkEntries<M>[K]
  >;
} & {
  [K in Exclude<
    Extract<keyof LinkEntries<M>, RequiredLinkKeys<M>>,
    Members
  >]: V.Input<LinkEntries<M>[K]>;
};

/** The columns one slot's `$through` may name, for the literal walk to read. */
export type LinkWriteKeys<Source, Key, R> =
  JunctionModelOf<Source, Key, R> extends infer M extends AnyModel
    ? Exclude<
        keyof M["~"]["state"]["scalars"],
        LinkMemberFields<
          JunctionFactsOf<Source, Key, R>,
          M,
          Source,
          TargetModelOf<R>
        >
      >
    : never;

/**
 * A nested write's target input on a slot a declared model holds: `$through` is
 * optional where every other column of the link can fill itself, and required
 * where one cannot. Every other slot reads its target's own schema unchanged.
 */
export type WithLinkWrite<
  Schema extends VibSchema<any, any>,
  Source,
  Key,
  S,
> = [
  JunctionModelOf<Source, Key, { readonly "~": { readonly state: S } }>,
] extends [never]
  ? Schema
  : JunctionModelOf<
        Source,
        Key,
        { readonly "~": { readonly state: S } }
      > extends infer M extends AnyModel
    ? LinkWriteInput<
        M,
        LinkMemberFields<
          JunctionFactsOf<Source, Key, { readonly "~": { readonly state: S } }>,
          M,
          Source,
          TargetModelOf<{ readonly "~": { readonly state: S } }>
        >
      > extends infer Written
      ? VibSchema<
          Schema[" vibInferred"]["0"] &
            (Record<never, never> extends Written
              ? { $through?: Written }
              : { $through: Written }),
          Schema[" vibInferred"]["1"]
        >
      : Schema
    : Schema;
