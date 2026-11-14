/**
 * `methods((scope) => ({ $name: fn, model: { name: fn } }))`: functions added
 * to the client (a `$` name) and to the models (a model's name). One factory,
 * run once per view it serves, the first time one of its methods is read; a
 * model method is called with `this` equal to the delegate it is read from.
 *
 * The part writes the `client` and `model` members the methods host reads.
 */
import { isFunction } from "@validation/value-guards";
import type {
  AnyTarget,
  EmptyFacts,
  MethodsCheck,
  MethodsFacts,
  MethodsScope,
  ModelName,
  Part,
} from "./contract";
import { extensionError } from "./definition";
import { builtPart } from "./extension";
import { methodsPart } from "./methods";

type Methods = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Functions added to the client and to the models of the extension's chain. */
export function methods<
  T extends AnyTarget,
  F extends (scope: MethodsScope<T>) => MethodsCheck<ReturnType<F>, T> = (
    scope: MethodsScope<T>
  ) => object,
>(
  factory: F
): Part<
  T,
  MethodsFacts<
    ReturnType<F>,
    Parameters<F> extends readonly [] ? false : true,
    ModelName<T>
  >
>;
export function methods(factory: (scope: never) => unknown): unknown {
  return buildMethods(factory);
}

/**
 * `methods` untyped: what an official extension builds its methods with,
 * typed by its own entry point rather than by an inferred target.
 */
export function buildMethods(
  factory: (scope: never) => unknown
): Part<AnyTarget, EmptyFacts>;
export function buildMethods(factory: (scope: never) => unknown): unknown {
  if (!isFunction(factory))
    throw new TypeError("methods() takes a factory of the client's scope");
  return builtPart([methodsPart], (draft, schema) => {
    const { name } = draft;
    // One answer per scope: the client's methods and each model's come from it.
    const made = new WeakMap<object, Methods>();
    const run = (scope: object): Methods => {
      let answer = made.get(scope);
      if (answer === undefined) {
        // The scope is the view the factory is typed against by its builder.
        const returned: unknown = Reflect.apply(factory, undefined, [scope]);
        if (!isRecord(returned))
          extensionError(
            `Extension "${name}" methods factory must return an object.`,
            name
          );
        for (const key of Object.keys(returned))
          if (!(key.startsWith("$") || Object.hasOwn(schema, key)))
            extensionError(
              `Extension "${name}" methods returned "${key}", which is neither a $ client method nor a model.`,
              name
            );
        answer = returned;
        made.set(scope, answer);
      }
      return answer;
    };
    draft.client = (scope: object) =>
      Object.fromEntries(
        Object.entries(run(scope)).filter(([key]) => key.startsWith("$"))
      );
    draft.model = Object.fromEntries(
      Object.keys(schema).map((model) => [
        model,
        (delegate: object, scope: object) => {
          const given = run(scope)[model];
          // A model's entry may be a function of its delegate and the scope.
          const own: unknown = isFunction(given)
            ? Reflect.apply(given, undefined, [delegate, scope])
            : given;
          if (own === undefined) return {};
          if (!isRecord(own))
            extensionError(
              `Extension "${name}" methods.${model} must be an object of methods.`,
              name
            );
          return Object.fromEntries(
            Object.entries(own).map(([method, fn]) => [
              method,
              isFunction(fn)
                ? (...args: unknown[]) => Reflect.apply(fn, delegate, args)
                : fn,
            ])
          );
        },
      ])
    );
  });
}
