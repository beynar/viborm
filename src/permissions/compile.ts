// The one formula of viborm/permissions (plan §3.2 R1), compiled once per schema:
//
//   P(M, a) = scopes(M, a) ∧ mandatory(M) ∧ ⋁_{b ⊒ a} rule(M, b)(b)
//
// Rule functions are evaluated here for their declared action, and
// the policy's spellings are lowered to the `where` vocabulary: `{ actor: "p" }`
// in a value position is the actor's field, `{ actor: { p: v } }` in a filter a
// condition on it, and a relation whose value is an action name the target's
// predicate at that action, inlined (D7). What comes out is plain data per
// model (K3): named predicates, the verbs and written fields that take them,
// the modes that narrow by them, the produced row's placement, moves and
// acyclic relations (R4, K4), and the projection key and read-gated fields
// (D5, D6, K5). A placement or a move drops a conjunct another one, or a
// judgement the same statement makes, provably implies (plan §11.4). It
// names no engine structure; the entry hands it to the chain.

import type { RowsVerbs } from "../extensions/controls";
import type { VibORMConfig } from "../index";
import { type ActorContract, actorContract, refuse } from "./actor";
import { FALSE, type PolicyModel, type Rule, type Where } from "./rules";

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
            readonly type: string;
            readonly isId?: boolean;
            readonly nullable?: boolean;
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
  readonly mandatory?: Where;
  readonly actions?: { readonly [action: string]: readonly string[] };
  readonly create?: Rule;
  readonly operations?: {
    readonly read?: string;
    readonly update?: string;
    readonly delete?: string;
  };
  readonly fields?: {
    readonly [field: string]: {
      readonly read?: string;
      readonly write?: string;
    };
  };
  readonly domains?: { readonly [name: string]: Rule };
  /** A named action or comma-separated actions' rule: `read`, `read, update`, … */
  readonly [action: string]: Rule | undefined;
}

export interface PermissionsConfig {
  /** Who calls: a `viborm/validation` object schema of the request's facts. */
  readonly actor: object;
  /** Distinct ordered actions every model without its own `actions` takes, lowest first. */
  readonly levels?: readonly string[];
  readonly mandatory?: Where;
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
 * action's `P(M, a)`, every domain's narrowing, `$create` (the placement
 * every created row satisfies, R4) and `move:<field>` (what the new row of
 * an update writing that field satisfies besides the predicates that judged
 * its old one). Then the predicate each operation takes (K3), the narrowed one an
 * update writing a protected field takes (R3), the produced
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
  /** Every model has a placement, false without a direct or inherited create grant. */
  readonly place: string;
  readonly moves: { readonly [field: string]: string };
}

export interface CompiledPolicy {
  /** The bound-only control that carries the actor. */
  readonly control: "actor";
  /** Each admitted scope and its transitive implications, including itself. */
  readonly scopes: Readonly<Record<string, readonly string[]>>;
  /** Every model of the schema: one the policy does not list holds nothing (R9). */
  readonly models: { readonly [model: string]: CompiledModel };
}

/** The `as` value a call takes when it names none: it narrows nothing. */
export const DEFAULT_MODE = "default";
/** The projection key the entry declares on every listed model (D6, OD-2). */
export const EVIDENCE_KEY = "$access";
/** The placement's name: the predicate of the create verb (R4). */
const PLACE = "$create";

const RESERVED = new Set([
  "mandatory",
  "actions",
  "operations",
  "fields",
  "domains",
]);
const OPERATIONS = new Set(["read", "update", "delete"]);
const CONFIG_KEYS = new Set([
  "actor",
  "levels",
  "mandatory",
  "models",
  "cache",
]);
const FIELD_KEYS = new Set(["read", "write"]);

/** Edits between two names (insert, delete, substitute, swap): how close a typo is. */
function distance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0
    )
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        rows[i - 1]![j]! + 1,
        rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = best;
    }
  return rows[a.length]![b.length]!;
}
const LOGICAL = new Set(["AND", "OR", "NOT"]);
const QUANTIFIERS = new Set(["is", "isNot", "some", "every", "none"]);
/** A plain object: a clause or an operator's record, never a value (a Date, a Decimal, bytes). */
const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
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
/**
 * Whether two values of a clause are the same value: numbers by
 * `Object.is` (NaN and ±Infinity are no `null`), bigints, dates by their
 * instant, arrays and records member by member; anything else by identity.
 */
