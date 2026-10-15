// The one formula of viborm/rbac (plan §3.2 R1), compiled once per schema:
//
//   P(M, a) = within(M)(a) ∧ limit(M, a) ∧ ( ⋁_{b ⊒ a} rule(M, b) ∨ ⋁_{g ∈ arms(M)} g(a) )
//
// Every function a rule holds is evaluated here, once per declared action, and
// the policy's spellings are lowered to the `where` vocabulary: `{ actor: "p" }`
// in a value position is the actor's field, `{ actor: { p: v } }` in a filter a
// condition on it, and a relation whose value is an action name the target's
// predicate at that action, inlined (D7). What comes out is plain data per
// model (K3): named predicates, the verbs and written fields that take them,
// the modes that narrow by them, the produced row's placement, moves and
// acyclic relations (R4, K4), and the projection key and read-gated fields
// (D5, D6, K5). A placement or a move drops a conjunct another one provably
// implies, so what administering already says is said once (D9). It names
// no engine structure; the entry hands it to the chain.

import type { RowsVerbs } from "../extensions/controls";
import type { VibORMConfig } from "../index";
import { actorPaths, refuse } from "./actor";
import { FALSE, type PolicyModel, type Rule, type Where } from "./helpers";

type Schema = VibORMConfig["schema"];
type AnyModel = Schema[string];

/** What the compiler reads of a model's declaration. */
interface ModelFacts {
  readonly scalars: Readonly<
    Record<
      string,
      {
        readonly "~": {
          readonly state: {
            readonly isId?: boolean;
            readonly nullable?: boolean;
            readonly base?: { readonly values?: readonly string[] };
          };
        };
      }
    >
  >;
  readonly relations: Readonly<
    Record<
      string,
      {
        readonly "~": {
          readonly state: {
            readonly foreignKey?: {
              readonly fields: readonly string[];
              readonly references: readonly string[];
            };
          };
          settleTarget(): unknown;
        };
      }
    >
  >;
  readonly compoundId?: Readonly<Record<string, { readonly entries: object }>>;
}

/** One model's declaration (plan §1.1). */
export interface ModelPolicy {
  readonly within?: Rule;
  readonly arms?: readonly Rule[];
  readonly actions?: { readonly [action: string]: readonly string[] };
  readonly create?: Rule;
  readonly operations?: {
    readonly read?: string;
    readonly update?: string;
    readonly delete?: string;
    readonly create?: string;
  };
  readonly fields?: {
    readonly [field: string]: {
      readonly read?: string;
      readonly write?: string;
    };
  };
  readonly domains?: { readonly [name: string]: Rule };
  /** A named action's rule: `view`, `edit`, `invite`, … */
  readonly [action: string]: Rule | readonly Rule[] | undefined;
}

export interface RbacConfig {
  /** Who calls: a `viborm/validation` object schema of the request's facts. */
  readonly actor: object;
  /** Ordered actions every model without its own `actions` takes, lowest first. */
  readonly levels?: readonly string[];
  readonly limit?: Rule;
  readonly models: { readonly [model: string]: ModelPolicy };
  /**
   * `"allow"` lets a governed read be served from the cache (OD-10). A cached
   * answer was judged when it was stored: a revoked grant or an expired
   * session reaches it only after its TTL. Refused when absent.
   */
  readonly cache?: "allow";
}

/**
 * One model's predicates and the uses that name them: a `rows` member's
 * `verbs` entry for the model (`RowsVerbs`). By name: every declared
 * action's `P(M, a)`, every domain's narrowing, `create` (the placement
 * every created row satisfies, R4) and `move:<field>` (what the new row of
 * an update writing that field satisfies besides the predicates that judged
 * its old one). Then the predicate each operation takes (K3), the one an
 * update writing a field takes instead of `update`'s (R3), the produced
 * row's placement, moves and acyclic relations (K4), and the projection key
 * and read-gated fields (K5). A verb left out names no declared action.
 */
