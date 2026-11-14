/**
 * A layer of a row domain as the engine lowers it, where its predicate reads
 * its call (brought by `arg`, `now`, `when`, `unless`, `provided`): what its
 * predicate is for one call. Its conditions fold per call, a value it still reads that is
 * absent makes it false where its control is required and drops it otherwise
 * (R6), and over a produced row what judges it folds the nullness the write
 * states into it.
 * The engine asks a layer what it resolves to; this module, loaded with the
 * extensions that declare row domains, answers.
 */
import {
  freeze,
  mergeQuantifiers,
  type PreparedOperand,
  type PreparedPredicate,
  type Queries,
  VACUOUS_FALSE,
} from "@query-engine/raptor3/shared/query";
import {
  type CallValues,
  Condition,
  Parameter,
} from "@query-engine/raptor3/shared/row-scope";
import { overKnown } from "./row-domain";

/**
 * The test of a `when` or an `unless`: where it applies nothing, its item
 * of a filter list goes, as if it were not written.
 */
export class Choice extends Condition {}

/** A predicate without the conjunctions of one member preparation wraps it in. */
const only = (predicate: PreparedPredicate): PreparedPredicate =>
  predicate.kind === "and" && predicate.predicates.length === 1
    ? only(predicate.predicates[0]!)
    : predicate;

/** The items a conjunction is made of, however it nests. */
const itemsOf = (predicate: PreparedPredicate): PreparedPredicate[] =>
  predicate.kind === "and"
    ? predicate.predicates.flatMap(itemsOf)
    : [predicate];

/** A layer's predicate under one outcome of its conditions. */
interface Folded {
  readonly predicate: PreparedPredicate;
  /** The parameters it still reads, `spread` where one is a whole list. */
  readonly parameters: readonly (readonly [Parameter, boolean])[];
}
const ALWAYS_TRUE: PreparedPredicate = freeze({ kind: "always", value: true });
/**
 * `predicate` with the leaves `known` answers for replaced by their outcome,
 * or by the leaf it answers, and the logical combinators simplified, so a
 * false arm goes with every parameter inside it. `deep` folds the body of a
 * relation too, which keeps its quantifier: for an outcome that holds
 * whatever row is read.
 */
export function fold(
  predicate: PreparedPredicate,
  known: (leaf: PreparedPredicate) => boolean | PreparedPredicate | undefined,
  deep: boolean
): PreparedPredicate {
  switch (predicate.kind) {
    case "condition":
    case "operation": {
      const outcome = known(predicate);
      if (outcome === undefined) return predicate;
      if (typeof outcome !== "boolean") return outcome;
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

/**
 * `predicate` read where every argument with a default takes it (`fallback`):
 * each test of such an argument folded once, and each value it reads bound,
 * as lowering binds a call's. A list operand takes an array, which no default
 * is: R6 reads it from the call as it would anywhere.
 */
function atDefaults(
  predicate: PreparedPredicate,
  fallback: Readonly<Record<string, unknown>>
): PreparedPredicate {
  const values: CallValues = { controls: fallback, required: () => false };
  const defaulted = (parameter: Parameter): boolean =>
    parameter.control !== undefined &&
    Object.hasOwn(fallback, parameter.control);
  let changed = false;
  const bound = <O extends PreparedOperand | undefined>(operand: O) => {
    if (
      operand?.kind !== "parameter" ||
      operand.spread === true ||
      !defaulted(operand.parameter)
    )
      return operand;
    changed = true;
    return {
      kind: "value" as const,
      value: fallback[operand.parameter.control!],
    };
  };
  return fold(
    predicate,
    (leaf) => {
      // An argument read here has a control: the instant is never asked.
      if (leaf.kind === "condition")
        return defaulted(leaf.condition.parameter)
          ? leaf.condition.holds(values, () => new Date())
          : undefined;
      if (leaf.kind !== "operation") return;
      changed = false;
      const { operand, operands, value } = leaf;
      let read = value;
      if (value instanceof Parameter && defaulted(value)) {
        changed = true;
        read = fallback[value.control!];
      }
      const out = freeze({
        ...leaf,
        ...(operand && { operand: bound(operand) }),
        ...(operands && { operands: freeze(operands.map(bound)) }),
        value: read,
      });
      return changed ? out : undefined;
    },
    true
  );
}

/**
 * `predicate` as `model`'s domain predicate of `layer`, read with each
 * call's values, or, given `fallback`, where every argument with a default
 * takes it: inside another layer's relation reads, and for the rows a kept
 * delete takes. A layer whose predicate folds to true states nothing.
 */
export function layerOf(
  layer: number,
  model: string,
  given: PreparedPredicate,
  fallback?: Readonly<Record<string, unknown>>
): PreparedPredicate {
  const predicate =
    fallback === undefined ? given : atDefaults(given, fallback);
  // A list of `when`s and `unless`es only states nothing where none of them
  // applies anything.
  const chosen = itemsOf(predicate).every((item) => {
    let test = item.kind === "or" ? only(item.predicates[0]!) : item;
    if (test.kind === "not") test = only(test.predicate);
    return test.kind === "condition" && test.condition instanceof Choice;
  });
  const found = new Set<Condition>();
  callReads(predicate, new Map(), found);
  const conditions = [...found];
  /**
   * Its predicate under each outcome of its conditions, one bit per
   * condition, first condition highest; past 30, one digit per condition.
   */
  const outcomes = new Map<number | string, Folded>();
  const wide = conditions.length > 30;
  /** The values it was last resolved with, and what it stated for them. */
  let last: CallValues | undefined | null = null;
  let outcome: PreparedPredicate | undefined;
  const under = (key: number | string): Folded => {
    const holds = (index: number): boolean =>
      typeof key === "string"
        ? key[index] === "1"
        : Math.floor(key / 2 ** (conditions.length - 1 - index)) % 2 === 1;
    const folded =
      conditions.length === 0
        ? predicate
        : foldConditions(predicate, (condition) =>
            holds(conditions.indexOf(condition))
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
      // A call resolves each layer several times with one values object, and
      // values shared by calls read no instant: the last outcome is theirs.
      if (values !== last) {
        last = values;
        outcome = stated(values, instant);
      }
      // The values a write sets fold into its judgement of the row it
      // produces: what judges brings what folds them (`produced.ts`).
      return outcome && overKnown(queries, alias, outcome);
    },
  });
  /** What the layer states for `values`, `undefined` where it states nothing. */
  function stated(
    values: CallValues | undefined,
    instant: () => Date
  ): PreparedPredicate | undefined {
    let key: number | string;
    if (wide) {
      let digits = "";
      for (const condition of conditions)
        digits += condition.holds(values, instant) ? "1" : "0";
      key = digits;
    } else {
      let bits = 0;
      // biome-ignore lint/style/useForOf: no iterator on a per-statement path (E5.1, measured).
      for (let index = 0; index < conditions.length; index++)
        bits = bits * 2 + (conditions[index]!.holds(values, instant) ? 1 : 0);
      key = bits;
    }
    const { predicate: resolved, parameters } = outcomes.get(key) ?? under(key);
    if (chosen && resolved === ALWAYS_TRUE) return undefined;
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
    return resolved;
  }
}
