/**
 * A call's row domain as prepared meaning, and the call's scope built from
 * it: what an extension's `rows` declarations answer where the engine asks
 * which rows a call may take. What judges the rows a write produces and what
 * a read may carry (`verbs`, `evidence`, `reads`) are the domain's `judge` and
 * `project`, made by what reads the verbs: this module does not hold them, so
 * a program whose extensions only filter rows does not either. The engine
 * names these questions and knows no declaration: this module is loaded with
 * the extensions that declare one.
 */

import { UnsupportedOperationError } from "@errors";
import {
  freeze,
  NO_LAYERS,
  type PreparedPredicate,
  type PreparedSelector,
  type Queries,
} from "@query-engine/raptor3/shared/query";
import type {
  CallRows,
  CallScope,
  ModelVerbs,
  RowDomain,
  RowJudgement,
  RowPurpose,
} from "@query-engine/raptor3/shared/row-scope";
import { type Input, memo } from "@query-engine/raptor3/shared/schema";
import type { Membership } from "@query-engine/raptor3/shared/storage";
import type { AnyModel } from "@schema/model";
import type { Judge } from "./judge";
import { layerOf } from "./layers";
import type { Projection } from "./projection";

/**
 * One row domain as prepared meaning: per purpose and model, the conjunction
 * of the model's inputs, each a {@link PreparedPredicate} `layer` node,
 * prepared at most once for every `Queries` of one engine view (its reads and
 * its write contexts share it) and for every call: a value a call supplies is
 * a parameter. A layer's node holds its verb predicates beside its purpose's
 * (R2), each input prepared once whatever purposes and verbs reuse it.
 * Prepared meaning holds no alias, adapter or driver, so the view's own
 * `Queries` prepares it.
 */
