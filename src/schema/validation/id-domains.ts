/**
 * Where a FOREIGN KEY gets its identifier domain.
 *
 * A key declares its format; the columns that reference it do not repeat the
 * declaration. `post.authorId` referencing `user.id` — a `.uuid("usr")` — holds
 * exactly the values `user.id` holds, so it admits them, normalizes them and
 * stores them the same way, and it does so without a generator of its own and
 * without a single character of its own declaration. That is the whole rule:
 * DERIVED, never re-declared.
 *
 * It is a fact of the SCHEMA, not of a scalar, which is why it lives at L5
 * beside the resolution that already knows which field references which. The
 * FK scalar's state is never touched: no default is installed on it, and two
 * models sharing one `s.string()` instance stay independent, because the answer
 * is keyed by (model, field) and not by the scalar.
 *
 * Derivation is a FIXPOINT because a referenced key may itself be a foreign
 * key — a one-to-one child whose primary key is its parent reference is the
 * ordinary case, and a chain of them is not unusual. A cycle with no
 * declaration anywhere on it simply has no domain; it is not an error, it is a
 * schema of plain strings.
 *
 * Two things make it fail, and both are the same failure: DISAGREEMENT. A field
 * reached through several references (a shared foreign key, a compound member,
 * a polymorphic variant row) must find one domain at the end of every one of
 * them, and a field that declares a domain must declare the one its target
 * already has. There is no first-target fallback and no "closest" rule: two
 * answers to "what does this column hold" is not something a default can fix.
 */

import {
  describeIdDomain,
  type IdDomain,
  sameIdDomain,
} from "@validation/primitives/id-codec";
import type { Model } from "../model";
import type { NativeType } from "../scalars/native-types";
import {
  describeIdNativeTypes,
  idDomainOfState,
  idStorageOf,
} from "../scalars/string/id-domain";
import type { ResolvedRelationIndex } from "./relation-resolution";
import { resolvedEdges } from "./relation-resolution";
import type { SchemaValidationIssue, ValidationContext } from "./types";

/** Per model, the domain of each field that has one — declared or derived. */
export type IdDomainIndex = ReadonlyMap<
  Model<any>,
  ReadonlyMap<string, IdDomain>
>;

/** The derived domains, plus everything disagreement had to say. */
export interface IdDomainDerivation {
  readonly domains: IdDomainIndex;
  readonly issues: readonly SchemaValidationIssue[];
}

/** One end of a reference: the key a foreign-key member points at. */
interface ReferenceTarget {
  readonly model: Model<any>;
  readonly field: string;
}

type ReferenceGraph = Map<Model<any>, Map<string, ReferenceTarget[]>>;

const MEMO = new WeakMap<ResolvedRelationIndex, IdDomainIndex>();

/** Every `(owner.field) → (target.field)` edge the resolved index states. */
function buildReferenceGraph(index: ResolvedRelationIndex): ReferenceGraph {
  const graph: ReferenceGraph = new Map();
  for (const edge of resolvedEdges(index)) {
    if (edge.kind !== "foreignKey") continue;
    const owner = edge.owner;
    const other =
      edge.endpoints[0] === owner ? edge.endpoints[1] : edge.endpoints[0];
    let byField = graph.get(owner.source);
    if (byField === undefined) {
      byField = new Map();
      graph.set(owner.source, byField);
    }
    for (const member of edge.reference.members) {
      let targets = byField.get(member.foreignField);
      if (targets === undefined) {
        targets = [];
        byField.set(member.foreignField, targets);
      }
      targets.push({
        model: other.source,
        field: member.referencedField,
      });
    }
  }
  return graph;
}

/** The domain a field DECLARES, read through the one declaration owner. */
function declaredDomainOf(
  model: Model<any>,
  field: string
): IdDomain | undefined {
  return idDomainOfState(model["~"].state.scalars[field]?.["~"].state);
}

function nameOf(ctx: ValidationContext | undefined, model: Model<any>): string {
  return ctx?.modelToName.get(model) ?? model["~"].names.ts ?? "model";
}

/**
 * Derive every foreign key's domain, and say where two answers met.
 *
 * The walk memoizes per (model, field) and marks a field IN PROGRESS while its
 * targets resolve, so a self-relation and a reference cycle terminate on their
 * own rather than through a depth budget.
 */
