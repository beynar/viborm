/**
 * What judges the rows a write produces, for one prepared domain: the verbs'
 * `place`, `moves` and `acyclic` rules, the refusal a judged write fails
 * with, and what an upsert says of a row it located. Made by what reads the
 * verbs (`verbs.ts`), only for a domain whose models declare verbs.
 */
import { JUDGED } from "@adapters/judged";
import { ForbiddenError } from "@errors";
import {
  NO_RELATIONS,
  type PreparedSelector,
} from "@query-engine/raptor3/shared/query";
import type {
  LazyRelations,
  RowJudgement,
} from "@query-engine/raptor3/shared/row-scope";
import { type Input, memo } from "@query-engine/raptor3/shared/schema";
import type { SqlOperationContext } from "@query-engine/raptor3/shared/sql-operation-context";
import type { SqlQueries } from "@query-engine/raptor3/shared/sql-queries";
import { nameOf, unsupported } from "@query-engine/raptor3/shared/terms";
import type { Question } from "@query-engine/raptor3/write/statements";
import type { PreparedGuardFailure } from "@query-engine/types";
import type { AnyModel } from "@schema/model";
import type { Sql } from "@sql";
import { producedSource, producedWhere } from "./produced";
import { readsAny } from "./reads";
import { type PreparedDomain, verbInputs } from "./row-domain";

