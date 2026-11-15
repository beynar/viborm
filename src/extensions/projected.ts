import type {
  Operation as Admitted,
  Arguments,
  EngineSchema,
} from "@query-engine/raptor3/shared/schema";
import type { Operation } from "@query-engine/types";
import type { AnyModel } from "@schema/model";
import { isPlainRecord } from "@schema/relation/terminal";
import { parseProviding } from "@validation/primitives/object";
import { namedGatedFields } from "./gates";
import type { Projection } from "./projection";

/**
 * Projection keys a domain declares, admitted by the shared schema (K5).
 *
 * The `select` and `include` schemas are the schema's, shared by every chain
 * over it, and refuse a key they do not declare unless the parse adds it
 * under the model's name (`parseProviding`). So a call whose domain declares
 * a projection key is admitted inside a parse that adds that key, with its
 * own validator. What admission cannot say is which read-gated fields the
 * caller named, since the `select` it returns names every scalar of a node
 * an `include` or an `omit` spelled: those are read from the caller's
 * arguments and marked on the `select` admission returned.
 */

/** The operations whose results are rows: the only ones a projection reaches. */
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

/** A key's admitted value: `true`, nothing for `false`, or a list of the names it declares. */
const keyValidator =
  (names: readonly (readonly [string, unknown])[]) => (value: unknown) =>
    typeof value === "boolean"
      ? { value: value || undefined }
      : Array.isArray(value) &&
          value.length > 0 &&
          value.every(
            (name) =>
              typeof name === "string" &&
              names.some(([declared]) => declared === name)
          )
        ? { value: [...value] }
        : {
            issues: [
              {
                message: `expected true, false or a list of ${names.map(([name]) => name).join(", ")}`,
              },
            ],
          };

/**
 * Mark, on each node admission returned, the read-gated fields the caller
 * named on that node: walked beside the caller's arguments, container by
 * container, as admission keeps them.
 */
function markNamed(
  domain: Projection,
  schema: EngineSchema,
  model: AnyModel,
  raw: unknown,
  admitted: unknown
): void {
  if (!(isPlainRecord(raw) && isPlainRecord(admitted))) return;
  const select = isPlainRecord(raw.select) ? raw.select : undefined;
  const omit = isPlainRecord(raw.omit) ? raw.omit : undefined;
  const named = new Set<string>();
  for (const field of domain.projected(model)?.gates.keys() ?? [])
    if (
      select
        ? select[field] === true && omit?.[field] !== true
        : omit?.[field] === false
    )
      named.add(field);
  if (named.size > 0 && isPlainRecord(admitted.select))
    namedGatedFields.set(admitted.select, named);
  for (const container of ["select", "include"] as const) {
    const given = raw[container];
    const kept = admitted[container];
    if (!(isPlainRecord(given) && isPlainRecord(kept))) continue;
    for (const name of Object.keys(given)) {
      const resolved = model["~"].state.relations[name]
        ? schema.index.get(model)?.get(name)
        : undefined;
      if (resolved === undefined) continue;
      const many = resolved.edge.kind === "variantJunctionCarrier";
      if (
        resolved.member ||
        !(many || resolved.edge.kind === "variantRowCarrier")
      ) {
        markNamed(
          domain,
          schema,
          schema.membership(model, name).target,
          given[name],
          kept[name]
        );
        continue;
      }
      const arms = (node: unknown) =>
        isPlainRecord(node) && many ? node.variants : node;
      const givenArms = arms(given[name]);
      const keptArms = arms(kept[name]);
      if (!(isPlainRecord(givenArms) && isPlainRecord(keptArms))) continue;
      for (const member of resolved.edge.members)
        markNamed(
          domain,
          schema,
          schema.membership(model, name, member.variant).target,
          givenArms[member.variant],
          keptArms[member.variant]
        );
    }
  }
}

/**
 * `raw` admitted by the schema with the projection keys of the domain added
 * to the schema's, and the read-gated fields it names marked: as the schema
 * admits it where the call reads no rows. The projection's `admit`, called
 * on it.
 */
export function admitProjected(
  this: Projection,
  schema: EngineSchema,
  model: AnyModel,
  operation: Admitted,
  raw: unknown
): Arguments {
  const admit = () => schema.admit(model, operation, raw);
  // The model's entries are read before its arguments: an entry given
  // lazily refuses the call first.
  this.projected(model);
  if (!ROW_RESULTS.has(operation)) return admit();
  // A projection is provided under `$` and its model's name.
  const admitted = parseProviding((name, key) => {
    const target = name[0] === "$" ? schema.schema[name.slice(1)] : undefined;
    const declared = target && this.projected(target)?.keys.get(key);
    return declared && keyValidator(declared.names);
  }, admit);
  markNamed(this, schema, model, raw, admitted);
  return admitted;
}
