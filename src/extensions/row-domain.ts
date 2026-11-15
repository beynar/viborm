/**
 * A call's row domain as prepared meaning, and the call's scope built from
 * it: what an extension's rules answer where the engine asks which rows a
 * call may take. What judges the rows a write produces and what a read may
 * carry (the words `only`, `check`, `gate` and `facts`) are the domain's
 * `judge` and `project`, brought by those words: this module does not hold
 * them, so a program whose extensions only filter rows does not either. The engine
 * names these questions and knows no declaration: this module is loaded with
 * the extensions that declare one.
 */

import { UnsupportedOperationError } from "@errors";
import {
  NO_LAYERS,
  type PreparedPredicate,
  type PreparedSelector,
  type Queries,
} from "@query-engine/raptor3/shared/query";
import type {
  CallRows,
  CallScope,
  RowDomain,
  RowPurpose,
  WriteJudgement,
} from "@query-engine/raptor3/shared/row-scope";
import { type Input, memo } from "@query-engine/raptor3/shared/schema";
import type { Membership } from "@query-engine/raptor3/shared/storage";
import type { AnyModel } from "@schema/model";
import type { Judge } from "./judge";
import type { Projection } from "./projection";

/**
 * `predicate` as a layer resolved it, over a produced row a judgement lowers
 * over: what judges brought folds the values the write sets into it.
 */
export function overKnown(
  queries: Queries,
  alias: string | undefined,
  predicate: PreparedPredicate
): PreparedPredicate {
  const { known } = queries;
  return known !== undefined && alias === known.alias
    ? known.fold(predicate, known.nulls)
    : predicate;
}

/**
 * `predicate` as `model`'s domain predicate of `layer`, where it reads
 * nothing of its call: what it states, whatever the call.
 */
function plainLayer(
  layer: number,
  model: string,
  predicate: PreparedPredicate
): PreparedPredicate {
  return {
    kind: "layer",
    layer,
    model,
    predicate,
    resolve: (queries: Queries, alias?: string) =>
      overKnown(queries, alias, predicate),
  };
}

/** A domain no member confines bounds no set. */
const unbounded = (): undefined => undefined;

/**
 * What the engine and what judges or projects rows ask a call's prepared
 * domain. {@link FilterDomain} answers for a chain whose parts filter, keep or
 * judge rows; a chain that only orders and stamps rows answers with a domain
 * that filters nothing (`plain-domain.ts`).
 */
export interface PreparedDomain {
  readonly rows: RowDomain;
  /** The domain absent arguments select: what a layer's traversals read (R5). */
  readonly defaults: PreparedDomain;
  /** The view that prepares this domain's predicates. */
  readonly queries: Queries;
  /** What judges the rows a write produces: where some model's entry judges them. */
  readonly judge: Judge | undefined;
  /** What a read carries and hides beside the rows: where some model's entry says. */
  readonly project: Projection | undefined;
  prepare(model: AnyModel, input: Input): PreparedSelector;
  conjunction(
    model: AnyModel,
    layers: Iterable<readonly [layer: number, inputs: readonly Input[]]>
  ): PreparedSelector | null;
  reads(call: CallScope): Queries;
  selector(
    model: AnyModel,
    purpose: RowPurpose,
    excluded?: readonly number[],
    judgement?: WriteJudgement
  ): PreparedSelector | undefined;
  bound(
    model: AnyModel,
    excluded: readonly number[]
  ): PreparedSelector | undefined;
  restrictsLinkWrite(queries: Queries, model: AnyModel): boolean;
  refuseHiddenLinkRow(
    queries: Queries,
    edge: Membership,
    fields: readonly string[],
    use: "read" | "filter"
  ): void;
}

/**
 * One row domain as prepared meaning: per purpose and model, the conjunction
 * of the model's inputs, each a {@link PreparedPredicate} `layer` node,
 * prepared at most once for every `Queries` of one engine view (its reads and
 * its write contexts share it) and for every call: a value a call supplies is
 * a parameter. A layer's node holds its entry's predicates beside its purpose's
 * (R2), each input prepared once whatever purposes and entries reuse it.
 * Prepared meaning holds no alias, adapter or driver, so the view's own
 * `Queries` prepares it.
 */
