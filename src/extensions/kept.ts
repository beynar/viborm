/**
 * The rows a model keeps where a call deletes them: what such a row takes
 * instead of going, and what it meets where the database would have refused
 * its removal. The engine asks the call's tombstones; this module, loaded
 * with the extensions that declare a deletion, answers.
 */
import { assembleAdapterSelect } from "@adapters/adapter-internals";
import type {
  PreparedDomain,
  PreparedPredicate,
  PreparedSelector,
  Queries,
  Query,
} from "@query-engine/raptor3/shared/query";
import {
  COUNT_LEAF,
  newSelectorFacts,
} from "@query-engine/raptor3/shared/query";
import type {
  Tombstone,
  Tombstones,
} from "@query-engine/raptor3/shared/row-scope";
import type { EngineSchema, Input } from "@query-engine/raptor3/shared/schema";
import type { SqlQueries } from "@query-engine/raptor3/shared/sql-queries";
import {
  bindMembership,
  type Membership,
} from "@query-engine/raptor3/shared/storage";
import type { Writer } from "@query-engine/raptor3/write/statements";
import type { PreparedGuardFailure } from "@query-engine/types";
import type { AnyModel } from "@schema/model";

export class Kept extends Map<string, Tombstone> implements Tombstones {
  marks(writer: Writer, model: AnyModel): Input | undefined {
    const { scope, schema } = writer.operation;
    const mark = this.get(model["~"].names.ts!);
    if (!mark) return undefined;
    // A kept row is updated: it takes what every update of its model takes.
    return writer.values(
      model,
      "update",
      schema.update(
        model,
        mark.at === undefined
          ? mark.assign
          : { ...mark.assign, [mark.at]: scope!.instant() }
      ),
      {}
    );
  }
  referenced(
    schema: EngineSchema,
    edge: Membership | undefined,
    of?: Input
  ): true | { readonly slot: string; readonly identity: Input } {
    const slot =
      edge &&
      schema
        .restrictingSlots(edge.target)
        .find(
          (name) =>
            schema.index.get(edge.target)?.get(name)?.edge ===
              edge.scope.edge &&
            !(edge.target === edge.source && name === edge.name)
        );
    return slot ? { slot, identity: of! } : true;
  }
  restriction(
    schema: EngineSchema,
    model: AnyModel
  ): PreparedGuardFailure | undefined {
    const slots = schema.restrictingSlots(model);
    return slots.length > 0
      ? {
          kind: "foreignKey",
          message: `Cannot delete '${model["~"].names.ts!}' record: a related record still references it through one of its relations whose foreign key restricts deletes: ${slots
            .map((slot) => `'${slot}'`)
            .join(", ")}.`,
          raceable: false,
        }
      : undefined;
  }
  /**
   * Every row of `selector` locked, answered as ONE row: the inner read takes
   * the row locks (`FOR UPDATE`), and the count over it, which must consume
   * every row, is all that crosses the wire. Locking a million candidates
   * then costs one row back, not a million keys.
   */
  lock(queries: Queries, selector: PreparedSelector): Query {
    const q = queries as SqlQueries;
    const a = q.adapter;
    const inner = q.rootAlias();
    const locked = assembleAdapterSelect(a, {
      columns: a.literals.true(),
      from: q.table(selector.model, inner),
      where: q.lowerSelector(selector, inner),
      forUpdate: true,
    });
    return {
      sql: assembleAdapterSelect(a, {
        columns: a.identifiers.aliased(a.aggregates.count(), "_count"),
        from: a.subqueries.correlate(locked, q.alias()),
      }),
      shape: { kind: "object", fields: { _count: COUNT_LEAF } },
    };
  }
  /**
   * The rows a hard delete meets the database's restrict on. A member is
   * visible when it satisfies its model's inputs in `visible`; one member may
   * be excepted by identity: the parent a nested delete keeps its link to,
   * whose own membership a hard delete removes first.
   */
  selector(
    queries: Queries,
    model: AnyModel,
    visible: PreparedDomain | undefined,
    except?: { readonly slot: string; readonly identity: Input }
  ): PreparedSelector {
    const predicates = queries.schema
      .restrictingSlots(model)
      .map((slot): PreparedPredicate => {
        const edge = bindMembership(queries.schema, model, slot);
        const arms: PreparedPredicate[] = [];
        const domain = visible?.selector(edge.target, "related")?.predicate;
        if (domain) arms.push(domain);
        if (except?.slot === slot)
          arms.push(
            queries.combine("NOT", [
              // The member's own facts: a premise states them, nothing plans on them.
              queries.identityPredicate(
                edge.target,
                except.identity,
                newSelectorFacts(false)
              ),
            ])
          );
        // Visibility is the given domain's, never the lowering call's own.
        return Object.freeze({
          kind: "relation",
          edge,
          quantifier: "some",
          predicate:
            arms.length === 0 ? undefined : queries.combine("AND", arms),
          unscoped: true,
        });
      });
    return Object.freeze({
      model,
      facts: newSelectorFacts(false),
      predicate: queries.combine("OR", predicates),
    });
  }
}
