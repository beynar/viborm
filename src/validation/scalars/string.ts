import type { ScalarState } from "@schema/scalars/common";
import { idDomainOfState } from "@schema/scalars/string/id-domain";
import { type IdDomain, isCompactIdFormat } from "../primitives/id-codec";
import v, { type V } from "../primitives/v";
import {
  buildSetUpdate,
  createScalarInterners,
  internedScalarSchemas,
  type ListFilterSchema,
  type ListUpdateSchema,
  listFilterFamily,
  listUpdateFamily,
  type SetUpdateSchema,
} from "./family";
import { scalarInternKey } from "./intern";
import {
  buildNegatableFilterSchema,
  type NegatableFilterSchema,
} from "./negatable-filter";

// Base schemas
const stringBase = v.string();
const stringList = v.string({ array: true });

// Internal filter base
const stringFilterBase = v.object({
  in: stringList,
  notIn: stringList,
  contains: v.fieldRefOr("string", stringBase),
  startsWith: v.fieldRefOr("string", stringBase),
  endsWith: v.fieldRefOr("string", stringBase),
  mode: v.enum(["default", "insensitive"]),
});

/**
 * The filter base of a COMPACTLY STORED identifier: equality, set membership
 * and ordering, and nothing that reads the value as text.
 *
 * `contains`, `startsWith`, `endsWith` and `mode` are gone because the column
 * does not hold the text they would search. A `uuid` column holds sixteen
 * bytes and a PostgreSQL `uuid`; `startsWith: "a0ee"` against it is a question
 * about a spelling the database never stored, and answering it would mean
 * rendering every row back to text at query time. Ordering survives: the byte
 * order of all four compact formats IS their canonical text order.
 */
const compactIdFilterBase = v.object({
  in: stringList,
  notIn: stringList,
});

/**
 * Comparison operand: a literal, a field reference to another string column, an
 * SQL fragment, or a callback returning one of the latter two.
 */
type StringOperand<
  S extends V.Schema,
  C extends V.Operand<any>,
> = V.ComparisonOperand<"string", S, C>;

/**
 * The text-predicate operand: a literal or a field reference, and nothing else.
 *
 * `contains` / `startsWith` / `endsWith` compile a referenced column fine (the
 * builder uses exact substring predicates, never LIKE patterns), so the
 * reference stays. The fragment — and with it the callback that returns one —
 * is drawn at the comparison operators only, where the builder's operand
 * handling is uniform. Acceptance that outran the builder would be
 * accept-and-ignore with extra steps.
 */
type StringTextOperand = V.FieldRefOr<"string", V.String>;

type StringFilterBase<S extends V.Schema, C extends V.Operand<any>> = {
  equals: StringOperand<S, C>;
  lt: StringOperand<S, C>;
  lte: StringOperand<S, C>;
  gt: StringOperand<S, C>;
  gte: StringOperand<S, C>;
  in: V.String<{ array: true }>;
  notIn: V.String<{ array: true }>;
  contains: StringTextOperand;
  startsWith: StringTextOperand;
  endsWith: StringTextOperand;
  mode: V.Enum<["default", "insensitive"]>;
};

type StringFilterSchema<
  S extends V.Schema,
  C extends V.Operand<any>,
> = NegatableFilterSchema<StringOperand<S, C>, StringFilterBase<S, C>>;

/** {@link StringFilterBase} without the four text predicates. */
type CompactIdFilterBase<S extends V.Schema, C extends V.Operand<any>> = {
  equals: StringOperand<S, C>;
  lt: StringOperand<S, C>;
  lte: StringOperand<S, C>;
  gt: StringOperand<S, C>;
  gte: StringOperand<S, C>;
  in: V.String<{ array: true }>;
  notIn: V.String<{ array: true }>;
};

type CompactIdFilterSchema<
  S extends V.Schema,
  C extends V.Operand<any>,
> = NegatableFilterSchema<StringOperand<S, C>, CompactIdFilterBase<S, C>>;

/** The four formats a column stores compactly, and therefore cannot search. */
type CompactIdKind = "uuid" | "uuidv7" | "ulid" | "ksuid";

/**
 * Whether this state NAMES one of the four compact identifier formats.
 *
 * Three arms, and each one is a real case:
 *
 *  - No generator at all. `NonNullable<undefined>` is `never`, and `never`
 *    vacuously extends everything, so a plain `s.string()` would otherwise be
 *    handed the narrowed filter its column has no reason for.
 *  - `.id()`'s implicit ULID. It declares a KEY, not a format, so the field
 *    keeps text storage and every string operator; narrowing here would offer
 *    a type the runtime schema does not enforce.
 *  - A named format, which is the only `true`.
 *
 * Each check is wrapped in a tuple so it cannot distribute: an undeclared field
 * carries the whole `AutoGenerateType` union, and a distributing conditional
 * answers `boolean` for it — neither arm.
 */
type DeclaresCompactId<F extends ScalarState<"string">> = [
  NonNullable<F["autoGenerate"]>,
] extends [never]
  ? false
  : [NonNullable<F["autoGenerate"]>["implicit"]] extends [true]
    ? false
    : [NonNullable<F["autoGenerate"]>["kind"]] extends [CompactIdKind]
      ? true
      : false;

