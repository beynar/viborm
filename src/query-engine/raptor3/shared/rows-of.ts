import type { AnyModel } from "@schema/model";
import { Sql } from "../../../sql/sql";
import type { RowJudgement } from "./row-scope";

/**
 * The rows of `model` the operation rendering it may see, under `alias`: a
 * condition an extension that writes its own SQL (ordering's subqueries)
 * puts beside a read of `model AS alias`, so that read takes the call's row
 * domain as every read of the engine does. The operation's `Queries`
 * settles it when it lowers the caller's fragment holding it (the call's
 * root domain at that alias, or `1 = 1`); rendered anywhere else, its text
 * is not SQL, so it cannot read past the domain unnoticed. With `judgement`,
 * the rows the call may write so (an update of those fields).
 */
export class RowsOf extends Sql {
  readonly model: AnyModel;
  readonly alias: string;
  readonly judgement: RowJudgement | undefined;
  constructor(model: AnyModel, alias: string, judgement?: RowJudgement) {
    super(["(viborm: rows of a model rendered outside a query)"], []);
    this.model = model;
    this.alias = alias;
    this.judgement = judgement;
  }
  settle(condition: Sql): void {
    RowsOf.fill(this, condition);
  }
}
