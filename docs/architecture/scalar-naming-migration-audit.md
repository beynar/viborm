# Scalar Naming Migration Audit

This is a tracking checklist for renaming primitive schema value terminology from `field` to `scalar`.

One row means one tracked rename target in one path or file group. Line-level repeats inside the same file are verified with the stale-name scans at the end.

## Naming Boundary

| Current | Replace | Reason | Path | Done |
| --- | --- | --- | --- | --- |
| Primitive schema value called `field` | Primitive schema value called `scalar` | `s.string()`, `s.int()`, `s.dateTime()`, `s.json()`, etc. are non-relation scalar definitions. | Package-wide | x |
| Relation `.fields(...).references(...)` | Keep as `fields` | This is FK field-name API, not scalar primitive naming. | `src/schema/relation/**` and docs examples | x |
| Index/id/unique `fields` parameters | Keep as `fields` | These APIs accept user model field names, not scalar definitions. | `src/schema/model/**` and schema API docs | x |
| Generic `fieldName` for user model keys | Keep unless the value is a scalar definition | A model property key can be scalar or relation. Blind replacement would be wrong. | Package-wide | x |

## Canonical Replacements

| Current | Replace | Reason | Path | Done |
| --- | --- | --- | --- | --- |
| `src/schema/fields/` | `src/schema/scalars/` | Package contains scalar primitive definitions. | `src/schema/fields/` | x |
| `@schema/fields` | `@schema/scalars` | Import alias should match scalar package. | Package-wide imports | x |
| `@schema/fields/*` | `@schema/scalars/*` | Import alias should match scalar package. | Package-wide imports | x |
| `docs/content/docs/schema/fields/` | `docs/content/docs/schema/scalars/` | Docs route describes scalar primitives. | `docs/content/docs/schema/fields/` | x |
| `/docs/schema/fields` | `/docs/schema/scalars` | Public docs href should match scalar route. | Docs hrefs | x |
| `docs/content/docs/internals/fields.mdx` | `docs/content/docs/internals/scalars.mdx` | Internals page describes scalar primitive implementation. | `docs/content/docs/internals/fields.mdx` | x |
| `tests/fields/` | `tests/scalars/` | Tests validate scalar schemas. | `tests/fields/` | x |
| `*-field-schemas.test.ts` | `*-scalar-schemas.test.ts` | Test filenames should match scalar schema vocabulary. | `tests/fields/*` | x |
| `{type}/field.ts` | `{type}/scalar.ts` | Concrete primitive class files should use scalar naming. | `src/schema/fields/*/field.ts` | x |
| `datetime/date-field.ts` | `datetime/date-scalar.ts` | Date primitive class file should use scalar naming. | `src/schema/fields/datetime/date-field.ts` | x |
| `datetime/time-field.ts` | `datetime/time-scalar.ts` | Time primitive class file should use scalar naming. | `src/schema/fields/datetime/time-field.ts` | x |
| `query-engine/builders/generated-field.ts` | `query-engine/builders/generated-scalar.ts` | Helper checks generated scalar defaults. | `src/query-engine/builders/generated-field.ts` | x |

## Exported Symbol Replacements

| Current | Replace | Reason | Path | Done |
| --- | --- | --- | --- | --- |
| `Field` | `Scalar` | Union represents scalar primitive classes, not relations. | `src/schema/fields/base.ts` | x |
| `AnyField` | `AnyScalar` | Loose alias should follow `Scalar`. | `src/schema/fields/base.ts` | x |
| `FieldState` | `ScalarState` | State belongs to scalar primitive instances. | `src/schema/fields/common.ts` | x |
| `ScalarFieldType` | `ScalarType` | Remove redundant field vocabulary. | `src/schema/fields/common.ts` | x |
| `StringField` | `StringScalar` | Concrete primitive class. | `src/schema/fields/string/field.ts` | x |
| `IntField` | `IntScalar` | Concrete primitive class. | `src/schema/fields/int/field.ts` | x |
| `FloatField` | `FloatScalar` | Concrete primitive class. | `src/schema/fields/float/field.ts` | x |
| `DecimalField` | `DecimalScalar` | Concrete primitive class. | `src/schema/fields/decimal/field.ts` | x |
| `BooleanField` | `BooleanScalar` | Concrete primitive class. | `src/schema/fields/boolean/field.ts` | x |
| `DateTimeField` | `DateTimeScalar` | Concrete primitive class. | `src/schema/fields/datetime/field.ts` | x |
| `DateField` | `DateScalar` | Concrete primitive class. | `src/schema/fields/datetime/date-field.ts` | x |
| `TimeField` | `TimeScalar` | Concrete primitive class. | `src/schema/fields/datetime/time-field.ts` | x |
| `BigIntField` | `BigIntScalar` | Concrete primitive class. | `src/schema/fields/bigint/field.ts` | x |
| `JsonField` | `JsonScalar` | Concrete primitive class. | `src/schema/fields/json/field.ts` | x |
| `BlobField` | `BlobScalar` | Concrete primitive class. | `src/schema/fields/blob/field.ts` | x |
| `PointField` | `PointScalar` | Concrete primitive class. | `src/schema/fields/point/field.ts` | x |
| `EnumField` | `EnumScalar` | Concrete primitive class. | `src/schema/fields/enum/field.ts` | x |
| `VectorField` | `VectorScalar` | Concrete primitive class. | `src/schema/fields/vector/field.ts` | x |
| `NumberField` | `NumberScalar` | Union of numeric scalar classes. | `src/schema/fields/index.ts` | x |

## Model Helper Replacements

| Current | Replace | Reason | Path | Done |
| --- | --- | --- | --- | --- |
| `FieldRecord` | `ModelShape` | Contains both scalars and relations; `ScalarRecord` would be false. | `src/schema/model/helper.ts` | x |
| `ScalarFieldKeys` | `ScalarKeys` | Keys of scalar entries. | `src/schema/model/helper.ts` | x |
| `RequiredFieldKeys` | `RequiredScalarKeys` | Required scalar keys. | `src/schema/model/helper.ts` | x |
| `UniqueFieldKeys` | `UniqueScalarKeys` | Unique/id scalar keys. | `src/schema/model/helper.ts` | x |
| `NumericFieldKeys` | `NumericScalarKeys` | Numeric scalar keys. | `src/schema/model/helper.ts` | x |
| `ScalarFields` | `ScalarMap` | Map of scalar entries. | `src/schema/model/helper.ts` | x |
| `RelationFields` | `RelationMap` | Map of relation entries; avoids relation "fields" wording. | `src/schema/model/helper.ts` | x |
| `UniqueFields` | `UniqueScalarMap` | Map of unique/id scalar entries. | `src/schema/model/helper.ts` | x |
| `ModelState.fields` | `ModelState.shape` or keep | Open decision: generic model-shape vocabulary, not scalar-only. Rename only if we want to purge public generic field wording too. | `src/schema/model/model.ts` | x |
| `s.model(fields)` | `s.model(shape)` or keep | Open decision: public API churn for model shape parameter. | `src/schema/model/model.ts` | x |

