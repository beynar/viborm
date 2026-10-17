import { ValidationError } from "@errors";
import type { AnyModel } from "@schema/model";
import { isPlainRecord } from "@schema/relation/terminal";
import type { Operation } from "../../types";
import { namedGatedFields, type PreparedDomain } from "./query";
import type { Arguments, EngineSchema, Input } from "./schema";

/**
 * Projection keys a domain declares, admitted beside the shared schema (K5).
 *
 * The `select` and `include` schemas are the schema's, shared by every chain
 * over it, and refuse a key they do not declare. So a call whose domain
 * declares a projection key has that key taken out of every node of its
 * projection before admission and put back, by path, into the node admission
 * returned; the node's read-gated fields the caller named are marked on the
 * `select` admission returned, which names every scalar of a node an
 * `include` or an `omit` spelled. Nothing else changes: a call that names no
 * key and no gated field is admitted as it was written.
 */

/** The verbs whose results are rows: the only ones a projection reaches. */
const ROW_RESULTS: ReadonlySet<Operation> = new Set<Operation>([
  "findMany",
  "findFirst",
  "findUnique",
  "create",
  "update",
  "upsert",
  "delete",
  "createMany",
  "updateMany",
  "deleteMany",
]);

type Container = "select" | "include";

/** What one node of a call's projection said that admission does not keep. */
interface Plan {
  /** The declared key the node named, in which container, with its value. */
  readonly key?: {
    readonly name: string;
    readonly container: Container;
    readonly value: unknown;
  };
  /** Its `select` named the key alone: a key field stood in for admission. */
  readonly bare: boolean;
  /** Its read-gated fields the caller named. */
  readonly named: ReadonlySet<string>;
  readonly children: ReadonlyMap<string, readonly [Container, Plan]>;
}

/**
 * One node, its declared key taken out: `undefined` where neither it nor a
 * node below says anything admission would not keep. Each container is read
 * once and every container on the path is copied, so admission reads the
 * values this walk read.
 */
function strip(
  domain: PreparedDomain,
  schema: EngineSchema,
  model: AnyModel,
  node: unknown
): readonly [Input, Plan] | undefined {
  if (!isPlainRecord(node)) return undefined;
  const facts = domain.projected(model);
  const read = {
    select: node.select,
    include: node.include,
  };
  const omit = isPlainRecord(node.omit) ? node.omit : undefined;
  const copies: Partial<Record<Container, Record<string, unknown>>> = {};
  const children = new Map<string, readonly [Container, Plan]>();
  let key: Plan["key"];
  for (const container of ["select", "include"] as const) {
    const given = read[container];
    if (!isPlainRecord(given)) continue;
    let copy: Record<string, unknown> | undefined;
    for (const name of Object.keys(given)) {
      const value = given[name];
      if (facts?.keys.has(name)) {
        key = { name, container, value };
        copy ??= { ...given };
        delete copy[name];
        continue;
      }
      const resolved = model["~"].state.relations[name]
        ? schema.index.get(model)?.get(name)
        : undefined;
      // A variant slot's arms are read as their defaults say.
      if (
        resolved === undefined ||
        (!resolved.member &&
          (resolved.edge.kind === "variantRowCarrier" ||
            resolved.edge.kind === "variantJunctionCarrier"))
      )
        continue;
      const child = strip(
        domain,
        schema,
        schema.membership(model, name).target,
        value
      );
      if (child === undefined) continue;
      (copy ??= { ...given })[name] = child[0];
      children.set(name, [container, child[1]]);
    }
    if (copy) copies[container] = copy;
  }
  const select = isPlainRecord(read.select) ? read.select : undefined;
  const named = new Set<string>();
  for (const field of facts?.gates.keys() ?? []) {
    const given = select
      ? select[field] === true && omit?.[field] !== true
      : omit?.[field] === false;
    if (given) named.add(field);
  }
  if (key === undefined && children.size === 0 && named.size === 0)
    return undefined;
  // An `include` that named the key alone is no `include`.
  const emptied =
    copies.include !== undefined && Object.keys(copies.include).length === 0;
  const { include: _included, ...rest } = node;
  const next: Input = emptied ? rest : { ...node };
  let bare = false;
  if (copies.select) {
    bare = Object.keys(copies.select).length === 0;
    next.select = bare ? { [schema.keys(model)[0]!]: true } : copies.select;
  }
  if (copies.include && !emptied) next.include = copies.include;
  return [next, { key, bare, named, children }];
}

/** A key's admitted value: `true`, `false` or a list of the names it declares. */
function admitKey(
  domain: PreparedDomain,
  model: AnyModel,
  key: NonNullable<Plan["key"]>,
  path: string,
  operation: Operation
): unknown {
  const { value } = key;
  if (typeof value === "boolean") return value;
  const names = domain.projected(model)!.keys.get(key.name)!.names;
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (name) =>
        typeof name === "string" &&
        names.some(([declared]) => declared === name)
    )
  )
    return Object.freeze([...value]);
  throw new ValidationError(
    operation,
    [
      {
        path: `${path}${key.container}.${key.name}`,
        message: `expected true, false or a list of ${names.map(([name]) => name).join(", ")}`,
      },
    ],
    { meta: { model: model["~"].names.ts! } }
  );
}

/** `admitted`, one node admission returned, with what its plan kept aside. */
function attach(
  domain: PreparedDomain,
  schema: EngineSchema,
  model: AnyModel,
  admitted: Input,
  plan: Plan,
  path: string,
  operation: Operation
): Input {
  const next: Input = { ...admitted };
  for (const [name, [container, child]] of plan.children) {
    const holder = next[container];
    if (!(isPlainRecord(holder) && isPlainRecord(holder[name]))) continue;
    next[container] = {
      ...holder,
      [name]: attach(
        domain,
        schema,
        schema.membership(model, name).target,
        holder[name],
        child,
        `${path}${container}.${name}.`,
        operation
      ),
    };
  }
  if (plan.key) {
    const value = admitKey(domain, model, plan.key, path, operation);
    const { container } = plan.key;
    if (plan.bare) next.select = {};
    if (value !== false) {
      const holder = next[container];
      next[container] = {
        ...(isPlainRecord(holder) ? holder : {}),
        [plan.key.name]: value,
      };
    }
  }
  if (plan.named.size > 0 && isPlainRecord(next.select))
    namedGatedFields.set(next.select, plan.named);
  return next;
}

/**
 * `raw` admitted by `admit` with the projection keys and named gated fields
 * of `domain` kept: as `admit(raw)` where the call names neither.
 */
export function admitProjected(
  domain: PreparedDomain,
  schema: EngineSchema,
  model: AnyModel,
  operation: Operation,
  raw: unknown,
  admit: (raw: unknown) => Arguments
): Arguments {
  const stripped = ROW_RESULTS.has(operation)
    ? strip(domain, schema, model, raw)
    : undefined;
  if (stripped === undefined) return admit(raw);
  const [node, plan] = stripped;
  return attach(
    domain,
    schema,
    model,
    admit(node) as Input,
    plan,
    "",
    operation
  ) as Arguments;
}
