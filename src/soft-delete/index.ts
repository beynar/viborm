// viborm/soft-delete: the entire extension.

import type { OperationPayload } from "../client/exports"; // public today
import { ClientInitializationError } from "../errors"; // viborm's own class
import type { PlacedControl } from "../extensions/controls";
import {
  type AnyTarget,
  arg,
  args,
  type ClientSchema,
  type DelegateOperationArgs,
  type DelegateOperationPayload,
  type DelegateOperationResult,
  type EmptyFacts,
  type Exact,
  type Extension,
  extension,
  type Facts,
  keep,
  methods,
  now,
  oneOf,
  type PendingOperation,
  rule,
  selecting,
  type Target,
  unless,
  type VibORMConfig,
  when,
} from "../index";

export interface SoftDeleteModel {
  readonly deletedAt: string; // a nullable DateTime field of this model
  readonly deletedBy?: string; // optional scalar field for the actor
}
export interface SoftDeleteConfig {
  readonly models: Readonly<Record<string, SoftDeleteModel>>;
  /** What a delete writes into `deletedBy`, fixed per derived client. */
  readonly actorId?: string | number | bigint;
  /** `actorId`'s name before 1.9.1, still accepted (`actor` names the request's actor in `permissions`). */
  readonly actor?: string | number | bigint;
}

const NAME = "viborm.softDelete";

// restore and purge take the model's own update and delete arguments
// (restore minus `data`); other keys are flagged.
// They are read from the delegate's own client (`Self`): written apart from
// any client, the extension's own target knows no model.
type ArgsOf<
  C extends VibORMConfig,
  K,
  O extends "update" | "updateMany" | "delete" | "deleteMany",
  Self,
> = DelegateOperationPayload<
  Self,
  O,
  OperationPayload<O, ClientSchema<C>[K & keyof ClientSchema<C>]>
>;
type RestoreArgs<
  C extends VibORMConfig,
  K,
  O extends "update" | "updateMany",
  Self,
> = Omit<ArgsOf<C, K, O, Self>, "data">;
type PurgeManyArgs<C extends VibORMConfig, K, Self> = NonNullable<
  ArgsOf<C, K, "deleteMany", Self>
>;
type NoExtra<A, R> = A & Record<Exclude<keyof A, keyof R>, never>; // flags data and typos

// Each result is typed from the delegate the method is called on (`Self`),
// so it follows every extension applied after this one: a later `rows`
// step types a to-one relation `| null`, a later `defaultOmit` drops a
// field. Called off its delegate (destructured), its result is `unknown`:
// using it is a type error, not a silent `never`. A type alias, not an interface: a method record.
// Exported so an exported client's declaration names it instead of spelling
// its arguments out.
export type SoftDeleteMethods<C extends VibORMConfig, K> = {
  restore<
    Self,
    const A extends DelegateOperationArgs<
      Self,
      RestoreArgs<C, K, "update", Self>
    >,
  >(
    this: Self,
    args: NoExtra<A, RestoreArgs<C, K, "update", Self>>
  ): PendingOperation<DelegateOperationResult<Self, "update", A>>;
  restoreMany<Self, A extends RestoreArgs<C, K, "updateMany", Self>>(
    this: Self,
    args: NoExtra<A, RestoreArgs<C, K, "updateMany", Self>>
  ): PendingOperation<DelegateOperationResult<Self, "updateMany", A>>;
  purge<
    Self,
    const A extends DelegateOperationArgs<Self, ArgsOf<C, K, "delete", Self>>,
  >(
    this: Self,
    args: NoExtra<A, ArgsOf<C, K, "delete", Self>>
  ): PendingOperation<DelegateOperationResult<Self, "delete", A>>;
  purgeMany<
    Self,
    A extends PurgeManyArgs<C, K, Self> = PurgeManyArgs<C, K, Self>,
  >(
    this: Self,
    args?: NoExtra<A, PurgeManyArgs<C, K, Self>>
  ): PendingOperation<DelegateOperationResult<Self, "deleteMany", A>>;
};

/** Each model's markers, as the client `$extends` is called on has them. */
type SoftDeleteModels<T extends AnyTarget> = {
  readonly [M in keyof ClientSchema<T["config"]> & string]?: {
    readonly deletedAt: ScalarsOf<T, M>;
    readonly deletedBy?: ScalarsOf<T, M>;
  };
};
type ScalarsOf<T extends AnyTarget, M> = M extends keyof ClientSchema<
  T["config"]
>
  ? Extract<keyof ClientSchema<T["config"]>[M]["~"]["state"]["scalars"], string>
  : never;

/** What `softDelete(config)` adds: its two arguments, the models it hides rows of, the methods. */
type SoftDeleteFacts<T extends AnyTarget, Models> = Facts<
  Record<never, never>,
  {
    readonly [K in keyof Models &
      keyof ClientSchema<T["config"]>]: SoftDeleteMethods<T["config"], K>;
  },
  {
    // A mode chooses rows a call selects: a create selects none. Spelled
    // out, so an exported client's declaration needs no other name.
    readonly deleted: PlacedControl<
      "without" | "with" | "only",
      PropertyKey,
      | "findMany"
      | "findFirst"
      | "findUnique"
      | "findFirstOrThrow"
      | "findUniqueOrThrow"
      | "count"
      | "aggregate"
      | "groupBy"
      | "exist"
      | "update"
      | "updateMany"
      | "upsert"
      | "delete"
      | "deleteMany"
    >;
    readonly mode: PlacedControl<
      "soft" | "hard",
      keyof Models,
      "delete" | "deleteMany"
    >;
  },
  Extract<keyof Models, string>
