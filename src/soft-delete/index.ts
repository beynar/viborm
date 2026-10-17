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

type Governed<Config extends SoftDeleteConfig> = VibORMConfig & {
  readonly schema: Record<Names<Config>, AnyModel>;
};
// A rows step goes before every result-consuming step.
type BeforeConsumers = ExtensionState & { readonly resultConsumer: undefined };

// Step A: controls, rows and deletion, checked against base's schema.
function rowsStep<
  Config extends SoftDeleteConfig,
  C extends Governed<Config>,
  X extends BeforeConsumers,
>(config: Config, base: VibORMClient<C, X>) {
  return base.$extends({
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
}

// Step B: restore methods, typed against the client they are given, which
// carries step A.
function methodsStep<
  Config extends SoftDeleteConfig,
  C extends Governed<Config>,
  X extends ExtensionState,
>(config: Config, client: VibORMClient<C, X>) {
  const model: RestoreModels<VibORMClient<C, X>, C, Config> = perModel(
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
          restore: (args: object) => update({ ...args, data, deleted: "only" }),
          restoreMany: (args: object) =>
            updateMany({ ...args, data, deleted: "only" }),
        };
      }
  );
  return client.$extends({ name: "viborm.softDelete.restore", model });
}

// A step takes its receiver whole and reads its C and X once from
// ClientTypeState, so `$extends(step)` never infers them against a generic
// client. The result names the step's own return type: declarations reference
// one instantiation instead of inlining its definition per use (each inline
// copy a distinct type, compared member by member: TS2589 from 25 models).
type Receiver<Config extends SoftDeleteConfig> = ClientTypeState<
  VibORMConfig,
  ExtensionState
> & {
  readonly $schema: Record<Names<Config>, AnyModel>;
  readonly $extends: (...args: never[]) => unknown;
};
type Rowed<
  Config extends SoftDeleteConfig,
  Base,
> = Base extends ClientTypeState<
  infer C extends Governed<Config>,
  infer X extends BeforeConsumers
>
  ? Base extends VibORMClient<C, X>
    ? ReturnType<typeof rowsStep<Config, C, X>>
    : never
  : never;
type Restorable<
  Config extends SoftDeleteConfig,
  Base,
> = Base extends ClientTypeState<
  infer C extends Governed<Config>,
  infer X extends ExtensionState
>
  ? Base extends VibORMClient<C, X>
    ? ReturnType<typeof methodsStep<Config, C, X>>
    : never
  : never;
// The whole factory's NoInfer keeps `$extends(softDelete(config))` from
// inferring between two client types (which measures the client alias's
// variance, ~650k instantiations once per program). The steps go without: a
// step written over `VibORMClient<C, X>` infers C and X from their result.
type SoftDeleteExtension<Config extends SoftDeleteConfig> = {
  <Base extends Receiver<Config>>(
    base: Base
  ): NoInfer<Restorable<Config, Rowed<Config, Base>>>;
  readonly rows: <Base extends Receiver<Config>>(
    base: Base
  ) => Rowed<Config, Base>;
  readonly methods: <Base extends Receiver<Config>>(
    client: Base
  ) => Restorable<Config, Base>;
};

// Every `rows` step of a chain goes before every method step (a method typed
// against a client whose rows a later step widens would lie), so the entry
// is both steps, `softDelete(config)(base)`, and each alone: `rows` and
// `methods`, to apply around another entry's steps.
export function softDelete<const Config extends SoftDeleteConfig>(
  config: Config
): SoftDeleteExtension<Config> {
  function rows<Base extends Receiver<Config>>(base: Base): Rowed<Config, Base>;
  function rows<C extends Governed<Config>, X extends BeforeConsumers>(
    base: VibORMClient<C, X>
  ) {
    return rowsStep(config, base);
  }
  function methods<Base extends Receiver<Config>>(
    client: Base
  ): Restorable<Config, Base>;
  function methods<C extends Governed<Config>, X extends ExtensionState>(
    client: VibORMClient<C, X>
  ) {
    return methodsStep(config, client);
  }
  function extend<Base extends Receiver<Config>>(
    base: Base
  ): NoInfer<Restorable<Config, Rowed<Config, Base>>>;
  function extend<C extends Governed<Config>, X extends BeforeConsumers>(
    base: VibORMClient<C, X>
  ) {
    return methodsStep(config, rowsStep(config, base));
  }
  return Object.assign(extend, { rows, methods });
}
