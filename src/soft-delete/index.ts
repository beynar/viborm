// viborm/soft-delete: the entire extension.

import type { OperationPayload } from "../client/exports"; // public today
import { ClientInitializationError } from "../errors"; // viborm's own class
import type {
  ClientSchema,
  ClientTypeState,
  DelegateOperationResult,
  ExtensionState,
  PendingOperation,
  VibORMClient,
  VibORMConfig,
} from "../index";

export interface SoftDeleteModel {
  readonly deletedAt: string; // a nullable DateTime field of this model
  readonly deletedBy?: string; // optional scalar field for the actor
}
export interface SoftDeleteConfig {
  readonly models: Readonly<Record<string, SoftDeleteModel>>;
  readonly actor?: string | number | bigint; // bound per derived client
}
type Schema = VibORMConfig["schema"];
type AnyModel = Schema[string];
type Names<Config extends SoftDeleteConfig> = keyof Config["models"] & string;

const NAME = "viborm.softDelete";

// One value per configured model, keys kept: the methods are typed from
// them. The cast is TypeScript's own limit: Object.fromEntries forgets keys.
function perModel<
  Config extends SoftDeleteConfig,
  T,
  S extends Schema = Schema,
>(config: Config, build: (m: SoftDeleteModel) => T, _schema?: S) {
  return Object.fromEntries(
    Object.entries(config.models).map(([k, m]) => [k, build(m)])
  ) as { readonly [K in Names<Config> & keyof S]: T };
}

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
// field. A type alias, not an interface: a method record.
type Methods<C extends VibORMConfig, K> = {
  restore<Self, A extends RestoreArgs<C, K, "update">>(
    this: Self,
    args: NoExtra<A, RestoreArgs<C, K, "update">>
  ): PendingOperation<DelegateOperationResult<Self, "update", A>>;
  restoreMany<Self, A extends RestoreArgs<C, K, "updateMany">>(
    this: Self,
    args: NoExtra<A, RestoreArgs<C, K, "updateMany">>
  ): PendingOperation<DelegateOperationResult<Self, "updateMany", A>>;
  purge<Self, A extends ArgsOf<C, K, "delete">>(
    this: Self,
    args: NoExtra<A, ArgsOf<C, K, "delete">>
  ): PendingOperation<DelegateOperationResult<Self, "delete", A>>;
  purgeMany<Self, A extends PurgeManyArgs<C, K> = PurgeManyArgs<C, K>>(
    this: Self,
    args?: NoExtra<A, PurgeManyArgs<C, K>>
  ): PendingOperation<DelegateOperationResult<Self, "deleteMany", A>>;
};

type Governed<Config extends SoftDeleteConfig> = VibORMConfig & {
  readonly schema: Record<Names<Config>, AnyModel>;
};

/**
 * Refuse a marker that is not a nullable, single DateTime field, before the
 * definition is applied (its rows predicates would refuse a required field
 * less clearly; a string field would fail at the first delete). A model or
 * field the schema lacks is left to core, which names it.
 */
function admitMarkers(schema: Schema, config: SoftDeleteConfig): void {
  for (const [name, { deletedAt }] of Object.entries(config.models)) {
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

// One definition: the `mode` control, the rows each `deleted` value
// selects, what a delete writes, and the methods, checked against base's
// schema. A factory takes its delegate as `never` (it reads nothing typed at
// this step), so later steps may add `rows` or `defaultOmit` freely.
function definitionOf<
  Config extends SoftDeleteConfig,
  C extends Governed<Config>,
>(config: Config, schema: ClientSchema<C>) {
  return {
    name: NAME,
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
        schema
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
        schema
      ),
    },
    model: perModel(
      config,
      ({ deletedAt, deletedBy }) =>
        (delegate: never) => {
          const data = {
            [deletedAt]: null,
            ...(deletedBy ? { [deletedBy]: null } : {}),
          };
          const {
            update,
            updateMany,
            delete: remove,
            deleteMany,
          } = delegate as Record<string, (args: object) => never>; // one cast
          // Tombstones only: `deleted: "only"` overrides a caller's value.
          const tombstones = { deleted: "only", mode: "hard" };
          return {
            restore: (args: object) =>
              update!({ ...args, data, deleted: "only" }),
            restoreMany: (args: object) =>
              updateMany!({ ...args, data, deleted: "only" }),
            purge: (args: object) => remove!({ ...args, ...tombstones }),
            purgeMany: (args: object = {}) =>
              deleteMany!({ ...args, ...tombstones }),
          };
        },
      schema
    ) as unknown as {
      readonly [K in Names<Config> & keyof ClientSchema<C>]: (
        delegate: never
      ) => Methods<C, K>;
    },
  } as const; // the literals `$extends` reads: names, modes, values
}