function same(x: unknown, y: unknown): boolean {
  if (typeof x === "number" || typeof y === "number") return Object.is(x, y);
  if (x === y) return true;
  if (x instanceof Date || y instanceof Date)
    return (
      x instanceof Date && y instanceof Date && x.getTime() === y.getTime()
    );
  if (Array.isArray(x) || Array.isArray(y))
    return (
      Array.isArray(x) &&
      Array.isArray(y) &&
      x.length === y.length &&
      x.every((item, index) => same(item, y[index]))
    );
  if (!(isRecord(x) && isRecord(y))) return false;
  const keys = Object.keys(x);
  return (
    keys.length === Object.keys(y).length &&
    keys.every((key) => Object.hasOwn(y, key) && same(x[key], y[key]))
  );
}

function or(clauses: readonly Clause[]): Clause {
  const kept = clauses.filter((clause): clause is Where => clause !== false);
  if (kept.length === 0) return false;
  if (kept.some(isTrue)) return {};
  // Rules have already been evaluated at their declaring actions. Equal
  // resulting branches contribute once without suppressing callback evaluation.
  const flat: Where[] = [];
  for (const clause of kept.flatMap((member) => membersOf(member, "OR")))
    if (!flat.some((held) => same(held, clause))) flat.push(clause);
  return flat.length === 1 ? flat[0]! : { OR: flat };
}

/** A model's admitted action graph, rule assignments and projection meaning. */
interface ActionRules {
  readonly rules: ReadonlyMap<
    string,
    { readonly rule: Rule | undefined; readonly source: string }
  >;
  readonly closure: ReadonlyMap<string, readonly string[]>;
  readonly evidence: { readonly names: readonly string[] };
}

/** Resolve grouped rule keys once, before any consumer reads their actions. */
function actionsOf(
  name: string,
  policy: ModelPolicy,
  levels: readonly string[]
): ActionRules {
  const implies = new Map<string, readonly string[]>(
    policy.actions
      ? Object.entries(policy.actions)
      : levels.map((level, index) => [level, levels.slice(index - 1, index)])
  );
  const rules = new Map<
    string,
    { readonly rule: Rule | undefined; readonly source: string }
  >();
  // Only a model's rule keys can group actions. Graph edges and levels name
  // individual actions, so accepting a comma there would create another action.
  for (const action of [
    ...levels,
    ...implies.keys(),
    ...[...implies.values()].flat(),
  ])
    if (action.includes(","))
      refuse(
        `models.${name}: "${action}" is not an individual action; commas group rules only`,
        name
      );

  for (const sourceKey of Object.keys(policy)) {
    if (RESERVED.has(sourceKey)) continue;
    const source = `models.${name}.${sourceKey}`;
    const binding = { rule: policy[sourceKey], source };
    const keys = sourceKey.includes(",")
      ? sourceKey
          .split(",")
          .map((key) => key.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, ""))
      : [sourceKey];
    for (const key of keys) {
      if (key.length === 0)
        refuse(
          `${source}: an action group cannot contain an empty member`,
          name
        );
      // Never reinterpret an old restriction or grant container as an action.
      if (key === "within")
        refuse(`${source} was renamed to "mandatory"`, name);
      if (key === "arms")
        refuse(
          `${source}: arms was removed; assign rules to named actions`,
          name
        );
      if (RESERVED.has(key))
        refuse(
          `${source}: "${key}" is a key of the declaration, not an action`,
          name
        );
      const previous = rules.get(key);
      if (previous !== undefined)
        refuse(
          `${source}: action "${key}" already has a rule at ${previous.source}`,
          name
        );
      rules.set(key, binding);
      if (implies.has(key)) continue;
      // An explicit graph lists every action: unknown members would introduce an undeclared permission.
      if (policy.actions)
        refuse(
          `${source}: neither an action ${name} lists in \`actions\` nor a key of the declaration (${[...RESERVED].join(", ")}); unknown action "${key}"`,
          name
        );
      // Implicit action members each receive the same typo protection as a key.
      const meant = [...RESERVED, ...levels].find(
        (known) =>
          known.toLowerCase() === key.toLowerCase() ||
          distance(known, key) <= (known.length <= 4 ? 1 : 2)
      );
      if (meant !== undefined)
        refuse(
          `${source}: spelled like "${meant}"; rename the action, or list the model's \`actions\``,
          name
        );
      implies.set(key, []);
    }
  }
  // An update or a delete grants read by default: whoever may change a row
  // may see it. A create is a placement over a proposed row and implies
  // nothing; custom actions imply only what is declared.
  for (const action of ["update", "delete"]) {
    const inherited = implies.get(action);
    if (inherited === undefined) continue;
    if (!implies.has("read")) implies.set("read", []);
    if (!inherited.includes("read"))
      implies.set(action, [...inherited, "read"]);
  }
  for (const [action, implied] of implies) {
    if (action === "arms" || action === "within")
      refuse(
        `models.${name}: "${action}" is a retired declaration key, not an action`,
        name
      );
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
  const closure = new Map<string, readonly string[]>();
  for (const action of implies.keys()) {
    const reached = new Set<string>();
    const visit = (name: string) => {
      if (reached.has(name)) return;
      reached.add(name);
      for (const next of implies.get(name)!) visit(next);
    };
    visit(action);
    closure.set(action, Object.freeze([...reached]));
  }
  return {
    rules,
    closure,
    evidence: { names: [...implies.keys()] },
  };
}