## Migration Type Mapping Replacements

| Current | Replace | Reason | Path | Done |
| --- | --- | --- | --- | --- |
| `VibORMFieldType` | `VibORMScalarType` | Migration type mapping maps scalar primitive types to SQL column types. | `src/migrations/drivers/type-mapping.ts` | x |
| `FieldTypeContext` | `ScalarTypeContext` | Context describes scalar-to-column mapping. | `src/migrations/drivers/type-mapping.ts` | x |
| `mapFieldType` | `mapScalarType` | Method maps scalar primitive type to database type. | `src/migrations/drivers/base.ts` | x |
| `mapFieldType` | `mapScalarType` | Method maps scalar primitive type to database type. | `src/migrations/drivers/mysql/index.ts` | x |
| `mapFieldType` | `mapScalarType` | Method maps scalar primitive type to database type. | `src/migrations/drivers/postgres/index.ts` | x |
| `mapFieldType` | `mapScalarType` | Method maps scalar primitive type to database type. | `src/migrations/drivers/sqlite/index.ts` | x |
| `mapFieldType` | `mapScalarType` | Caller maps model scalar to migration column type. | `src/migrations/serializer.ts` | x |
| `fieldType` property | `scalarType` property | Config interface describes scalar primitive kind. | `src/schema/fields/types.ts` | x |

## Path Rename Checklist

### Source Scalar Package

| Current | Replace | Reason | Path | Done |
| --- | --- | --- | --- | --- |
| `src/schema/fields/AGENTS.md` | `src/schema/scalars/AGENTS.md` | Local architecture guide for scalar package. | `src/schema/fields/AGENTS.md` | x |
| `src/schema/fields/base.ts` | `src/schema/scalars/base.ts` | Scalar union/type exports. | `src/schema/fields/base.ts` | x |
| `src/schema/fields/bigint/field.ts` | `src/schema/scalars/bigint/scalar.ts` | BigInt scalar implementation. | `src/schema/fields/bigint/field.ts` | x |
| `src/schema/fields/bigint/index.ts` | `src/schema/scalars/bigint/index.ts` | BigInt scalar exports. | `src/schema/fields/bigint/index.ts` | x |
| `src/schema/fields/blob/field.ts` | `src/schema/scalars/blob/scalar.ts` | Blob scalar implementation. | `src/schema/fields/blob/field.ts` | x |
| `src/schema/fields/blob/index.ts` | `src/schema/scalars/blob/index.ts` | Blob scalar exports. | `src/schema/fields/blob/index.ts` | x |
| `src/schema/fields/boolean/field.ts` | `src/schema/scalars/boolean/scalar.ts` | Boolean scalar implementation. | `src/schema/fields/boolean/field.ts` | x |
| `src/schema/fields/boolean/index.ts` | `src/schema/scalars/boolean/index.ts` | Boolean scalar exports. | `src/schema/fields/boolean/index.ts` | x |
| `src/schema/fields/common.ts` | `src/schema/scalars/common.ts` | Shared scalar state helpers. | `src/schema/fields/common.ts` | x |
| `src/schema/fields/datetime/date-field.ts` | `src/schema/scalars/datetime/date-scalar.ts` | Date scalar implementation. | `src/schema/fields/datetime/date-field.ts` | x |
| `src/schema/fields/datetime/field.ts` | `src/schema/scalars/datetime/scalar.ts` | DateTime scalar implementation. | `src/schema/fields/datetime/field.ts` | x |
| `src/schema/fields/datetime/index.ts` | `src/schema/scalars/datetime/index.ts` | Temporal scalar exports. | `src/schema/fields/datetime/index.ts` | x |
| `src/schema/fields/datetime/time-field.ts` | `src/schema/scalars/datetime/time-scalar.ts` | Time scalar implementation. | `src/schema/fields/datetime/time-field.ts` | x |
| `src/schema/fields/decimal/field.ts` | `src/schema/scalars/decimal/scalar.ts` | Decimal scalar implementation. | `src/schema/fields/decimal/field.ts` | x |
| `src/schema/fields/decimal/index.ts` | `src/schema/scalars/decimal/index.ts` | Decimal scalar exports. | `src/schema/fields/decimal/index.ts` | x |
| `src/schema/fields/enum/field.ts` | `src/schema/scalars/enum/scalar.ts` | Enum scalar implementation. | `src/schema/fields/enum/field.ts` | x |
| `src/schema/fields/enum/index.ts` | `src/schema/scalars/enum/index.ts` | Enum scalar exports. | `src/schema/fields/enum/index.ts` | x |
| `src/schema/fields/float/field.ts` | `src/schema/scalars/float/scalar.ts` | Float scalar implementation. | `src/schema/fields/float/field.ts` | x |
| `src/schema/fields/float/index.ts` | `src/schema/scalars/float/index.ts` | Float scalar exports. | `src/schema/fields/float/index.ts` | x |
| `src/schema/fields/index.ts` | `src/schema/scalars/index.ts` | Scalar package barrel. | `src/schema/fields/index.ts` | x |
| `src/schema/fields/int/field.ts` | `src/schema/scalars/int/scalar.ts` | Int scalar implementation. | `src/schema/fields/int/field.ts` | x |
| `src/schema/fields/int/index.ts` | `src/schema/scalars/int/index.ts` | Int scalar exports. | `src/schema/fields/int/index.ts` | x |
| `src/schema/fields/json/field.ts` | `src/schema/scalars/json/scalar.ts` | JSON scalar implementation. | `src/schema/fields/json/field.ts` | x |
| `src/schema/fields/json/index.ts` | `src/schema/scalars/json/index.ts` | JSON scalar exports. | `src/schema/fields/json/index.ts` | x |
| `src/schema/fields/native-types.ts` | `src/schema/scalars/native-types.ts` | Native scalar column type helpers. | `src/schema/fields/native-types.ts` | x |
| `src/schema/fields/number/field.ts` | `src/schema/scalars/number/scalar.ts` | Number scalar re-exports. | `src/schema/fields/number/field.ts` | x |
| `src/schema/fields/number/index.ts` | `src/schema/scalars/number/index.ts` | Number scalar exports. | `src/schema/fields/number/index.ts` | x |
| `src/schema/fields/point/field.ts` | `src/schema/scalars/point/scalar.ts` | Point scalar implementation. | `src/schema/fields/point/field.ts` | x |
| `src/schema/fields/point/index.ts` | `src/schema/scalars/point/index.ts` | Point scalar exports. | `src/schema/fields/point/index.ts` | x |
| `src/schema/fields/string/autogenerate.ts` | `src/schema/scalars/string/autogenerate.ts` | String scalar autogeneration helpers. | `src/schema/fields/string/autogenerate.ts` | x |
| `src/schema/fields/string/field.ts` | `src/schema/scalars/string/scalar.ts` | String scalar implementation. | `src/schema/fields/string/field.ts` | x |
| `src/schema/fields/string/index.ts` | `src/schema/scalars/string/index.ts` | String scalar exports. | `src/schema/fields/string/index.ts` | x |
| `src/schema/fields/types.ts` | `src/schema/scalars/types.ts` | Scalar config types. | `src/schema/fields/types.ts` | x |
| `src/schema/fields/vector/field.ts` | `src/schema/scalars/vector/scalar.ts` | Vector scalar implementation. | `src/schema/fields/vector/field.ts` | x |
| `src/schema/fields/vector/index.ts` | `src/schema/scalars/vector/index.ts` | Vector scalar exports. | `src/schema/fields/vector/index.ts` | x |