export function deriveIdDomains(
  index: ResolvedRelationIndex,
  ctx?: ValidationContext
): IdDomainDerivation {
  const graph = buildReferenceGraph(index);
  const domains = new Map<Model<any>, Map<string, IdDomain>>();
  const issues: SchemaValidationIssue[] = [];
  const settled = new Map<Model<any>, Map<string, IdDomain | undefined>>();
  // Keyed by model IDENTITY, not by name: a name is for the message, and two
  // models that happen to render the same one must not share a cycle mark.
  const active = new Map<Model<any>, Set<string>>();

  const publish = (
    model: Model<any>,
    field: string,
    domain: IdDomain | undefined
  ): IdDomain | undefined => {
    let bySettled = settled.get(model);
    if (bySettled === undefined) {
      bySettled = new Map();
      settled.set(model, bySettled);
    }
    bySettled.set(field, domain);
    if (domain !== undefined) {
      let byField = domains.get(model);
      if (byField === undefined) {
        byField = new Map();
        domains.set(model, byField);
      }
      byField.set(field, domain);
    }
    return domain;
  };

  const resolve = (model: Model<any>, field: string): IdDomain | undefined => {
    const cached = settled.get(model);
    if (cached?.has(field) === true) return cached.get(field);

    const declared = declaredDomainOf(model, field);
    const targets = graph.get(model)?.get(field);
    if (targets === undefined || targets.length === 0) {
      return publish(model, field, declared);
    }

    let inProgress = active.get(model);
    if (inProgress === undefined) {
      inProgress = new Set();
      active.set(model, inProgress);
    }
    if (inProgress.has(field)) {
      // A reference that is still resolving cannot answer about itself. The
      // declaration it may carry is the only answer there is on this arm.
      return declared;
    }
    inProgress.add(field);
    const marker = `${nameOf(ctx, model)}.${field}`;

    let agreed = declared;
    let agreedFrom = agreed === undefined ? undefined : marker;
    let conflicted = false;
    for (const target of targets) {
      const targetDomain = resolve(target.model, target.field);
      const targetMarker = `${nameOf(ctx, target.model)}.${target.field}`;
      if (agreedFrom === undefined) {
        agreed = targetDomain;
        agreedFrom = targetMarker;
        continue;
      }
      if (sameIdDomain(agreed, targetDomain)) continue;
      conflicted = true;
      issues.push({
        code: "FK012",
        message:
          `'${marker}' would hold ${describeIdDomain2(agreed)} through '${agreedFrom}' ` +
          `and ${describeIdDomain2(targetDomain)} through '${targetMarker}'. ` +
          "A column stores one identifier domain.",
        severity: "error",
        model: nameOf(ctx, model),
        field,
        candidates: [agreedFrom, targetMarker],
        repair:
          declared === undefined
            ? `Give every key '${marker}' references the same identifier format, prefix and length`
            : `Declare '${marker}' with the same identifier format, prefix and length as '${targetMarker}', or declare nothing and let it derive`,
      });
    }
    inProgress.delete(field);
    return publish(model, field, conflicted ? undefined : agreed);
  };

  for (const [model, byField] of graph) {
    for (const field of byField.keys()) resolve(model, field);
  }

  // The polymorphic row carrier's ONE private id column stores every variant's
  // key, so every variant's key must hold one domain — the same DISAGREEMENT
  // rule the shared-foreign-key case above states, over a column that is not a
  // field and therefore has no (model, field) of its own to key an issue by.
  //
  // It is checked HERE and not beside the rest of P002 because the answer may
  // be DERIVED: a variant whose primary key is its parent foreign key declares
  // nothing and still holds uuids, and the storage rule runs while the index it
  // would have to ask is still being built. Comparing declarations there
  // refused two variants that hold the same domain and admitted two that hold
  // different ones — the second of which is what types the carrier column from
  // one variant and writes another variant's key through it.
  for (const edge of resolvedEdges(index)) {
    if (edge.kind !== "variantRowCarrier") continue;
    const carrier = `${nameOf(ctx, edge.carrier.source)}.${edge.carrier.field}`;
    // A published carrier has at least one member — the edge type says so.
    const [head, ...rest] = edge.members;
    const agreed = resolve(head.targetModel, head.referencedField);
    let agreedFrom = `${nameOf(ctx, head.targetModel)}.${head.referencedField}`;
    for (const member of rest) {
      const domain = resolve(member.targetModel, member.referencedField);
      if (sameIdDomain(agreed, domain)) continue;
      const marker = `${nameOf(ctx, member.targetModel)}.${member.referencedField}`;
      issues.push({
        code: "P002",
        message:
          `The one id column of '${carrier}' would hold ${describeIdDomain2(agreed)} ` +
          `through '${agreedFrom}' and ${describeIdDomain2(domain)} through '${marker}'. ` +
          "A column stores one identifier domain.",
        severity: "error",
        model: nameOf(ctx, edge.carrier.source),
        relation: edge.carrier.field,
        candidates: [agreedFrom, marker],
        repair: `Give every variant target of '${carrier}' the same identifier format, prefix and length`,
      });
      agreedFrom = marker;
    }
  }

  // Every model the index registers, so a declared domain on a relationless
  // model is checked too. The resolved index holds one slot map per registered
  // model, including an empty one.
  for (const model of index.keys()) {
    const scalars = model["~"].state.scalars;
    for (const field of Object.keys(scalars)) {
      const domain = resolve(model, field);
      if (domain === undefined) continue;
      refuseUnusableNativeType(
        model,
        field,
        scalars[field]?.["~"].nativeType,
        domain,
        ctx,
        issues
      );
    }
  }

  return { domains, issues };
}