function apply<
  Config extends SoftDeleteConfig,
  C extends Governed<Config>,
  X extends ExtensionState,
>(config: Config, base: VibORMClient<C, X>) {
  admitMarkers(base.$schema, config);
  return base.$extends(definitionOf<Config, C>(config, base.$schema));
}

// The two steps a chain written before 1.8 applies around another entry's
// (`rows` then `methods`): the definition without its methods, and the
// methods alone, under the name they had.
function rowsStep<
  Config extends SoftDeleteConfig,
  C extends Governed<Config>,
  X extends ExtensionState,
>(config: Config, base: VibORMClient<C, X>) {
  const { model: _methods, ...rows } = definitionOf<Config, C>(
    config,
    base.$schema
  );
  admitMarkers(base.$schema, config);
  return base.$extends(rows);
}
function methodsStep<
  Config extends SoftDeleteConfig,
  C extends Governed<Config>,
  X extends ExtensionState,
>(config: Config, client: VibORMClient<C, X>) {
  const { model } = definitionOf<Config, C>(config, client.$schema);
  return client.$extends({ name: `${NAME}.restore`, model });
}

// A step takes its receiver whole and reads its C and X once from
// ClientTypeState, so `$extends(softDelete(config))` never infers them
// against a generic client. The result names the step's own return type:
// declarations reference one instantiation instead of inlining its
// definition per use (each inline copy a distinct type, compared member by
// member: TS2589 from 25 models).
type Receiver<Config extends SoftDeleteConfig> = ClientTypeState<
  VibORMConfig,
  ExtensionState
> & {
  readonly $schema: Record<Names<Config>, AnyModel>;
  readonly $extends: (...args: never[]) => unknown;
};
// A step with `rows` follows no result consumer: no factory typed against
// the client it extends (TypeScript's order rule; the official extensions'
// factories read nothing typed, so they never are one).
type BeforeConsumers<X extends ExtensionState, Client> = [
  X["resultConsumer"],
] extends [undefined]
  ? Client
  : never;
type Applied<
  Config extends SoftDeleteConfig,
  Base,
> = Base extends ClientTypeState<
  infer C extends Governed<Config>,
  infer X extends ExtensionState
>
  ? Base extends VibORMClient<C, X>
    ? BeforeConsumers<X, ReturnType<typeof apply<Config, C, X>>>
    : never
  : never;
type Rowed<
  Config extends SoftDeleteConfig,
  Base,
> = Base extends ClientTypeState<
  infer C extends Governed<Config>,
  infer X extends ExtensionState
>
  ? Base extends VibORMClient<C, X>
    ? BeforeConsumers<X, ReturnType<typeof rowsStep<Config, C, X>>>
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
// variance, ~650k instantiations once per program).
type SoftDeleteExtension<Config extends SoftDeleteConfig> = {
  <Base extends Receiver<Config>>(base: Base): NoInfer<Applied<Config, Base>>;
  /** The controls, rows and deletion alone (chains written before 1.8). */
  readonly rows: <Base extends Receiver<Config>>(
    base: Base
  ) => Rowed<Config, Base>;
  /** The methods alone (chains written before 1.8). */
  readonly methods: <Base extends Receiver<Config>>(
    client: Base
  ) => Restorable<Config, Base>;
};

/**
 * Keep deleted rows as tombstones: `client.$extends(softDelete({ models: {
 * post: { deletedAt: "deletedAt" } } }))`. One step, applied in any order
 * with the other extensions.
 */
export function softDelete<const Config extends SoftDeleteConfig>(
  config: Config
): SoftDeleteExtension<Config> {
  function extend<Base extends Receiver<Config>>(
    base: Base
  ): NoInfer<Applied<Config, Base>>;
  function extend<C extends Governed<Config>, X extends ExtensionState>(
    base: VibORMClient<C, X>
  ) {
    return apply(config, base);
  }
  function rows<Base extends Receiver<Config>>(base: Base): Rowed<Config, Base>;
  function rows<C extends Governed<Config>, X extends ExtensionState>(
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
  return Object.assign(extend, { rows, methods });
}
