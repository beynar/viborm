/**
 * `fields({ [model | "$allModels"]: { [field]: { needs, compute } } })`:
 * fields computed from the columns each row a call returns reads. A part of
 * its own: an extension that does not import it carries none of it.
 */
import type { AnyTarget, Facts, Part } from "./contract";
import type { NoControls } from "./controls";
import { builtPart } from "./extension";
import {
  type ComputedFieldDeclaration,
  resultPart,
  snapshotResult,
} from "./result";
import type { DefinitionResultFields, ResultInference } from "./result-types";

type NoMethods = Record<never, never>;

/** Fields computed from the columns each returned row reads. */
export function fields<
  T extends AnyTarget,
  const Declared extends object = object,
  Needs = unknown,
>(
  fields: Declared &
    NonNullable<
      ResultInference<T["config"], T["state"]["result"], Needs>["result"]
    >
): Part<
  T,
  Facts<
    NoMethods,
    NoMethods,
    NoControls,
    never,
    never,
    DefinitionResultFields<{ readonly result: Declared }>
  >
>;
export function fields(
  declared: Readonly<
    Record<string, Readonly<Record<string, ComputedFieldDeclaration>>>
  >
): unknown {
  return builtPart([resultPart], (draft, schema) => {
    const own = snapshotResult(declared, draft.name, schema);
    const result: Record<string, object> = { ...draft.result };
    for (const [model, entries] of Object.entries(own))
      result[model] = Object.freeze({ ...result[model], ...entries });
    draft.result = Object.freeze(result) as typeof own;
  });
}
