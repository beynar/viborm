import { type InferType, PG, s } from "@src/schema";
import v from "@validation/primitives/v";

const nullableName = s.string().nullable().default("anonymous");
type NullableName = InferType<(typeof nullableName)["~"]["state"]>;

const _textName: NullableName = "Ada";
const _nullName: NullableName = null;

// @ts-expect-error - a string scalar does not infer a number
const _refusedName: NullableName = 42;

const numericId = s.decimal(PG.DECIMAL.NUMERIC(20, 4)).id().map("amount");
const _numericIdFlag: true = numericId["~"].state.isId;
const _numericUniqueFlag: true = numericId["~"].state.isUnique;
const _numericColumn: string = numericId["~"].state.columnName;

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
const _numberInfers: InferType<(typeof ratio)["~"]["state"]> = 1.5;
// @ts-expect-error - an approximate-number scalar does not infer a string
const _numberRefusesText: InferType<(typeof ratio)["~"]["state"]> = "1.5";

const nullableRatios = s.number(PG.FLOAT.REAL).nullable().array();
const _numberNullable: true = nullableRatios["~"].state.nullable;
const _numberArray: true = nullableRatios["~"].state.array;
const _numberArrayType: "number" = nullableRatios["~"].state.type;
type NullableRatios = InferType<(typeof nullableRatios)["~"]["state"]>;
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