### Tests

| Current | Replace | Reason | Path | Done |
| --- | --- | --- | --- | --- |
| `tests/fields/bigint-field-schemas.test.ts` | `tests/scalars/bigint-scalar-schemas.test.ts` | BigInt scalar schema tests. | `tests/fields/bigint-field-schemas.test.ts` | x |
| `tests/fields/blob-field-schemas.test.ts` | `tests/scalars/blob-scalar-schemas.test.ts` | Blob scalar schema tests. | `tests/fields/blob-field-schemas.test.ts` | x |
| `tests/fields/boolean-field-schemas.test.ts` | `tests/scalars/boolean-scalar-schemas.test.ts` | Boolean scalar schema tests. | `tests/fields/boolean-field-schemas.test.ts` | x |
| `tests/fields/datetime-field-schemas.test.ts` | `tests/scalars/datetime-scalar-schemas.test.ts` | Temporal scalar schema tests. | `tests/fields/datetime-field-schemas.test.ts` | x |
| `tests/fields/enum-field-schemas.test.ts` | `tests/scalars/enum-scalar-schemas.test.ts` | Enum scalar schema tests. | `tests/fields/enum-field-schemas.test.ts` | x |
| `tests/fields/json-field-schemas.test.ts` | `tests/scalars/json-scalar-schemas.test.ts` | JSON scalar schema tests. | `tests/fields/json-field-schemas.test.ts` | x |
| `tests/fields/number-field-schemas.test.ts` | `tests/scalars/number-scalar-schemas.test.ts` | Numeric scalar schema tests. | `tests/fields/number-field-schemas.test.ts` | x |
| `tests/fields/point-field-schemas.test.ts` | `tests/scalars/point-scalar-schemas.test.ts` | Point scalar schema tests. | `tests/fields/point-field-schemas.test.ts` | x |
| `tests/fields/string-field-schemas.test.ts` | `tests/scalars/string-scalar-schemas.test.ts` | String scalar schema tests. | `tests/fields/string-field-schemas.test.ts` | x |
| `tests/fields/vector-field-schemas.test.ts` | `tests/scalars/vector-scalar-schemas.test.ts` | Vector scalar schema tests. | `tests/fields/vector-field-schemas.test.ts` | x |

### Docs Routes

| Current | Replace | Reason | Path | Done |
| --- | --- | --- | --- | --- |
| `docs/content/docs/schema/fields/bigint.mdx` | `docs/content/docs/schema/scalars/bigint.mdx` | BigInt scalar docs. | `docs/content/docs/schema/fields/bigint.mdx` | x |
| `docs/content/docs/schema/fields/blob.mdx` | `docs/content/docs/schema/scalars/blob.mdx` | Blob scalar docs. | `docs/content/docs/schema/fields/blob.mdx` | x |
| `docs/content/docs/schema/fields/boolean.mdx` | `docs/content/docs/schema/scalars/boolean.mdx` | Boolean scalar docs. | `docs/content/docs/schema/fields/boolean.mdx` | x |
| `docs/content/docs/schema/fields/datetime.mdx` | `docs/content/docs/schema/scalars/datetime.mdx` | Temporal scalar docs. | `docs/content/docs/schema/fields/datetime.mdx` | x |
| `docs/content/docs/schema/fields/enum.mdx` | `docs/content/docs/schema/scalars/enum.mdx` | Enum scalar docs. | `docs/content/docs/schema/fields/enum.mdx` | x |
| `docs/content/docs/schema/fields/index.mdx` | `docs/content/docs/schema/scalars/index.mdx` | Scalar docs index. | `docs/content/docs/schema/fields/index.mdx` | x |
| `docs/content/docs/schema/fields/json.mdx` | `docs/content/docs/schema/scalars/json.mdx` | JSON scalar docs. | `docs/content/docs/schema/fields/json.mdx` | x |
| `docs/content/docs/schema/fields/meta.json` | `docs/content/docs/schema/scalars/meta.json` | Scalar docs navigation. | `docs/content/docs/schema/fields/meta.json` | x |
| `docs/content/docs/schema/fields/number.mdx` | `docs/content/docs/schema/scalars/number.mdx` | Numeric scalar docs. | `docs/content/docs/schema/fields/number.mdx` | x |
| `docs/content/docs/schema/fields/string.mdx` | `docs/content/docs/schema/scalars/string.mdx` | String scalar docs. | `docs/content/docs/schema/fields/string.mdx` | x |
| `docs/content/docs/schema/fields/vector.mdx` | `docs/content/docs/schema/scalars/vector.mdx` | Vector scalar docs. | `docs/content/docs/schema/fields/vector.mdx` | x |

## Import Path Checklist

