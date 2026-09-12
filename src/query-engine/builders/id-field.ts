/**
 * Where the query engine reads an identifier field's DOMAIN and its PHYSICAL
 * form.
 *
 * Two facts, asked together because no seam needs one without the other. The
 * DOMAIN — declared by a named format, or derived by L5 from the key a foreign
 * key references — says which strings the field holds and what their canonical
 * spelling is. The REPRESENTATION says what the column physically holds for
 * one, and it is the ADAPTER's answer: `bytea` on PostgreSQL and `BINARY(16)`
 * on MySQL are the same ULID, and the engine is not allowed to know which
 * dialect it is building for.
 *
 * These are lookups, not a second identifier concept, exactly as
 * {@link file://./decimal-field.ts} is for decimals. A field with no domain
 * answers `undefined` everywhere and every path stays the one it was.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import type { Model } from "@schema/model";
import type { Scalar } from "@schema/scalars/base";
import { idDomainOfState } from "@schema/scalars/string/id-domain";
import { idDomainOf } from "@schema/validation/id-domains";
import type { ResolvedRelationIndex } from "@schema/validation/relation-resolution";
import type {
  IdDomain,
  IdRepresentation,
} from "@validation/primitives/id-codec";
import {
  decodePhysicalId,
  encodePhysicalId,
} from "@validation/primitives/id-codec";
import { QueryEngineError } from "../types";

/** One identifier column: what it admits, and what it physically holds. */
export interface IdColumn {
  readonly domain: IdDomain;
  readonly representation: IdRepresentation;
}

/**
 * The domain and representation of a DECLARED identifier scalar.
 *
 * Serves every column whose scalar IS the referenced key's own — a junction
 * table's side columns and a polymorphic row carrier's id column both carry
 * that exact Scalar — so those columns inherit the key's storage without a
 * second derivation and without a lookup key of their own.
 */
export function idColumnOfScalar(
  adapter: DatabaseAdapter,
  scalar: Scalar | undefined
): IdColumn | undefined {
  const domain = idDomainOfState(scalar?.["~"].state);
  return domain === undefined ? undefined : column(adapter, domain, scalar);
}

/**
 * The domain and representation of one MODEL FIELD, foreign keys included.
 *
 * The index is what a foreign key's domain is derived from; a field that
 * declares its own never reads it, so a scope without one still answers for
 * every declared key.
 */
export function idColumnOf(
  adapter: DatabaseAdapter,
  model: Model<any>,
  field: string,
  relations: ResolvedRelationIndex | undefined
): IdColumn | undefined {
  const domain = idDomainOf(model, field, relations);
  return domain === undefined
    ? undefined
    : column(adapter, domain, model["~"].state.scalars[field]);
}

function column(
  adapter: DatabaseAdapter,
  domain: IdDomain,
  scalar: Scalar | undefined
): IdColumn {
  const representation =
    adapter.result.idRepresentation?.(domain, scalar?.["~"].nativeType) ??
    "text";
  return { domain, representation };
}

/**
 * The physical value to bind for one identifier, or a named refusal.
 *
 * The value has already crossed the field's validation schema, which admitted
 * and canonicalized it; encoding again here is the same closing move
 * `decimalLiteral` makes, and it covers the paths that reach a binding without
 * one — a `set` inside an atomic update object, a connect-derived foreign key,
 * a relation-correlated key lowered by `referenceSql`. A value the domain does
 * not contain has no bytes, and binding it would write a row no read could
 * return.
 */
export function encodeIdValue(
  fieldName: string,
  value: unknown,
  { domain, representation }: IdColumn
): string | Uint8Array {
  if (typeof value !== "string") {
    throw new QueryEngineError(
      `Identifier field '${fieldName}' received ${typeof value}, which is not one of its values.`
    );
  }
  const physical = encodePhysicalId(value, domain, representation);
  if (physical === undefined) {
    throw new QueryEngineError(
      `Identifier field '${fieldName}' received a value outside its declared ${domain.format} domain.`
    );
  }
  return physical;
}

/** The public string one physical identifier value stands for, or `undefined`. */
export function decodeIdValue(
  physical: unknown,
  { domain, representation }: IdColumn
): string | undefined {
  return decodePhysicalId(physical, domain, representation);
}