export class FilterDomain implements PreparedDomain {
  readonly rows: RowDomain;
  readonly defaults: FilterDomain;
  readonly queries: Queries;
  readonly #prepared = {
    root: new Map<string, PreparedSelector | null>(),
    related: new Map<string, PreparedSelector | null>(),
  };
  readonly #inputs = new Map<Input, PreparedSelector>();
  /** What judges the rows a write produces: where some model's entry judges them. */
  readonly judge: Judge | undefined;
  readonly project: Projection | undefined;
  /**
   * What an `excluded` layer states its own whole-table sets of a model hold
   * (`rows.confine`): nothing where no member confines one.
   */
  readonly bound: ReturnType<NonNullable<RowDomain["bound"]>>;
  #view: Queries | undefined;
  /**
   * The domain read with each call's values, and its default twin of the
   * same class, made with it: where no argument has a default, itself.
   */
  constructor(rows: RowDomain, queries: Queries) {
    this.rows = rows;
    this.queries = queries;
    this.defaults = rows.defaults
      ? new new.target(rows.defaults, queries)
      : this;
    this.judge = rows.judge?.(this);
    this.project = rows.project?.(this);
    this.bound = rows.bound?.(this) ?? unbounded;
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
   * node, then the layers ANDed. `null` where no layer states one.
   */
  conjunction(
    model: AnyModel,
    layers: Iterable<readonly [layer: number, inputs: readonly Input[]]>
  ): PreparedSelector | null {
    const name = model["~"].names.ts!;
    const queries = this.queries;
    const layered = this.rows.layered ?? plainLayer;
    const parts: PreparedSelector[] = [];
    for (const [layer, inputs] of layers) {
      if (inputs.length === 0) continue;
      const wheres = inputs.map((input) => this.prepare(model, input));
      const part =
        wheres.length === 1 ? wheres[0]! : queries.andSelectors(model, wheres);
      // Every input prepares to a predicate: `{}` to an empty conjunction.
      parts.push({
        ...part,
        predicate: layered(layer, name, part.predicate!),
      });
    }
    if (parts.length === 0) return null;
    return parts.length === 1 ? parts[0]! : queries.andSelectors(model, parts);
  }
  /**
   * The read view under this domain for `call`: one for every call, whose
   * lifetime is the domain's, unless the call carries the values its
   * parameters read, which say which.
   */
  reads(call: CallScope): Queries {
    return (
      call.rows.values?.view?.(this, call) ??
      (this.#view ??= this.queries.under(this))
    );
  }
  /**
   * `model`'s predicate for `purpose` without the `excluded` layers, and,
   * under a `judgement`, what the layers' entries add for it (`entries.ts`).
   * `undefined` where it states none.
   */
  selector(
    model: AnyModel,
    purpose: RowPurpose,
    excluded = NO_LAYERS,
    judgement?: WriteJudgement
  ): PreparedSelector | undefined {
    const name = model["~"].names.ts!;
    const key = this.key(name, excluded, judgement);
    return (
      memo(this.#prepared[purpose], key, () =>
        this.conjunction(
          model,
          this.layers(name, this.rows[purpose].get(name), excluded, judgement)
        )
      ) ?? undefined
    );
  }
  /** The plain key allocates nothing: a read takes it at every lookup. */
  protected key(
    name: string,
    excluded: readonly number[],
    _judgement?: WriteJudgement
  ): string {
    return excluded.length === 0 ? name : `${name} ${excluded}`;
  }
  /** Each layer's inputs of a model, but the `excluded` layers'. */
  protected layers(
    _name: string,
    inputs: readonly Input[] | undefined,
    excluded: readonly number[],
    _judgement?: WriteJudgement
  ): (readonly [number, readonly Input[]])[] {
    const layers: (readonly [number, readonly Input[]])[] = [];
    for (const [layer, where] of (inputs ?? []).entries())
      if (where !== undefined && !excluded.includes(layer))
        layers.push([layer, [where]]);
    return layers;
  }
  /** Whether a call's domain of `model`, root or related, can leave a row out. */
  #hidesRows(queries: Queries, model: AnyModel): boolean {
    const holds = (predicate: PreparedPredicate): boolean => {
      if (predicate.kind === "layer") {
        const resolved = predicate.resolve(queries);
        return resolved === undefined || holds(resolved);
      }
      if (predicate.kind === "and") return predicate.predicates.every(holds);
      return predicate.kind === "always" && predicate.value;
    };
    return (["root", "related"] as const).some((purpose) => {
      const domain = queries.domainOf(model, purpose);
      return domain?.predicate !== undefined && !holds(domain.predicate);
    });
  }
  /**
   * Whether a call's extensions judge writes to a junction model: its rows,
   * and its entries where some word brought them (`entries.ts`). A link is
   * written with neither read nor judged, so a `$through` write through it
   * is refused where a direct write would have been judged.
   */
  restrictsLinkWrite(queries: Queries, model: AnyModel): boolean {
    return this.#hidesRows(queries, model);
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
    // Only a junction membership reaches a declared junction model here.
    const model = (edge as Extract<Membership, { kind: "junction" }>).declared!
      .model;
    const name = model["~"].names.ts;
    if (this.#hidesRows(queries, model))
      throw new UnsupportedOperationError(
        `Cannot ${use} $through of relation '${edge.name}': '${name}' rows are restricted here; read the links through the '${name}' delegate.`
      );
    this.project?.refuseGatedLink(edge, model, fields, use);
  }
}
/**
 * Each row domain a call selects, prepared once per query owner. A prepared
 * domain derives only from the domain and that owner (its adapter and result
 * parser), so clients sharing the owner share it too.
 */
const preparedDomains = new WeakMap<
  Queries,
  WeakMap<RowDomain, FilterDomain>
>();

/**
 * What prepares one call's row facts as the engine reads them, with
 * `Domain`: its domains prepared for `queries`. Stated on every
 * {@link CallRows}. The default domain is the call's own where the call
 * passed every argument with a default at its default.
 */
export const preparer = (Domain: typeof FilterDomain) =>
  function prepare(
    this: CallRows,
    queries: Queries,
    instant: () => Date
  ): CallScope {
    const domain = memo(
      memo(preparedDomains, queries, () => new WeakMap()),
      this.domain,
      () => new Domain(this.domain, queries)
    );
    return {
      rows: this,
      domain,
      defaults: this.values?.defaults ? domain.defaults : domain,
      instant,
    };
  };

/** What prepares the call facts of a chain whose rules only filter. */
export const prepareCall = /* @__PURE__ */ preparer(FilterDomain);
