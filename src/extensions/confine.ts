/**
 * `confine: within(where)`: what every row of a set a statement computes
 * over a whole table holds. The word brings what admits and binds it, so a
 * rule that confines nothing carries none of it.
 */
import type { PreparedSelector } from "@query-engine/raptor3/shared/query";
import type { RowDomain } from "@query-engine/raptor3/shared/row-scope";
import { type Input, memo } from "@query-engine/raptor3/shared/schema";
import type { AnyModel } from "@schema/model";
import type { AdmittedLayer, Confines } from "./admission";
import type { ConfineWord, HeldOperand, IsHeld } from "./contract";
import { Held } from "./judge-words";
import type { PreparedDomain } from "./row-domain";
import type { Site } from "./rule-words";

/**
 * What an `excluded` layer states its own whole-table sets of a model hold,
 * for one prepared domain: inside its own predicates a layer reads nothing
 * of itself, but a set the statement computes over a whole table (a shared
 * body, a reaching set) still holds only what it bounds. `undefined` where
 * none states one.
 */
function bound(domain: PreparedDomain) {
  const bounds = new Map<string, PreparedSelector | null>();
  return (
    model: AnyModel,
    excluded: readonly number[]
  ): PreparedSelector | undefined => {
    const name = model["~"].names.ts!;
    const inputs = domain.rows.confine?.get(name);
    if (inputs === undefined) return undefined;
    // Every excluded layer's: each only narrows, and one left out would let
    // another's widen what it bounds.
    return (
      memo(bounds, `${name} ${excluded}`, () =>
        domain.conjunction(
          model,
          excluded.map((layer) => {
            const input = inputs[layer];
            return [layer, input === undefined ? [] : [input]] as const;
          })
        )
      ) ?? undefined
    );
  };
}

const CONFINES: Confines = {
  admit: ({ admit }, written, references) =>
    Object.fromEntries(
      Object.entries(written).map(([name, where]) => [
        name,
        admit(name, `${name}.confine`, where, references),
      ])
    ),
  bind(layers: readonly AdmittedLayer[]): Partial<RowDomain> {
    const confine = new Map<string, Input[]>();
    for (const [layer, member] of layers.entries())
      for (const [model, where] of Object.entries(member.confine ?? {}))
        memo(confine, model, () => [])[layer] = where;
    return { confine, bound };
  },
};

/** `within(where)`'s value: what a model's whole-table sets hold. */
class Within extends Held<object> {
  join({ key, model, schema, lazy, layer, refuse }: Site): void {
    // An entry given lazily is admitted after its layer's confinements.
    if (key !== "confine" || lazy)
      refuse(`${lazy ? "a lazy entry" : key} does not take within()`);
    // The model's own columns: a confinement reads no relation, so lowering
    // it never builds another set it would confine in turn.
    const { scalars } = schema[model]!["~"].state;
    for (const field of Object.keys(this.held))
      if (!Object.hasOwn(scalars, field))
        refuse(`confine names "${field}", which is not a scalar field`);
    (layer!.confine ??= {})[model] = this.held;
    (layer!.brings ??= {}).confines = CONFINES;
  }
}

/**
 * Every row of a set computed over the model's whole table holds `where`, a
 * filter of the model's own columns: `confine: within(where)`.
 */
export function within<W>(
  where: HeldOperand<W>
): IsHeld<W> extends true ? ConfineWord<never> : ConfineWord<W>;
export function within(where: object): unknown {
  return new Within(where);
}
