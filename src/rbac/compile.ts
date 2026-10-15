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
// the modes that narrow by them, and placement (R4). It names no engine
// structure; the entry hands it to the chain.

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
            readonly foreignKey?: { readonly fields: readonly string[] };
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
}

/**
 * One model's predicates and the uses that name them. Its `predicates`,
 * `read`, `update`, `delete` and `writes` are a `rows` member's `verbs` entry
 * for the model as K3 declares it (`RowsVerbs`): every declared action's
 * `P(M, a)`, every domain's narrowing and `create` (placement) by name, the
 * predicate each operation takes, and the one an update writing a field takes
 * instead of `update`'s (R3). A verb left out names no declared action.
 */
export interface CompiledModel extends RowsVerbs {
  readonly predicates: { readonly [name: string]: Where };
  readonly writes: { readonly [field: string]: string };
  /** The predicate a result row must hold for the field to be present (D5). */
  readonly reads: { readonly [field: string]: string };
  /** `as` values, each narrowing by one predicate (R8). */
  readonly modes: { readonly [mode: string]: string };
  /** The predicate every created row satisfies (R4). */
  readonly place?: string;
}

export interface CompiledPolicy {
  /** The bound-only control that carries the actor. */
  readonly control: "actor";
  /** Every model of the schema: one the policy does not list holds nothing (R9). */
  readonly models: { readonly [model: string]: CompiledModel };
}

/** The `as` value a call takes when it names none: it narrows nothing. */
export const DEFAULT_MODE = "default";

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

  const compiled: Record<string, CompiledModel> = {};
  for (const name of Object.keys(schema)) {
    const policy = config.models[name];
    if (policy === undefined) {
      compiled[name] = Object.freeze({
        predicates: {},
        writes: {},
        reads: {},
        modes: {},
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
    for (const action of model.actions)
      named[action] = P(name, action) || FALSE;

    const operations = policy.operations ?? {};
    for (const operation of Object.keys(operations))
      if (!OPERATIONS.has(operation))
        refuse(
          `models.${name}.operations.${operation}: not an operation`,
          name
        );
    // OD-3: a model whose actions are exactly the levels deletes at the top.
    const exact = model.leveled && model.actions.length === levels.length;
    const verbs: Record<string, string> = {};
    for (const [verb, fallback] of [
      ["read", "view"],
      ["update", "edit"],
      ["delete", exact ? levels.at(-1)! : "delete"],
    ] as const) {
      const action = operations[verb] ?? fallback;
      if (operations[verb] !== undefined)
        declared(`operations.${verb}`, action);
      if (model.actions.includes(action)) verbs[verb] = action;
    }

    const modes: Record<string, string> = Object.fromEntries(
      model.actions.map((action) => [action, action])
    );
    for (const [domain, rule] of Object.entries(policy.domains ?? {})) {
      if (domain in named || domain === "create")
        refuse(
          `models.${name}.domains.${domain}: an action or placement has that name`,
          name
        );
      named[domain] =
        lower(name, "view", rule, `models.${name}.domains.${domain}`) || FALSE;
      modes[domain] = domain;
    }
    // One `as` name space for every model: the default is no action's.
    if (Object.hasOwn(modes, DEFAULT_MODE))
      refuse(
        `models.${name}: "${DEFAULT_MODE}" is the mode a call takes by default, not an action or a domain`,
        name
      );

    let place: string | undefined;
    if (policy.create !== undefined) {
      const action = declared(
        "operations.create",
        operations.create ?? "edit"
      )!;
      named.create =
        and([
          lower(name, action, policy.within ?? {}, `models.${name}.within`),
          lower(name, action, config.limit ?? {}, "limit"),
          lower(name, action, policy.create, `models.${name}.create`),
        ]) || FALSE;
      place = "create";
    }

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
    compiled[name] = Object.freeze({
      predicates: Object.freeze(named),
      ...verbs,
      writes: Object.freeze(writes),
      reads: Object.freeze(reads),
      modes: Object.freeze(modes),
      ...(place === undefined ? {} : { place }),
    });
  }
  return Object.freeze({ control: "actor", models: Object.freeze(compiled) });
}
