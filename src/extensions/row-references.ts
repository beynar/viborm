/**
 * What a row domain's predicate alone may write, prepared: `$exists`, a
 * check of another model's rows, and `{ $row, up }`, a column of an enclosing
 * row. Admission makes these nodes and hands each what prepares it; this
 * module is loaded with the extensions that declare row domains.
 */
import { assembleAdapterSelect } from "@adapters/adapter-internals";
import { UnsupportedOperationError } from "@errors";
import {
  exactDecimalDomain,
  sameDecimalDomain,
} from "@query-engine/raptor3/shared/decimal";
import { incomparableIdentifiers } from "@query-engine/raptor3/shared/identifier";
import {
  freeze,
  memberRead,
  newSelectorFacts,
  type PreparedOperand,
  type PreparedPredicate,
  type PreparedScalar,
  type Queries,
  readsRelation,
  type SelectorFacts,
  sharedKey,
  states,
} from "@query-engine/raptor3/shared/query";
import type {
  Existence,
  OuterColumn,
} from "@query-engine/raptor3/shared/row-scope";
import type { SqlQueries } from "@query-engine/raptor3/shared/sql-queries";
import { type Sql, sql } from "@sql";
import { SqlSlot } from "../sql/slot";

/**
 * `$exists`: the target's rows, read by the statement wherever it sits, so
 * a write to them orders before it (a read of the target with no path).
 */
export function prepareExistence(
  q: Queries,
  existence: Existence,
  facts: SelectorFacts | undefined
): PreparedPredicate {
  const model = q.schema.schema[existence.model]!;
  const nestedFacts = facts && newSelectorFacts(false);
  // One body below the row that holds it, joined to nothing: a
  // `{ $row, up }` inside it may read that row (or one above), and then it
  // is correlated; else it is the same wherever the statement holds it.
  const scopes = q.scopes;
  q.scopes = [...scopes, { model, facts: nestedFacts }];
  let predicate: PreparedPredicate;
  try {
    predicate = q.prepareWhere(model, existence.where, nestedFacts, []);
  } finally {
    q.scopes = scopes;
  }
  if (facts && nestedFacts) {
    facts.exact = false;
    const domain = q.domain?.selector(model, "related");
    if (domain)
      for (const field of domain.facts.fields) nestedFacts.fields.add(field);
    facts.reads.push({
      model,
      path: [],
      fields: nestedFacts.fields,
      equals: nestedFacts.equals,
      exact: false,
    });
    facts.reads.push(...nestedFacts.reads);
  }
  return freeze({
    kind: "exists",
    model,
    lower: lowerExistence,
    ...(states(predicate) && { predicate }),
  });
}
/**
 * `EXISTS (SELECT 1 FROM target WHERE related AND stated)`, correlated to
 * nothing: inside a statement sharing its bodies, every occurrence with the
 * same text and values settles to one `WITH` member holding at most one row,
 * and each reads it as `EXISTS (SELECT 1 FROM <member>)`.
 */
