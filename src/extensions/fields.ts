/**
 * `fields({ [model | "$allModels"]: { [field]: { needs, compute } } })`:
 * fields computed from the columns each row a call returns reads. A part of
 * its own: an extension that does not import it carries none of it.
 */
import type {
  AnyTarget,
  Facts,
  ModelName,
  NoArguments,
  Part,
} from "./contract";
import { type ComputedFieldDeclaration, fieldsPart } from "./result";
import type { ComputedFieldTypes, FieldsInference } from "./result-types";

type NoMethods = Record<never, never>;

/** Fields computed from the columns each returned row reads. */
export function fields<
  T extends AnyTarget,
  const Declared extends object = object,
  Needs = unknown,
>(
  fields: Declared & FieldsInference<T["config"], T["state"]["fields"], Needs>
): Part<
  T,
  Facts<
    NoMethods,
    NoMethods,
    NoArguments,
    never,
    never,
    ComputedFieldTypes<
      Pick<Declared, Extract<keyof Declared, ModelName<T> | "$allModels">>
    >
  >
>;
export function fields(
  declared: Readonly<
    Record<string, Readonly<Record<string, ComputedFieldDeclaration>>>
  >
): unknown {
  return fieldsPart(declared);
}