>;

/** Refuse a marker that is not a nullable, single DateTime field. */
function admitMarkers(
  schema: VibORMConfig["schema"],
  entries: readonly (readonly [string, SoftDeleteModel])[]
): void {
  for (const [name, { deletedAt }] of entries) {
    const scalars = Object.hasOwn(schema, name)
      ? schema[name]!["~"].state.scalars
      : undefined;
    if (!(scalars && Object.hasOwn(scalars, deletedAt))) continue;
    const state = scalars[deletedAt]!["~"].state;
    if (state.type !== "datetime" || state.array || !state.nullable)
      throw new ClientInitializationError(
        `softDelete: ${name}.${deletedAt} must be a nullable DateTime field (s.dateTime().nullable()): a live row holds null there.`,
        { meta: { extension: NAME } }
      );
  }
}

/** No client: what an extension written apart from one is built against. */
type Untyped = Target<
  VibORMConfig<Record<never, never>>,
  AnyTarget["state"],
  EmptyFacts
>;
type Schema = VibORMConfig["schema"];

/** A delegate as the methods call it: its own operations. */
type Self = Readonly<Record<string, (args: object) => unknown>>;

/**
 * Keep deleted rows as tombstones: `client.$extends(softDelete({ models: {
 * post: { deletedAt: "deletedAt" } } }))`. One step, applied in any order
 * with the other extensions.
 */
export function softDelete<T extends AnyTarget, const Models>(config: {
  readonly models: Models &
    SoftDeleteModels<T> &
    NoInfer<Exact<Models, SoftDeleteModels<T>>>;
  /** What a delete writes into `deletedBy`, fixed per extension. */
  readonly actorId?: string | number | bigint;
  /** `actorId`'s name before 1.9.1, still accepted. */
  readonly actor?: string | number | bigint;
}): Extension<T, SoftDeleteFacts<T, Models>>;
export function softDelete(config: SoftDeleteConfig): unknown {
  if (config.actorId !== undefined && config.actor !== undefined)
    throw new ClientInitializationError(
      "softDelete: give actorId, not both actorId and actor (its former name).",
      { meta: { extension: NAME } }
    );
  const actor = config.actorId ?? config.actor ?? null;
  const entries = Object.entries(config.models);
  const managed = entries.map(([model]) => model);
  // Built against no client: the entries are read from the schema the
  // extension is applied to, and checked there; `softDelete`'s own
  // signature types what it adds.
  return extension<Untyped>(
    NAME,
    args({
      deleted: oneOf("without", "with", "only")
        .default("without")
        .on(selecting),
      // Named, not `deletes`: that set brings what watches writes.
      mode: oneOf("soft", "hard").on(["delete", "deleteMany"]).models(managed),
    }),
    // Read where the extension is applied: a marker that is not a nullable
    // DateTime is refused there, before its filters would refuse it less
    // clearly (a string field would fail at the first delete).
    rule<Untyped, (schema: Schema) => object>((schema) => {
      admitMarkers(schema, entries);
      return Object.fromEntries(
        entries.map(([model, { deletedAt, deletedBy }]) => [
          model,
          {
            root: [
              when(arg("deleted"), "without", { [deletedAt]: null }),
              when(arg("deleted"), "only", { [deletedAt]: { not: null } }),
            ],
            related: unless(arg("deleted"), "with", { [deletedAt]: null }),
            delete: {
              instead: keep(
                unless(arg("mode"), "hard", {
                  [deletedAt]: now,
                  ...(deletedBy ? { [deletedBy]: actor } : {}),
                })
              ),
            },
          },
        ])
      );
    }),
    // The methods read nothing typed at this step (each result is typed from
    // the delegate it is called on), so later extensions may hide rows or
    // omit fields freely.
    methods((): object =>
      Object.fromEntries(
        entries.map(([model, { deletedAt, deletedBy }]) => {
          const data = {
            [deletedAt]: null,
            ...(deletedBy ? { [deletedBy]: null } : {}),
          };
          // Tombstones only: `deleted: "only"` overrides a caller's value.
          const tombstones = { deleted: "only", mode: "hard" };
          return [
            model,
            {
              restore(this: Self, given: object) {
                return this.update!({ ...given, data, deleted: "only" });
              },
              restoreMany(this: Self, given: object) {
                return this.updateMany!({ ...given, data, deleted: "only" });
              },
              purge(this: Self, given: object) {
                return this.delete!({ ...given, ...tombstones });
              },
              purgeMany(this: Self, given: object = {}) {
                return this.deleteMany!({ ...given, ...tombstones });
              },
            },
          ];
        })
      )
    )
  );
}