| Current | Replace | Reason | Path | Done |
| --- | --- | --- | --- | --- |
| `@schema/fields` imports | `@schema/scalars` imports | Import scalar definitions from renamed package. | `src/client/result-types.ts` | x |
| `@schema/model/helper` names using `FieldRecord` | `ModelShape` helper names | Client type extraction should use model shape vocabulary. | `src/client/types.ts` | x |
| `@schema/fields` imports | `@schema/scalars` imports | Migration base driver maps scalar primitives. | `src/migrations/drivers/base.ts` | x |
| `@schema/fields` imports | `@schema/scalars` imports | MySQL migration driver maps scalar primitives. | `src/migrations/drivers/mysql/index.ts` | x |
| `@schema/fields` imports | `@schema/scalars` imports | Postgres migration driver maps scalar primitives. | `src/migrations/drivers/postgres/index.ts` | x |
| `@schema/fields` imports | `@schema/scalars` imports | SQLite migration driver maps scalar primitives. | `src/migrations/drivers/sqlite/index.ts` | x |
| `@schema/fields/native-types` import | `@schema/scalars/native-types` import | Native scalar type helpers move with scalar package. | `src/migrations/drivers/type-mapping.ts` | x |
| `../schema/fields/base` import | `../schema/scalars/base` import | Serializer reads scalar state. | `src/migrations/serializer.ts` | x |
| `@schema/fields` import | `@schema/scalars` import | Generated default helper reads scalar state. | `src/query-engine/builders/generated-field.ts` | x |
| `@schema/fields` import | `@schema/scalars` import | Where builder reads scalar state/type. | `src/query-engine/builders/where-builder.ts` | x |
| `@schema/fields` import | `@schema/scalars` import | Result parser reads scalar state/type. | `src/query-engine/result/result-parser.ts` | x |
| `./fields` exports | `./scalars` exports | Public schema exports should expose scalar vocabulary. | `src/schema/exports.ts` | x |
| `./fields/*` imports | `./scalars/*` imports | Hydration should read scalar state from scalar package. | `src/schema/hydration.ts` | x |
| `./fields/*` imports/exports | `./scalars/*` imports/exports | Main schema API should expose scalar vocabulary. | `src/schema/index.ts` | x |
| `@schema/fields/base` import | `@schema/scalars/base` import | Model helper distinguishes scalars from relations. | `src/schema/model/helper.ts` | x |
| `../fields/*` imports | `../scalars/*` imports | Model state uses scalar definitions. | `src/schema/model/model.ts` | x |
| `../../fields/base` import | `../../scalars/base` import | Schema validation rule inspects scalar definitions. | `src/schema/validation/rules/database.ts` | x |
| `../../fields/base` import | `../../scalars/base` import | FK validation rule inspects scalar definitions. | `src/schema/validation/rules/fk.ts` | x |
| `../../fields/base` import | `../../scalars/base` import | Model validation rule inspects scalar definitions. | `src/schema/validation/rules/model.ts` | x |
| `../../fields/base` import | `../../scalars/base` import | Relation validation rule inspects scalar definitions. | `src/schema/validation/rules/relation.ts` | x |
| `@schema/fields` import | `@schema/scalars` import | Create validation uses scalar helper types. | `src/validation/model/core/create.ts` | x |
| `@schema/fields/common` import | `@schema/scalars/common` import | BigInt operation schemas derive from scalar state. | `src/validation/scalars/bigint.ts` | x |
| `@schema/fields/common` import | `@schema/scalars/common` import | Blob operation schemas derive from scalar state. | `src/validation/scalars/blob.ts` | x |
| `@schema/fields/common` import | `@schema/scalars/common` import | Boolean operation schemas derive from scalar state. | `src/validation/scalars/boolean.ts` | x |
| `@schema/fields/common` import | `@schema/scalars/common` import | Date operation schemas derive from scalar state. | `src/validation/scalars/date.ts` | x |
| `@schema/fields/common` import | `@schema/scalars/common` import | DateTime operation schemas derive from scalar state. | `src/validation/scalars/datetime.ts` | x |
| `@schema/fields/common` import | `@schema/scalars/common` import | Decimal operation schemas derive from scalar state. | `src/validation/scalars/decimal.ts` | x |
| `@schema/fields/common` import | `@schema/scalars/common` import | Enum operation schemas derive from scalar state. | `src/validation/scalars/enum.ts` | x |
| `@schema/fields/common` import | `@schema/scalars/common` import | Float operation schemas derive from scalar state. | `src/validation/scalars/float.ts` | x |
| `@schema/fields` import | `@schema/scalars` import | Scalar schema registry dispatch uses scalar state. | `src/validation/scalars/index.ts` | x |
| `@schema/fields/common` import | `@schema/scalars/common` import | Int operation schemas derive from scalar state. | `src/validation/scalars/int.ts` | x |
| `@schema/fields/common` import | `@schema/scalars/common` import | JSON operation schemas derive from scalar state. | `src/validation/scalars/json.ts` | x |
| `@schema/fields/common` import | `@schema/scalars/common` import | Point operation schemas derive from scalar state. | `src/validation/scalars/point.ts` | x |
| `@schema/fields/common` import | `@schema/scalars/common` import | String operation schemas derive from scalar state. | `src/validation/scalars/string.ts` | x |
| `@schema/fields/common` import | `@schema/scalars/common` import | Time operation schemas derive from scalar state. | `src/validation/scalars/time.ts` | x |
| `@schema/fields/common` import | `@schema/scalars/common` import | Vector operation schemas derive from scalar state. | `src/validation/scalars/vector.ts` | x |
| `@schema/fields/*` imports | `@schema/scalars/*` imports | BigInt scalar tests. | `tests/fields/bigint-field-schemas.test.ts` | x |
| `@schema/fields/*` imports | `@schema/scalars/*` imports | Blob scalar tests. | `tests/fields/blob-field-schemas.test.ts` | x |
| `@schema/fields/*` imports | `@schema/scalars/*` imports | Boolean scalar tests. | `tests/fields/boolean-field-schemas.test.ts` | x |
| `@schema/fields/*` imports | `@schema/scalars/*` imports | Temporal scalar tests. | `tests/fields/datetime-field-schemas.test.ts` | x |
| `@schema/fields/*` imports | `@schema/scalars/*` imports | Enum scalar tests. | `tests/fields/enum-field-schemas.test.ts` | x |
| `@schema/fields/*` imports | `@schema/scalars/*` imports | JSON scalar tests. | `tests/fields/json-field-schemas.test.ts` | x |
| `@schema/fields/*` imports | `@schema/scalars/*` imports | Numeric scalar tests. | `tests/fields/number-field-schemas.test.ts` | x |
| `@schema/fields/*` imports | `@schema/scalars/*` imports | Point scalar tests. | `tests/fields/point-field-schemas.test.ts` | x |
| `@schema/fields/*` imports | `@schema/scalars/*` imports | String scalar tests. | `tests/fields/string-field-schemas.test.ts` | x |
| `@schema/fields/*` imports | `@schema/scalars/*` imports | Vector scalar tests. | `tests/fields/vector-field-schemas.test.ts` | x |
| `../../src/schema/fields/common` import | `../../src/schema/scalars/common` import | Migration DDL tests use scalar state/type. | `tests/migrations/ddl-drivers.test.ts` | x |
| `../../src/schema/fields/common` import | `../../src/schema/scalars/common` import | Migration DDL tests use scalar state/type. | `tests/migrations/ddl.test.ts` | x |
| `../../src/schema/fields` import | `../../src/schema/scalars` import | Shared scalar instance test. | `tests/schema/shared-field.test.ts` | x |

