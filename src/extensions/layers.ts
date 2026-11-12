/**
 * A layer of a row domain as the engine lowers it: what its predicate is for
 * one call. Its conditions fold per call, a value it still reads that is
 * absent makes it false where its control is required and drops it otherwise
 * (R6), and over a produced row the nullness the write states folds into it.
 * The engine asks a layer what it resolves to; this module, loaded with the
 * extensions that declare row domains, answers.
 */
import {
  freeze,
  mergeQuantifiers,
  type PreparedPredicate,
  type Queries,
  VACUOUS_FALSE,
} from "@query-engine/raptor3/shared/query";
import {
  type Condition,
  Parameter,
} from "@query-engine/raptor3/shared/row-scope";

/** A layer's predicate under one outcome of its conditions. */
interface Folded {
  readonly predicate: PreparedPredicate;
  /** The parameters it still reads, `spread` where one is a whole list. */
  readonly parameters: readonly (readonly [Parameter, boolean])[];
}
const ALWAYS_TRUE: PreparedPredicate = freeze({ kind: "always", value: true });
/**
 * `predicate` with the leaves `known` answers for replaced by their outcome
 * and the logical combinators simplified, so a false arm goes with every
 * parameter inside it. `deep` folds the body of a relation too, which keeps
 * its quantifier: for an outcome that holds whatever row is read.
 */
function fold(
  predicate: PreparedPredicate,
  known: (leaf: PreparedPredicate) => boolean | undefined,
  deep: boolean
): PreparedPredicate {
  switch (predicate.kind) {
    case "condition":
    case "operation": {
      const outcome = known(predicate);
      if (outcome === undefined) return predicate;
      return outcome ? ALWAYS_TRUE : VACUOUS_FALSE;
    }
    case "and":
    case "or": {
      const conjunction = predicate.kind === "and";
      const kept: PreparedPredicate[] = [];
      for (const member of predicate.predicates) {
        const folded = fold(member, known, deep);
        if (folded.kind !== "always") kept.push(folded);
        else if (folded.value !== conjunction) return folded;
      }
      if (kept.length === 0) return conjunction ? ALWAYS_TRUE : VACUOUS_FALSE;
      if (
        kept.length === predicate.predicates.length &&
        kept.every((member, index) => member === predicate.predicates[index])
      )
        return predicate;
      // A dropped arm may have held two quantifiers over one relation apart.
      const merged = deep ? mergeQuantifiers(predicate.kind, kept) : undefined;
      return merged?.length === 1 && !conjunction
        ? merged[0]!
        : freeze({ kind: predicate.kind, predicates: freeze(merged ?? kept) });
    }
    case "not": {
      const folded = fold(predicate.predicate, known, deep);
      if (folded.kind === "always")
        return folded.value ? VACUOUS_FALSE : ALWAYS_TRUE;
      return folded === predicate.predicate
        ? predicate
        : freeze({ kind: "not", predicate: folded });
    }
    case "relation":
    case "exists": {
      if (!(deep && predicate.predicate)) return predicate;
      const folded = fold(predicate.predicate, known, deep);
      // No row matches a false body; a true one still needs a row to exist.
      if (
        predicate.kind === "exists" &&
        folded.kind === "always" &&
        !folded.value
      )
        return VACUOUS_FALSE;
      if (folded === predicate.predicate) return predicate;
      if (predicate.kind === "relation")
        return freeze({ ...predicate, predicate: folded });
      return freeze({
        kind: "exists",
        model: predicate.model,
        lower: predicate.lower,
        ...(folded.kind !== "always" && { predicate: folded }),
      });
    }
    default:
      return predicate;
  }
}
/** `predicate` with every condition replaced by its outcome. */
const foldConditions = (
  predicate: PreparedPredicate,
  holds: (condition: Condition) => boolean
): PreparedPredicate =>
  fold(
    predicate,
    (leaf) => (leaf.kind === "condition" ? holds(leaf.condition) : undefined),
    true
  );
