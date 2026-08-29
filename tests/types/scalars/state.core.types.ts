import { DecimalScalar, PG, s } from "@src/schema";
import type { InferInput } from "@validation";
import v from "@validation/primitives/v";
import Decimal from "decimal.js";

const nullableName = s.string().nullable().default("anonymous");
type NullableName = InferInput<(typeof nullableName)["~"]["state"]["base"]>;

const _textName: NullableName = "Ada";
const _nullName: NullableName = null;

// @ts-expect-error - a string scalar does not infer a number
const _refusedName: NullableName = 42;

const numericId = s.decimal({ precision: 20, scale: 4 }).id().map("amount");
const _numericIdFlag: true = numericId["~"].state.isId;
const _numericUniqueFlag: true = numericId["~"].state.isUnique;
const _numericColumn: string = numericId["~"].state.columnName;
const _numericPrecision: number = numericId["~"].state.decimal.precision;
const _numericScale: number = numericId["~"].state.decimal.scale;

const localTimestamp = s.dateTime().withoutTimezone().updatedAt();
const _withoutTimezone: false = localTimestamp["~"].state.withTimezone;
const _generatedOnUpdate: "updatedAt" =
  localTimestamp["~"].state.autoGenerate.kind;

const namedEnum = s.enum(["PENDING", "ACTIVE"]).name("status");
const _enumName: string = namedEnum["~"].state.enumName;

const fixedVector = s.vector().dimension(384);
const _vectorDimension: number = fixedVector["~"].state.dimension;

/**
 * The approximate-number scalar, entered exactly as an application writes it.
 *
 * `state.type` is the token every consumer downstream reads — the operation
 * schema dispatcher, the SQL cast, the result parser, the migration type map
 * and the Schema JSON discriminator — so each modifier is pinned to carry it
 * through unchanged along with the fact that modifier declared.
 */
const ratio = s.number();
const _numberType: "number" = ratio["~"].state.type;
const _numberInfers: InferInput<(typeof ratio)["~"]["state"]["base"]> = 1.5;

// @ts-expect-error - an approximate-number scalar does not infer a string
const _numberRefusesText: InferInput<(typeof ratio)["~"]["state"]["base"]> =
  "1.5";

const nullableRatios = s.number(PG.FLOAT.REAL).nullable().array();
const _numberNullable: true = nullableRatios["~"].state.nullable;
const _numberArray: true = nullableRatios["~"].state.array;
const _numberArrayType: "number" = nullableRatios["~"].state.type;
type NullableRatios = InferInput<(typeof nullableRatios)["~"]["state"]["base"]>;
const _numberArrayInfersList: NullableRatios = [1.5];
const _numberArrayInfersNull: NullableRatios = null;

// @ts-expect-error - a nullable number list does not infer a bare number
const _numberArrayRefusesScalar: NullableRatios = 1.5;

const defaultedRatio = s.number().default(1.5).map("ratio_column");
const _numberHasDefault: true = defaultedRatio["~"].state.hasDefault;
const _numberOptional: true = defaultedRatio["~"].state.optional;
const _numberColumn: string = defaultedRatio["~"].state.columnName;

const numberKey = s.number().id();
const _numberIsId: true = numberKey["~"].state.isId;
const _numberIdIsUnique: true = numberKey["~"].state.isUnique;
const _numberUnique: true = s.number().unique()["~"].state.isUnique;

const validatedRatio = s.number().schema(v.number());
const _numberKeepsSchema: ReturnType<typeof v.number> =
  validatedRatio["~"].state.schema;

// The current base schema already carries list and nullability shape. Defaults
// consume that one input type; they do not wrap its array a second time.
s.string().array().default(["first", "second"]);
s.string()
  .array()
  .default(() => ["first", "second"]);
s.int().array().default([1, 2]);
s.int().array().nullable().default(null);

// @ts-expect-error - a list scalar takes the list itself, not one member
s.string().array().default("first");