## Symbol Checklist

### Concrete Scalar Classes

| Current | Replace | Reason | Path | Done |
| --- | --- | --- | --- | --- |
| `StringField` | `StringScalar` | Concrete scalar class. | `src/schema/fields/string/field.ts` | x |
| `StringField` | `StringScalar` | Re-export concrete scalar class. | `src/schema/fields/string/index.ts` | x |
| `IntField` | `IntScalar` | Concrete scalar class. | `src/schema/fields/int/field.ts` | x |
| `IntField` | `IntScalar` | Re-export concrete scalar class. | `src/schema/fields/int/index.ts` | x |
| `FloatField` | `FloatScalar` | Concrete scalar class. | `src/schema/fields/float/field.ts` | x |
| `FloatField` | `FloatScalar` | Re-export concrete scalar class. | `src/schema/fields/float/index.ts` | x |
| `DecimalField` | `DecimalScalar` | Concrete scalar class. | `src/schema/fields/decimal/field.ts` | x |
| `DecimalField` | `DecimalScalar` | Re-export concrete scalar class. | `src/schema/fields/decimal/index.ts` | x |
| `BooleanField` | `BooleanScalar` | Concrete scalar class. | `src/schema/fields/boolean/field.ts` | x |
| `BooleanField` | `BooleanScalar` | Re-export concrete scalar class. | `src/schema/fields/boolean/index.ts` | x |
| `DateTimeField` | `DateTimeScalar` | Concrete scalar class. | `src/schema/fields/datetime/field.ts` | x |
| `DateTimeField` | `DateTimeScalar` | Re-export concrete scalar class. | `src/schema/fields/datetime/index.ts` | x |
| `DateField` | `DateScalar` | Concrete scalar class. | `src/schema/fields/datetime/date-field.ts` | x |
| `DateField` | `DateScalar` | Re-export concrete scalar class. | `src/schema/fields/datetime/index.ts` | x |
| `TimeField` | `TimeScalar` | Concrete scalar class. | `src/schema/fields/datetime/time-field.ts` | x |
| `TimeField` | `TimeScalar` | Re-export concrete scalar class. | `src/schema/fields/datetime/index.ts` | x |
| `BigIntField` | `BigIntScalar` | Concrete scalar class. | `src/schema/fields/bigint/field.ts` | x |
| `BigIntField` | `BigIntScalar` | Re-export concrete scalar class. | `src/schema/fields/bigint/index.ts` | x |
| `JsonField` | `JsonScalar` | Concrete scalar class. | `src/schema/fields/json/field.ts` | x |
| `JsonField` | `JsonScalar` | Re-export concrete scalar class. | `src/schema/fields/json/index.ts` | x |
| `BlobField` | `BlobScalar` | Concrete scalar class. | `src/schema/fields/blob/field.ts` | x |
| `BlobField` | `BlobScalar` | Re-export concrete scalar class. | `src/schema/fields/blob/index.ts` | x |
| `PointField` | `PointScalar` | Concrete scalar class. | `src/schema/fields/point/field.ts` | x |
| `PointField` | `PointScalar` | Re-export concrete scalar class. | `src/schema/fields/point/index.ts` | x |
| `EnumField` | `EnumScalar` | Concrete scalar class. | `src/schema/fields/enum/field.ts` | x |
| `EnumField` | `EnumScalar` | Re-export concrete scalar class. | `src/schema/fields/enum/index.ts` | x |
| `VectorField` | `VectorScalar` | Concrete scalar class. | `src/schema/fields/vector/field.ts` | x |
| `VectorField` | `VectorScalar` | Re-export concrete scalar class. | `src/schema/fields/vector/index.ts` | x |
| `NumberField` | `NumberScalar` | Numeric scalar union export. | `src/schema/fields/index.ts` | x |
| `IntField`, `FloatField`, `DecimalField` | `IntScalar`, `FloatScalar`, `DecimalScalar` | Numeric scalar re-export file. | `src/schema/fields/number/field.ts` | x |
| `StringField`, `IntField`, `FloatField`, `DecimalField`, `BooleanField`, `DateTimeField`, `DateField`, `TimeField`, `BigIntField`, `JsonField`, `BlobField`, `PointField`, `EnumField`, `VectorField` | `StringScalar`, `IntScalar`, `FloatScalar`, `DecimalScalar`, `BooleanScalar`, `DateTimeScalar`, `DateScalar`, `TimeScalar`, `BigIntScalar`, `JsonScalar`, `BlobScalar`, `PointScalar`, `EnumScalar`, `VectorScalar` | Scalar union imports and members. | `src/schema/fields/base.ts` | x |
| All `*Field` scalar class exports | All `*Scalar` scalar class exports | Public scalar barrel. | `src/schema/fields/index.ts` | x |
| All `*Field` scalar class exports | All `*Scalar` scalar class exports | Main schema public exports. | `src/schema/index.ts` | x |
| `NumberField` | `NumberScalar` | Public schema export. | `src/schema/exports.ts` | x |

### Scalar State And Union Types