/** The projection always reports one boolean per admitted action. */
export function evidenceOf(
  config: PermissionsConfig,
  name: string
): { readonly names: readonly string[] } {
  return actionsOf(name, config.models[name]!, config.levels ?? []).evidence;
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
  config: PermissionsConfig,
  schema: Schema,
  actor: ActorContract = actorContract(config.actor)
): CompiledPolicy {
  const noActions: readonly string[] = Object.freeze([]);
  const levels = config.levels ?? noActions;
  if (new Set(levels).size !== levels.length)
    refuse("levels must list each action only once");
  for (const key of Object.keys(config))
    if (!CONFIG_KEYS.has(key))
      refuse(
        `"${key}" is not a key of the policy (${[...CONFIG_KEYS].join(", ")})`
      );
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

  const actions = new Map<string, ActionRules>(
    Object.entries(config.models).map(([name, policy]) => [
      name,
      actionsOf(name, policy, levels),
    ])
  );
  const models = new Map<string, PolicyModel>();
  const modelOf = (name: string): PolicyModel => {
    const known = models.get(name);
    if (known) return known;
    const model: PolicyModel = Object.freeze({
      name,
      actions: Object.freeze([...(actions.get(name)?.evidence.names ?? [])]),
    });
    models.set(name, model);
    return model;
  };

  // The declared rule owns callback evaluation. Inheritance reuses that exact
  // predicate; credential scope gates apply only to the requested action.
  const authoredRules = new Map<string, Clause>();
  const authoredPredicates = new WeakMap<Where, ReadSummary>();
  const rules = new Map<string, Clause>();
  const predicates = new Map<string, Clause>();
  const open: string[] = [];
  const scope = (name: string, action: string): Where => ({
    OR: [
      { $if: { control: "scopes", path: "unrestricted", equals: true } },
      { $if: { control: "scopes", path: "allowed", has: `${name}.${action}` } },
    ],
  });
  const ruleAt = (name: string, action: string): Clause => {
    const key = `${name}.${action}`;
    const known = rules.get(key);
    if (known !== undefined) return known;
    const binding = actions.get(name)!.rules.get(action);
    const source =
      binding?.rule === undefined
        ? false
        : lower(name, action, binding.rule, binding.source);
    authoredRules.set(key, source);
    const clause = availableGrant(name, source);
    rules.set(key, clause);
    return clause;
  };
  const restrictions = new Map<string, Clause>();
  const restriction = (name: string): Clause => {
    const known = restrictions.get(name);
    if (known !== undefined) return known;
    const admit = (input: unknown, at: string): void => {
      if (typeof input === "function")
        refuse(
          `${at}: mandatory is action-independent and cannot contain callbacks`,
          name
        );
      if (Array.isArray(input)) for (const member of input) admit(member, at);
      else if (isRecord(input))
        for (const member of Object.values(input)) admit(member, at);
    };
    const policy = config.models[name]!;
    admit(policy.mandatory, `models.${name}.mandatory`);
    admit(config.mandatory, "mandatory");
    const clause = and([
      lower(name, "read", policy.mandatory ?? {}, `models.${name}.mandatory`),
      lower(name, "read", config.mandatory ?? {}, "mandatory"),
    ]);
    restrictions.set(name, clause);
    return clause;
  };
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
    const declared = actions.get(name)!;
    const inherited =
      declared.rules.get(action)?.rule === false
        ? []
        : [...declared.closure].flatMap(([from, reaches]) =>
            reaches.includes(action) ? [from] : []
          );
    const branches = inherited.map((from) => ruleAt(name, from));
    const granted = or(branches);
    const clause = and([restriction(name), absorb(name, granted)]);
    // A named rule used under NOT/none must retain its authored dependencies:
    // a generated absence guard is not evidence that the negative rule holds.
    if (clause !== false) {
      const summaries = inherited.map((from) =>
        summarizeReads(
          name,
          authoredRules.get(`${name}.${from}`)!,
          "source",
          true
        )
      );
      const mandatory = summarizeReads(name, restriction(name), "source", true);
      if (mandatory !== null && summaries.every((part) => part !== null))
        authoredPredicates.set(
          clause,
          combineReads(true, [mandatory, combineReads(false, summaries)])
        );
    }
    open.pop();
    predicates.set(key, clause);
    return clause;
  };
  /**
   * A disjunction without a member another member provably contains: where
   * `x ⇒ y`, `x ∨ y` is `y`, so `x` is dropped (the later of two equivalent
   * members). Rules evaluated at their declared action and inherited (a
   * grouped `"read, update": capped(rule)`) differ per action only by what
   * the higher action narrows (`role in [...]`, a coverage list), so the
   * narrower branches fold into the widest one, as the plan's one-branch
   * form had them, with the same rows. Sound, never complete (§11.4 D13):
   * what the prover cannot show stays.
   */
  const absorb = (name: string, clause: Clause): Clause => {
    if (clause === false || !Array.isArray(clause.OR)) return clause;
    // lower/or normalize siblings into AND, so OR is the only root key here.
    const members = clause.OR as Where[];
    const dropped = new Set<number>();
    for (let at = 0; at < members.length; at++) {
      const member = members[at]!;
      for (let other = 0; other < members.length; other++) {
        if (other === at || dropped.has(other)) continue;
        const wider = members[other]!;
        if (!implies(name, member, wider)) continue;
        // Equivalent members keep the earlier one.
        if (other > at && implies(name, wider, member)) continue;
        const before = members.filter((_, index) => !dropped.has(index));
        const after = members.filter(
          (_, index) => index !== at && !dropped.has(index)
        );
        if (
          !preservesReads(
            name,
            and([restriction(name), or(before)]),
            and([restriction(name), or(after)])
          )
        )
          continue;
        dropped.add(at);
        break;
      }
    }
    const kept = members.filter((_, at) => !dropped.has(at));
    return kept.length === 1 ? kept[0]! : { OR: kept };
  };

  /** A path the actor schema declares, or the refusal naming where it is read. */
  const path = (at: string, read: unknown) => {
    if (typeof read === "string" && !actor.hasPath(read))
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
    if (typeof rule === "boolean") return rule ? {} : false;
    if (typeof rule === "function")
      return lower(name, action, rule(action, modelOf(name)), at);
    if (!isRecord(rule))
      refuse(
        `${at}: a rule is a boolean, a where object or a function of the action`,
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
    let requiresEmpty = false;
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
      else if (op === "every") requiresEmpty = true;
    }
    // `every false` requires an empty relation, which implies any `none`
    // clause. Apply it last so property order cannot weaken the conjunction.
    if (requiresEmpty) out.none = {};
    return Object.keys(out).length === 0 ? undefined : out;
  };

  /**
   * Whether `a` implies `b`, both read at `name`, by their structure alone:
   * sound, never complete (a `false` only keeps a conjunct). It is what lets
   * a placement and a move say once what the statement already judges, so
   * the heaviest writes fit a provider's statement limits (plan §11.4).
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
    // A relation: the same walk, its body implied at the target. Negative
    // quantifiers reverse containment; their wrappers are never scalar keys.
    const ops = [...QUANTIFIERS].filter((op) => Object.hasOwn(value, op));
    if (ops.length === 0) return implies(target, given, value);
    return ops.every(
      (op) =>
        isRecord(given[op]) &&
        isRecord(value[op]) &&
        same(without(given, op), without(value, op)) &&
        (op === "none" || op === "isNot"
          ? implies(target, value[op], given[op])
          : implies(target, given[op], value[op]))
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
  /**
   * R6 reads parameters only after call conditions have folded. A read's
   * guard therefore includes both AND's false siblings and OR's true
   * siblings. Flat sets lose this distinction and can widen a policy.
   * These summaries describe only folding, never row truth or SQL.
   */
  interface ReadSummary {
    readonly yes: Clause;
    readonly no: Clause;
    readonly reads: ReadonlyMap<string, Clause>;
  }
  const negate = (guard: Clause): Clause => {
    if (guard === false) return {};
    if (isTrue(guard)) return false;
    if (Object.keys(guard).length === 1 && isRecord(guard.NOT))
      return guard.NOT;
    if (Array.isArray(guard.AND))
      return or(guard.AND.map((member: Where) => negate(member)));
    if (Array.isArray(guard.OR))
      return guardAnd(guard.OR.map((member: Where) => negate(member)));
    return { NOT: guard };
  };
  /** Boolean guards, unlike row predicates, have two-valued logic. Push
   * negation to conditions and remove repeated factors without distributing
   * conjunctions over disjunctions or expanding a truth table. */
  const guardAnd = (guards: readonly Clause[]): Clause => {
    const combined = and(guards);
    if (combined === false || !Array.isArray(combined.AND)) return combined;
    const kept: Where[] = [];
    for (const member of combined.AND)
      if (!kept.some((prior) => same(prior, member))) kept.push(member);
    return and(kept);
  };
  const falseSummary: ReadSummary = {
    yes: false,
    no: {},
    reads: new Map(),
  };
  const atomic = (
    reads: ReadonlyMap<string, Clause> = new Map()
  ): ReadSummary => ({
    yes: false,
    no: false,
    reads,
  });
  const combineReads = (
    conjunction: boolean,
    summaries: readonly ReadSummary[]
  ): ReadSummary => {
    const yes = (conjunction ? guardAnd : or)(
      summaries.map((part) => part.yes)
    );
    const no = (conjunction ? or : guardAnd)(summaries.map((part) => part.no));
    const live = negate(conjunction ? no : yes);
    const reads = new Map<string, Clause>();
    for (const part of summaries)
      for (const [key, guard] of part.reads) {
        const held = guardAnd([live, guard]);
        reads.set(key, or([reads.get(key) ?? false, held]));
      }
    return { yes, no, reads };
  };
  const summaries = new Map(
    Object.keys(schema).map((name) => [
      name,
      new WeakMap<object, ReadSummary | null>(),
    ])
  );
  const sourceSummaries = new Map(
    Object.keys(schema).map((name) => [
      name,
      new WeakMap<object, ReadSummary | null>(),
    ])
  );
  const negativeSummaries = new Map(
    Object.keys(schema).map((name) => [
      name,
      new WeakMap<object, ReadSummary | null>(),
    ])
  );
  const compiledSummaries = new Map(
    Object.keys(schema).map((name) => [
      name,
      new WeakMap<object, ReadSummary | null>(),
    ])
  );
  const parameterKey = (
    operand: unknown,
    spread: boolean
  ): string | undefined =>
    isRecord(operand) &&
    typeof operand.control === "string" &&
    (operand.path === undefined || typeof operand.path === "string") &&
    Object.keys(operand).every((key) => key === "control" || key === "path")
      ? JSON.stringify([operand.control, operand.path ?? null, spread])
      : undefined;
  const containsParameter = (operand: unknown): boolean =>
    parameterKey(operand, false) !== undefined ||
    (Array.isArray(operand)
      ? operand.some(containsParameter)
      : isRecord(operand) && Object.values(operand).some(containsParameter));
  const readOperators = new Set([
    "equals",
    "not",
    "in",
    "notIn",
    "lt",
    "lte",
    "gt",
    "gte",
    "contains",
    "startsWith",
    "endsWith",
    "has",
    "hasSome",
    "hasEvery",
    "isEmpty",
  ]);
  /** Ordinary scalar filters contain no call conditions. Exotic operands
   * are left alone rather than guessing how a provider reads their values. */
  const scalarReads = (operand: unknown): ReadSummary | null => {
    const direct = parameterKey(operand, false);
    if (direct !== undefined) return atomic(new Map([[direct, {}]]));
    if (!isRecord(operand)) return containsParameter(operand) ? null : atomic();
    if (Object.keys(operand).length === 0) return null;
    const reads = new Map<string, Clause>();
    for (const [operator, value] of Object.entries(operand)) {
      if (operator === "mode" || operator === "path") continue;
      if (!readOperators.has(operator)) return null;
      const key = parameterKey(
        value,
        operator === "in" || operator === "notIn"
      );
      if (key !== undefined) reads.set(key, {});
      else if (operator === "not" || operator === "equals") {
        const nested = scalarReads(value);
        if (nested === null) return null;
        for (const [read, guard] of nested.reads) reads.set(read, guard);
      } else if (
        Array.isArray(value) &&
        (operator === "in" || operator === "notIn")
      ) {
        for (const item of value) {
          const read = parameterKey(item, false);
          if (read !== undefined) reads.set(read, {});
          else if (containsParameter(item)) return null;
        }
      } else if (containsParameter(value)) return null;
    }
    // Modifier-only objects can also be literal JSON. Do not infer folding
    // without the scalar codec's admission decision.
    if (Object.keys(operand).every((key) => key === "mode" || key === "path"))
      return null;
    return atomic(reads);
  };
  const summarizeReads = (
    name: string,
    clause: unknown,
    source: "source" | "compiled" | undefined = undefined,
    negative = false
  ): ReadSummary | null => {
    if (clause === false) return falseSummary;
    if (!isRecord(clause)) return null;
    if (source === "source") {
      const original = authoredPredicates.get(clause);
      if (original !== undefined)
        return negative ? original : summarizeReads(name, clause, "compiled");
    }
    const cache = (
      source === "compiled"
        ? compiledSummaries
        : source
          ? negative
            ? negativeSummaries
            : sourceSummaries
          : summaries
    ).get(name)!;
    const known = cache.get(clause);
    if (known !== undefined) return known;
    const parts: ReadSummary[] = [];
    const unsupported = () => {
      cache.set(clause, null);
      return null;
    };
    for (const [key, value] of Object.entries(clause)) {
      if (LOGICAL.has(key)) {
        const bodies = Array.isArray(value) ? value : [value];
        const nested: ReadSummary[] = [];
        for (const body of bodies) {
          const summary = summarizeReads(
            name,
            body,
            source,
            negative || key === "NOT"
          );
          if (summary === null) return unsupported();
          nested.push(
            key === "NOT"
              ? { yes: summary.no, no: summary.yes, reads: summary.reads }
              : summary
          );
        }
        parts.push(combineReads(key !== "OR", nested));
      } else if (key === "$if") {
        if (!isRecord(value)) return unsupported();
        const guard = { $if: value };
        parts.push({ yes: guard, no: negate(guard), reads: new Map() });
      } else if (Object.hasOwn(stateOf(name).scalars, key)) {
        if (source && stateOf(name).scalars[key]!["~"].state.type === "json") {
          // Only complete JSON equality operands are value-node positions.
          // Nested JSON records that resemble markers remain literal data.
          const reads = new Map<string, Clause>();
          const collect = (value: unknown): void => {
            const direct = parameterKey(value, false);
            if (direct !== undefined) reads.set(direct, {});
            else if (isRecord(value)) {
              const equals = parameterKey(value.equals, false);
              if (equals !== undefined) reads.set(equals, {});
              if (isRecord(value.not)) collect(value.not);
            }
          };
          collect(value);
          parts.push(atomic(reads));
        } else {
          const summary = scalarReads(value);
          if (summary === null && !source) return unsupported();
          parts.push(summary ?? atomic());
        }
      } else {
        const target = targetOf(name, key);
        if (target === undefined) return unsupported();
        if (value === null) {
          parts.push(atomic());
          continue;
        }
        const bodies: { body: unknown; negative: boolean }[] = [];
        if (
          isRecord(value) &&
          Object.keys(value).some((op) => QUANTIFIERS.has(op))
        ) {
          for (const [op, body] of Object.entries(value)) {
            if (QUANTIFIERS.has(op))
              bodies.push({
                body,
                negative:
                  negative || op === "every" || op === "none" || op === "isNot",
              });
            else if (op !== "recurse" && op !== "self") return unsupported();
          }
        } else bodies.push({ body: value, negative });
        const relations: ReadSummary[] = [];
        for (const { body, negative: bodyNegative } of bodies) {
          if (body === null) {
            relations.push(atomic());
            continue;
          }
          const summary = summarizeReads(target, body, source, bodyNegative);
          if (summary === null) return unsupported();
          // A relation keeps its quantifier even when its body folds constant.
          relations.push(atomic(summary.reads));
        }
        parts.push(combineReads(true, relations));
      }
    }
    const result = combineReads(true, parts);
    cache.set(clause, result);
    return result;
  };
  const provesGuard = (name: string, a: Clause, b: Clause): boolean =>
    a === false || (b !== false && (isTrue(b) || implies(name, a, b)));
  /**
   * Each declared grant owns absence. Fold it false before generic R6 reads
   * its operands, keeping other grants available. Read guards come from the
   * same summary that simplification uses, so authored $if short circuits
   * still suppress unused dependencies. The guard surrounds the complete
   * rule, never a comparison that NOT/none/every could turn into a grant.
   */
  const provesPresence = (guard: Clause, path: string): boolean => {
    if (guard === false) return true;
    if (Array.isArray(guard.AND))
      return guard.AND.some((part: Where) => provesPresence(part, path));
    if (Array.isArray(guard.OR))
      return guard.OR.every((part: Where) => provesPresence(part, path));
    const condition = isRecord(guard.$if) ? guard.$if : undefined;
    const absent =
      isRecord(guard.NOT) && isRecord(guard.NOT.$if)
        ? guard.NOT.$if
        : undefined;
    const test = condition ?? (absent?.exists === false ? absent : undefined);
    return (
      test?.control === "actor" &&
      typeof test.path === "string" &&
      (test.path === path || test.path.startsWith(`${path}.`)) &&
      (condition === undefined || condition.exists !== false)
    );
  };
  const availableGrant = (name: string, clause: Clause): Clause => {
    if (clause === false) return clause;
    const summary = summarizeReads(name, clause, "source");
    if (summary === null) return clause;
    const guards: Clause[] = [];
    for (const [key, live] of summary.reads) {
      const [control, path] = JSON.parse(key) as [
        string,
        string | null,
        boolean,
      ];
      if (control !== "actor") continue;
      const uncertain = actor.availabilityPath(path ?? undefined);
      if (uncertain === undefined) continue;
      const present = {
        $if: { control: "actor", path: uncertain, exists: true },
      };
      if (provesPresence(live, uncertain) || provesGuard(name, live, present))
        continue;
      guards.push(or([negate(live), present]));
    }
    if (guards.length === 0) return clause;
    const guarded = and([guardAnd(guards), clause]);
    return guarded;
  };

  /** Equal conditional reads preserve missing/null AND non-list spread
   * refusals. This simplifier injects no guards. An unsupported
   * shape or unproved equivalence simply retains the original expression. */
  const preservesReads = (
    name: string,
    before: Clause,
    after: Clause
  ): boolean => {
    const left = summarizeReads(name, before);
    const right = summarizeReads(name, after);
    if (left === null || right === null) return false;
    // Both callers only delete clauses: no new parameter can appear after.
    // Entries survive even when their guard is false, so guard changes still
    // have to prove equivalence in both directions.
    for (const [key, a] of left.reads) {
      const b = right.reads.get(key) ?? false;
      if (!(provesGuard(name, a, b) && provesGuard(name, b, a))) return false;
    }
    return true;
  };
  /**
   * The conjunction of `clauses` without a member another one implies (or
   * one of `given`, which the same statement already judges). A member is
   * dropped only where the complete judgement retains the same conditional
   * parameter reads, including those supplied by `given` (R6).
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
      const covers = (other: Where) => implies(name, other, member);
      if (
        !(
          given.some(covers) ||
          kept.some((other, at) => at !== index && covers(other))
        )
      )
        continue;
      const remaining = kept.filter((_, at) => at !== index);
      if (
        preservesReads(
          name,
          and([...given, ...kept]),
          and([...given, ...remaining])
        )
      )
        kept.splice(index, 1);
    }
    return and(kept);
  };

  /**
   * The action each verb of a listed model takes (K3, OD-3): `operations`,
   * else read, update and delete; a verb whose action the model does not
   * declare takes none. Adding actions never changes an operation mapping.
   */
  const verbsFor = (name: string) => {
    const model = modelOf(name);
    const operations = config.models[name]!.operations ?? {};
    const verbs: Record<string, string> = {};
    for (const [verb, fallback] of [
      ["read", "read"],
      ["update", "update"],
      ["delete", "delete"],
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
          `models.${name}.${role} names "${action}", which ${name} does not declare. Declared actions: ${model.actions.join(", ") || "none"}. Add its rule or choose a declared action.`,
          name
        );
      return action;
    };
    const named = new Map<string, Where>();
    /** One name space per model: actions, domains, placement and moves. */
    const claim = (key: string, at: string, clause: Where) => {
      if (named.has(key))
        refuse(
          `${at}: an action, a domain, the placement or a move already has the name "${key}"`,
          name
        );
      named.set(key, clause);
    };
    for (const action of model.actions)
      named.set(action, and([P(name, action), scope(name, action)]) || FALSE);

    const operations = policy.operations ?? {};
    for (const operation of Object.keys(operations))
      if (!OPERATIONS.has(operation))
        refuse(
          `models.${name}.operations.${operation}: not a configurable operation; use read, update or delete (create always uses its own grant)`,
          name
        );
    for (const verb of ["read", "update", "delete"] as const)
      declared(`operations.${verb}`, operations[verb]);
    const verbs = verbsFor(name);
    const evidence = actions.get(name)!.evidence;

    const writes: Record<string, string> = {};
    const reads: Record<string, string> = {};
    const state = stateOf(name);
    for (const [field, entry] of Object.entries(policy.fields ?? {})) {
      const unknown = isRecord(entry)
        ? Object.keys(entry).find((key) => !FIELD_KEYS.has(key))
        : "";
      if (unknown !== undefined)
        refuse(
          `models.${name}.fields.${field}${unknown ? `.${unknown}` : ""}: a field entry takes only read and write`,
          name
        );
      const { read, write } = entry;
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
      if (write !== undefined) {
        declared(`fields.${field}.write`, write);
        if (write === verbs.update) writes[field] = write;
        else {
          // Field protection narrows the operation's grant. Core chooses one
          // write predicate per field, so compose both permissions here rather
          // than letting a field grant replace a denied or absent update grant.
          const protectedWrite = `$write:${field}`;
          claim(
            protectedWrite,
            `models.${name}.fields.${field}.write`,
            and([
              verbs.update === undefined ? false : named.get(verbs.update)!,
              named.get(write)!,
            ]) || FALSE
          );
          writes[field] = protectedWrite;
        }
      }
      // A key, a foreign key or a relation is refused by K5's admission.
      if (read === undefined) continue;
      reads[field] = declared(`fields.${field}.read`, read)!;
    }
    // Creation is a named action evaluated on the proposed row. Its placement
    // adds target visibility; moves reuse the row rule without requiring a
    // create credential scope for an update.
    const create = P(name, "create");
    const keys = keysOf(name);
    claim(
      PLACE,
      `models.${name}.create`,
      conjoin(name, [
        create,
        scope(name, "create"),
        ...keys.map(({ clause }) => clause),
      ]) || FALSE
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
        .map((action) => named.get(action)!);
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

    const modes = new Map<string, string>(
      model.actions.map((action) => [action, action])
    );
    for (const [domain, rule] of Object.entries(policy.domains ?? {})) {
      const at = `models.${name}.domains.${domain}`;
      claim(domain, at, lower(name, "read", rule, at) || FALSE);
      modes.set(domain, domain);
    }
    // One `as` name space for every model: the default is no action's.
    if (modes.has(DEFAULT_MODE))
      refuse(
        `models.${name}: "${DEFAULT_MODE}" is the mode a call takes by default, not an action or a domain`,
        name
      );

    compiled[name] = Object.freeze({
      predicates: Object.freeze(Object.fromEntries(named)),
      ...verbs,
      writes: Object.freeze(writes),
      reads: Object.freeze(reads),
      modes: Object.freeze(Object.fromEntries(modes)),
      place: PLACE,
      moves: Object.freeze(moves),
      // Per row, always one boolean for each admitted action.
      ...(evidence.names.length > 0 && {
        evidence: Object.freeze({
          as: EVIDENCE_KEY,
          names: Object.freeze(evidence.names),
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
  const scopes = Object.fromEntries(
    [...actions].flatMap(([name, declared]) =>
      [...declared.closure].map(([action, implied]) => [
        `${name}.${action}`,
        Object.freeze(implied.map((next) => `${name}.${next}`)),
      ])
    )
  );
  return Object.freeze({
    control: "actor",
    scopes: Object.freeze(scopes),
    models: Object.freeze(compiled),
  });

  /**
   * Per model, the self relations holding a key that some compiled
   * predicate recurses over, wherever it is read.
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
