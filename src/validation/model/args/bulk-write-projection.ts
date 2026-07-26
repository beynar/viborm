import type { AnyModel } from "@schema/model";
import type {
  ObjectOptions,
  ObjectSchema,
} from "@validation/primitives/object";

/**
 * A bulk write projects SCALARS.
 *
 * `createMany` / `updateMany` / `deleteMany` return their affected rows straight
 * out of the write statement — `RETURNING` on a capable driver, capture-and-
 * refetch on a non-returning one — and viborm does not project relations into
 * that row set. Both spellings of "give me a relation too" are refused here, at
 * the parse boundary, with a message that names the alternative:
 *
 *  - `include`, which has no place on the surface at all; and
 *  - a relation key (or `_count`) inside `select`, which the scalar-only
 *    `core.scalarSelect` schema would otherwise reject as a bare
 *    "Unknown key: <relation>".
 *
 * The second refusal is the load-bearing one, and it replaces SILENTLY WRONG
 * DATA. A relation subquery embedded in a `RETURNING` list has no table alias to
 * correlate against, so its outer column reference binds by name and is captured
 * by the inner table whenever both tables have a column of that name. Observed
 * on PGlite before this refusal existed, with `findMany` as the control:
 *
 *   warehouse.updateMany({ …, select: { id: true, inventory: … } })
 *     -> [{ id: "w1", inventory: [] }]           // every to-many, always empty
 *   node.createMany({ data: [{ id: "n2", parentId: "n1" }],
 *                     select: { id: true, parent: … } })
 *     -> [{ id: "n2", parent: null }]            // self-relation to-one
 *   node.findMany({ where: { id: "n2" }, select: { id: true, parent: … } })
 *     -> [{ id: "n2", parent: { id: "n1" } }]    // the truth
 *
 * A to-one hop between differently-named tables happened to work, which is what
 * made the hole look like a feature. Fail closed instead: read relations in a
 * separate query.
 *
 * Prisma divergence, deliberate: Prisma's `createManyAndReturn` /
 * `updateManyAndReturn` DO accept relations in `select`/`include` (its generator
 * emits `<Model>SelectCreateManyAndReturn` / `<Model>IncludeCreateManyAndReturn`).
 * viborm refuses rather than ship a projection that answers wrongly.
 */
export const restrictToScalarProjection = <
  TEntries,
  TOpts extends ObjectOptions | undefined,
>(
  schema: ObjectSchema<TEntries, TOpts>,
  model: AnyModel,
  operation: string
): ObjectSchema<TEntries, TOpts> => {
  const relationKeys = new Set(Object.keys(model["~"].state.relations));
  const standard = schema["~standard"];

  const validate: typeof standard.validate = (value) => {
    if (hasOwnKey(value, "include")) {
      return issue(
        `'include' is not supported on '${operation}': a bulk write returns the rows its write statement produced, and viborm does not project relations into them. Select the scalar fields you need and read relations in a separate query.`
      );
    }
    const relationKey = findProjectedRelation(value, relationKeys);
    if (relationKey !== undefined) {
      return issue(
        `'select.${relationKey}' is not supported on '${operation}': a bulk write projects scalar fields only. Read the relation in a separate query.`
      );
    }
    return standard.validate(value);
  };

  return {
    ...schema,
    parse: validate,
    "~standard": {
      version: standard.version,
      vendor: standard.vendor,
      validate,
      get types() {
        return standard.types;
      },
      get jsonSchema() {
        return standard.jsonSchema;
      },
    },
  };
};

const issue = (message: string) => ({ issues: [{ message }] });

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const hasOwnKey = (value: unknown, key: string): boolean =>
  isPlainRecord(value) && Object.hasOwn(value, key);

/**
 * The first relation-shaped key in the payload's `select`, or `undefined`.
 * `_count` counts as one: it is a relation-derived projection built by the same
 * correlated-subquery machinery.
 */
const findProjectedRelation = (
  value: unknown,
  relationKeys: ReadonlySet<string>
): string | undefined => {
  if (!isPlainRecord(value)) return undefined;
  const select = value.select;
  if (!isPlainRecord(select)) return undefined;
  for (const key of Object.keys(select)) {
    if (select[key] === undefined) continue;
    if (key === "_count" || relationKeys.has(key)) return key;
  }
  return undefined;
};