| Current | Replace | Reason | Path | Done |
| --- | --- | --- | --- | --- |
| `Field` | `Scalar` | Scalar primitive union. | `src/schema/fields/base.ts` | x |
| `AnyField` | `AnyScalar` | Loose scalar primitive union alias. | `src/schema/fields/base.ts` | x |
| `FieldState` | `ScalarState` | Scalar instance state. | `src/schema/fields/common.ts` | x |
| `FieldState` | `ScalarState` | Scalar union imports state. | `src/schema/fields/base.ts` | x |
| `FieldState` | `ScalarState` | Public scalar barrel. | `src/schema/fields/index.ts` | x |
| `FieldState` | `ScalarState` | Main schema public type exports. | `src/schema/index.ts` | x |
| `FieldState` | `ScalarState` | String scalar implementation. | `src/schema/fields/string/field.ts` | x |
| `FieldState` | `ScalarState` | Int scalar implementation. | `src/schema/fields/int/field.ts` | x |
| `FieldState` | `ScalarState` | Float scalar implementation. | `src/schema/fields/float/field.ts` | x |
| `FieldState` | `ScalarState` | Decimal scalar implementation. | `src/schema/fields/decimal/field.ts` | x |
| `FieldState` | `ScalarState` | Boolean scalar implementation. | `src/schema/fields/boolean/field.ts` | x |
| `FieldState` | `ScalarState` | DateTime scalar implementation. | `src/schema/fields/datetime/field.ts` | x |
| `FieldState` | `ScalarState` | Date scalar implementation. | `src/schema/fields/datetime/date-field.ts` | x |
| `FieldState` | `ScalarState` | Time scalar implementation. | `src/schema/fields/datetime/time-field.ts` | x |
| `FieldState` | `ScalarState` | BigInt scalar implementation. | `src/schema/fields/bigint/field.ts` | x |
| `FieldState` | `ScalarState` | JSON scalar implementation. | `src/schema/fields/json/field.ts` | x |
| `FieldState` | `ScalarState` | Blob scalar implementation. | `src/schema/fields/blob/field.ts` | x |
| `FieldState` | `ScalarState` | Point scalar implementation. | `src/schema/fields/point/field.ts` | x |
| `FieldState` | `ScalarState` | Enum scalar implementation. | `src/schema/fields/enum/field.ts` | x |
| `FieldState` | `ScalarState` | Vector scalar implementation. | `src/schema/fields/vector/field.ts` | x |
| `ScalarFieldType` | `ScalarType` | Remove field vocabulary from scalar type discriminator. | `src/schema/fields/common.ts` | x |
| `ScalarFieldType` | `ScalarType` | Remove field vocabulary from scalar config types. | `src/schema/fields/types.ts` | x |
| `ScalarFieldType` | `ScalarType` | Public scalar barrel. | `src/schema/fields/index.ts` | x |
| `ScalarFieldType` | `ScalarType` | Main schema public exports. | `src/schema/index.ts` | x |

### Cross-Layer Type Usage

| Current | Replace | Reason | Path | Done |
| --- | --- | --- | --- | --- |
| `Field`, `FieldState` | `Scalar`, `ScalarState` | Client result inference maps scalar outputs. | `src/client/result-types.ts` | x |
| `FieldRecord` | `ModelShape` | Client operation payload derives from model shape. | `src/client/types.ts` | x |
| `Field`, `FieldState` | `Scalar`, `ScalarState` | Migration base maps scalars to SQL columns. | `src/migrations/drivers/base.ts` | x |
| `Field`, `FieldState` | `Scalar`, `ScalarState` | MySQL migration driver maps scalars to SQL columns. | `src/migrations/drivers/mysql/index.ts` | x |
| `Field`, `FieldState` | `Scalar`, `ScalarState` | Postgres migration driver maps scalars to SQL columns. | `src/migrations/drivers/postgres/index.ts` | x |
| `Field`, `FieldState` | `Scalar`, `ScalarState` | SQLite migration driver maps scalars to SQL columns. | `src/migrations/drivers/sqlite/index.ts` | x |
| `Field` | `Scalar` | Serializer reads scalar definitions. | `src/migrations/serializer.ts` | x |
| `Field` | `Scalar` | Generated default helper reads scalar state. | `src/query-engine/builders/generated-field.ts` | x |
| `FieldState`, `ScalarFieldType` | `ScalarState`, `ScalarType` | Where builder checks scalar filters. | `src/query-engine/builders/where-builder.ts` | x |
| `Field` | `Scalar` | Result parser parses scalar values. | `src/query-engine/result/result-parser.ts` | x |
| `Field` | `Scalar` | Hydration reads scalar/relation model members. | `src/schema/hydration.ts` | x |
| `Field` | `Scalar` | Model helper extracts scalars from model shape. | `src/schema/model/helper.ts` | x |
| `FieldRecord`, `ScalarFields`, `RelationFields`, `UniqueFields` | `ModelShape`, `ScalarMap`, `RelationMap`, `UniqueScalarMap` | Model state helper types should avoid field vocabulary. | `src/schema/model/model.ts` | x |
| `Field` | `Scalar` | Database schema validation inspects scalar definitions. | `src/schema/validation/rules/database.ts` | x |
| `Field` | `Scalar` | FK schema validation inspects scalar definitions. | `src/schema/validation/rules/fk.ts` | x |
| `Field` | `Scalar` | Model schema validation inspects scalar definitions. | `src/schema/validation/rules/model.ts` | x |
| `Field` | `Scalar` | Relation schema validation inspects scalar definitions. | `src/schema/validation/rules/relation.ts` | x |
| `RequiredFieldKeys` | `RequiredScalarKeys` | Create validation requires scalar keys. | `src/validation/model/core/create.ts` | x |
| `ScalarFieldKeys`, `NumericFieldKeys` | `ScalarKeys`, `NumericScalarKeys` | Aggregate/groupBy validation uses scalar keys. | `src/validation/model/args/aggregate.ts` | x |

### Validation Scalar Files

| Current | Replace | Reason | Path | Done |
| --- | --- | --- | --- | --- |
| `FieldState` | `ScalarState` | BigInt schema builder derives from scalar state. | `src/validation/scalars/bigint.ts` | x |
| `FieldState` | `ScalarState` | Blob schema builder derives from scalar state. | `src/validation/scalars/blob.ts` | x |
| `FieldState` | `ScalarState` | Boolean schema builder derives from scalar state. | `src/validation/scalars/boolean.ts` | x |
| `FieldState` | `ScalarState` | Date schema builder derives from scalar state. | `src/validation/scalars/date.ts` | x |
| `FieldState` | `ScalarState` | DateTime schema builder derives from scalar state. | `src/validation/scalars/datetime.ts` | x |
| `FieldState` | `ScalarState` | Decimal schema builder derives from scalar state. | `src/validation/scalars/decimal.ts` | x |
| `FieldState` | `ScalarState` | Enum schema builder derives from scalar state. | `src/validation/scalars/enum.ts` | x |
| `FieldState` | `ScalarState` | Float schema builder derives from scalar state. | `src/validation/scalars/float.ts` | x |
| `FieldState` | `ScalarState` | Scalar schema dispatcher derives from scalar state. | `src/validation/scalars/index.ts` | x |
| `FieldState` | `ScalarState` | Int schema builder derives from scalar state. | `src/validation/scalars/int.ts` | x |
| `FieldState` | `ScalarState` | JSON schema builder derives from scalar state. | `src/validation/scalars/json.ts` | x |
| `FieldState` | `ScalarState` | Point schema builder derives from scalar state. | `src/validation/scalars/point.ts` | x |
| `FieldState` | `ScalarState` | String schema builder derives from scalar state. | `src/validation/scalars/string.ts` | x |
| `FieldState` | `ScalarState` | Time schema builder derives from scalar state. | `src/validation/scalars/time.ts` | x |
| `FieldState` | `ScalarState` | Vector schema builder derives from scalar state. | `src/validation/scalars/vector.ts` | x |

