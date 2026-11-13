import type { AnyModel } from "@schema/model";
import { type Sql, sql } from "@sql";

/** A model's name, as the schema's keys say it. */
export const nameOf = (model: AnyModel): string => model["~"].names.ts!;
/** A model's table, as the database names it. */
export const tableOf = (model: AnyModel): string => model["~"].names.sql!;
/** The scalars a model declares, by field. */
export const scalarsOf = (model: AnyModel) => model["~"].state.scalars;
/** Parts of a statement, one after the other with a comma between. */
export const listed = (parts: readonly Sql[]): Sql => sql.join(parts, ", ");
