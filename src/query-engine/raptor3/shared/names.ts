import type { AnyModel } from "@schema/model";

/** A model's name, as the schema's keys say it. */
export const nameOf = (model: AnyModel): string => model["~"].names.ts!;
/** A model's table, as the database names it. */
export const tableOf = (model: AnyModel): string => model["~"].names.sql!;