export class Judge {
  readonly #domain: PreparedDomain;
  readonly #produced = new Map<string, PreparedSelector | null>();
  constructor(domain: PreparedDomain) {
    this.#domain = domain;
  }
  /**
   * The values the judgement of a created row of `model` binds, beside the
   * rows a statement inserts: what a chunk of them leaves of the driver's
   * bind budget.
   */
  binds(q: SqlQueries, model: AnyModel): number {
    const placed = this.produced(model);
    return (placed && q.lowerSelector(placed)?.values.length) ?? 0;
  }
  /**
   * The SELECT an INSERT of `rows` of `model` reads its values from, where
   * the rows it creates are judged, and what the statement says when one is
   * refused, in the name of `relation` where they are created through one.
   */
  inserted(
    q: SqlQueries,
    operation: SqlOperationContext,
    model: AnyModel,
    fields: readonly string[],
    rows: readonly Input[],
    relation?: string
  ): { readonly probe: Sql; readonly stops: PreparedGuardFailure } | undefined {
    const placed = this.produced(model);
    if (placed === undefined) return undefined;
    // A row of defaults only has no value to judge before it is written.
    if (fields.length === 0)
      unsupported(
        `Cannot create a '${nameOf(model)}' row that writes no field: its placement is judged on the values it writes.`
      );
    const probe = producedSource(
      q,
      JUDGED[operation.driver.dialect]!,
      model,
      fields,
      rows,
      placed
    );
    return (
      probe && {
        probe,
        stops: this.refusal(
          operation.operation,
          model,
          undefined,
          "create",
          relation
        ),
      }
    );
  }
  /**
   * The WHERE of an update of the rows `question` names (`candidates`, at
   * the alias it is handed) assigning `values`, where the rows it leaves are
   * judged at `judgement`, and what the statement says when one is refused.
   */
  updated(
    q: SqlQueries,
    operation: SqlOperationContext,
    question: Question,
    candidates: (alias: string) => Sql | undefined,
    values: Input,
    judgement: RowJudgement,
    limit?: number
  ): { readonly where: Sql; readonly stops: PreparedGuardFailure } | undefined {
    const { model } = question;
    const where = producedWhere(
      q,
      JUDGED[operation.driver.dialect]!,
      model,
      candidates,
      values,
      this.produced(model, judgement, Object.keys(values)),
      this.cycles(model, judgement),
      limit
    );
    return (
      where && {
        where,
        stops: this.refusal(
          operation.operation,
          model,
          judgement,
          question.verb,
          (question.member?.edge ?? question.through)?.name
        ),
      }
    );
  }
  /**
   * What a write of `operation` says when the row it would leave is refused:
   * the `verb` it is written with through `relation`, where it is nested;
   * else why, where it writes a field some layer `moves` judges again.
   */
  refusal(
    operation: string,
    model: AnyModel,
    judgement?: RowJudgement,
    verb?: string,
    relation?: string
  ): PreparedGuardFailure {
    if (verb && relation)
      return {
        kind: "nestedWrite",
        relation,
        message: `Cannot ${verb} relation '${relation}': the record it writes is not permitted.`,
        raceable: false,
      };
    const forbidden: PreparedGuardFailure = {
      kind: "forbidden",
      message: `${operation} produced a row that is not permitted.`,
      raceable: false,
    };
    const reason = judgement && this.#reason(model, judgement);
    return reason === undefined ? forbidden : { ...forbidden, reason };
  }
  /**
   * What an upsert says when it located no row and its create is refused
   * for the key it named: where no row of the model may be updated at all,
   * the row it located exists, and the update is what is not permitted.
   */
  located(model: AnyModel): ((cause: Error) => Error) | undefined {
    const name = model["~"].names.ts!;
    const never = this.#domain.rows.verbs?.get(name)?.some((layer) => {
      const members = layer?.update.OR;
      return (
        Array.isArray(members) &&
        members.length === 0 &&
        Object.keys(layer!.update).length === 1
      );
    });
    return never
      ? (cause) =>
          new ForbiddenError(name, "update", {
            reason: "the row this upsert locates exists",
            cause,
          })
      : undefined;
  }
  /**
   * Why the row an update judged at `judgement` would leave is refused,
   * where it writes a field some layer `moves` judges again; `undefined`
   * where it says nothing more than that the row is not permitted.
   */
  #reason(model: AnyModel, judgement: RowJudgement): string | undefined {
    const layers = this.#domain.rows.verbs?.get(model["~"].names.ts!);
    if (layers === undefined) return undefined;
    const moved = judgement.writes.filter((field) =>
      layers.some((layer) => layer?.moves.has(field) === true)
    );
    if (moved.length === 0) return undefined;
    const relations = model["~"].state.relations;
    const through = judgement.writes.filter(
      (field) =>
        Object.hasOwn(relations, field) &&
        relations[field]!["~"].state.foreignKey?.fields.some((key) =>
          moved.includes(key)
        ) === true
    );
    return `the row it would leave, judged again because it writes ${moved.join(", ")}${through.length > 0 ? ` (through ${through.join(", ")})` : ""}, is refused`;
  }
  /**
   * What the row a write of `model` produces is judged at, as a value,
   * against the rows as they stand before the write (R4): a created row
   * (no `judgement`) at each layer's `place`; an updated one at the
   * predicates that judged its old row, `read` and its verb's (WITH CHECK),
   * and its written fields' `moves`. A write that states its candidates'
   * judgement in its own statement names the fields it `assigned`: where it
   * assigns none of what judged its old row, that judgement is the old
   * row's and is not stated twice. `undefined` where no layer judges it: no
   * verbs, no `place` for a create, a delete, an update nothing judges.
   */
  produced(
    model: AnyModel,
    judgement?: RowJudgement,
    assigned?: readonly string[]
  ): PreparedSelector | undefined {
    if (judgement?.verb === "delete") return undefined;
    const domain = this.#domain;
    const name = model["~"].names.ts!;
    const verbs = domain.rows.verbs?.get(name);
    if (verbs === undefined) return undefined;
    const changed = assigned && new Set(assigned);
    const keys = domain.queries.schema.keys(model);
    const prepared = memo(
      this.#produced,
      judgement
        ? `update ${name} ${[...judgement.writes].sort()} ${assigned ? [...assigned].sort() : "*"}`
        : `create ${name}`,
      () => {
        const layers: (readonly [number, Input[]])[] = [];
        for (const [layer, own] of verbs.entries()) {
          if (own === undefined) continue;
          // What judged the old row judges the new one, unless the write
          // assigns nothing it reads: then the new row's answer is the old
          // row's, which the statement's own candidates already state.
          const checked = judgement
            ? [own.read, ...verbInputs(own, judgement)]
            : [];
          const unchanged =
            changed !== undefined &&
            checked.every((where) => {
              const { predicate } = domain.prepare(model, where);
              return (
                predicate === undefined || !readsAny(predicate, changed, keys)
              );
            });
          const wheres = judgement
            ? [
                ...(unchanged ? [] : checked),
                ...judgement.writes.flatMap((field) => {
                  const move = own.moves.get(field);
                  return move === undefined ? [] : [move];
                }),
              ]
            : own.place === undefined
              ? []
              : [own.place];
          layers.push([layer, [...new Set(wheres)]]);
        }
        return domain.conjunction(model, layers, true);
      }
    );
    return prepared ?? undefined;
  }
  /**
   * The self relations whose links an update judged at `judgement` must
   * keep acyclic (R4): each layer's `acyclic` relations of `model` whose key
   * fields it writes.
   */
  cycles(model: AnyModel, judgement: RowJudgement): readonly string[] {
    if (judgement.verb === "delete") return NO_RELATIONS;
    const domain = this.#domain;
    const verbs = domain.rows.verbs?.get(model["~"].names.ts!);
    if (verbs === undefined) return NO_RELATIONS;
    const relations = new Set<string>();
    const written = (relation: string) => {
      const edge = domain.queries.schema.membership(model, relation);
      return (
        judgement.writes.includes(relation) ||
        (edge.kind === "reference" &&
          edge.pairs.some((pair) => judgement.writes.includes(pair.source)))
      );
    };
    for (const own of verbs) {
      const acyclic = own?.acyclic;
      if (acyclic === undefined) continue;
      const named = Array.isArray(acyclic)
        ? acyclic
        : (acyclic as LazyRelations).candidates.some(written)
          ? (acyclic as LazyRelations).resolve()
          : NO_RELATIONS;
      for (const relation of named)
        if (written(relation)) relations.add(relation);
    }
    return relations.size === 0 ? NO_RELATIONS : [...relations];
  }
}