s.int()
  .array()
  .default([
    // @ts-expect-error - the former double-wrapped spelling is not a list default
    [1, 2],
  ]);

// @ts-expect-error - the approximate scalar is `s.number()`; `s.float()` is gone
s.float();

// @ts-expect-error - number defaults must be numbers
s.number().default("1.5");

// @ts-expect-error - booleans cannot be identifiers
s.boolean().id();

// @ts-expect-error - vectors are already arrays
s.vector().array();

// @ts-expect-error - points cannot be unique keys
s.point().unique();

// @ts-expect-error - JSON values cannot be identifiers
s.json().id();

// @ts-expect-error - integer defaults must be numbers
s.int().default("1");

// @ts-expect-error - enum defaults must be declared values
s.enum(["PENDING", "ACTIVE"]).default("UNKNOWN");

// =============================================================================
// THE DECIMAL DOMAIN, ENTERED EXACTLY AS AN APPLICATION WRITES IT
// =============================================================================
//
// Every probe below is a call to `s.decimal(...)`, not a typed internal alias,
// and every hostile-key probe sits BESIDE A REAL KEY: a misspelling alone is
// red on any unkeyed surface because of weak-type detection and proves nothing.
// Each one is also written twice — as a FRESH literal, which excess-property
// checking sees, and from a HELD variable, which it does not. Only the second
// is evidence that the refusal is structural.

const price = s.decimal({ precision: 10, scale: 2 });

// The class remains an internal implementation type, not a second public
// declaration boundary beside `s.decimal(...)`.
// @ts-expect-error - no constructible DecimalScalar value is exported
new DecimalScalar();

// @ts-expect-error - a decimal has no zero-argument form: a scale cannot be
// inferred from storage, a value, a driver, or an operation
s.decimal();

// @ts-expect-error - and no native-type override: the column type is DERIVED
s.decimal(PG.STRING.TEXT);

// @ts-expect-error - `precision` alone does not name a domain
s.decimal({ precision: 10 });

// @ts-expect-error - `scale` alone does not either
s.decimal({ scale: 2 });

// @ts-expect-error - a misspelling is refused BESIDE the real keys
s.decimal({ precision: 10, scale: 2, scal: 2 });

// @ts-expect-error - and so is a rounding option: V1 has one rounding rule and
// does not expose it as a per-field concept
s.decimal({ precision: 10, scale: 2, rounding: "half-even" });

const heldWithTypo = { precision: 10, scale: 2, scal: 2 };
// @ts-expect-error - refused structurally, so a HELD bag cannot smuggle it past
// excess-property checking
s.decimal(heldWithTypo);

const heldWithRounding = { precision: 10, scale: 2, rounding: "half-even" };
// @ts-expect-error - the same, held
s.decimal(heldWithRounding);

declare const heldDomainUnion:
  | { readonly precision: 10; readonly scale: 2 }
  | {
      readonly precision: 10;
      readonly scale: 2;
      readonly rounding: "half-even";
    };
// @ts-expect-error - every branch of a held union is checked for extra keys
s.decimal(heldDomainUnion);

declare const chooseDomain: boolean;
const freshDomainUnion = chooseDomain
  ? { precision: 10, scale: 2 }
  : { precision: 10, scale: 2, rounding: "half-even" };
// @ts-expect-error - a fresh union cannot hide an extra-key branch either
s.decimal(freshDomainUnion);

// @ts-expect-error - there is no second decimal mode to switch into
price.fixed({ precision: 10, scale: 2 });

// @ts-expect-error - a decimal default is a Decimal, a string, or a number
price.default(true);

// @ts-expect-error - a custom schema observes the exact VALUE, not its text
price.schema(v.string());

price.array().nullable();
price.array().default(["1.5", 2, new Decimal("3.5")]);
const readonlyDecimalList = ["1.5", new Decimal("2.5")] as const;
price.array().default(readonlyDecimalList);
