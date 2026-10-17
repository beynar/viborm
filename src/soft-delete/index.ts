// viborm/soft-delete: the entire extension.

import type { OperationPayload } from "../client/exports"; // public today
import type {
  ClientSchema,
  ClientTypeState,
  ExtendedOperationResult,
  ExtensionState,
  PendingOperation,
  VibORMClient,
  VibORMConfig,
} from "../index";

export interface SoftDeleteModel {
  readonly deletedAt: string; // a DateTime field of this model
  readonly deletedBy?: string; // optional scalar field for the actor
}
export interface SoftDeleteConfig {
  readonly models: Readonly<Record<string, SoftDeleteModel>>;
  readonly actor?: string | number | bigint; // bound per derived client
}
type Schema = VibORMConfig["schema"];
type AnyModel = Schema[string];
type Names<Config extends SoftDeleteConfig> = keyof Config["models"] & string;

// One value per configured model, keys kept: step B types `db.post.restore`
// from them. The cast is TypeScript's own limit: Object.fromEntries forgets keys.
function perModel<
  Config extends SoftDeleteConfig,
  T,
  S extends Schema = Schema,
>(config: Config, build: (m: SoftDeleteModel) => T, _schema?: S) {
  return Object.fromEntries(
    Object.entries(config.models).map(([k, m]) => [k, build(m)])
  ) as { readonly [K in Names<Config> & keyof S]: T };
}

// restore takes the model's own update arguments, minus `data`; other keys are flagged.
type RestoreArgs<
  C extends VibORMConfig,
  K,
  O extends "update" | "updateMany",
> = Omit<
  OperationPayload<O, ClientSchema<C>[K & keyof ClientSchema<C>]>,
  "data"
>;
type NoExtra<A, R> = A & Record<Exclude<keyof A, keyof R>, never>; // flags data and typos
type RestoreModels<
  M,
  C extends VibORMConfig,
  Config extends SoftDeleteConfig,
> = {
  // The delegate of a client generic over its state stays deferred: untyped.
  readonly [K in Names<Config>]: (delegate: never) => {
    restore<A extends RestoreArgs<C, K, "update">>(
      args: NoExtra<A, RestoreArgs<C, K, "update">>
    ): PendingOperation<ExtendedOperationResult<M, K, "update", A>>;
    restoreMany<A extends RestoreArgs<C, K, "updateMany">>(
      args: NoExtra<A, RestoreArgs<C, K, "updateMany">>
    ): PendingOperation<ExtendedOperationResult<M, K, "updateMany", A>>;
  };
};

// Every `rows` step of a chain goes before every method step (a method typed
// against a client whose rows a later step widens would lie), so the entry
// is both steps, `softDelete(config)(base)`, and each alone: `rows` and
// `methods`, to apply around another entry's steps.
export function softDelete<const Config extends SoftDeleteConfig>(
  config: Config
) {
  // Step A: controls, rows and deletion, checked against base's schema.
  // Node 22's type stripper leaves a newline after `return <...>`, triggering ASI.
  const rows = <
    C extends VibORMConfig & {
      readonly schema: Record<Names<Config>, AnyModel>;
    },
    X extends ExtensionState & { readonly resultConsumer: undefined },
  >(
    base: ClientTypeState<C, X> & NoInfer<VibORMClient<C, X>>
  ) =>
    base.$extends({
      name: "viborm.softDelete",
      controls: { mode: { oneOf: ["soft", "hard"] } }, // deletion places it on managed deletes
      rows: {
        control: "deleted", // the call argument that picks a mode
        default: "without",
        models: perModel(
          config,
          ({ deletedAt }) => ({
            without: {
              root: { [deletedAt]: null },
              related: { [deletedAt]: null },
            },
            with: {},
            only: {
              root: { [deletedAt]: { not: null } },
              related: { [deletedAt]: null },
            },
          }),
          base.$schema
        ),
      },
      deletion: {
        removeWhen: { mode: "hard" }, // this call deletes physically
        models: perModel(
          config,
          ({ deletedAt, deletedBy }) => ({
            at: deletedAt, // receives the call's one timestamp
            assign: deletedBy ? { [deletedBy]: config.actor ?? null } : {},
          }),
          base.$schema
        ),
      },
    });
  // Step B: restore methods, typed against the client they are given, which
  // carries step A.
  const methods = <
    C extends VibORMConfig & {
      readonly schema: Record<Names<Config>, AnyModel>;
    },
    X extends ExtensionState,
  >(
    client: ClientTypeState<C, X> & NoInfer<VibORMClient<C, X>>
  ) => {
    const model: RestoreModels<typeof client, C, Config> = perModel(
      config,
      ({ deletedAt, deletedBy }) =>
        (delegate: { update: unknown; updateMany: unknown }) => {
          const data = {
            [deletedAt]: null,
            ...(deletedBy ? { [deletedBy]: null } : {}),
          };
          const update = delegate.update as (args: object) => never; // one cast
          const updateMany = delegate.updateMany as (args: object) => never; // one cast
          return {
            restore: (args: object) =>
              update({ ...args, data, deleted: "only" }),
            restoreMany: (args: object) =>
              updateMany({ ...args, data, deleted: "only" }),
          };
        }
    );
    return client.$extends({ name: "viborm.softDelete.restore", model });
  };
  const apply = <
    C extends VibORMConfig & {
      readonly schema: Record<Names<Config>, AnyModel>;
    },
    X extends ExtensionState & { readonly resultConsumer: undefined },
  >(
    base: ClientTypeState<C, X> & NoInfer<VibORMClient<C, X>>
  ) => methods(rows<C, X>(base));
  type Complete<Base> =
    Base extends ClientTypeState<
      infer C extends VibORMConfig & {
        readonly schema: Record<Names<Config>, AnyModel>;
      },
      infer X extends ExtensionState & { readonly resultConsumer: undefined }
    >
      ? Base extends VibORMClient<C, X>
        ? ReturnType<typeof apply<C, X>>
        : never
      : never;
  function extend<
    Base extends ClientTypeState<VibORMConfig, ExtensionState> & {
      readonly $schema: Record<Names<Config>, AnyModel>;
      readonly $extends: (...args: never[]) => unknown;
    },
  >(base: Base): NoInfer<Complete<Base>>;
  function extend<
    C extends VibORMConfig & {
      readonly schema: Record<Names<Config>, AnyModel>;
    },
    X extends ExtensionState & { readonly resultConsumer: undefined },
  >(base: ClientTypeState<C, X> & NoInfer<VibORMClient<C, X>>) {
    return apply(base);
  }
  // Give the factory one callable object type. Object.assign's inferred
  // function intersection loses the receiver when passed to generic `$extends`.
  // A type alias also lets declaration emit inline these local derived types.
  type Extension = {
    <
      Base extends ClientTypeState<VibORMConfig, ExtensionState> & {
        readonly $schema: Record<Names<Config>, AnyModel>;
        readonly $extends: (...args: never[]) => unknown;
      },
    >(
      base: Base
    ): NoInfer<Complete<Base>>;
    readonly rows: typeof rows;
    readonly methods: typeof methods;
  };
  const extension: Extension = Object.assign(extend, { rows, methods });
  return extension;
}
