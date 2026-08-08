import { type InferType, PG, s } from "@src/schema";

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
const _generatedOnUpdate: "updatedAt" = localTimestamp["~"].state.autoGenerate;

const namedEnum = s.enum(["PENDING", "ACTIVE"]).name("status");
const _enumName: string = namedEnum["~"].state.enumName;

const fixedVector = s.vector().dimension(384);
const _vectorDimension: number = fixedVector["~"].state.dimension;

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
