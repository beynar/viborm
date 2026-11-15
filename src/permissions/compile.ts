// The one formula of viborm/permissions (plan §3.2 R1), compiled once per schema:
//
//   P(M, a) = scopes(M, a) ∧ mandatory(M) ∧ ⋁_{b ⊒ a} rule(M, b)(b)
//
// Rule functions are evaluated here for their declared action, and
// the policy's spellings are lowered to the words of a rule: `{ actor: "p" }`
// in a value position is `arg("actor", "p")`, `{ actor: { p: v } }` in a filter
// a `provided` test of it, `$if` and `$exists` their words, and a relation
// whose value is an action name the target's predicate at that action,
// inlined (D7). What comes out is each model's rule entry (K3): its read
// predicate, its read-gated fields and `$access` facts (D5, D6, K5), its
// modes, the produced row's placement, moves and acyclic relations (R4, K4),
// and the predicate each write takes. A placement or a move drops a conjunct
// another one, or a judgement the same statement makes, provably implies
// (plan §11.4). The proof reads what each word it wrote stands for.

import { ClientInitializationError } from "../errors";
import { check, facts, gate, only } from "../extensions/judge-words";
import {
  arg,
  exists,
  nothing,
  now,
  provided,
  row,
  when,
} from "../extensions/rule-words";
import type { ArgTest, VibORMConfig } from "../index";
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
  readonly mandatory?: Where;
  readonly models: { readonly [model: string]: ModelPolicy };
  /**
   * `"allow"` lets a governed read be served from the cache (OD-10). A cached
   * answer was judged when it was stored: a revoked grant or an expired
   * session reaches it only after its TTL. Refused when absent.
   */
  readonly cache?: "allow";
  /**
   * The tenant a governed call stays in: on every model with a scalar
   * `field` but the ones `except` names, a set the policy's rules compute
   * over a whole table, where a positive test reads it, holds only the rows
   * whose `field` is the actor's `actor` path (`rows.confine`). Nothing else
   * reads differently. `except` names the models whose rows a rule reads
   * beyond the actor's tenant: a person's memberships of other
   * organizations, a shared catalogue.
   */
  readonly tenant?: {
    readonly field: string;
    readonly actor: string;
    readonly except?: readonly string[];
  };
}

/**
 * One model's rule entry, as `permissions` hands it to the chain: its read
 * predicate, each field it gates and its `$access` facts, the modes that
 * narrow a call's own rows (`root`), the placement every created row
 * satisfies (R4), and the predicate each write takes: an update writing a
 * protected field its own (R3), one writing a field the placement reads the
 * placement again (a move). A verb whose action the model does not declare
 * takes no row. Predicates are shared by identity wherever they are read.
 */
export interface CompiledModel {
  readonly read: {
    readonly where: object;
    readonly fields: { readonly [field: string]: Gate };
    readonly select?: { readonly [key: `$${string}`]: Facts };
  };
  readonly root?: readonly object[];
  readonly create: { readonly check: Check };
  readonly update: {
    readonly where: Only;
    readonly fields: {
      readonly [field: string]: {
        readonly where?: Only;
        readonly check?: Check;
      };
    };
  };
  readonly delete: { readonly where: Only };
  /** The self relations an update keeps acyclic: they need every model compiled. */
  readonly acyclic: () => readonly string[];
}
type Gate = ReturnType<typeof gate<unknown>>;
type Facts = ReturnType<typeof facts<string>>;
type Check = ReturnType<typeof check<unknown>>;
type Only = ReturnType<typeof only<unknown>>;

export interface CompiledPolicy {
  /** Each admitted scope and its transitive implications, including itself. */
  readonly scopes: Readonly<Record<string, readonly string[]>>;
  /** Every model of the schema: one the policy does not list holds nothing (R9). */
  readonly models: { readonly [model: string]: CompiledModel };
}

/** The `as` value a call takes when it names none: it narrows nothing. */
export const DEFAULT_MODE = "default";
/** The call argument that narrows a call to one action or domain (R8). */
export const MODE = "as";
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
/** Keys a declaration no longer takes, and what took their place. */
const RETIRED: Readonly<Record<string, string>> = {
  within: 'was renamed to "mandatory"',
  arms: "was removed; assign rules to named actions",
};
const OPERATIONS = new Set(["read", "update", "delete"]);
const CRUD = new Set(["create", "read", "update", "delete"]);
const CONFIG_KEYS = new Set([
  "actor",
  "mandatory",
  "models",
  "cache",
  "tenant",
]);
const FIELD_KEYS = new Set(["read", "write"]);

const LOGICAL = new Set(["AND", "OR", "NOT"]);
/** A check of another model's rows that reads no column of the row judged. */
const EXISTS = "$exists";
/** A row a rule reads: its model, and why a `{ $row, up }` may not cross it. */
interface Scope {
  readonly model: string;
  readonly sealed?: string;
}
/** `{ $row, up }`: a column of a row the rule reads, `up` bodies above. */
const isEnclosingRow = (
  value: unknown
): value is { readonly $row: string; readonly up: number } =>
  isRecord(value) &&
  Object.keys(value).length === 2 &&
  typeof value.$row === "string" &&
  Number.isSafeInteger(value.up) &&
  (value.up as number) >= 0;
const QUANTIFIERS = new Set(["is", "isNot", "some", "every", "none"]);
/**
 * A plain object: a clause or an operator's record, never a value (a Date, a
 * Decimal, bytes). A field reference is a plain object whose only key is a
 * symbol: read as a record it would be `{}`, true everywhere, so an object
 * with a symbol key is a value.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.getOwnPropertySymbols(value).length === 0
  );
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
/**
 * A rule's record that writes `$if` or `$exists` beside its filters: the one
 * conjunction it was written as, which a conjunction it joins holds whole,
 * and its conjuncts in the order the rule spells them.
 */
export const written = new WeakMap<Where, readonly Where[]>();

function and(clauses: readonly Clause[]): Clause {
  if (clauses.includes(false)) return false;
  const kept = (clauses as Where[])
    .filter((clause) => !isTrue(clause))
    .flatMap((clause) =>
      written.has(clause) ? [clause] : membersOf(clause, "AND")
    );
  if (kept.length < 2) return kept[0] ?? {};
  return { AND: kept };
}

