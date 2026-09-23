/**
 * The engine's identifier seam: every place Raptor 3 hands a value to the
 * identifier codec, in one identifier-named module — the sibling of
 * `decimal.ts`, and for the same reason.
 *
 * Two facts, asked together because no seam needs one without the other. The
 * DOMAIN — declared by a named format, or derived by L5 from the key a foreign
 * key references — says which strings a column holds and what their canonical
 * spelling is (`idDomainOf`). The REPRESENTATION says what the column
 * physically holds for one, and it is the ADAPTER's answer
 * (`result.idRepresentation`, derived from the one storage owner
 * `idStorageOf`): `bytea` on PostgreSQL and `BINARY(16)` on MySQL are the same
 * ULID, and the engine is not allowed to know which dialect it is building for.
 *
 * This module knows no format's bytes and spells no SQL of its own: the codec
 * (`validation/primitives/id-codec.ts`) owns the bytes, and every expression
 * below is an adapter member. A field with no domain answers `undefined` from
 * {@link identifierColumn}, and every path stays the one it was.
 */
import type { DatabaseAdapter } from "@adapters/database-adapter";
import type { AnyModel } from "@schema/model";
import { idDomainOf } from "@schema/validation/id-domains";
import type { ResolvedRelationIndex } from "@schema/validation/relation-resolution";
import type { Sql } from "@sql";
import {
  decodePhysicalId,
  describeIdDomain,
  encodePhysicalId,
  type IdDomain,
  type IdRepresentation,
  sameIdDomain,
} from "@validation/primitives/id-codec";
import { assertInvariant } from "./invariant";
import type { PhysicalField } from "./storage";

/** One identifier column: what it admits, and what it physically holds. */
export interface IdentifierColumn {
  readonly domain: IdDomain;
  readonly representation: IdRepresentation;
}

/**
 * The domain and representation of one stored column, or `undefined` when it
 * holds no identifier domain.
 *
 * A declared scalar is its own key. A PRIVATE column — a polymorphic row
 * carrier's id column — holds no field of its own: it holds some model key's
 * values, and that key's domain may be DERIVED (the one-to-one child whose
 * primary key is its parent foreign key), and derivation is keyed by (model,
 * field), never by a scalar instance two models may share. So the private
 * column NAMES the key it stands in for (`PhysicalField.reference`) and is
 * resolved through the same lookup, against that key; the type discriminator
 * names none. A junction side needs no such name: every binding of it already
 * goes through the referenced key (`Queries.junctionWhere`).
 */
export function identifierColumn(
  adapter: DatabaseAdapter,
  index: ResolvedRelationIndex,
  model: AnyModel,
  field: string,
  physical: PhysicalField
): IdentifierColumn | undefined {
  const key =
    model["~"].state.scalars[field] === undefined
      ? physical.reference
      : { model, field };
  if (key === undefined) return undefined;
  const domain = idDomainOf(key.model, key.field, index);
  if (domain === undefined) return undefined;
  const representation =
    adapter.result.idRepresentation?.(
      domain,
      key.model["~"].state.scalars[key.field]?.["~"].nativeType
    ) ?? "text";
  return { domain, representation };
}

/**
 * Whether the column holds something other than the public string itself —
 * payload bytes, or a PostgreSQL `uuid`. A text-stored domain is NOT compact:
 * it binds, projects, collates and aggregates exactly as any string column.
 */
export function isCompact(
  column: IdentifierColumn | undefined
): column is IdentifierColumn {
  return column !== undefined && column.representation !== "text";
}

/**
 * The physical value ONE compact identifier binds as.
 *
 * INVARIANT, not a refusal (N4): every value that reaches a binding of an
 * identifier column crossed the field's validation schema, which admitted and
 * canonicalized it into the domain — a payload, a `{ set }`, a filter operand,
 * a cursor, a unique selector, a connect key — or is a captured row key, which
 * the decoder returned as the canonical public string. A `Sql` operand never
 * reaches here: it is the caller's physical fragment.
 */
