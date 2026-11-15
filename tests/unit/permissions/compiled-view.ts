/**
 * The compiler's output as these witnesses read it: per model, its named
 * predicates in the plain spelling of a rule (`{ control, path }` for an
 * argument's value, `$if`, `$exists`, `{ $row, up }`, `{ now: true }`), the
 * names each verb, written field, read-gated field, mode and move takes, and
 * the acyclic relations. The compiler writes the words of a rule; this view
 * reads them back, so a witness states a predicate as a policy writes one.
 */

import {
  ArgTestFilter,
  ArgValue,
  ExistsFilter,
  now,
  RowValue,
} from "@src/extensions/rule-words";
import type { ActorContract } from "@src/permissions/actor";
import {
  type Compiled,
  policyCompiler as compilerOf,
  EVIDENCE_KEY,
  isRecord,
  type PermissionsConfig,
  policyArguments,
  written,
} from "@src/permissions/compile";
import type { Where } from "@src/permissions/rules";

type Schema = Parameters<typeof compilerOf>[1];

/** One model compiled, named and plain. */
export interface PlainModel {
  readonly predicates: { readonly [name: string]: Where };
  readonly read?: string;
  readonly update?: string;
  readonly delete?: string;
  readonly writes: { readonly [field: string]: string };
  readonly reads: { readonly [field: string]: string };
  readonly modes: { readonly [mode: string]: string };
  readonly place: string;
  readonly moves: { readonly [field: string]: string };
  readonly evidence?: { readonly as: string; readonly names: string[] };
  readonly acyclic?: readonly string[];
}

export interface PlainPolicy {
  readonly control: "actor";
  readonly scopes: Readonly<Record<string, readonly string[]>>;
  readonly models: { readonly [model: string]: PlainModel };
}

/** A compiled value or predicate in a rule's plain spelling. */
export function plain(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (value === now) return { now: true };
  if (value instanceof ArgValue)
    return value.path === undefined
      ? { control: value.name }
      : { control: value.name, path: value.path };
  if (value instanceof ArgTestFilter)
    return {
      $if: { ...(plain(value.arg) as object), ...(value.test as object) },
    };
  if (value instanceof ExistsFilter)
    return {
      $exists: Object.fromEntries(
        Object.entries(value.spec).map(([model, where]) => [
          model,
          plain(where),
        ])
      ),
    };
  if (value instanceof RowValue) return { $row: value.column, up: value.up };
  if (Array.isArray(value)) return value.map(plain);
  if (!isRecord(value)) return value;
  // A record the rule wrote with `$if` or `$exists` beside its filters.
  const members = written.get(value as never);
  if (members !== undefined)
    return Object.assign({}, ...members.map((member) => plain(member)));
  return Object.fromEntries(
    Object.entries(value).map(([key, member]) => [key, plain(member)])
  );
}

/** One model's compiled predicates and the names its uses take. */
export function plainModel(
  config: PermissionsConfig,
  name: string,
  { predicates, entry }: Compiled
): PlainModel {
  const named = Object.fromEntries(
    [...predicates].map(([key, clause]) => [key, plain(clause) as Where])
  );
  const policy = Object.hasOwn(config.models, name)
    ? config.models[name]
    : undefined;
  if (policy === undefined)
    return {
      predicates: named,
      writes: {},
      reads: {},
      modes: {},
      place: "$create",
      moves: {},
    };
  const facts = entry.read.select?.[EVIDENCE_KEY] as
    | { readonly held: Readonly<Record<string, unknown>> }
    | undefined;
  const actions = Object.keys(facts?.held ?? {});
  const verbs: Record<string, string> = {};
  for (const verb of ["read", "update", "delete"] as const) {
    const action = policy.operations?.[verb] ?? verb;
    if (actions.includes(action)) verbs[verb] = action;
  }
  const writes: Record<string, string> = {};
  const reads: Record<string, string> = {};
  for (const [field, { read, write }] of Object.entries(policy.fields ?? {})) {
    if (write !== undefined)
      writes[field] = write === verbs.update ? write : `$write:${field}`;
    if (read !== undefined) reads[field] = read;
  }
  const modes = Object.fromEntries(
    [...actions, ...Object.keys(policy.domains ?? {})].map((mode) => [
      mode,
      mode,
    ])
  );
  const moves = Object.fromEntries(
    [...predicates.keys()]
      .filter((key) => key.startsWith("move:"))
      .map((key) => [key.slice("move:".length), key])
  );
  return {
    predicates: named,
    ...verbs,
    writes,
    reads,
    modes,
    place: "$create",
    moves,
    ...(actions.length > 0 && {
      evidence: { as: EVIDENCE_KEY, names: actions },
    }),
  };
}

/** A compiler whose models read as {@link PlainModel}s. */
export function policyCompiler(
  config: PermissionsConfig,
  schema: Schema,
  actor?: ActorContract
) {
  const compiler = compilerOf(config, schema, actor);
  let whole: PlainPolicy | undefined;
  return {
    declared: compiler.declared,
    model: (name: string) => plainModel(config, name, compiler.model(name)),
    acyclic: (name: string) => compiler.model(name).entry.acyclic(),
    policy: (): PlainPolicy => {
      if (whole !== undefined) return whole;
      const models: Record<string, PlainModel> = {};
      for (const name of Object.keys(schema)) {
        const compiled = compiler.model(name);
        const relations = compiled.entry.acyclic();
        const model = plainModel(config, name, compiled);
        models[name] =
          relations.length === 0 ? model : { ...model, acyclic: relations };
      }
      whole = {
        control: "actor",
        scopes: policyArguments(config).scopes,
        models,
      };
      return whole;
    },
  };
}

/** Every model compiled, as the witnesses read it. */
export const compilePolicy = (
  config: PermissionsConfig,
  schema: Schema,
  actor?: ActorContract
): PlainPolicy => policyCompiler(config, schema, actor).policy();