/**
 * What a word the compiler writes stands for, as its proof reads it: an
 * argument's value (its argument and path), a condition on one (the value
 * and its test), another model's rows (the model and the `where` they
 * match), a column of an enclosing row (its column and how many bodies up).
 */
type Made =
  | { readonly arg: readonly [control: string, path: unknown] }
  | { readonly provided: readonly [tested: object, test: Where] }
  | { readonly exists: readonly [model: string, body: Where] }
  | { readonly row: readonly [column: string, up: unknown] };
/**
 * One compilation's structural keys: two values share a key exactly when they
 * are the same value, numbers by `Object.is` (NaN and ±Infinity are no
 * `null`), bigints, valid dates by their instant, arrays and records member by
 * member; anything else by identity. A record or an array is keyed once, so
 * equality, duplicate removal and the implication cache cost one lookup
 * however often a shared clause is met. Keys hold only for one compilation,
 * which never mutates what it reads.
 */
function structuralKeys(made: WeakMap<object, Made>) {
  const shapes = new Map<string, string>();
  const known = new WeakMap<object, string>();
  // Opaque values (a Decimal, bytes, a symbol) are equal only to themselves.
  const opaque = new Map<unknown, string>();
  let next = 0;
  const keyOf = (value: unknown): string => {
    switch (typeof value) {
      case "number":
        return Object.is(value, -0) ? "n-0" : `n${value}`;
      case "string":
        return `s${JSON.stringify(value)}`;
      case "bigint":
        return `b${value}`;
      case "boolean":
      case "undefined":
        return `p${value}`;
      default:
        break;
    }
    if (value === null) return "pnull";
    // A date is read at each comparison; an invalid one equals only itself.
    if (value instanceof Date && !Number.isNaN(value.getTime()))
      return `d${value.getTime()}`;
    if (typeof value !== "object") {
      let key = opaque.get(value);
      if (key === undefined) opaque.set(value, (key = `o${next++}`));
      return key;
    }
    let key = known.get(value);
    if (key !== undefined) return key;
    // A word is what it stands for; another value equals only itself.
    const word = made.get(value);
    if (word !== undefined) key = `w${keyOf(word)}`;
    else if (Array.isArray(value) || isRecord(value)) {
      const shape = Array.isArray(value)
        ? `[${value.map(keyOf).join(",")}]`
        : `{${Object.keys(value)
            .sort()
            .map((field) => `${JSON.stringify(field)}:${keyOf(value[field])}`)
            .join(",")}}`;
      key = shapes.get(shape);
      if (key === undefined) shapes.set(shape, (key = `#${next++}`));
    } else key = `o${next++}`;
    known.set(value, key);
    return key;
  };
  const same = (x: unknown, y: unknown): boolean =>
    (x === y && typeof x !== "number") || keyOf(x) === keyOf(y);
  /** `members` without a repeated value, in order. */
  const distinct = <T>(members: readonly T[]): T[] => {
    const seen = new Set<string>();
    return members.filter((member) => {
      const key = keyOf(member);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const or = (clauses: readonly Clause[]): Clause => {
    const kept = clauses.filter((clause): clause is Where => clause !== false);
    if (kept.length === 0) return false;
    if (kept.some(isTrue)) return {};
    // Rules have already been evaluated at their declaring actions. Equal
    // resulting branches contribute once without suppressing callback evaluation.
    const flat = distinct(kept.flatMap((member) => membersOf(member, "OR")));
    return flat.length === 1 ? flat[0]! : { OR: flat };
  };
  return { keyOf, same, distinct, or };
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
function actionsOf(name: string, policy: ModelPolicy): ActionRules {
  const implies = new Map<string, readonly string[]>(
    Object.entries(policy.actions ?? {})
  );
  const rules = new Map<
    string,
    { readonly rule: Rule | undefined; readonly source: string }
  >();
  // Never reinterpret a key of the declaration, nor an old restriction or
  // grant container, as an action.
  const notAction = (key: string, at: string) => {
    if (Object.hasOwn(RETIRED, key))
      refuse(`${at}: "${key}" ${RETIRED[key]}`, name);
    if (RESERVED.has(key))
      refuse(
        `${at}: "${key}" is a key of the declaration, not an action`,
        name
      );
  };
  // Only a model's rule keys can group actions. Graph edges name individual
  // actions, so accepting a comma there would create another action.
  for (const action of [...implies.keys(), ...[...implies.values()].flat()])
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
      notAction(key, source);
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
      // Without a graph a model's actions are CRUD: any other key is a typo
      // or a custom action, and was never to become a permission unlisted.
      if (!CRUD.has(key))
        refuse(
          `${source}: "${key}" is not create, read, update or delete. A custom action is declared in the model's graph (one outside a graph was removed): actions: { read: [], ${key}: ["read"] }`,
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
    notAction(action, `models.${name}`);
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
    closure.set(action, [...reached]);
  }
  return {
    rules,
    closure,
    evidence: { names: [...implies.keys()] },
  };
}

/**
 * What a policy's arguments accept, read from the declaration alone: every
 * `as` value (the default, each listed model's actions and domains) and
 * each credential scope with the scopes it implies. A declaration the
 * compiler refuses yields the default alone: applying it refuses it there.
 */
export function policyArguments(config: PermissionsConfig): {
  readonly modes: readonly string[];
  readonly scopes: Readonly<Record<string, readonly string[]>>;
} {
  try {
    const modes = new Set<string>([DEFAULT_MODE]);
    const scopes: Record<string, readonly string[]> = {};
    for (const [name, policy] of Object.entries(config.models)) {
      const { closure } = actionsOf(name, policy);
      for (const [action, implied] of closure) {
        modes.add(action);
        scopes[`${name}.${action}`] = implied.map((next) => `${name}.${next}`);
      }
      for (const domain of Object.keys(policy.domains ?? {})) modes.add(domain);
    }
    return { modes: [...modes], scopes };
  } catch {
    return { modes: [DEFAULT_MODE], scopes: {} };
  }
}

/** `{ control, path? }`: an argument's value, as a rule may spell one. */
const isReference = (
  value: Record<string, unknown>
): value is { readonly control: string; readonly path?: unknown } =>
  typeof value.control === "string" &&
  Object.keys(value).every((key) => key === "control" || key === "path");

/**
 * Compiles a policy against the schema it governs, every model at once: what
 * `policy.compile(schema)` shows.
 */
export function compilePolicy(
  config: PermissionsConfig,
  schema: Schema,
  actor: ActorContract = actorContract(config.actor)
): CompiledPolicy {
  const compiler = policyCompiler(config, schema, actor);
  return {
    scopes: policyArguments(config).scopes,
    models: Object.fromEntries(
      Object.keys(schema).map((name) => [name, compiler.model(name).entry])
    ),
  };
}

/** A model's verbs and `as` modes: what applying a policy needs before any query. */
export interface DeclaredModel {
  readonly read?: string;
  readonly update?: string;
  readonly delete?: string;
  /** Its actions, then its domains: each names the predicate of its own name. */
  readonly modes: readonly string[];
  /** What the policy's own whole-table sets of this model hold (`tenant`). */
  readonly bound?: Where | undefined;
}

/** What a model declares, read without lowering a rule. */
interface Declared extends DeclaredModel {
  /** Field → the predicate an update writing it takes (by name). */
  readonly writes: { readonly [field: string]: string };
  /** The fields whose write action is not the update verb's: `$write:<field>`. */
  readonly protectedWrites: readonly (readonly [
    field: string,
    write: string,
  ])[];
  readonly reads: { readonly [field: string]: string };
  /** Field → its move (filled when the model compiles). */
  readonly moves?: { readonly [field: string]: string };
}
/** A model the policy does not list declares nothing. */
const UNLISTED: Declared = {
  modes: [],
  writes: {},
  protectedWrites: [],
  reads: {},
};

/**
 * One policy against one schema, compiled a model at a time. Building it
 * checks everything the declaration says without lowering a rule (its keys,
 * models, action graphs, operations, fields and `as` names), so those
 * refusals come when the policy is applied; a rule's own refusals (a field,
 * an actor path, a relation's action, a rule that reads itself) come when
 * its model is first compiled. Models compile into one shared state, so each
 * predicate is lowered once whatever order they are asked in, and the output
 * is the same as compiling every model at once.
 */
export interface PolicyCompiler {
  /** Every model of the schema: its verbs and modes. */
  readonly declared: { readonly [model: string]: DeclaredModel };
  /** One model compiled: one the policy does not list holds nothing (R9). */
  model(name: string): Compiled;
}

const NO_RELATIONS: readonly string[] = [];
/** One model compiled: its predicates by name, which `acyclic` walks, and its entry. */
export interface Compiled {
  readonly predicates: ReadonlyMap<string, Where>;
  readonly entry: CompiledModel;
}

export function policyCompiler(
  config: PermissionsConfig,
  schema: Schema,
  actor: ActorContract = actorContract(config.actor)
): PolicyCompiler {
  const made = new WeakMap<object, Made>();
  const { keyOf, same, distinct, or } = structuralKeys(made);
  /** What `word` stands for, kept for the proof. */
  const wrote = (word: object, stands: Made): Where => {
    made.set(word, stands);
    // A word stands where a filter or a value goes: the rule's admission
    // reads it in that place, its members hidden from every type.
    return word as Where;
  };
  const madeOf = (value: unknown): Made | undefined =>
    typeof value === "object" && value !== null ? made.get(value) : undefined;
  /** A filter: a `where`, or a word that stands for one. */
  const isClause = (value: unknown): value is Where =>
    isRecord(value) || madeOf(value) !== undefined;
  /** An argument's value: the actor's, or the call's scopes. */
  const ref = (control: string, path?: unknown) =>
    // The rule's admission refuses a path that is not a string.
    wrote(arg(control, path as string | undefined), {
      arg: [control, path],
    });
  /** True only where the argument's value passes the test. */
  const condition = (control: string, path: unknown, test: Where) => {
    // The rule's admission refuses a path that is not a string.
    const tested = arg(control, path as string | undefined);
    // The rule's admission checks the test and refuses another shape.
    return wrote(provided(tested, test as ArgTest), {
      provided: [wrote(tested, { arg: [control, path] }), test],
    });
  };
  for (const key of Object.keys(config))
    if (!CONFIG_KEYS.has(key))
      refuse(
        key === "levels"
          ? 'levels was removed: declare the graph on each model instead, actions: { read: [], update: ["read"], full: ["update"] }'
          : `"${key}" is not a key of the policy (${[...CONFIG_KEYS].join(", ")})`
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
      actionsOf(name, policy),
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
  const rules = new Map<string, Clause>();
  const predicates = new Map<string, Clause>();
  /** Every `P(M, a)`: inlined anywhere, its `{ $row, up }` never leaves it. */
  const inlined = new WeakSet<Where>();
  const open: string[] = [];
  const scope = (name: string, action: string): Where => ({
    OR: [
      condition("scopes", "unrestricted", { equals: true }),
      condition("scopes", "allowed", { has: `${name}.${action}` }),
    ],
  });
  const ruleAt = (name: string, action: string): Clause => {
    const key = `${name}.${action}`;
    const known = rules.get(key);
    if (known !== undefined) return known;
    const binding = actions.get(name)!.rules.get(action);
    const clause =
      binding?.rule === undefined
        ? false
        : lower(name, action, binding.rule, binding.source);
    rules.set(key, clause);
    return clause;
  };
  const restrictions = new Map<string, Clause>();
  const restriction = (name: string): Clause => {
    const known = restrictions.get(name);
    if (known !== undefined) return known;
    // Lowered at no action: a callback in it is refused where it stands.
    const clause = and([
      lower(
        name,
        undefined,
        config.models[name]!.mandatory ?? {},
        `models.${name}.mandatory`
      ),
      lower(name, undefined, config.mandatory ?? {}, "mandatory"),
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
    // A compiler outlives a refusal (a model compiles at its first call, and
    // the next call asks again): the walk is unwound whatever happens.
    try {
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
      predicates.set(key, clause);
      if (clause !== false) inlined.add(clause);
      return clause;
    } finally {
      open.pop();
    }
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
    let judgement = and([restriction(name), clause]);
    for (let at = 0; at < members.length; at++) {
      const member = members[at]!;
      for (let other = 0; other < members.length; other++) {
        if (other === at || dropped.has(other)) continue;
        const wider = members[other]!;
        if (!implies(name, member, wider)) continue;
        // Equivalent members keep the earlier one.
        if (other > at && implies(name, wider, member)) continue;
        const after = members.filter(
          (_, index) => index !== at && !dropped.has(index)
        );
        const reduced = and([restriction(name), or(after)]);
        if (!preservesReads(name, judgement, reduced)) continue;
        judgement = reduced;
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
  /** Each model's tenant bound (`tenant`), checked once: undefined where the model has no such field. */
  const tenantOf = (
    tenant: PermissionsConfig["tenant"]
  ): ((name: string) => Where | undefined) => {
    if (tenant === undefined) return () => undefined;
    const except = tenant?.except ?? [];
    if (
      !isRecord(tenant) ||
      typeof tenant.field !== "string" ||
      typeof tenant.actor !== "string" ||
      !Array.isArray(except) ||
      except.some((name) => typeof name !== "string") ||
      Object.keys(tenant).some(
        (key) => key !== "field" && key !== "actor" && key !== "except"
      )
    )
      refuse(
        "tenant is { field, actor, except? }: the scalar field that names a row's tenant, the actor path that names the caller's, and the models read beyond it"
      );
    path("tenant.actor", tenant.actor);
    const holds = (name: string) =>
      Object.hasOwn(stateOf(name).scalars, tenant.field);
    if (!Object.keys(schema).some(holds))
      refuse(
        `tenant.field: no model of the schema has a scalar field "${tenant.field}"`
      );
    for (const name of except)
      if (!(Object.hasOwn(schema, name) && holds(name)))
        refuse(
          `tenant.except names ${name}, which is not a model of the schema with a scalar field "${tenant.field}"`
        );
    const bound: Where = { [tenant.field]: ref("actor", tenant.actor) };
    return (name) =>
      holds(name) && !except.includes(name) ? bound : undefined;
  };
  /**
   * A value position: the actor's fields and the other spellings of a value
   * as their words, checked. A document compared whole (a JSON value) is a
   * literal: an actor value is the operand itself, never an object inside it.
   */
  const value = (
    at: string,
    input: unknown,
    enclosing: (row: { readonly $row: string; readonly up: number }) => void,
    spelled = true
  ): unknown => {
    // A list's members keep `{ actor }` as written and check no path.
    if (Array.isArray(input))
      return input.map((item) => value(at, item, enclosing, false));
    if (spelled && isActorField(input)) {
      path(at, input.actor);
      return ref("actor", input.actor);
    }
    if (!isRecord(input)) return input;
    if (spelled && input.control === "actor") path(at, input.path);
    if (isReference(input)) return ref(input.control, input.path);
    const keys = Object.keys(input);
    if (typeof input.$row === "string" && keys.length === 2) {
      // `up` counts bodies: another value would read the rule's own row.
      if (!isEnclosingRow(input))
        refuse(
          `${at}: { $row, up } takes a column and a whole number, 0 or more`
        );
      enclosing(input);
      return wrote(row(input.$row, input.up as number), {
        row: [input.$row, input.up],
      });
    }
    if (input.now === true && keys.length === 1) return now;
    return Object.fromEntries(
      keys.map((key) => [
        key,
        key === "equals" &&
        isRecord(input[key]) &&
        !isReference(input[key]) &&
        !isActorField(input[key])
          ? input[key]
          : value(at, input[key], enclosing, spelled),
      ])
    );
  };
  /** `{ actor: { p: v } }` in a filter: one condition per leaf. */
  const conditions = (at: string, facts: unknown, prefix = ""): Where[] => {
    if (!isRecord(facts))
      refuse(
        `${at} tests the actor with a value that is not an object of its facts`
      );
    // An empty object tests nothing: it would hold for every actor.
    if (Object.keys(facts).length === 0)
      refuse(
        `${at} tests the actor${prefix ? ` at "${prefix.slice(0, -1)}"` : ""} with an empty object`
      );
    return Object.entries(facts).flatMap(([key, fact]) => {
      const read = `${prefix}${key}`;
      if (isRecord(fact)) return conditions(at, fact, `${read}.`);
      path(at, read);
      if (fact !== null && typeof fact === "object")
        refuse(
          `${at} tests actor path "${read}" against ${Array.isArray(fact) ? "a list" : "a value that is not a literal"}`
        );
      return [
        condition(
          "actor",
          read,
          fact === null ? { exists: false } : { equals: fact }
        ),
      ];
    });
  };

  /**
   * A rule function's predicate. Whatever it throws is its model's refusal,
   * like any other mistake in a rule: it fails that model, never another.
   */
  const evaluated = (
    rule: Extract<Rule, (...args: never[]) => unknown>,
    action: string,
    name: string,
    at: string
  ): unknown => {
    try {
      return rule(action, modelOf(name));
    } catch (error) {
      if (error instanceof ClientInitializationError) throw error;
      return refuse(
        `${at}: the rule function threw at "${action}"`,
        name,
        error
      );
    }
  };
  /** A rule of `name` read at `action` (written at `at`), lowered to the `where` vocabulary. */
  const lower = (
    name: string,
    action: string | undefined,
    rule: unknown,
    at: string,
    scopes: readonly Scope[] = [{ model: name }]
  ): Clause => {
    if (typeof rule === "boolean") return rule ? {} : false;
    if (typeof rule === "function")
      return action === undefined
        ? refuse(
            `${at}: mandatory is action-independent and cannot contain callbacks`,
            name
          )
        : lower(
            name,
            action,
            evaluated(
              rule as Extract<Rule, (...args: never[]) => unknown>,
              action,
              name,
              at
            ),
            at,
            scopes
          );
    if (!isRecord(rule))
      refuse(
        `${at}: a rule is a boolean, a where object or a function of the action`,
        name
      );
    const state = stateOf(name);
    const out: Record<string, unknown> = {};
    const also: Clause[] = [];
    let tested: Where | undefined;
    let existing: Where | undefined;
    for (const [key, member] of Object.entries(rule)) {
      if (LOGICAL.has(key)) {
        const list = (Array.isArray(member) ? member : [member]).map((item) =>
          lower(name, action, item, at, scopes)
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
        const { control, path: read, ...test } = isRecord(member) ? member : {};
        // A name the words take for the call's instant: refused here, in
        // the policy's own terms.
        if (typeof control !== "string")
          refuse(
            `${at}: $if names one control and exactly one test of it`,
            name
          );
        if (control === "actor") path(at, read);
        tested = condition(control as string, read, test);
      } else if (key === EXISTS) {
        // Another model's rows, read at their own model: action names are
        // that model's predicates (D7), as in a relation's body.
        const models = isRecord(member) ? Object.keys(member) : [];
        const [model] = models;
        if (models.length !== 1 || !Object.hasOwn(schema, model!))
          refuse(
            `${at}: $exists names exactly one model of the schema and the where its rows must match`,
            name
          );
        // One body below this row, joined to nothing.
        const body = lower(model!, action, (member as Where)[model!], at, [
          ...scopes,
          { model: model! },
        ]);
        if (body === false) return false;
        existing = wrote(exists({ [model!]: body }), {
          exists: [model!, body],
        });
      } else if (member === undefined) {
        // A filter's `undefined` filters nothing: in a rule it would grant
        // every row, as an absent value never should.
        refuse(
          `${at}: ${key} is compared with undefined, which holds for every row; compare with null, a literal or an actor value`,
          name
        );
      } else if (targetOf(name, key) !== undefined) {
        const lowered = relation(name, action, key, member, at, scopes);
        if (lowered === false) return false;
        if (lowered !== undefined) out[key] = lowered;
      } else {
        out[key] = value(at, member, (operand) =>
          enclosingRow(name, key, operand, at, scopes)
        );
      }
    }
    const words = [tested, existing].filter((word) => word !== undefined);
    if (words.length === 0) return and([out, ...also]);
    const held: Where =
      isTrue(out) && words.length === 1
        ? words[0]!
        : { AND: [...(isTrue(out) ? [] : [out]), ...words] };
    written.set(
      held,
      Object.keys(rule).flatMap((key) =>
        key === "$if"
          ? [tested!]
          : key === EXISTS
            ? [existing!]
            : Object.hasOwn(out, key)
              ? [{ [key]: out[key] }]
              : []
      )
    );
    return and([held, ...also]);
  };

  /**
   * A `{ $row, up }` in a scalar's operand names a column of a row the rule
   * reads (its own at `up: 0`), never past the rule's root, an `$exists`
   * body's, or a recursive relation's body.
   */
  const enclosingRow = (
    name: string,
    key: string,
    operand: { readonly $row: string; readonly up: number },
    at: string,
    scopes: readonly Scope[]
  ): void => {
    const spelled = `{ $row: ${JSON.stringify(operand.$row)}, up: ${operand.up} }`;
    const index = scopes.length - 1 - operand.up;
    if (index < 0)
      refuse(
        `${at}: ${key} compares ${spelled}, which reaches past the rule (${scopes.length - 1} relation bodies deep here)`,
        name
      );
    const crossed = scopes.slice(index + 1).find((scope) => scope.sealed);
    if (crossed)
      refuse(
        `${at}: ${key} compares ${spelled} across a recursive relation to ${crossed.model}`,
        name
      );
    const owner = scopes[index]!.model;
    if (!Object.hasOwn(stateOf(owner).scalars, operand.$row))
      refuse(
        `${at}: ${key} compares ${spelled}, and ${owner} has no scalar field "${operand.$row}"`,
        name
      );
  };
  /** A relation filter: an action name is the target's predicate (D7). */
  const relation = (
    name: string,
    action: string | undefined,
    key: string,
    member: unknown,
    at: string,
    scopes: readonly Scope[]
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
    // A field reference, a Date or any other value is not a relation filter.
    if (typeof member === "object" && member !== null && !isRecord(member))
      refuse(
        `${at} filters ${key} with a value that is not a filter object, an action name or null`,
        name
      );
    if (!isRecord(member)) return member;
    if (!Object.keys(member).some((op) => QUANTIFIERS.has(op)))
      return lower(target, action, member, at, [...scopes, { model: target }]);
    const out: Record<string, unknown> = {};
    let requiresEmpty = false;
    const scope = {
      model: target,
      ...(member.recurse !== undefined && { sealed: "recursive" }),
    };
    for (const [op, body] of Object.entries(member)) {
      if (!(QUANTIFIERS.has(op) && body !== null)) {
        out[op] = body;
        continue;
      }
      const lowered = lower(target, action, body, at, [...scopes, scope]);
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
      new Map<string, Map<string, boolean>>(),
    ])
  );
  const implies = (name: string, a: Where, b: Where): boolean => {
    if (a === b) return true;
    // Keyed by structure: simplification rebuilds equal guards many times.
    const byModel = implied.get(name)!;
    const left = keyOf(a);
    let row = byModel.get(left);
    if (row === undefined) byModel.set(left, (row = new Map()));
    const right = keyOf(b);
    let answer = row.get(right);
    if (answer === undefined) row.set(right, (answer = provable(name, a, b)));
    return answer;
  };
  const provable = (name: string, a: Where, b: Where): boolean => {
    const right = conjuncts(b);
    if (right.length !== 1)
      return right.every((member) => implies(name, a, member));
    const left = conjuncts(a);
    const [key, given] = headOf(left[0] ?? { AND: [] });
    const [wanted, value] = headOf(right[0]!);
    if (left.length === 1 && key === "OR")
      return (given as Where[]).every((member) => implies(name, member, b));
    if (
      wanted === "OR" &&
      (value as Where[]).some((member) => implies(name, a, member))
    )
      return true;
    if (left.length !== 1)
      return left.some((member) => implies(name, member, b));
    if (key !== wanted) return false;
    const mine = madeOf(left[0]);
    const theirs = madeOf(right[0]);
    if (mine && theirs && "provided" in mine && "provided" in theirs) {
      const [tested, test] = mine.provided;
      const [other, wider] = theirs.provided;
      return (
        same(mine, theirs) ||
        (same(tested, other) && narrower(test, wider, "hasSome"))
      );
    }
    if (mine && theirs && "exists" in mine && "exists" in theirs) {
      // EXISTS is monotone: a narrower body finds a row only where a wider one does.
      const [left, narrow] = mine.exists;
      const [right, wide] = theirs.exists;
      return left === right && implies(left, narrow, wide);
    }
    if (!(isRecord(given) && isRecord(value))) return same(given, value);
    if (key === "NOT") return implies(name, value, given);
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
  /**
   * A conjunct's one key and its member: what a word stands for under the
   * key a rule spells it with.
   */
  const headOf = (clause: Where): [string, unknown] => {
    const word = madeOf(clause);
    return word === undefined
      ? Object.entries(clause)[0]!
      : ["exists" in word ? EXISTS : "$if", clause];
  };
  /** Stable decomposition lets the implication cache reuse each owned member. */
  const conjunctions = new WeakMap<Where, readonly Where[]>();
  const conjuncts = (clause: Where): readonly Where[] => {
    const known = conjunctions.get(clause);
    if (known !== undefined) return known;
    const members =
      written.get(clause) ??
      (!isRecord(clause) ||
      (Object.keys(clause).length === 1 && !Object.hasOwn(clause, "AND"))
        ? [clause]
        : Object.entries(clause).flatMap(([key, member]) =>
            // `and` writes every conjunction as a list.
            key === "AND"
              ? (member as Where[]).flatMap(conjuncts)
              : [{ [key]: member }]
          ));
    conjunctions.set(clause, members);
    return members;
  };
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
  /**
   * Guards are rebuilt for every candidate a simplification tries, so each
   * one is shared: an equal guard is the first one built, and its negation
   * is derived once.
   */
  const builtGuards = new Map<string, Where>();
  const shared = (guard: Clause): Clause => {
    if (guard === false) return guard;
    const key = keyOf(guard);
    const held = builtGuards.get(key);
    if (held !== undefined) return held;
    builtGuards.set(key, guard);
    return guard;
  };
  const negations = new WeakMap<Where, Clause>();
  const negate = (guard: Clause): Clause => {
    if (guard === false) return {};
    if (isTrue(guard)) return false;
    if (Object.keys(guard).length === 1 && isClause(guard.NOT))
      return guard.NOT;
    const held = negations.get(guard);
    if (held !== undefined) return held;
    const negation = Array.isArray(guard.AND)
      ? guardOr(guard.AND.map((member: Where) => negate(member)))
      : Array.isArray(guard.OR)
        ? guardAnd(guard.OR.map((member: Where) => negate(member)))
        : shared({ NOT: guard });
    negations.set(guard, negation);
    return negation;
  };
  /** One combination of shared guards, built once per distinct operands. */
  const combinations = new Map<string, Clause>();
  const combined = (
    operator: string,
    operands: readonly Clause[],
    build: () => Clause
  ): Clause => {
    let key = operator;
    for (const operand of operands)
      key += operand === false ? " F" : ` ${keyOf(operand)}`;
    if (combinations.has(key)) return combinations.get(key)!;
    const guard = shared(build());
    combinations.set(key, guard);
    return guard;
  };
  const guardOr = (guards: readonly Clause[]): Clause =>
    combined("OR", guards, () => or(guards));
  /** Boolean guards, unlike row predicates, have two-valued logic. Push
   * negation to conditions and remove repeated factors without distributing
   * conjunctions over disjunctions or expanding a truth table. */
  const guardAnd = (guards: readonly Clause[]): Clause =>
    combined("AND", guards, () => {
      const all = and(guards);
      if (all === false || !Array.isArray(all.AND)) return all;
      return and(distinct(all.AND as Where[]));
    });
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
    const yes = (conjunction ? guardAnd : guardOr)(
      summaries.map((part) => part.yes)
    );
    const no = (conjunction ? guardOr : guardAnd)(
      summaries.map((part) => part.no)
    );
    const live = negate(conjunction ? no : yes);
    const reads = new Map<string, Clause>();
    for (const part of summaries)
      for (const [key, guard] of part.reads) {
        const held = guardAnd([live, guard]);
        reads.set(key, guardOr([reads.get(key) ?? false, held]));
      }
    return { yes, no, reads };
  };
  /** Each clause's summary per model: a shared clause is walked once. */
  const summaries = new Map(
    Object.keys(schema).map((name) => [
      name,
      new WeakMap<object, ReadSummary | null>(),
    ])
  );
  const parameterKey = (
    operand: unknown,
    spread: boolean
  ): string | undefined => {
    const word = madeOf(operand);
    return word && "arg" in word
      ? JSON.stringify([word.arg[0], word.arg[1] ?? null, spread])
      : undefined;
  };
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
    // An enclosing row's column and the call's instant are written as
    // records of their own, which no read operator spells.
    if (operand === now || madeOf(operand)) return null;
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
    clause: unknown
  ): ReadSummary | null => {
    if (clause === false) return falseSummary;
    if (!isClause(clause)) return null;
    // A condition guards what it is read with; another model's rows are
    // read like a positive relation's body, wherever the clause is.
    const word = madeOf(clause);
    // A word in a clause's place is a condition or another model's rows:
    // an argument's value and an enclosing row's column stand for values.
    if (word !== undefined) {
      if ("exists" in word) {
        const summary = summarizeReads(...word.exists);
        return summary && combineReads(true, [atomic(summary.reads)]);
      }
      return combineReads(true, [
        { yes: clause, no: negate(clause), reads: new Map() },
      ]);
    }
    const cache = summaries.get(name)!;
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
          const summary = summarizeReads(name, body);
          if (summary === null) return unsupported();
          nested.push(
            key === "NOT"
              ? { yes: summary.no, no: summary.yes, reads: summary.reads }
              : summary
          );
        }
        parts.push(combineReads(key !== "OR", nested));
      } else if (Object.hasOwn(stateOf(name).scalars, key)) {
        const summary = scalarReads(value);
        if (summary === null) return unsupported();
        parts.push(summary);
      } else {
        const target = targetOf(name, key);
        if (target === undefined) return unsupported();
        if (value === null) {
          parts.push(atomic());
          continue;
        }
        const bodies: unknown[] = [];
        if (
          isRecord(value) &&
          Object.keys(value).some((op) => QUANTIFIERS.has(op))
        ) {
          for (const [op, body] of Object.entries(value)) {
            if (QUANTIFIERS.has(op)) bodies.push(body);
            else if (op !== "recurse" && op !== "self") return unsupported();
          }
        } else bodies.push(value);
        const relations: ReadSummary[] = [];
        for (const body of bodies) {
          if (body === null) {
            relations.push(atomic());
            continue;
          }
          const summary = summarizeReads(target, body);
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
    a === false ||
    (b !== false && (isTrue(b) || same(a, b) || implies(name, a, b)));

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
    const kept = [...conjuncts(all)];
    let judgement = and([...given, ...kept]);
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
      const reduced = and([...given, ...remaining]);
      if (preservesReads(name, judgement, reduced)) {
        judgement = reduced;
        kept.splice(index, 1);
      }
    }
    return and(kept);
  };

  /** The rows `relation` reaches that the actor views: `P(T, read)`, false
   * where T holds none (R9, fail closed). */
  const visibleThrough = (name: string, relation: string): Clause => {
    const target = targetOf(name, relation)!;
    const action = declarations.get(target)?.read;
    const held = action ? P(target, action) : false;
    return held === false ? false : { [relation]: { is: held } };
  };
  /**
   * Each foreign key `name` holds, with what R4 asks of a value written to
   * it: null where every field of the key may be, or a target the actor
   * views.
   */
  const keysOf = (name: string) =>
    Object.entries(stateOf(name).relations).flatMap(([relation, declared]) => {
      const key = declared["~"].state.foreignKey;
      if (key === undefined) return [];
      const visible = visibleThrough(name, relation);
      const nullable = key.fields.every(
        (field) => stateOf(name).scalars[field]?.["~"].state.nullable === true
      );
      const own = nullable
        ? or([and(key.fields.map((field) => ({ [field]: null }))), visible])
        : visible;
      return [{ relation, fields: key.fields, clause: own }];
    });
  /**
   * The fields of `name`'s row a clause read at `name` reads: a scalar, the
   * key behind a relation it holds, the fields a relation it does not hold
   * joins on, and a self relation's body where `self` reads the row itself.
   */
  /**
   * The fields of the rule's own row its bodies compare (`{ $row, up:
   * depth }`). An inlined predicate is relative to its own root and never
   * reaches past it, so it is not walked; a shared clause is walked once per
   * depth.
   */
  const rootReads = (
    name: string,
    clause: unknown,
    depth: number,
    into: Set<string>,
    seen = new Map<object, Set<number>>()
  ): void => {
    const word = madeOf(clause);
    if (word && "row" in word) {
      if (word.row[1] === depth) into.add(word.row[0]);
      return;
    }
    if (typeof clause !== "object" || clause === null) return;
    // Below the root, an inlined predicate's references stay inside it; at
    // depth 0 it may be a branch of the rule itself (a `P` an action shares).
    if (depth > 0 && inlined.has(clause as Where)) return;
    const depths = seen.get(clause) ?? new Set<number>();
    if (depths.has(depth)) return;
    seen.set(clause, depths.add(depth));
    if (Array.isArray(clause)) {
      for (const item of clause) rootReads(name, item, depth, into, seen);
      return;
    }
    if (word && "exists" in word) {
      const [model, body] = word.exists;
      rootReads(model, body, depth + 1, into, seen);
    }
    if (!isRecord(clause)) return;
    for (const [key, member] of Object.entries(clause)) {
      const target = LOGICAL.has(key) ? undefined : targetOf(name, key);
      if (target === undefined || !isRecord(member)) {
        rootReads(name, member, depth, into, seen);
        continue;
      }
      const quantified = Object.keys(member).some((op) => QUANTIFIERS.has(op));
      if (!quantified) {
        // The to-one shorthand: the body is the related row's own filter.
        rootReads(target, member, depth + 1, into, seen);
        continue;
      }
      for (const op of QUANTIFIERS) {
        const body = member[op];
        if (isRecord(body)) rootReads(target, body, depth + 1, into, seen);
      }
    }
  };
  const fieldsRead = (name: string, clause: Where, into: Set<string>) => {
    rootReads(name, clause, 0, into);
    return ownFields(name, clause, into);
  };
  const ownFields = (name: string, clause: unknown, into: Set<string>) => {
    // A condition and another model's rows read no field of the row.
    if (!isRecord(clause)) return into;
    for (const [key, member] of Object.entries(clause)) {
      if (LOGICAL.has(key))
        for (const item of Array.isArray(member) ? member : [member])
          ownFields(name, item, into);
      else if (targetOf(name, key) === undefined) into.add(key);
      else {
        for (const field of joinedOn(name, key)) into.add(field);
        if (isRecord(member) && member.self === true)
          for (const op of QUANTIFIERS)
            if (isRecord(member[op])) ownFields(name, member[op], into);
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

  /** One name per predicate of a model: actions, domains, the placement, moves. */
  const unclaimed = (
    names: { has(key: string): boolean },
    key: string,
    at: string,
    name: string
  ) => {
    if (names.has(key))
      refuse(
        `${at}: an action, a domain, the placement or a move already has the name "${key}"`,
        name
      );
  };
  // Every check that lowers no rule runs before any model is compiled: the
  // declaration's names (operations, fields, domains, the `as` names), so a
  // misspelt one is refused when the policy is applied, wherever it is.
  const declarations = new Map<string, Declared>();
  for (const name of Object.keys(config.models)) {
    const policy = config.models[name]!;
    const model = modelOf(name);
    const declared = (role: string, action: string | undefined) => {
      if (action !== undefined && !model.actions.includes(action))
        refuse(
          `models.${name}.${role} names "${action}", which ${name} does not declare. Declared actions: ${model.actions.join(", ") || "none"}. Add its rule or choose a declared action.`,
          name
        );
      return action;
    };
    // The names `claim` gives out below, but for the moves, which need the
    // placement lowered: the same refusals, at the same places.
    const claimed = new Set<string>(model.actions);
    const claimName = (key: string, at: string) => {
      unclaimed(claimed, key, at, name);
      claimed.add(key);
    };
    const operations = policy.operations ?? {};
    for (const operation of Object.keys(operations))
      if (!OPERATIONS.has(operation))
        refuse(
          `models.${name}.operations.${operation}: not a configurable operation; use read, update or delete (create always uses its own grant)`,
          name
        );
    // The action each verb takes (K3, OD-3): `operations`, else read,
    // update and delete; a verb whose action the model does not declare
    // takes none. Adding actions never changes an operation mapping.
    const verbs: { read?: string; update?: string; delete?: string } = {};
    for (const verb of ["read", "update", "delete"] as const) {
      const action = declared(`operations.${verb}`, operations[verb]) ?? verb;
      if (model.actions.includes(action)) verbs[verb] = action;
    }
    const writes: Record<string, string> = {};
    const protectedWrites: [field: string, write: string][] = [];
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
          const protectedWrite = `$write:${field}`;
          claimName(protectedWrite, `models.${name}.fields.${field}.write`);
          writes[field] = protectedWrite;
          protectedWrites.push([field, write]);
        }
      }
      // A key, a foreign key or a relation is refused by K5's admission.
      if (read === undefined) continue;
      reads[field] = declared(`fields.${field}.read`, read)!;
    }
    claimName(PLACE, `models.${name}.create`);
    const domains = Object.keys(policy.domains ?? {});
    for (const domain of domains)
      claimName(domain, `models.${name}.domains.${domain}`);
    const modes = [...model.actions, ...domains];
    // One `as` name space for every model: the default is no action's.
    if (modes.includes(DEFAULT_MODE))
      refuse(
        `models.${name}: "${DEFAULT_MODE}" is the mode a call takes by default, not an action or a domain`,
        name
      );
    declarations.set(name, {
      ...verbs,
      modes,
      writes,
      protectedWrites,
      reads,
    });
  }

  /** One listed model's predicates, by name, and its rule entry. */
  const compileModel = (name: string): Compiled => {
    const policy = config.models[name]!;
    const model = modelOf(name);
    const declared = declarations.get(name)!;
    const { writes, protectedWrites, ...verbs } = declared;
    const named = new Map<string, Where>();
    // The declaration's names were claimed when the policy was applied; a
    // move's name is new here, and a domain may take one.
    const claim = (key: string, at: string, clause: Where) => {
      unclaimed(named, key, at, name);
      named.set(key, clause);
    };
    for (const action of model.actions)
      named.set(action, and([P(name, action), scope(name, action)]) || FALSE);
    // Field protection narrows the operation's grant. Core chooses one
    // write predicate per field, so compose both permissions here rather
    // than letting a field grant replace a denied or absent update grant.
    for (const [field, write] of protectedWrites)
      named.set(
        `$write:${field}`,
        and([
          verbs.update === undefined ? false : named.get(verbs.update)!,
          named.get(write)!,
        ]) || FALSE
      );
    // Creation is a named action evaluated on the proposed row. Its placement
    // adds target visibility; moves reuse the row rule without requiring a
    // create credential scope for an update.
    const create = P(name, "create");
    const keys = keysOf(name);
    named.set(
      PLACE,
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
    for (const [domain, rule] of Object.entries(policy.domains ?? {})) {
      const at = `models.${name}.domains.${domain}`;
      claim(domain, at, lower(name, "read", rule, at) || FALSE);
    }
    return entryOf(name, named, { ...declared, moves });
  };
  /**
   * A model's rule entry from its predicates by name: its read action, each
   * field it gates and its `$access`, each write verb at its action (an
   * action it does not grant takes no row), the fields whose write takes
   * its own action, the placement of a created row and the moves of an
   * updated one, and the modes that narrow its call's own rows (the
   * default and the read action narrow nothing: `read` holds in every
   * mode).
   */
  const entryOf = (
    name: string,
    named: ReadonlyMap<string, Where>,
    { writes, reads, moves = {}, modes, ...verbs }: Declared
  ): Compiled => {
    const P = (key: string | undefined): object =>
      key === undefined ? nothing : named.get(key)!;
    const names = modelOf(name).actions;
    const root = modes
      .filter((mode) => mode !== verbs.read)
      .map((mode) => when(arg(MODE), mode, P(mode)));
    return {
      predicates: named,
      entry: {
        read: {
          where: P(verbs.read),
          fields: Object.fromEntries(
            Object.entries(reads).map(([field, key]) => [field, gate(P(key))])
          ),
          // Per row, always one boolean for each admitted action.
          ...(names.length > 0 && {
            select: {
              [EVIDENCE_KEY]: facts(
                Object.fromEntries(names.map((fact) => [fact, P(fact)]))
              ),
            },
          }),
        },
        ...(root.length > 0 && { root }),
        create: { check: check(P(PLACE)) },
        update: {
          where: only(P(verbs.update)),
          fields: Object.fromEntries(
            [...new Set([...Object.keys(writes), ...Object.keys(moves)])].map(
              (field) => [
                field,
                {
                  ...(writes[field] !== undefined && {
                    where: only(P(writes[field])),
                  }),
                  ...(moves[field] !== undefined && {
                    check: check(P(moves[field])),
                  }),
                },
              ]
            )
          ),
        },
        delete: { where: only(P(verbs.delete)) },
        acyclic: () => acyclicAt(name),
      },
    };
  };

  // A Map: a model may be named `constructor`.
  const compiled = new Map<string, Compiled>();
  /** `name` compiled, once: an unlisted model holds nothing (R9). */
  const modelAt = (name: string): Compiled => {
    const known = compiled.get(name);
    if (known !== undefined) return known;
    const entry = Object.hasOwn(config.models, name)
      ? compileModel(name)
      : entryOf(name, new Map([[PLACE, FALSE]]), UNLISTED);
    compiled.set(name, entry);
    return entry;
  };
  // R4: a self key a predicate recurses over never takes a parent inside
  // the row's own subtree. Any model's predicate may recurse over another's
  // relation, so this is the one fact that needs the whole policy compiled.
  let recursed: ReadonlyMap<string, readonly string[]> | undefined;
  const acyclicAt = (name: string): readonly string[] => {
    if (recursed === undefined) {
      // A model whose rules are refused judges nothing, and every model
      // that inlines one of its predicates is refused with it: what the
      // others recurse over is complete without it.
      for (const each of Object.keys(schema))
        try {
          modelAt(each);
        } catch (error) {
          if (!(error instanceof ClientInitializationError)) throw error;
        }
      recursed = recursion(compiled);
    }
    return recursed.get(name) ?? NO_RELATIONS;
  };
  const related = tenantOf(config.tenant);
  return {
    declared: Object.fromEntries(
      Object.keys(schema).map((name) => {
        const { writes, protectedWrites, reads, ...declared } =
          declarations.get(name) ?? UNLISTED;
        return [name, { ...declared, bound: related(name) }];
      })
    ),
    model: modelAt,
  };

  /**
   * Per model, the self relations holding a key that some compiled
   * predicate recurses over, wherever it is read.
   */
  function recursion(models: ReadonlyMap<string, Compiled>) {
    const found = new Map<string, string[]>();
    // Per model, the clauses already walked there (P is shared, D7).
    const seen = new Map(
      Object.keys(schema).map((name) => [name, new WeakSet<object>()])
    );
    const walk = (name: string, clause: unknown): void => {
      const word = madeOf(clause);
      if (word && "exists" in word) walk(...word.exists);
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
    for (const [name, model] of models)
      for (const clause of model.predicates.values()) walk(name, clause);
    return found;
  }
}
