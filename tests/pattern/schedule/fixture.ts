/**
 * A literal Pattern builder for the scheduler and packer fixtures. Stream C's
 * constructor may not exist in this tree, so fixtures are written by hand
 * through this thin allocator: rows, variables and cells in payload order.
 */
import type { Model } from "@schema/model";
import { getTableName } from "@schema/model";
import type {
  Arm,
  Cell,
  Mode,
  Pattern,
  Predicate,
  Projection,
  Reference,
  Row,
  Variable,
} from "@src/query-engine/pattern/pattern";

export class PatternBuilder {
  private readonly rows: Row[] = [];
  private readonly cells: Cell[] = [];
  private readonly references: Reference[] = [];
  private readonly arms: Arm[] = [];
  private readonly variables: Variable[] = [];
  private projection: Projection | undefined;

  readonly operation: string;

  constructor(operation: string) {
    this.operation = operation;
  }

  literal(value: unknown, scalar?: Variable["scalar"]): Variable {
    return this.variable({ kind: "literal", value }, scalar);
  }

  generated(materialize: () => unknown, scalar?: Variable["scalar"]): Variable {
    return this.variable({ kind: "generated", materialize }, scalar);
  }

  matched(row: number, column: string, scalar?: Variable["scalar"]): Variable {
    return this.variable({ kind: "matched", row, column }, scalar);
  }

  returned(row: number, column: string, scalar?: Variable["scalar"]): Variable {
    return this.variable({ kind: "returned", row, column }, scalar);
  }

  private variable(
    binding: Variable["binding"],
    scalar?: Variable["scalar"]
  ): Variable {
    const variable: Variable = {
      id: this.variables.length,
      binding,
      ...(scalar ? { scalar } : {}),
    };
    this.variables.push(variable);
    return variable;
  }

  /** Reserve the next row id (so `matched` variables can name it before the row exists). */
  nextRow(): number {
    return this.rows.length;
  }

  row(input: {
    model: Model<any>;
    mode: Mode;
    key: readonly Variable[];
    newKey?: readonly Variable[];
    fresh?: boolean;
    cardinality?: "one" | "set";
    arm?: number;
    predicate?: Predicate;
    matchIsDecision?: boolean;
    verb?: string;
  }): Row {
    const row: Row & { verb?: string } = {
      id: this.rows.length,
      table: { model: input.model, table: getTableName(input.model) },
      mode: input.mode,
      cardinality: input.cardinality ?? "one",
      key: input.key,
      ...(input.newKey ? { newKey: input.newKey } : {}),
      fresh: input.fresh ?? false,
      ...(input.arm === undefined ? {} : { arm: input.arm }),
      ...(input.predicate ? { predicate: input.predicate } : {}),
      ...(input.matchIsDecision ? { matchIsDecision: true } : {}),
      ...(input.verb ? { verb: input.verb } : {}),
    };
    this.rows.push(row);
    return row;
  }

  cell(row: Row, column: string, value: Variable, mode: Mode = "assert"): Cell {
    const cell: Cell = { row: row.id, column, value, mode };
    this.cells.push(cell);
    return cell;
  }

  reference(input: {
    holder: Row;
    referenced: Row;
    columns: readonly { holderColumn: string; referencedColumn: string }[];
    relation: { model: Model<any>; field: string };
    onKeyChange?: Reference["onKeyChange"];
    nullable?: boolean;
    unique?: boolean;
  }): Reference {
    const reference: Reference = {
      holder: input.holder.id,
      referenced: input.referenced.id,
      columns: input.columns,
      onKeyChange: input.onKeyChange ?? "restrict",
      nullable: input.nullable ?? true,
      unique: input.unique ?? false,
      relation: input.relation,
    };
    this.references.push(reference);
    return reference;
  }

  arm(decision: Row, taken: "found" | "missing"): Arm {
    const arm: Arm = { id: this.arms.length, decision: decision.id, taken };
    this.arms.push(arm);
    return arm;
  }

  project(projection: Projection): void {
    this.projection = projection;
  }

  equals(column: string, operand: Variable): Predicate {
    return { kind: "scalar", column, operator: "equals", operand };
  }

  build(root: Row): Pattern {
    return {
      root: root.id,
      rows: this.rows,
      cells: this.cells,
      references: this.references,
      arms: this.arms,
      variables: this.variables,
      ...(this.projection ? { projection: this.projection } : {}),
      operation: this.operation,
    };
  }
}
