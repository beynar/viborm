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
import { idDomainOf } from "@schema/validation/id-domains";
import type { ResolvedRelationIndex } from "@schema/validation/relation-resolution";
import { isSql, type Sql } from "@sql";
import type {
  IdDomain,
  IdRepresentation,
} from "@validation/primitives/id-codec";
import {
  decodePhysicalId,
  encodePhysicalId,
} from "@validation/primitives/id-codec";
import { QueryEngineError } from "../types";
import { isOperationValueReference } from "../write-engine/OperationFragment";

/** One identifier column: what it admits, and what it physically holds. */
export interface IdColumn {
  readonly domain: IdDomain;
  readonly representation: IdRepresentation;
}

/** The key one PRIVATE column stands in for: the pair {@link idColumnOf} takes. */
export interface IdColumnReference {
  readonly model: Model<any>;
  readonly field: string;
}

/**
 * The domain and representation of a PRIVATE column that stands in for a key.
 *
 * A junction table's side columns and a polymorphic row carrier's id column
 * hold no field of their own; each holds the values of some model's key. That
 * key's domain may be DERIVED — the one-to-one child whose primary key is its
 * parent foreign key is the ordinary case — and derivation is keyed by (model,
 * field), never by a scalar instance two models may share. So a private column
 * is resolved through the SAME lookup a public field is, against the key it
 * names; reading its scalar's own declaration would type the column as text
 * while the column it references is sixteen bytes.
 *
 * A column that stands in for no key (a polymorphic type discriminator) names
 * none and answers `undefined`.
 */
export function idColumnOfPrivate(
  adapter: DatabaseAdapter,
  reference: IdColumnReference | undefined,
  relations: ResolvedRelationIndex | undefined
): IdColumn | undefined {
  return reference === undefined
    ? undefined
    : idColumnOf(adapter, reference.model, reference.field, relations);
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

/**
 * A value whose spelling is knowable NOW — not a deferred symbol, not a
 * pre-built fragment, not the absent value of a nullable key.
 */
export function isConcreteIdValue(value: unknown): boolean {
  return (
    value !== null &&
    value !== undefined &&
    !isSql(value) &&
    !isOperationValueReference(value)
  );
}

/**
 * The SQL ONE identifier operand binds as — the only place that decision is
 * made, for a public field and a private column alike.
 *
 * A CONCRETE identifier takes the physical binding every other write of this
 * column takes: bytes for a compact column, canonical uuid text for a
 * PostgreSQL `uuid`. A DEFERRED one cannot be encoded (its value does not exist
 * yet), so it is cast into the column's physical type instead — the generic
 * `text` cast names a type the column does not have.
 *
 * Both seams that lower an identifier call this: the value builder, which
 * reaches it holding a `QueryScope`, and the relation-key lowering, which
 * reaches it holding the destination model and not its scope. That is why it
 * takes the ADAPTER, exactly as {@link decimalLiteral} does and for the same
 * reason — two spellings of one binding is how a relation key came to be
 * written two different ways in one statement pair.
 */
export function idLiteral(
  adapter: DatabaseAdapter,
  fieldName: string,
  value: unknown,
  idColumn: IdColumn
): Sql {
  return isConcreteIdValue(value)
    ? adapter.literals.id(
        encodeIdValue(fieldName, value, idColumn),
        idColumn.representation
      )
    : adapter.expressions.idCast(
        adapter.literals.value(value),
        idColumn.representation
      );
}

/** The public string one physical identifier value stands for, or `undefined`. */
export function decodeIdValue(
  physical: unknown,
  { domain, representation }: IdColumn
): string | undefined {
  return decodePhysicalId(physical, domain, representation);
}