export class PreparedDomain {
  readonly rows: RowDomain;
  /** The domain absent controls select: what a layer's traversals read (R5). */
  readonly defaults: PreparedDomain;
  /** The view that prepares this domain's predicates. */
  readonly queries: Queries;
  readonly #prepared = {
    root: new Map<string, PreparedSelector | null>(),
    related: new Map<string, PreparedSelector | null>(),
  };
  readonly #inputs = new Map<Input, PreparedSelector>();
  readonly #bounds = new Map<string, PreparedSelector | null>();
  /** What judges the rows a write produces: where some model's verbs judge them. */
  readonly judge: Judge | undefined;
  /** What a read carries and hides beside the rows: where some model's verbs say. */
  readonly project: Projection | undefined;
  #view: Queries | undefined;
  constructor(rows: RowDomain, queries: Queries, defaults?: PreparedDomain) {
    this.rows = rows;
    this.queries = queries;
    this.defaults = defaults ?? this;
    this.judge = rows.judge?.(this);
    this.project = rows.project?.(this);
  }
  /** `input`, one of `model`'s predicates, prepared once for this domain. */
  prepare(model: AnyModel, input: Input): PreparedSelector {
    return memo(this.#inputs, input, () =>
      this.queries.prepareSelector(model, input)
    );
  }
  /**
   * The conjunction of what `layers` state of `model`, each layer by its
   * place in the chain: a layer's inputs ANDed and marked as that layer's
   * node, then the layers ANDed. `null` where no layer states one. With
   * `reading`, a layer whose inputs read no row is left out: it judges
   * nothing.
   */
  conjunction(
    model: AnyModel,
    layers: Iterable<readonly [layer: number, inputs: readonly Input[]]>,
    reading = false
  ): PreparedSelector | null {
    const name = model["~"].names.ts!;
    const queries = this.queries;
    const parts: PreparedSelector[] = [];
    for (const [layer, inputs] of layers) {
      if (inputs.length === 0) continue;
      const wheres = inputs.map((input) => this.prepare(model, input));
      const part =
        wheres.length === 1 ? wheres[0]! : queries.andSelectors(model, wheres);
      if (part.predicate !== undefined)
        parts.push(
          freeze({ ...part, predicate: layerOf(layer, name, part.predicate) })
        );
      else if (!reading) parts.push(part);
    }
    if (parts.length === 0) return null;
    return parts.length === 1 ? parts[0]! : queries.andSelectors(model, parts);
  }
  /**
   * The read view under this domain for `call`: one for every call, whose
   * lifetime is the domain's, unless the call carries the values its
   * parameters read.
   */
  reads(call: CallScope): Queries {
    return call.rows.values === undefined
      ? (this.#view ??= this.queries.under(this))
      : this.queries.under(this, call);
  }
  /**
   * `model`'s predicate for `purpose` without the `excluded` layers, and,
   * under a `judgement`, each layer's predicates of its verb: `delete`'s, or
   * one per field an update writes (that field's own, else `update`'s), or
   * `update`'s when it writes none (R3). `undefined` where it states none.
   */
  selector(
    model: AnyModel,
    purpose: RowPurpose,
    excluded = NO_LAYERS,
    judgement?: RowJudgement
  ): PreparedSelector | undefined {
    const name = model["~"].names.ts!;
    const verbs = this.rows.verbs?.get(name);
    const judged = verbs && judgement;
    // The plain key allocates nothing: a read takes it at every lookup.
    const key = judged
      ? `${name} ${excluded} ${judged.verb}${judged.marks ? "+" : ""} ${[...judged.writes].sort()}`
      : excluded.length === 0
        ? name
        : `${name} ${excluded}`;
    let prepared = this.#prepared[purpose].get(key);
    if (prepared === undefined)
      prepared = memo(this.#prepared[purpose], key, () => {
        const inputs = this.rows[purpose].get(name);
        if (inputs === undefined && verbs === undefined) return null;
        const layers: (readonly [number, Input[]])[] = [];
        const count = Math.max(inputs?.length ?? 0, verbs?.length ?? 0);
        for (let layer = 0; layer < count; layer++) {
          if (excluded.includes(layer)) continue;
          const own = verbs?.[layer];
          const where = inputs?.[layer];
          layers.push([
            layer,
            [
              ...(own ? [own.read] : []),
              ...(where === undefined ? [] : [where]),
              ...(own && judged ? verbInputs(own, judged) : []),
            ],
          ]);
        }
        return this.conjunction(model, layers);
      });
    return prepared ?? undefined;
  }
  /**
   * What an `excluded` layer states its own whole-table sets of `model` hold
   * (`rows.confine`): inside its own predicates a layer reads nothing of
   * itself, but a set the statement computes over a whole table (a shared
   * body, a reaching set) still holds only what it bounds. `undefined` where
   * none states one.
   */
  bound(
    model: AnyModel,
    excluded: readonly number[]
  ): PreparedSelector | undefined {
    const name = model["~"].names.ts!;
    const inputs = this.rows.confine?.get(name);
    if (inputs === undefined) return undefined;
    // Every excluded layer's: each only narrows, and one left out would let
    // another's widen what it bounds.
    return (
      memo(this.#bounds, `${name} ${excluded}`, () =>
        this.conjunction(
          model,
          excluded.map((layer) => {
            const input = inputs[layer];
            return [layer, input === undefined ? [] : [input]] as const;
          })
        )
      ) ?? undefined
    );
  }
  /** Whether a call's `purpose` domain of `model` can leave a row out. */
  #hidesRows(queries: Queries, model: AnyModel, purpose: RowPurpose): boolean {
    const holds = (predicate: PreparedPredicate): boolean => {
      if (predicate.kind === "layer") {
        const resolved = predicate.resolve(queries);
        return resolved === undefined || holds(resolved);
      }
      if (predicate.kind === "and") return predicate.predicates.every(holds);
      return predicate.kind === "always" && predicate.value;
    };
    const domain = queries.domainOf(model, purpose);
    return domain?.predicate !== undefined && !holds(domain.predicate);
  }
  /**
   * Whether a call's extensions judge writes to a junction model: its rows,
   * its verbs. A link is written with neither read nor judged, so a `$through`
   * write through it is refused where a direct write would have been judged.
   */
  restrictsLinkWrite(queries: Queries, model: AnyModel): boolean {
    return (
      this.#hidesRows(queries, model, "root") ||
      this.#hidesRows(queries, model, "related") ||
      this.rows.verbs
        ?.get(model["~"].names.ts!)
        ?.some((verbs) => verbs !== undefined) === true
    );
  }
  /**
   * What a direct read of the junction model would hide stays hidden from a
   * `$through` that reads it, or that tests it, which is the same disclosure one
   * row at a time. Not honoured in the statement: a target row the hop reached
   * has no faithful answer for a link its reader may not see, so the call is
   * refused before any statement.
   */
  refuseHiddenLinkRow(
    queries: Queries,
    edge: Membership,
    fields: readonly string[],
    use: "read" | "filter"
  ): void {
    const model = (edge as Extract<Membership, { kind: "junction" }>).declared!
      .model;
    const name = model["~"].names.ts;
    if (
      this.#hidesRows(queries, model, "root") ||
      this.#hidesRows(queries, model, "related")
    )
      throw new UnsupportedOperationError(
        `Cannot ${use} $through of relation '${edge.name}': this client restricts which '${name}' rows a call may read. Read the links through the '${name}' delegate.`
      );
    const gates = queries.domain?.project?.projected(model)?.gates;
    const gated = gates && fields.find((field) => gates.has(field));
    if (gated !== undefined)
      throw new UnsupportedOperationError(
        `Cannot ${use} $through.${gated} of relation '${edge.name}': this client gates that field of '${name}'. Read it through the '${name}' delegate.`
      );
  }
}
/** The verb predicates one layer's `judgement` takes, each once. */
export function verbInputs(
  verbs: ModelVerbs,
  judgement: RowJudgement
): Input[] {
  if (judgement.verb === "delete") return [verbs.delete];
  if (judgement.writes.length === 0) return [verbs.update];
  return [
    ...new Set([
      ...judgement.writes.map(
        (field) => verbs.writes.get(field) ?? verbs.update
      ),
      ...(judgement.marks ? [verbs.delete] : []),
    ]),
  ];
}

/**
 * Each row domain a call selects, prepared once per query owner. A prepared
 * domain derives only from the domain, that owner (its adapter and result
 * parser) and its defaults, so clients sharing the owner share it too. The
 * domain alone keys it: a chain's binding builds each domain with its one
 * default domain.
 */
const preparedDomains = new WeakMap<
  Queries,
  WeakMap<RowDomain, PreparedDomain>
>();

function preparedDomain(
  queries: Queries,
  rows: RowDomain,
  defaults?: PreparedDomain
): PreparedDomain {
  const byDomain = memo(preparedDomains, queries, () => new WeakMap());
  return memo(
    byDomain,
    rows,
    () => new PreparedDomain(rows, queries, defaults)
  );
}

/** One call's row facts as the engine reads them: its domains prepared for `queries`. Stated on every {@link CallRows}. */
export function prepareCall(
  this: CallRows,
  queries: Queries,
  instant: () => Date
): CallScope {
  const defaults = preparedDomain(queries, this.defaults);
  return {
    rows: this,
    domain: preparedDomain(queries, this.domain, defaults),
    defaults,
    instant,
  };
}
