// viborm/soft-delete: the entire extension.

import type { OperationPayload } from "../client/exports"; // public today
import { ClientInitializationError } from "../errors"; // viborm's own class
import type { PlacedControl } from "../extensions/controls";
import { buildMethods } from "../extensions/methods-part";
import { buildRule } from "../extensions/rows-translation";
import {
  type AnyTarget,
  arg,
  args,
  type ClientSchema,
  type DelegateOperationArgs,
  type DelegateOperationResult,
  type Extension,
  extension,
  type Facts,
  keep,
  now,
  oneOf,
  type PendingOperation,
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
type ArgsOf<
  C extends VibORMConfig,
  K,
  O extends "update" | "updateMany" | "delete" | "deleteMany",
> = OperationPayload<O, ClientSchema<C>[K & keyof ClientSchema<C>]>;
type RestoreArgs<
  C extends VibORMConfig,
  K,
  O extends "update" | "updateMany",
> = Omit<ArgsOf<C, K, O>, "data">;
type PurgeManyArgs<C extends VibORMConfig, K> = NonNullable<
  ArgsOf<C, K, "deleteMany">
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
    const A extends DelegateOperationArgs<Self, RestoreArgs<C, K, "update">>,
  >(
    this: Self,
    args: NoExtra<A, RestoreArgs<C, K, "update">>
  ): PendingOperation<DelegateOperationResult<Self, "update", A>>;
  restoreMany<Self, A extends RestoreArgs<C, K, "updateMany">>(
    this: Self,
    args: NoExtra<A, RestoreArgs<C, K, "updateMany">>
  ): PendingOperation<DelegateOperationResult<Self, "updateMany", A>>;
  purge<
    Self,
    const A extends DelegateOperationArgs<Self, ArgsOf<C, K, "delete">>,
  >(
    this: Self,
    args: NoExtra<A, ArgsOf<C, K, "delete">>
  ): PendingOperation<DelegateOperationResult<Self, "delete", A>>;
  purgeMany<Self, A extends PurgeManyArgs<C, K> = PurgeManyArgs<C, K>>(
    this: Self,
    args?: NoExtra<A, PurgeManyArgs<C, K>>
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

/** A model the config names that the client lacks: refused where it is written. */
type KnownModels<Models, T extends AnyTarget> = {
  readonly [M in keyof Models]: M extends keyof ClientSchema<T["config"]>
    ? Models[M]
    : never;
};

/** What `softDelete(config)` adds: its two arguments, the models it hides rows of, the methods. */
type SoftDeleteFacts<T extends AnyTarget, Models> = Facts<
  Record<never, never>,
  {
    readonly [K in keyof Models &
      keyof ClientSchema<T["config"]>]: SoftDeleteMethods<T["config"], K>;
  },
  {
    readonly deleted: PlacedControl<"without" | "with" | "only">;
    readonly mode: PlacedControl<
      "soft" | "hard",
      keyof Models,
      "delete" | "deleteMany"
    >;
  },
  Extract<keyof Models, string>
>;

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
    NoInfer<KnownModels<Models, T>>;
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
  // Written apart from the rule, its argument names are checked where the
  // extension is applied.
  const rows = Object.fromEntries(
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
  return extension(
    NAME,
    args({
      // A delete of a managed model with mode "hard" deletes physically.
      mode: oneOf("soft", "hard"),
      // The call argument that picks which rows a call sees.
      deleted: oneOf("without", "with", "only").default("without"),
    }),
    buildRule(rows),
    // The methods read nothing typed at this step (each result is typed from
    // the delegate it is called on), so later extensions may hide rows or
    // omit fields freely.
    buildMethods(() =>
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
