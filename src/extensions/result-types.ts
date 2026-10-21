/**
 * The types of `result` (computed fields): what a definition may declare,
 * what it contributes to the chain's type state, and the fields one model
 * gains. Type-only; the runtime is `./result.ts`.
 */

import type { VibORMConfig } from "@client/client";
import type { InferModelOutput } from "@client/result-types";
import type { ClientSchema } from "@client/schema-links";
import type { Model } from "@schema/model";

type AllModels = "$allModels";

/** `Base` with `Over`'s members replacing its own. */
type Override<Base, Over> = [keyof Over] extends [never]
  ? Base
  : [keyof Base] extends [never]
    ? Over
    : Omit<Base, keyof Over> & Over;

type FieldsAt<Result, Key> = Key extends keyof Result ? Result[Key] : unknown;

/**
 * The fields one model gains, with their types: `$allModels` first, the
 * model's own after it, as the runtime orders them.
 */
export type ModelResultFields<Result, ModelName> = Override<
  FieldsAt<Result, AllModels> & {},
  FieldsAt<Result, ModelName> & {}
>;

/**
 * Each declared field's type: what its `compute` returns. A definition
 * without `result` contributes `Record<never, never>`, spelled out rather
 * than through a local alias: a consumer's declaration emit prints this type
 * inside every extended client's state, and a name no public entry exports
 * would make that client unnameable there (TS2742).
 */
export type DefinitionResultFields<Definition> = Definition extends {
  readonly result: infer Declared;
}
  ? Declared extends object
    ? {
        readonly [ModelName in keyof Declared]: {
          -readonly [Field in keyof Declared[ModelName]]: Declared[ModelName][Field] extends {
            compute(...args: never[]): infer Value;
          }
            ? Value
            : never;
        };
      }
    : Record<never, never>
  : Record<never, never>;

/** The chain's fields with a later extension's: it wins a name. */
export type MergeResultFields<Previous extends object, Next extends object> = [
  keyof Next,
] extends [never]
  ? Previous
  : [keyof Previous] extends [never]
    ? Next
    : {
        readonly [ModelName in keyof Previous | keyof Next]: Override<
          FieldsAt<Previous, ModelName> & {},
          FieldsAt<Next, ModelName> & {}
        >;
      };

/** The row a model's `compute` reads from: its scalars and earlier fields. */
type ComputeRow<M, Earlier> =
  M extends Model<infer State>
    ? Override<InferModelOutput<State>, Earlier>
    : never;

/** The keys a `needs` map asks for. */
type NeededKeys<Needs> = Needs extends object
  ? {
      [Key in keyof Needs]: Needs[Key] extends false ? never : Key;
    }[keyof Needs]
  : never;

/** The row one model's `compute` reads, before `needs` narrows it. */
type ComputeRowOf<
  C extends VibORMConfig,
  Earlier extends object,
  ModelName,
> = ModelName extends keyof ClientSchema<C>
  ? ComputeRow<
      ClientSchema<C>[ModelName],
      ModelResultFields<Earlier, ModelName>
    >
  : never;

/**
 * The `result` member as `$extends` and `defineExtension` type it. `Fields`
 * is its own type parameter, inferred from each field's `needs`, so that
 * each `compute` is given exactly the fields its `needs` names, typed from
 * the model: reading one it does not name is a compile error, as it would be
 * `undefined` at runtime, and a need the model lacks is refused. The
 * definition's own type parameter cannot carry this: a definition holding a
 * `compute` not yet typed is not inferred from at all. The shapes are
 * written inline, not through an interface, which TypeScript does not infer
 * through.
 */
export type ResultInference<
  C extends VibORMConfig,
  Earlier extends object,
  Fields,
> = {
  readonly result?: {
    readonly [ModelName in keyof Fields]: ModelName extends "$allModels"
      ? {
          readonly [Field in keyof Fields[ModelName]]: {
            readonly needs?: Fields[ModelName][Field] &
              Readonly<Record<string, boolean>>;
            compute(
              row: {
                readonly [Key in NeededKeys<Fields[ModelName][Field]>]: unknown;
              }
            ): unknown;
          };
        }
      : {
          readonly [Field in keyof Fields[ModelName]]: {
            readonly needs?: Fields[ModelName][Field] &
              Readonly<
                Record<
                  Exclude<
                    keyof Fields[ModelName][Field],
                    keyof ComputeRowOf<C, Earlier, ModelName>
                  >,
                  never
                >
              > & {
                readonly [Key in keyof ComputeRowOf<
                  C,
                  Earlier,
                  ModelName
                >]?: boolean;
              };
            compute(
              row: Pick<
                ComputeRowOf<C, Earlier, ModelName>,
                Extract<
                  NeededKeys<Fields[ModelName][Field]>,
                  keyof ComputeRowOf<C, Earlier, ModelName>
                >
              >
            ): unknown;
          };
        };
  } & Readonly<
    Record<Exclude<keyof Fields, keyof ClientSchema<C> | "$allModels">, never>
  >;
};

/**
 * The `result` member of the definition envelope: which keys it holds. The
 * types of `needs` and `compute` are {@link ResultInference}'s.
 */
export type ResultDefinition<C extends VibORMConfig> = {
  readonly [ModelName in keyof ClientSchema<C> | "$allModels"]?: {
    readonly [field: string]: {
      readonly needs?: object;
      readonly compute: unknown;
    };
  };
};
