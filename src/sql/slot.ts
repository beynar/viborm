import { Sql } from "./sql";

/**
 * A fragment whose text its statement decides once the statement is whole,
 * between two forms known where it is placed: the provisional one until
 * {@link settle}, which the statement's owner calls before anything renders
 * it (rendering a fragment keeps its text, {@link Sql.peek} does not).
 */
export class SqlSlot extends Sql {
  constructor(provisional: Sql) {
    super(["", ""], [provisional]);
  }
  settle(content: Sql): void {
    SqlSlot.fill(this, content);
  }
}