/**
 * Refuse a native type override the declared domain cannot live in.
 *
 * The override says what the COLUMN is; the domain says what the column holds.
 * `varchar(26)` holds a ULID as text, `BINARY(16)` holds its bytes, and
 * `INTEGER` holds neither — and nothing downstream can repair that choice: the
 * migration would emit the column the override named and the engine would bind
 * the value the domain named, which is a table that refuses every row.
 *
 * Dialect-blind, because the override names its own dialect. It is checked HERE
 * rather than in the advisory rule list because `skipValidation` may drop
 * advice and must not be able to drop this.
 */
function refuseUnusableNativeType(
  model: Model<any>,
  field: string,
  nativeType: NativeType | undefined,
  domain: IdDomain,
  ctx: ValidationContext | undefined,
  issues: SchemaValidationIssue[]
): void {
  if (nativeType === undefined) return;
  if (idStorageOf(domain, nativeType, nativeType.db) !== undefined) return;
  const marker = `${nameOf(ctx, model)}.${field}`;
  issues.push({
    code: "F013",
    message: `'${marker}' holds ${describeIdDomain(domain)}, which cannot live in the ${nativeType.db} column '${nativeType.type}'.`,
    severity: "error",
    model: nameOf(ctx, model),
    field,
    repair: `Declare '${marker}' with one of: ${describeIdNativeTypes(domain.format, nativeType.db)} — or drop the native type and take the automatic column.`,
  });
}

/** `describeIdDomain`, extended to the absence of one. */
function describeIdDomain2(domain: IdDomain | undefined): string {
  return domain === undefined
    ? "no identifier domain"
    : describeIdDomain(domain);
}

/**
 * The derived domains of one resolved index, computed once per index identity.
 *
 * Every consumer that already threads the index reads this — the write path's
 * parameter encoding, the read projection, the result decode, the operation
 * schemas and the migration serializer — so there is one derivation per schema
 * and not one per query. The issues are dropped here: a schema whose domains
 * disagree never becomes an index (the gate refuses it), so by the time anyone
 * asks this question there is nothing left to report.
 */
export function idDomainsOf(index: ResolvedRelationIndex): IdDomainIndex {
  const existing = MEMO.get(index);
  if (existing) return existing;
  const derived = deriveIdDomains(index).domains;
  MEMO.set(index, derived);
  return derived;
}

/**
 * The identifier domain of one model field: the ONE lookup every consumer uses.
 *
 * Declared first, derived second — and never both, because a declaration that
 * disagrees with what it references is refused before an index exists. Reads
 * the index only when the field declares nothing, so a schema with no relations
 * pays nothing.
 */
export function idDomainOf(
  model: Model<any>,
  field: string,
  index: ResolvedRelationIndex | undefined
): IdDomain | undefined {
  const declared = declaredDomainOf(model, field);
  if (declared !== undefined || index === undefined) return declared;
  return idDomainsOf(index).get(model)?.get(field);
}
