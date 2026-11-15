/**
 * `defaultOmit(config)`: fields left out of every result unless a call asks
 * for them (`omit: { f: false }` or a `select`). One extension, applied in
 * one step: `client.$extends(defaultOmit({ user: { passwordHash: true } }))`.
 * Written with the public words: `defaults` and `omitted`. Its name is
 * fixed and a name is unique in a chain, so a chain applies it once; the
 * omissions of different extensions' `defaults` add up per model.
 */
import { ClientInitializationError } from "@errors";
import type {
  AnyTarget,
  EmptyFacts,
  Extension,
  Facts,
  Target,
} from "@extensions/contract";
import { defaults, omitted } from "@extensions/defaults";
import { extension } from "@extensions/extension";
import type { VibORMConfig } from "./client";
import type { ClientOmitConfig, ExactClientOmitConfig } from "./omit";
import type { ClientSchema } from "./schema-links";

const NAME = "viborm.defaultOmit";

type NoMethods = Record<never, never>;

/** No client: what an extension written apart from one is built against. */
type Untyped = Target<
  VibORMConfig<Record<never, never>>,
  AnyTarget["state"],
  EmptyFacts
>;

/**
 * What `defaultOmit(config)` adds: the fields it omits, per model of the
 * target (`Names`; a model it does not have is refused at its key already).
 */
type DefaultOmitFacts<Config, Names extends string = string> = Facts<
  NoMethods,
  NoMethods,
  NoMethods,
  never,
  never,
  NoMethods,
  { readonly [M in keyof Config & Names]: Config[M] }
>;

/** Leave fields out of every result by default. */
export function defaultOmit<T extends AnyTarget, const Config>(
  config: Config &
    ClientOmitConfig<ClientSchema<T["config"]>> &
    NoInfer<ExactClientOmitConfig<Config, ClientSchema<T["config"]>>>
): Extension<
  T,
  DefaultOmitFacts<Config, keyof ClientSchema<T["config"]> & string>
>;
export function defaultOmit(
  config: Readonly<Record<string, Readonly<Record<string, unknown>>>>
): unknown {
  const entries: Record<string, { fields: Record<string, typeof omitted> }> =
    {};
  for (const [model, fields] of Object.entries(config)) {
    const own: Record<string, typeof omitted> = {};
    for (const [field, value] of Object.entries(fields)) {
      if (value !== true)
        throw new ClientInitializationError(
          `Default omit configuration member "${model}.${field}" must be true.`
        );
      own[field] = omitted;
    }
    entries[model] = { fields: own };
  }
  // Built against no client: `defaultOmit`'s own signature types what it adds.
  return extension<Untyped>(
    NAME,
    defaults<Untyped, () => object>(() => entries)
  );
}