## Documentation Checklist

| Current | Replace | Reason | Path | Done |
| --- | --- | --- | --- | --- |
| `Field Types`, `field type`, `field schema`, `FieldState` | `Scalar Types`, `scalar type`, `scalar schema`, `ScalarState` | README describes scalar primitives. | `README.md` | x |
| `Field Types`, `FieldState`, `FieldRecord`, scalar primitive `field` wording | `Scalar Types`, `ScalarState`, `ModelShape`, scalar primitive wording | Schema README describes scalar package and model shape. | `src/schema/README.md` | x |
| `fields/` package docs | `scalars/` package docs | Schema architecture guide should point to scalar package. | `src/schema/AGENTS.md` | x |
| `Schema Fields`, `Field Types`, `FieldState`, `StringField`, `Field` | `Schema Scalars`, `Scalar Types`, `ScalarState`, `StringScalar`, `Scalar` | Local scalar package guide. | `src/schema/fields/AGENTS.md` | x |
| `src/schema/fields` references | `src/schema/scalars` references | Validation guide should point to scalar package. | `src/validation/AGENTS.md` | x |
| Scalar package cross-link as fields | Scalar package cross-link as scalars | Relation guide should link to scalar package while keeping FK `.fields()`. | `src/schema/relation/AGENTS.md` | x |
| `schema/fields` docs route | `schema/scalars` docs route | Docs navigation. | `docs/content/docs/meta.json` | x |
| `/docs/schema/fields` href | `/docs/schema/scalars` href | Schema docs card route. | `docs/content/docs/schema/index.mdx` | x |
| Scalar primitive page title/copy using `Field` | Scalar primitive page title/copy using `Scalar` | BigInt scalar docs. | `docs/content/docs/schema/fields/bigint.mdx` | x |
| Scalar primitive page title/copy using `Field` | Scalar primitive page title/copy using `Scalar` | Blob scalar docs. | `docs/content/docs/schema/fields/blob.mdx` | x |
| Scalar primitive page title/copy using `Field` | Scalar primitive page title/copy using `Scalar` | Boolean scalar docs. | `docs/content/docs/schema/fields/boolean.mdx` | x |
| Scalar primitive page title/copy using `Field` | Scalar primitive page title/copy using `Scalar` | Temporal scalar docs. | `docs/content/docs/schema/fields/datetime.mdx` | x |
| Scalar primitive page title/copy using `Field` | Scalar primitive page title/copy using `Scalar` | Enum scalar docs. | `docs/content/docs/schema/fields/enum.mdx` | x |
| `Field Types` docs index | `Scalar Types` docs index | Scalar docs index. | `docs/content/docs/schema/fields/index.mdx` | x |
| Scalar primitive page title/copy using `Field` | Scalar primitive page title/copy using `Scalar` | JSON scalar docs. | `docs/content/docs/schema/fields/json.mdx` | x |
| Scalar primitive page title/copy using `Field` | Scalar primitive page title/copy using `Scalar` | Number scalar docs. | `docs/content/docs/schema/fields/number.mdx` | x |
| Scalar primitive page title/copy using `Field` | Scalar primitive page title/copy using `Scalar` | String scalar docs. | `docs/content/docs/schema/fields/string.mdx` | x |
| Scalar primitive page title/copy using `Field` | Scalar primitive page title/copy using `Scalar` | Vector scalar docs. | `docs/content/docs/schema/fields/vector.mdx` | x |
| `Field type definitions`, `src/schema/fields`, `FieldState`, `Field Types` | `Scalar type definitions`, `src/schema/scalars`, `ScalarState`, `Scalar Types` | Internals page describes scalar implementation. | `docs/content/docs/internals/fields.mdx` | x |
| `L2: Fields` | `L2: Scalars` | Internals architecture layer naming. | `docs/content/docs/internals/index.mdx` | x |
| `fields/` layer and `StringField` examples | `scalars/` layer and `StringScalar` examples | Internals architecture diagrams. | `docs/content/docs/internals/architecture.mdx` | x |
| Scalar primitive `Field Types` section | `Scalar Types` section | Reference schema API. | `docs/content/docs/reference/schema-api.mdx` | x |
| `Field`, `NumberField`, primitive field comments | `Scalar`, `NumberScalar`, primitive scalar comments | Public exports reference. | `docs/content/docs/reference/exports.mdx` | x |
| `field types` in migration type mapping docs | `scalar types` | Migration docs explain scalar-to-column mapping. | `docs/content/docs/migration/drivers/index.mdx` | x |
| `Field Class`, `Field Scalar Types` | `Scalar Class`, `Scalar Types` | Old readme table of contents. | `readme/README.md` | x |
| `field class`, `field types`, `FieldState` | `scalar class`, `scalar types`, `ScalarState` | Old field class design doc. | `readme/1.2_field_class.md` | x |
| `field scalar types` | `scalar types` | Old scalar reference title. | `readme/1.3_field_scalar_types.md` | x |
| `BaseField`, `StringField`, `FieldState` | `BaseScalar`, `StringScalar`, `ScalarState` | Old schema architecture diagrams. | `readme/SCHEMA_ARCHITECTURE.md` | x |
| `BaseField`, `StringField`, `FieldState` | `BaseScalar`, `StringScalar`, `ScalarState` | Old advanced type-system doc. | `readme/advanced-type-system.md` | x |
| `All Field Types`, `StringField`, `FieldState` | `All Scalar Types`, `StringScalar`, `ScalarState` | Old all-types status doc. | `readme/all-field-types-working.md` | x |
| `StringField`, `NumberField`, `BooleanField`, scalar primitive field wording | `StringScalar`, `NumberScalar`, `BooleanScalar`, scalar primitive wording | Old scalar specificity doc. | `readme/field_specificity.md` | x |
| `StringField`, `NumberField`, `Field<T>` | `StringScalar`, `NumberScalar`, `Scalar<T>` | Old type-system generics doc. | `readme/type_system_generics.md` | x |