export interface CompiledModel extends RowsVerbs {
  readonly predicates: { readonly [name: string]: Where };
  readonly writes: { readonly [field: string]: string };
  /** The predicate a result row must hold for the field to be present (D5). */
  readonly reads: { readonly [field: string]: string };
  /** `as` values, each narrowing by one predicate (R8). */
  readonly modes: { readonly [mode: string]: string };
  /** `create`: every model has one, false where it declares no `create:` (R9). */
  readonly place: string;
  readonly moves: { readonly [field: string]: string };
}

export interface CompiledPolicy {
  /** The bound-only control that carries the actor. */
  readonly control: "actor";
  /** Every model of the schema: one the policy does not list holds nothing (R9). */
  readonly models: { readonly [model: string]: CompiledModel };
}

/** The `as` value a call takes when it names none: it narrows nothing. */
export const DEFAULT_MODE = "default";
/** The projection key the entry declares on every listed model (D6, OD-2). */
export const EVIDENCE_KEY = "$access";
/** The placement's name: the predicate of the create verb (R4). */
const PLACE = "create";

const RESERVED = new Set([
  "within",
  "arms",
  "actions",
  "create",
  "operations",
  "fields",
  "domains",
]);
const OPERATIONS = new Set(["read", "update", "delete", "create"]);
const LOGICAL = new Set(["AND", "OR", "NOT"]);
const QUANTIFIERS = new Set(["is", "isNot", "some", "every", "none"]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isActorField = (value: unknown): value is { actor: string } =>
  isRecord(value) &&
  typeof value.actor === "string" &&
  Object.keys(value).length === 1;

/** A clause: a `where`, or `false` when it folds false while compiling. */
type Clause = Where | false;
const isTrue = (clause: Where) => Object.keys(clause).length === 0;
const membersOf = (clause: Where, key: "AND" | "OR"): Where[] =>
  Object.keys(clause).length === 1 && Array.isArray(clause[key])
    ? (clause[key] as Where[])
    : [clause];

function and(clauses: readonly Clause[]): Clause {
  if (clauses.includes(false)) return false;
  const kept = (clauses as Where[])
    .filter((clause) => !isTrue(clause))
    .flatMap((clause) => membersOf(clause, "AND"));
  if (kept.length < 2) return kept[0] ?? {};
  return { AND: kept };
}
function or(clauses: readonly Clause[]): Clause {
  const kept = clauses.filter((clause): clause is Where => clause !== false);
  if (kept.length === 0) return false;
  if (kept.some(isTrue)) return {};
  const flat = kept.flatMap((clause) => membersOf(clause, "OR"));
  return flat.length === 1 ? flat[0]! : { OR: flat };
}

/** Each action of a model with what it directly implies (D3). */
function actionsOf(
  name: string,
  policy: ModelPolicy,
  levels: readonly string[]
): ReadonlyMap<string, readonly string[]> {
  const implies = new Map<string, readonly string[]>(
    policy.actions
      ? Object.entries(policy.actions)
      : levels.map((level, index) => [level, levels.slice(index - 1, index)])
  );
  // A rule key that is not an action of the model names one implying view.
  for (const key of Object.keys(policy))
    if (!(RESERVED.has(key) || implies.has(key)))
      implies.set(key, key === "view" ? [] : ["view"]);
  for (const [action, implied] of implies) {
    if (RESERVED.has(action))
      refuse(
        `models.${name}: "${action}" is a key of the declaration, not an action`,
        name
      );
    for (const next of implied)
      if (!implies.has(next))
        refuse(
          `models.${name}.actions.${action} implies "${next}", which ${name} does not declare`,
          name
        );
  }
  return implies;
}

/**
 * What a listed model's projection key reports (D6): its actions, in their
 * declared order, and whether they are exactly the levels, so that the key
 * reads the highest one held. A model that declares none has no key.
 */
export function evidenceOf(
  config: RbacConfig,
  name: string
): { readonly names: readonly string[]; readonly ordered: boolean } {
  const policy = config.models[name]!;
  const levels = config.levels ?? [];
  const names = [...actionsOf(name, policy, levels).keys()];
  return {
    names,
    ordered:
      policy.actions === undefined &&
      names.length > 0 &&
      names.length === levels.length,
  };
}

/**
 * Each model's `rows.verbs` entry: its predicates, the verbs and written
 * fields that name them (K3), the produced row's placement, moves and
 * acyclic relations (K4), and its projection key and read-gated fields (K5).
 * Modes are the entry's own (`rows.models`), never part of it.
 */
export function verbsOf(compiled: CompiledPolicy): Record<string, RowsVerbs> {
  return Object.fromEntries(
    Object.entries(compiled.models).map(
      ([name, { modes, reads, ...verbs }]) => [
        name,
        Object.keys(reads).length === 0 ? verbs : { ...verbs, reads },
      ]
    )
  );
}

/** Compiles a policy against the schema it governs. */
export function compilePolicy(
  config: RbacConfig,
  schema: Schema,
  hasPath: (path: string) => boolean = actorPaths(config.actor)
): CompiledPolicy {
  const levels = config.levels ?? [];
  for (const name of Object.keys(config.models))
    if (!Object.hasOwn(schema, name))
      refuse(`models.${name}: the schema has no such model`, name);

  const names = new Map<AnyModel, string>(
    Object.entries(schema).map(([name, model]) => [model, name])
  );
  const stateOf = (name: string) =>
    schema[name]!["~"].state as unknown as ModelFacts;
  const relationOf = (name: string, relation: string) =>
    Object.hasOwn(stateOf(name).relations, relation)
      ? stateOf(name).relations[relation]!["~"]
      : undefined;
  const targetOf = (name: string, relation: string) => {
    const settled = relationOf(name, relation)?.settleTarget();
    return names.get(settled as AnyModel);
  };

  const implications = new Map<string, ReadonlyMap<string, readonly string[]>>(
    Object.entries(config.models).map(([name, policy]) => [
      name,
      actionsOf(name, policy, levels),
    ])
  );
  const models = new Map<string, PolicyModel>();
  const modelOf = (name: string): PolicyModel => {
    const known = models.get(name);
    if (known) return known;
    const implies = implications.get(name) ?? new Map();
    const above = new Map(
      [...implies.keys()].map((action) => {
        const reaches = (from: string, seen: Set<string>): boolean => {
          if (from === action) return true;
          if (seen.has(from)) return false;
          seen.add(from);
          return implies.get(from)!.some((next) => reaches(next, seen));
        };
        const up = [...implies.keys()].filter((b) => reaches(b, new Set()));
        return [action, Object.freeze(up)] as const;
      })
    );
    const model: PolicyModel = {
      name,
      actions: [...implies.keys()],
      levels,
      leveled: implies.size > 0 && !config.models[name]!.actions,
      above: (action) => above.get(action)!,
      related: (relation) => {
        const target = targetOf(name, relation);
        return target === undefined ? undefined : modelOf(target);
      },
      foreignKey: (relation) =>
        relationOf(name, relation)?.state.foreignKey?.fields,
      values: (field) => stateOf(name).scalars[field]?.["~"].state.base?.values,
      reachedBy: (relation) =>
        [...names.values()].some((other) => targetOf(other, relation) === name),
    };
    models.set(name, model);
    return model;
  };

  // P(M, a), once per pair; a pair met again while it compiles is a cycle.
  const predicates = new Map<string, Clause>();
  const open: string[] = [];
  const P = (name: string, action: string): Clause => {
    const key = `${name}.${action}`;
    const known = predicates.get(key);
    if (known !== undefined) return known;
    if (open.includes(key))
      refuse(
        `models.${key} reads itself: ${[...open.slice(open.indexOf(key)), key].join(" → ")}`,
        name
      );
    open.push(key);
    const policy = config.models[name]!;
    const model = modelOf(name);
    const at = `models.${name}`;
    const clause = and([
      lower(name, action, policy.within ?? {}, `${at}.within`),
      lower(name, action, config.limit ?? {}, "limit"),
      or([
        ...model
          .above(action)
          .filter((b) => policy[b] !== undefined)
          .map((b) => lower(name, b, policy[b], `${at}.${b}`)),
        ...(policy.arms ?? []).map((arm, index) =>
          lower(name, action, arm, `${at}.arms[${index}]`)
        ),
      ]),
    ]);
    open.pop();
    predicates.set(key, clause);
    return clause;
  };

  /** A path the actor schema declares, or the refusal naming where it is read. */
  const path = (at: string, read: unknown) => {
    if (typeof read === "string" && !hasPath(read))
      refuse(
        `${at} reads actor path "${read}", which the actor schema does not declare`
      );
  };
  /** A value position: the actor's fields as values, checked. */
  const value = (at: string, input: unknown): unknown => {
    if (isActorField(input)) {
      path(at, input.actor);
      return { control: "actor", path: input.actor };
    }
    if (!isRecord(input)) return input;
    if (input.control === "actor") path(at, input.path);
    return Object.fromEntries(
      Object.entries(input).map(([key, member]) => [key, value(at, member)])
    );
  };
  /** `{ actor: { p: v } }` in a filter: one condition per leaf. */
  const conditions = (at: string, facts: unknown, prefix = ""): Where[] => {
    if (!isRecord(facts))
      refuse(
        `${at} tests the actor with a value that is not an object of its facts`
      );
    return Object.entries(facts).flatMap(([key, fact]) => {
      const read = `${prefix}${key}`;
      if (isRecord(fact)) return conditions(at, fact, `${read}.`);
      path(at, read);
      if (fact !== null && typeof fact === "object")
        refuse(`${at} tests actor path "${read}" against a list`);
      return [
        {
          $if:
            fact === null
              ? { control: "actor", path: read, exists: false }
              : { control: "actor", path: read, equals: fact },
        },
      ];
    });
  };

  /** A rule of `name` read at `action` (written at `at`), lowered to the `where` vocabulary. */
  const lower = (
    name: string,
    action: string,
    rule: unknown,
    at: string
  ): Clause => {
    if (typeof rule === "function")
      return lower(name, action, rule(action, modelOf(name)), at);
    if (!isRecord(rule))
      refuse(
        `${at}: a rule is a where object or a function of the action`,
        name
      );
    const state = stateOf(name);
    const out: Record<string, unknown> = {};
    const also: Clause[] = [];
    for (const [key, member] of Object.entries(rule)) {
      if (LOGICAL.has(key)) {
        const list = (Array.isArray(member) ? member : [member]).map((item) =>
          lower(name, action, item, at)
        );
        const folded =
          key === "OR"
            ? or(list)
            : and(
                key === "AND"
                  ? list
                  : list.map((item) =>
                      item === false ? {} : isTrue(item) ? false : { NOT: item }
                    )
              );
        if (folded === false) return false;
        also.push(folded);
      } else if (
        key === "actor" &&
        !(
          Object.hasOwn(state.scalars, key) ||
          Object.hasOwn(state.relations, key)
        )
      ) {
        also.push(...conditions(at, member));
      } else if (key === "$if") {
        if (isRecord(member) && member.control === "actor")
          path(at, member.path);
        out[key] = member;
      } else if (targetOf(name, key) !== undefined) {
        const lowered = relation(name, action, key, member, at);
        if (lowered === false) return false;
        if (lowered !== undefined) out[key] = lowered;
      } else out[key] = value(at, member);
    }
    return and([out, ...also]);
  };

  /** A relation filter: an action name is the target's predicate (D7). */
  const relation = (
    name: string,
    action: string,
    key: string,
    member: unknown,
    at: string
  ): unknown => {
    const target = targetOf(name, key)!;
    if (typeof member === "string") {
      if (!modelOf(target).actions.includes(member))
        refuse(
          `${at} reads ${key} at "${member}", which ${target} does not declare`,
          name
        );
      const held = P(target, member);
      return held === false ? false : { is: held };
    }
    if (!isRecord(member)) return member;
    if (!Object.keys(member).some((op) => QUANTIFIERS.has(op)))
      return lower(target, action, member, at);
    const out: Record<string, unknown> = {};
    for (const [op, body] of Object.entries(member)) {
      if (!(QUANTIFIERS.has(op) && body !== null)) {
        out[op] = body;
        continue;
      }
      const lowered = lower(target, action, body, at);
      // A false body: `is`/`some` hold nowhere, `isNot`/`none` everywhere,
      // `every` only where nothing is related.
      if (lowered !== false) out[op] = lowered;
      else if (op === "is" || op === "some") return false;
      else if (op === "every") out.none = {};
    }
    return Object.keys(out).length === 0 ? undefined : out;
  };

  /**
   * Whether `a` implies `b`, both read at `name`, by their structure alone:
   * sound, never complete (a `false` only keeps a conjunct). It is what lets
   * a placement drop what its administering action already says (D9).
   */
  const implied = new Map(
    Object.keys(schema).map((name) => [
      name,
      new WeakMap<object, WeakMap<object, boolean>>(),
    ])
  );
  const implies = (name: string, a: Where, b: Where): boolean => {
    if (a === b) return true;
    const byModel = implied.get(name)!;
    let row = byModel.get(a);
    if (row === undefined) byModel.set(a, (row = new WeakMap()));
    let answer = row.get(b);
    if (answer === undefined) row.set(b, (answer = provable(name, a, b)));
    return answer;
  };
  const provable = (name: string, a: Where, b: Where): boolean => {
    const right = conjuncts(b);
    if (right.length !== 1)
      return right.every((member) => implies(name, a, member));
    const left = conjuncts(a);
    const [key, given] = Object.entries(left[0] ?? { AND: [] })[0]!;
    const [wanted, value] = Object.entries(right[0]!)[0]!;
    if (left.length === 1 && key === "OR")
      return (given as Where[]).every((member) => implies(name, member, b));
    if (
      wanted === "OR" &&
      (value as Where[]).some((member) => implies(name, a, member))
    )
      return true;
    if (left.length !== 1)
      return left.some((member) => implies(name, member, b));
    if (key !== wanted || !isRecord(given) || !isRecord(value))
      return key === wanted && same(given, value);
    if (key === "NOT") return implies(name, value, given);
    if (key === "$if")
      return same(given, value) || narrower(given, value, "hasSome");
    const target = targetOf(name, key);
    if (target === undefined)
      return (
        same(given, value) ||
        narrower(given, value, "hasSome") ||
        narrower(given, value, "in")
      );
    // A relation: the same walk, its body implied at the target.
    const ops = ["is", "some", "every"].filter((op) =>
      Object.hasOwn(value, op)
    );
    if (ops.length === 0) return implies(target, given, value);
    return ops.every(
      (op) =>
        isRecord(given[op]) &&
        isRecord(value[op]) &&
        same(without(given, op), without(value, op)) &&
        implies(target, given[op], value[op])
    );
  };
  /** A clause as a conjunction of single-key members. */
  const conjuncts = (clause: Where): Where[] =>
    Object.keys(clause).length === 1 && !Object.hasOwn(clause, "AND")
      ? [clause]
      : Object.entries(clause).flatMap(([key, member]) =>
          // `and` writes every conjunction as a list.
          key === "AND"
            ? (member as Where[]).flatMap(conjuncts)
            : [{ [key]: member }]
        );
  const without = (record: Where, key: string) => {
    const { [key]: _dropped, ...rest } = record;
    return rest;
  };
  /** `{ op: S1, …rest }` against `{ op: S2, …rest }`, with S1 ⊆ S2. */
  const narrower = (given: Where, value: Where, op: string) =>
    Array.isArray(given[op]) &&
    Array.isArray(value[op]) &&
    same(without(given, op), without(value, op)) &&
    (given[op] as unknown[]).every((item) =>
      (value[op] as unknown[]).some((other) => same(item, other))
    );
  const texts = new WeakMap<object, string>();
  const same = (x: unknown, y: unknown): boolean => {
    if (x === y) return true;
    if (
      !((isRecord(x) || Array.isArray(x)) && (isRecord(y) || Array.isArray(y)))
    )
      return false;
    const text = (item: object) => {
      const known = texts.get(item);
      if (known !== undefined) return known;
      const written = JSON.stringify(item);
      texts.set(item, written);
      return written;
    };
    return text(x) === text(y);
  };
  /** The actor paths a clause reads as values (R6 resolves them per predicate). */
  const references = (
    clause: unknown,
    into = new Set<string>()
  ): Set<string> => {
    if (Array.isArray(clause))
      for (const item of clause) references(item, into);
    else if (isRecord(clause)) {
      if (clause.control === "actor" && typeof clause.path === "string")
        into.add(clause.path);
      for (const [key, member] of Object.entries(clause))
        if (key !== "$if") references(member, into);
    }
    return into;
  };
  /**
   * The conjunction of `clauses` without a member another one implies (or
   * one of `given`, which the same statement already judges). A member is
   * dropped only where its actor values are read by what implies it, so an
   * absent value still makes the predicate false (R6).
   */
  const conjoin = (
    name: string,
    clauses: readonly Clause[],
    given: readonly Where[] = []
  ): Clause => {
    const all = and(clauses);
    if (all === false) return false;
    const kept = conjuncts(all);
    for (let index = kept.length - 1; index >= 0; index--) {
      const member = kept[index]!;
      const read = references(member);
      const covers = (other: Where) =>
        implies(name, other, member) &&
        [...read].every((path) => references(other).has(path));
      if (
        given.some(covers) ||
        kept.some((other, at) => at !== index && covers(other))
      )
        kept.splice(index, 1);
    }
    return and(kept);
  };

  /**
   * The action each verb of a listed model takes (K3, OD-3): `operations`,
   * else view, edit and delete (the top level where its actions are exactly
   * the levels); a verb whose action the model does not declare takes none.
   */
  const verbsFor = (name: string) => {
    const model = modelOf(name);
    const operations = config.models[name]!.operations ?? {};
    const verbs: Record<string, string> = {};
    for (const [verb, fallback] of [
      ["read", "view"],
      ["update", "edit"],
      ["delete", evidenceOf(config, name).ordered ? levels.at(-1)! : "delete"],
    ] as const) {
      const action = operations[verb] ?? fallback;
      if (model.actions.includes(action)) verbs[verb] = action;
    }
    return verbs;
  };
  /**
   * Each foreign key `name` holds, with what R4 asks of a value written to
   * it: null where every field of the key may be, or a target the actor
   * views, `P(T, read)` (false where T holds none: R9, fail closed).
   */
  const keysOf = (name: string) =>
    Object.entries(stateOf(name).relations).flatMap(([relation, declared]) => {
      const key = declared["~"].state.foreignKey;
      if (key === undefined) return [];
      const target = targetOf(name, relation)!;
      const action = config.models[target] && verbsFor(target).read;
      const held = action ? P(target, action) : false;
      const visible: Clause =
        held === false ? false : { [relation]: { is: held } };
      const nullable = key.fields.every(
        (field) => stateOf(name).scalars[field]?.["~"].state.nullable === true
      );
      return [
        {
          fields: key.fields,
          clause: nullable
            ? or([and(key.fields.map((field) => ({ [field]: null }))), visible])
            : visible,
        },
      ];
    });
  /**
   * The fields of `name`'s row a clause read at `name` reads: a scalar, the
   * key behind a relation it holds, the fields a relation it does not hold
   * joins on, and a self relation's body where `self` reads the row itself.
   */
  const fieldsRead = (name: string, clause: Where, into: Set<string>) => {
    for (const [key, member] of Object.entries(clause)) {
      if (LOGICAL.has(key))
        for (const item of Array.isArray(member) ? member : [member])
          fieldsRead(name, item as Where, into);
      else if (key === "$if") continue;
      else if (targetOf(name, key) === undefined) into.add(key);
      else {
        for (const field of joinedOn(name, key)) into.add(field);
        if (isRecord(member) && member.self === true)
          for (const op of QUANTIFIERS)
            if (isRecord(member[op])) fieldsRead(name, member[op], into);
      }
    }
    return into;
  };
  /** The relations of `name` whose foreign key holds `field`. */
  const holders = (name: string, field: string) =>
    Object.entries(stateOf(name).relations)
      .filter(([, declared]) =>
        declared["~"].state.foreignKey?.fields.includes(field)
      )
      .map(([relation]) => relation);
  /** The fields of `name` a relation of it joins on. */
  const joinedOn = (name: string, relation: string): readonly string[] => {
    const own = relationOf(name, relation)!.state.foreignKey;
    if (own !== undefined) return own.fields;
    // Held on the other side: the fields of `name` some key references.
    const referenced = new Set<string>();
    for (const other of names.values())
      for (const declared of Object.values(stateOf(other).relations)) {
        const key = declared["~"].state.foreignKey;
        if (
          key !== undefined &&
          names.get(declared["~"].settleTarget() as AnyModel) === name
        )
          for (const field of key.references) referenced.add(field);
      }
    return [...referenced];
  };

  const compiled: Record<string, CompiledModel> = {};
  for (const name of Object.keys(schema)) {
    const policy = config.models[name];
    if (policy === undefined) {
      // R9: nothing is read, written or created on a model the policy does not list.
      compiled[name] = Object.freeze({
        predicates: Object.freeze({ [PLACE]: FALSE }),
        writes: {},
        reads: {},
        modes: {},
        place: PLACE,
        moves: {},
      });
      continue;
    }
    const model = modelOf(name);
    const declared = (role: string, action: string | undefined) => {
      if (action !== undefined && !model.actions.includes(action))
        refuse(
          `models.${name}.${role} names "${action}", which ${name} does not declare`,
          name
        );
      return action;
    };
    const named: Record<string, Where> = {};
    /** One name space per model: actions, domains, placement and moves. */
    const claim = (key: string, at: string, clause: Where) => {
      if (Object.hasOwn(named, key))
        refuse(
          `${at}: an action, a domain, the placement or a move already has the name "${key}"`,
          name
        );
      named[key] = clause;
    };
    for (const action of model.actions)
      named[action] = P(name, action) || FALSE;

    const operations = policy.operations ?? {};
    for (const operation of Object.keys(operations))
      if (!OPERATIONS.has(operation))
        refuse(
          `models.${name}.operations.${operation}: not an operation`,
          name
        );
    for (const verb of ["read", "update", "delete"] as const)
      declared(`operations.${verb}`, operations[verb]);
    const verbs = verbsFor(name);
    const evidence = evidenceOf(config, name);

    const writes: Record<string, string> = {};
    const reads: Record<string, string> = {};
    const state = stateOf(name);
    for (const [field, { read, write }] of Object.entries(
      policy.fields ?? {}
    )) {
      if (
        !(
          Object.hasOwn(state.scalars, field) ||
          Object.hasOwn(state.relations, field)
        )
      )
        refuse(
          `models.${name}.fields.${field}: ${name} has no such field`,
          name
        );
      if (write !== undefined)
        writes[field] = declared(`fields.${field}.write`, write)!;
      // A key, a foreign key or a relation is refused by K5's admission.
      if (read === undefined) continue;
      reads[field] = declared(`fields.${field}.read`, read)!;
    }
    // R4: place = within ∧ limit ∧ create: at the create action, and every
    // key's target visible; false where the model declares no `create:`.
    const at = (rule: Rule, where: string) => {
      const action = declared(
        "operations.create",
        operations.create ?? "edit"
      )!;
      return lower(name, action, rule, where);
    };
    const create: Clause =
      policy.create === undefined
        ? false
        : and([
            at(policy.within ?? {}, `models.${name}.within`),
            at(config.limit ?? {}, "limit"),
            at(policy.create, `models.${name}.create`),
          ]);
    const keys = keysOf(name);
    claim(
      PLACE,
      `models.${name}.create`,
      conjoin(name, [create, ...keys.map(({ clause }) => clause)]) || FALSE
    );
    // A move (OD-14): an update writing a field the placement reads is
    // placed again; one writing a key, its target visible.
    const placed =
      create === false
        ? new Set<string>()
        : fieldsRead(name, create, new Set());
    const moves: Record<string, string> = {};
    for (const field of new Set([
      ...placed,
      ...keys.flatMap(({ fields }) => fields),
    ])) {
      const move = `move:${field}`;
      // The new row is also judged at what judged the old one (R4), which a
      // move need not say: the read verb, and the field's write action when
      // every spelling of the write (the field, a relation holding it) takes
      // the same one (R3).
      const spelled = new Set(
        [field, ...holders(name, field)].map(
          (written) => writes[written] ?? verbs.update
        )
      );
      const judged = [verbs.read, ...(spelled.size === 1 ? spelled : [])]
        .filter((action) => action !== undefined)
        .map((action) => named[action]!);
      claim(
        move,
        `models.${name}.fields.${field}`,
        conjoin(
          name,
          [
            placed.has(field) ? create : {},
            ...keys
              .filter(({ fields }) => fields.includes(field))
              .map(({ clause }) => clause),
          ],
          judged
        ) || FALSE
      );
      moves[field] = move;
    }

    const modes: Record<string, string> = Object.fromEntries(
      model.actions.map((action) => [action, action])
    );
    for (const [domain, rule] of Object.entries(policy.domains ?? {})) {
      const at = `models.${name}.domains.${domain}`;
      claim(domain, at, lower(name, "view", rule, at) || FALSE);
      modes[domain] = domain;
    }
    // One `as` name space for every model: the default is no action's.
    if (Object.hasOwn(modes, DEFAULT_MODE))
      refuse(
        `models.${name}: "${DEFAULT_MODE}" is the mode a call takes by default, not an action or a domain`,
        name
      );

    compiled[name] = Object.freeze({
      predicates: Object.freeze(named),
      ...verbs,
      writes: Object.freeze(writes),
      reads: Object.freeze(reads),
      modes: Object.freeze(modes),
      place: PLACE,
      moves: Object.freeze(moves),
      // D6: per row, the actions held; the highest one where they are the levels.
      ...(evidence.names.length > 0 && {
        evidence: Object.freeze({
          as: EVIDENCE_KEY,
          names: Object.freeze(evidence.names),
          ...(evidence.ordered && { ordered: true }),
        }),
      }),
    });
  }
  // R4: a self key a predicate recurses over never takes a parent inside
  // the row's own subtree.
  for (const [name, recursed] of recursion(compiled))
    compiled[name] = Object.freeze({
      ...compiled[name]!,
      acyclic: Object.freeze(recursed),
    });
  return Object.freeze({ control: "actor", models: Object.freeze(compiled) });

  /**
   * Per model, the self relations holding a key that some compiled
   * predicate recurses over (`up()`), wherever it is read.
   */
  function recursion(models: Record<string, CompiledModel>) {
    const found = new Map<string, string[]>();
    // Per model, the clauses already walked there (P is shared, D7).
    const seen = new Map(
      Object.keys(models).map((name) => [name, new WeakSet<object>()])
    );
    const walk = (name: string, clause: unknown): void => {
      if (!isRecord(clause) || seen.get(name)!.has(clause)) return;
      seen.get(name)!.add(clause);
      for (const [key, member] of Object.entries(clause)) {
        if (LOGICAL.has(key)) {
          for (const item of Array.isArray(member) ? member : [member])
            walk(name, item);
          continue;
        }
        const target = targetOf(name, key);
        if (target === undefined || !isRecord(member)) continue;
        if (
          target === name &&
          member.recurse !== undefined &&
          relationOf(name, key)!.state.foreignKey !== undefined
        ) {
          const list = found.get(name) ?? [];
          if (!list.includes(key)) list.push(key);
          found.set(name, list);
        }
        const bodies = [...QUANTIFIERS].filter((op) =>
          Object.hasOwn(member, op)
        );
        if (bodies.length === 0) walk(target, member);
        for (const op of bodies) walk(target, member[op]);
      }
    };
    for (const [name, model] of Object.entries(models))
      for (const clause of Object.values(model.predicates)) walk(name, clause);
    return found;
  }
}