/**
 * `predicate` over a produced row whose fields' nullness the write states
 * (`nulls`: field to whether its value is null), each null test of such a
 * field replaced by its outcome: the values a write sets fold into its
 * judgement, so an arm on a key it leaves null does not reach the statement.
 * Only the row's own columns: a relation reads other rows, and is kept as it
 * is.
 */
const foldKnownNulls = (
  predicate: PreparedPredicate,
  nulls: ReadonlyMap<string, boolean>
): PreparedPredicate =>
  fold(
    predicate,
    (leaf) => {
      if (leaf.kind !== "operation") return;
      const { target, operand } = leaf;
      return leaf.operator === "equals" &&
        target.kind === "column" &&
        target.path === undefined &&
        operand?.kind === "value" &&
        operand.value === null &&
        target.scalar.physical.scalar["~"].state.type !== "json"
        ? nulls.get(target.scalar.field)
        : undefined;
    },
    false
  );
/** Every parameter and condition a layer's predicate reads. */
function callReads(
  predicate: PreparedPredicate,
  parameters: Map<Parameter, boolean>,
  conditions: Set<Condition>
): void {
  switch (predicate.kind) {
    case "condition":
      conditions.add(predicate.condition);
      return;
    case "and":
    case "or":
      for (const member of predicate.predicates)
        callReads(member, parameters, conditions);
      return;
    case "not":
      callReads(predicate.predicate, parameters, conditions);
      return;
    case "relation":
      if (predicate.link) callReads(predicate.link, parameters, conditions);
      if (predicate.predicate)
        callReads(predicate.predicate, parameters, conditions);
      return;
    case "exists":
      if (predicate.predicate)
        callReads(predicate.predicate, parameters, conditions);
      return;
    case "operation":
      for (const operand of [predicate.operand, ...(predicate.operands ?? [])])
        if (operand?.kind === "parameter")
          parameters.set(operand.parameter, operand.spread === true);
      if (
        predicate.value instanceof Parameter &&
        !parameters.has(predicate.value)
      )
        parameters.set(predicate.value, false);
      return;
    default:
      return;
  }
}

/** `predicate` as `model`'s domain predicate of `layer`. */
export function layerOf(
  layer: number,
  model: string,
  predicate: PreparedPredicate
): PreparedPredicate {
  const found = new Set<Condition>();
  callReads(predicate, new Map(), found);
  const conditions = [...found];
  /** Its predicate under each outcome of its conditions, one digit per condition. */
  const outcomes = new Map<string, Folded>();
  const under = (key: string): Folded => {
    const folded =
      conditions.length === 0
        ? predicate
        : foldConditions(
            predicate,
            (condition) => key[conditions.indexOf(condition)] === "1"
          );
    const parameters = new Map<Parameter, boolean>();
    callReads(folded, parameters, new Set());
    const outcome = { predicate: folded, parameters: [...parameters] };
    outcomes.set(key, outcome);
    return outcome;
  };
  return freeze({
    kind: "layer",
    layer,
    model,
    predicate,
    resolve(queries: Queries, alias?: string) {
      const { values, instant } = queries;
      let key = "";
      // biome-ignore lint/style/useForOf: no iterator on a per-statement path (E5.1, measured).
      for (let index = 0; index < conditions.length; index++)
        key += conditions[index]!.holds(values, instant) ? "1" : "0";
      const { predicate: resolved, parameters } =
        outcomes.get(key) ?? under(key);
      let dropped = false;
      // biome-ignore lint/style/useForOf: no iterator on a per-statement path (E5.1, measured).
      for (let index = 0; index < parameters.length; index++) {
        const [parameter, spread] = parameters[index]!;
        const value = parameter.read(values, instant);
        if (value !== undefined && (!spread || Array.isArray(value))) continue;
        if (values?.required(parameter.control!, model)) return VACUOUS_FALSE;
        dropped = true;
      }
      if (dropped) return undefined;
      // The values a write sets fold into its judgement of the row it produces.
      const { known } = queries as Queries & {
        known?: { alias: string; nulls: ReadonlyMap<string, boolean> };
      };
      return known !== undefined && alias === known.alias
        ? foldKnownNulls(resolved, known.nulls)
        : resolved;
    },
  });
}