## Test Content Checklist

| Current | Replace | Reason | Path | Done |
| --- | --- | --- | --- | --- |
| `FieldState`, `field` local scalar variables, `Raw BigInt Field` titles | `ScalarState`, `scalar` locals, `Raw BigInt Scalar` titles | BigInt scalar tests. | `tests/fields/bigint-field-schemas.test.ts` | x |
| `FieldState`, `field` local scalar variables, `Blob Field` titles | `ScalarState`, `scalar` locals, `Blob Scalar` titles | Blob scalar tests. | `tests/fields/blob-field-schemas.test.ts` | x |
| `FieldState`, `field` local scalar variables, `Boolean Field` titles | `ScalarState`, `scalar` locals, `Boolean Scalar` titles | Boolean scalar tests. | `tests/fields/boolean-field-schemas.test.ts` | x |
| `FieldState`, `field` local scalar variables, `DateTime Field` titles | `ScalarState`, `scalar` locals, `DateTime Scalar` titles | Temporal scalar tests. | `tests/fields/datetime-field-schemas.test.ts` | x |
| `FieldState`, `field` local scalar variables, `Enum Field` titles | `ScalarState`, `scalar` locals, `Enum Scalar` titles | Enum scalar tests. | `tests/fields/enum-field-schemas.test.ts` | x |
| `FieldState`, `field` local scalar variables, `JSON Field` titles | `ScalarState`, `scalar` locals, `JSON Scalar` titles | JSON scalar tests. | `tests/fields/json-field-schemas.test.ts` | x |
| `FieldState`, `field` local scalar variables, `Number Field` titles | `ScalarState`, `scalar` locals, `Number Scalar` titles | Numeric scalar tests. | `tests/fields/number-field-schemas.test.ts` | x |
| `FieldState`, `field` local scalar variables, `Point Field` titles | `ScalarState`, `scalar` locals, `Point Scalar` titles | Point scalar tests. | `tests/fields/point-field-schemas.test.ts` | x |
| `FieldState`, `field` local scalar variables, `String Field` titles | `ScalarState`, `scalar` locals, `String Scalar` titles | String scalar tests. | `tests/fields/string-field-schemas.test.ts` | x |
| `FieldState`, `field` local scalar variables, `Vector Field` titles | `ScalarState`, `scalar` locals, `Vector Scalar` titles | Vector scalar tests. | `tests/fields/vector-field-schemas.test.ts` | x |
| `enumField` scalar factory | `enumScalar` scalar factory | Enum factory should match scalar naming while `s.enum()` remains the builder API. | `src/schema/scalars/enum/scalar.ts` | x |
| `enumField` imports/usages | `enumScalar` imports/usages | Tests and docs should not import scalar factory under field naming. | `tests/scalars/enum-scalar-schemas.test.ts` | x |
| `readme/*field*` scalar-design filenames | `readme/*scalar*` scalar-design filenames | Scalar design notes should not live under field-named files. | `readme/` | x |
| Scalar object locals named `field` | Scalar object locals named `scalar` | Code should reserve `field` for model field keys and relation FK fields. | `src/schema/validation/`, `src/query-engine/` | x |
| `All Field Types` | `All Scalar Types` | Integration test uses scalar primitive suite wording. | `tests/client/all-field-types.test.ts` | x |
| `FieldState`, `ScalarFieldType` | `ScalarState`, `ScalarType` | DDL tests use scalar state/type. | `tests/migrations/ddl.test.ts` | x |
| `FieldState`, `ScalarFieldType` | `ScalarState`, `ScalarType` | Driver DDL tests use scalar state/type. | `tests/migrations/ddl-drivers.test.ts` | x |
| `shared-field` test name/content | `shared-scalar` test name/content | Shared scalar instance test. | `tests/schema/shared-field.test.ts` | x |

## Keep Checklist

| Current | Replace | Reason | Path | Done |
| --- | --- | --- | --- | --- |
| `.fields(...names)` | Do not replace | Relation FK API. | `src/schema/relation/to-one.ts` | x |
| `RelationState.fields` | Do not replace | Stores FK field names. | `src/schema/relation/types.ts` | x |
| `fields/references` wording | Do not replace | Relation correlation terminology. | `src/query-engine/builders/correlation-utils.ts` | x |
| Relation/index/constraint `fields` arrays | Do not replace | Arrays contain user model field names. | `src/migrations/serializer.ts` | x |
| `.fields("fk").references("id")` examples | Do not replace | Public relation API examples. | `docs/content/docs/reference/schema-api.mdx` | x |
| `.fields("authorId").references("id")` examples | Do not replace | Public relation API examples. | `README.md` | x |
| `fieldName` for user model keys | Do not replace by default | Could refer to scalar or relation model key. | Package-wide | x |
| Query messages like `Unknown where field` | Review manually | Refers to user input key, not necessarily scalar primitive. | `src/query-engine/builders/where-builder.ts` | x |

## Verification Checklist

| Current | Replace | Reason | Path | Done |
| --- | --- | --- | --- | --- |
| `pnpm type-check` | Passing result | Type surface must compile after rename. | Repository root | x |
| `pnpm vitest run tests/scalars tests/migrations/ddl.test.ts tests/migrations/ddl-drivers.test.ts tests/client/all-field-types.test.ts` | Passing result | Focused scalar, migration, and all-scalar integration tests. | Repository root | x |
| `git diff --check` | Passing result | No whitespace damage. | Repository root | x |

Final stale-name scans:

```bash
rg -n "@schema/fields|src/schema/fields|tests/fields|/docs/schema/fields|schema/fields"
rg -n "\\b(StringField|IntField|FloatField|DecimalField|BooleanField|DateTimeField|DateField|TimeField|BigIntField|JsonField|BlobField|PointField|EnumField|VectorField|NumberField)\\b" src tests docs readme README.md
rg -n "\\b(FieldState|AnyField|ScalarFieldType|FieldRecord|ScalarFieldKeys|RequiredFieldKeys|UniqueFieldKeys|NumericFieldKeys|ScalarFields|RelationFields|UniqueFields)\\b" src tests docs readme README.md
rg -n "\\b(VibORMFieldType|FieldTypeContext|mapFieldType)\\b" src tests docs readme README.md
```

Expected remaining `field` matches after the scalar migration:

```text
relation .fields() and .references() docs/code
model/index/constraint field-name arrays
query error messages that refer to unknown user model keys
SQL column-name helper docs if the public name intentionally stays field-oriented
```