const buildStringFilterSchema = <S extends V.Schema, C extends V.Operand<any>>(
  schema: S,
  members: V.String<{ array: true }>
): StringFilterSchema<S, C> => {
  const operand = v.comparisonOperand("string", schema);
  const filter = stringFilterBase.extend({
    equals: operand,
    lt: operand,
    lte: operand,
    gt: operand,
    gte: operand,
    in: members,
    notIn: members,
  });
  return buildNegatableFilterSchema<
    StringOperand<S, C>,
    StringFilterBase<S, C>
  >(filter, operand);
};

const buildCompactIdFilterSchema = <
  S extends V.Schema,
  C extends V.Operand<any>,
>(
  schema: S,
  members: V.String<{ array: true }>
): CompactIdFilterSchema<S, C> => {
  const operand = v.comparisonOperand("string", schema);
  const filter = compactIdFilterBase.extend({
    equals: operand,
    lt: operand,
    lte: operand,
    gt: operand,
    gte: operand,
    in: members,
    notIn: members,
  });
  return buildNegatableFilterSchema<
    StringOperand<S, C>,
    CompactIdFilterBase<S, C>
  >(filter, operand);
};

/**
 * A string LIST has no identifier domain — `idDomainOfState` answers `undefined`
 * for an array field — so its three variants are the shared family with no
 * narrowing and no second base.
 */
const buildStringListFilterSchema = listFilterFamily(stringBase, stringList);
const buildStringListUpdateSchema = listUpdateFamily(stringBase, stringList);

export interface StringSchemas<
  F extends ScalarState<"string">,
  C extends V.Operand<any> = V.Operand<any>,
> {
  base: F["base"];
  create: V.String<F>;
  update: F["array"] extends true
    ? ListUpdateSchema<F["base"], V.String, V.String<{ array: true }>>
    : SetUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? ListFilterSchema<F["base"], V.String, V.String<{ array: true }>>
    : DeclaresCompactId<F> extends true
      ? CompactIdFilterSchema<F["base"], C>
      : StringFilterSchema<F["base"], C>;
}

const interners = createScalarInterners();

/**
 * The field's base schema, with its identifier domain admitted.
 *
 * A domain field's base is the schema EVERY operand is built from — filter
 * comparisons, `set`, list members, the compound-key member schemas — so
 * admitting and normalizing here is what makes one policy cover create,
 * update, where, cursors, unique selectors and nested-write keys at once. A
 * field without a domain keeps the base the scalar already froze: no domain,
 * no second schema.
 */
const domainBaseOf = <F extends ScalarState<"string">>(
  state: F,
  idDomain: IdDomain | undefined
): F["base"] => {
  if (idDomain === undefined) return state.base;
  const options = {
    nullable: state.nullable,
    array: state.array,
    schema: state.schema,
    idDomain,
  };
  return v.string(options);
};

/**
 * The SET-MEMBERSHIP operand — `in` / `notIn`, and the negated arm with them.
 *
 * A member of `in` is an identifier exactly as `equals`'s operand is, so it
 * crosses the same admission and the same alias folding. The module-level
 * `stringList` cannot carry a field's domain, and a set built from it admitted
 * a value outside the domain (refused later, at the wrong boundary, as a
 * `QueryEngineError`) and left an alias unfolded — which hashed ONE identifier
 * to two cache keys, the exact failure normalizing at the args boundary exists
 * to prevent.
 */
const domainMembersOf = (
  idDomain: IdDomain | undefined
): V.String<{ array: true }> =>
  idDomain === undefined ? stringList : v.string({ array: true, idDomain });

/** The create options, which differ from the state only by the domain. */
const domainStateOf = <F extends ScalarState<"string">>(
  state: F,
  idDomain: IdDomain | undefined
): F => (idDomain === undefined ? state : { ...state, idDomain });

/**
 * The schemas of one string field.
 *
 * `derived` is the domain a FOREIGN-KEY member inherits from the key it
 * references — resolved once in L5 and threaded here by the registry, because
 * an FK carries no generator of its own and its state is deliberately left
 * untouched. A field that declares its own domain reads it from that
 * declaration; nothing merges the two, because a declared domain that
 * disagrees with its target is a schema error, refused before any schema is
 * built.
 */
export const buildStringSchema = <
  F extends ScalarState<"string">,
  C extends V.Operand<any> = V.Operand<any>,
>(
  state: F,
  derived?: IdDomain
): StringSchemas<F, C> => {
  const idDomain =
    state.array === true ? undefined : (idDomainOfState(state) ?? derived);
  const base = domainBaseOf(state, idDomain);
  return internedScalarSchemas<StringSchemas<F, C>>(
    interners,
    scalarInternKey(state, idDomain),
    {
      base,
      create: () => v.string(domainStateOf(state, idDomain)),
      update: () =>
        state.array ? buildStringListUpdateSchema(base) : buildSetUpdate(base),
      filter: () =>
        state.array
          ? buildStringListFilterSchema(base)
          : idDomain !== undefined && isCompactIdFormat(idDomain.format)
            ? buildCompactIdFilterSchema(base, domainMembersOf(idDomain))
            : buildStringFilterSchema(base, domainMembersOf(idDomain)),
    }
  );
};