function lowerExistence(
  this: Extract<PreparedPredicate, { kind: "exists" }>,
  queries: Queries,
  alias: string
): Sql {
  const q = queries as SqlQueries;
  const a = q.adapter;
  const { model } = this;
  const child = q.rowAlias(model);
  const frame = { alias: child, escaped: false };
  q.frames.push(frame);
  let stated: Sql[];
  try {
    stated = this.predicate ? [q.lowerPredicate(this.predicate, child)] : [];
  } finally {
    q.frames.pop();
  }
  const domain = q.domainOf(model, "related");
  const lowered = domain && q.lowerSelector(domain, child);
  const related =
    lowered && this.predicate && readsRelation(this.predicate)
      ? a.subqueries.isolated(lowered)
      : lowered;
  const conditions = related ? [related, ...stated] : stated;
  const where =
    conditions.length === 0
      ? a.literals.true()
      : a.operators.and(...conditions);
  const inline = a.subqueries.existsCheck(q.attached(model, child), where);
  const shared = q.shared;
  // Correlated to a row above it: written where it is.
  if (shared === undefined || frame.escaped) return a.filters.some(inline);
  const query = assembleAdapterSelect(a, {
    columns: sql`1`,
    from: q.attached(model, child),
    where,
    limit: q.value(1),
  });
  const key = sharedKey(query);
  let body = shared.byKey.get(key);
  if (body === undefined) {
    body = {
      name: `__shared_${shared.order.length}`,
      query,
      correlated: false,
      slots: [],
    };
    shared.byKey.set(key, body);
    shared.order.push(body);
  }
  const use = a.filters.some(
    a.subqueries.existsCheck(memberRead(a, body.name), a.literals.true())
  );
  const slot = new SqlSlot(use);
  body.slots.push({
    slot,
    inline: a.filters.some(inline),
    use,
    test: { alias, columns: [], holds: true },
  });
  return slot;
}
/**
 * `{ $row, up }`: the column of the row `up` relation bodies above, which
 * that row's scope reads, compared like a field reference. Refused when it
 * leaves the predicate (or an `$exists` body), crosses a recursive or
 * polymorphic relation, or names what a comparison cannot read.
 */
export function prepareOuterColumn(
  q: Queries,
  owner: PreparedScalar,
  value: OuterColumn
): Extract<PreparedOperand, { kind: "field" }> {
  const spelled = `{ $row: ${JSON.stringify(value.$row)}, up: ${value.up} }`;
  const scopes = q.scopes;
  const at = scopes.length - 1 - value.up;
  if (at < 0)
    throw new UnsupportedOperationError(
      `${spelled} reaches past the predicate it is written in: it is ${Math.max(scopes.length - 1, 0)} relation bodies deep.`
    );
  for (let index = at + 1; index < scopes.length; index++)
    if (scopes[index]!.sealed !== undefined)
      throw new UnsupportedOperationError(
        `${spelled} crosses a ${scopes[index]!.sealed} relation: an enclosing row is read only through plain relations.`
      );
  const { model, facts } = scopes[at]!;
  const name = model["~"].names.ts ?? "unknown";
  const referenced = model["~"].state.scalars[value.$row];
  const own = owner.physical.scalar["~"].state;
  if (!referenced)
    throw new UnsupportedOperationError(
      `${spelled} does not name a scalar field of '${name}'.`
    );
  const other = referenced["~"].state;
  const kinds = new Set([own.type, other.type]);
  if (
    own.array === true ||
    other.array === true ||
    own.type === "json" ||
    !(
      own.type === other.type ||
      (kinds.size === 2 && kinds.has("string") && kinds.has("enum"))
    )
  )
    throw new UnsupportedOperationError(
      `${spelled} names '${name}.${value.$row}' (${other.array === true ? `${other.type}[]` : other.type}), which cannot be compared with '${owner.field}' (${own.array === true ? `${own.type}[]` : own.type}).`
    );
  const ownDomain = exactDecimalDomain(own);
  const otherDomain = exactDecimalDomain(other);
  if (ownDomain && otherDomain && !sameDecimalDomain(ownDomain, otherDomain))
    throw new UnsupportedOperationError(
      `${spelled} names a decimal(${otherDomain.precision},${otherDomain.scale}) and '${owner.field}' is decimal(${ownDomain.precision},${ownDomain.scale}): two decimals compare exactly only when they declare the same precision and scale.`
    );
  const storage = incomparableIdentifiers(
    q.scalarShape(owner.model, owner.field).id,
    q.scalarShape(model, value.$row).id,
    owner.field,
    value.$row
  );
  if (storage !== undefined)
    throw new UnsupportedOperationError(`${spelled}: ${storage}`);
  // The row that holds the column reads it: a write to it reorders.
  facts?.fields.add(value.$row);
  return {
    kind: "field",
    scalar: q.scalar(model, value.$row),
    ...(value.up > 0 && { up: value.up }),
  };
}
