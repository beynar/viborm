// Base Scalar Exports
// Common types and interfaces for all scalar classes

import type { BigIntScalar } from "./bigint/scalar";
import type { BlobScalar } from "./blob/scalar";
import type { BooleanScalar } from "./boolean/scalar";
import type { ScalarState } from "./common";
import type { DateScalar } from "./datetime/date-scalar";
import type { DateTimeScalar } from "./datetime/scalar";
import type { TimeScalar } from "./datetime/time-scalar";
import type { DecimalScalar } from "./decimal/scalar";
import type { EnumScalar } from "./enum/scalar";
import type { FloatScalar } from "./float/scalar";
import type { IntScalar } from "./int/scalar";
import type { JsonScalar } from "./json/scalar";
import type { PointScalar } from "./point/scalar";
import type { StringScalar } from "./string/scalar";
import type { VectorScalar } from "./vector/scalar";

// =============================================================================
// SCALAR TYPE - UNION OF ALL SCALAR CLASSES
// =============================================================================

/**
 * Union type of all concrete scalar classes with any state.
 * This is the canonical "Scalar" type used throughout the codebase.
 *
 * Benefits over an interface:
 * - No need to maintain a separate interface in sync with classes
 * - TypeScript infers exact shape from actual implementations
 * - Adding new properties (like nativeType) automatically works
 */

export type Scalar =
  | StringScalar<ScalarState<"string">>
  | IntScalar<ScalarState<"int">>
  | FloatScalar<ScalarState<"float">>
  | DecimalScalar<ScalarState<"decimal">>
  | BooleanScalar<ScalarState<"boolean">>
  | DateTimeScalar<ScalarState<"datetime">>
  | DateScalar<ScalarState<"date">>
  | TimeScalar<ScalarState<"time">>
  | BigIntScalar<ScalarState<"bigint">>
  | JsonScalar<ScalarState<"json">>
  | VectorScalar<ScalarState<"vector">>
  | BlobScalar<ScalarState<"blob">>
  | PointScalar<ScalarState<"point">>
  | EnumScalar<ScalarState<"enum">>;

/**
 * Any scalar with any state (for loose typing).
 * Alias for Scalar - both represent the union of all scalar classes.
 */
export type AnyScalar = Scalar;

// =============================================================================
// RE-EXPORTS FROM COMMON
// =============================================================================

export {
  type AutoGenerate,
  type AutoGenerateType,
  createDefaultState,
  type DefaultValue,
  type InferBaseType,
  type InferCreateType,
  type MaybeArray,
  type MaybeNullable,
  type ScalarState,
  type ScalarType,
  type UpdateState,
} from "./common";