export function encodeIdentifier(
  column: IdentifierColumn,
  value: unknown,
  field: string
): string | Uint8Array {
  const physical =
    typeof value === "string"
      ? encodePhysicalId(value, column.domain, column.representation)
      : undefined;
  assertInvariant(
    physical !== undefined,
    `Identifier field '${field}' reached its binding with a value outside ${describeIdDomain(column.domain)}: admission canonicalizes every identifier operand into its domain.`
  );
  return physical;
}

/** The public string one physical identifier value stands for, or `undefined`. */
export function decodeIdentifier(
  column: IdentifierColumn,
  value: unknown
): string | undefined {
  return decodePhysicalId(value, column.domain, column.representation);
}

/**
 * One compact identifier expression, spelled for TRANSPORT: lowercase hex for
 * a byte column, the column itself otherwise.
 *
 * A byte column travels as hex in a flat select exactly as inside a JSON
 * carrier. JSON cannot hold binary at all, so the carrier has no choice;
 * making the flat read take the same spelling keeps ONE physical promise per
 * column — the decoder reads the same text whether the row came back from a
 * top-level select or three levels inside an `include`, and the drivers' many
 * binary shapes stop being a variable.
 *
 * `nullable` is a fact about the EXPRESSION, not only about the column: a
 * `MIN()` over no rows is null however the column is declared. The guard is a
 * measured requirement, not symmetry: SQLite's `hex(NULL)` is the EMPTY
 * STRING, so without it a null identifier reads as a zero-byte one.
 */
export function transportedIdentifier(
  adapter: DatabaseAdapter,
  column: IdentifierColumn | undefined,
  expression: Sql,
  nullable: boolean
): Sql {
  if (column?.representation !== "bytes") return expression;
  const hex = adapter.expressions.blobToHex(expression);
  return nullable
    ? adapter.expressions.caseWhen(
        [
          {
            when: adapter.operators.isNull(expression),
            then: adapter.literals.null(),
          },
        ],
        hex
      )
    : hex;
}

/**
 * What `MIN`/`MAX` run OVER for one compact identifier: its transported TEXT.
 *
 * Two facts force it, either alone decisive: PostgreSQL has no `min(uuid)`
 * and no `max(bytea)`, and JSON — the aggregate carrier — cannot hold binary.
 * The answer is the same: every compact format's canonical text is
 * fixed-width and lowercase, so its text order IS its byte order. The null
 * guard travels INSIDE the aggregate, where SQLite's `hex(NULL)` would
 * otherwise be the empty string that wins every `MIN`.
 */
export function aggregatedIdentifier(
  adapter: DatabaseAdapter,
  column: IdentifierColumn | undefined,
  expression: Sql
): Sql {
  if (column?.representation === "uuid")
    return adapter.expressions.cast(expression, "text");
  return transportedIdentifier(adapter, column, expression, true);
}

/** One phrase naming a column's identifier storage, for the refusal below. */
function describeStorage(column: IdentifierColumn | undefined): string {
  if (column === undefined) return "plain string text";
  const stored =
    column.representation === "text"
      ? "as its own text"
      : column.representation === "uuid"
        ? "as a uuid payload"
        : "as payload bytes";
  return `${describeIdDomain(column.domain)}, stored ${stored}`;
}

/**
 * The comparability of two columns a FIELD REFERENCE puts side by side, or
 * the refusal's sentence when one public value would not have one physical
 * spelling in both.
 *
 * Admission cannot ask it: the interned filter schemas are model-blind and
 * see two strings. Two text columns compare whatever their domains — each
 * holds the whole public string — and two compact columns compare only inside
 * one domain in one storage.
 */
export function incomparableIdentifiers(
  own: IdentifierColumn | undefined,
  other: IdentifierColumn | undefined,
  ownField: string,
  otherField: string
): string | undefined {
  const representation = own?.representation ?? "text";
  if (representation === (other?.representation ?? "text")) {
    if (representation === "text") return undefined;
    if (sameIdDomain(own?.domain, other?.domain)) return undefined;
  }
  return (
    `'${ownField}' is ${describeStorage(own)} and '${otherField}' is ` +
    `${describeStorage(other)}. Two columns compare only when one value has the ` +
    "same physical spelling in both."
  );
}
