import { Field, Model } from "@schema";
import { FieldNames, ModelFields } from "../foundation/model-extraction";

// Import the FieldUpdateOperations type specifically
import type { FieldUpdateOperations } from "./update-input";

// ============================================================================
// UPDATE MANY INPUT
// ============================================================================

/**
 * Input for updateMany operations - only allows scalar field updates,
 * no relation updates to keep operations simple and performant
 */
export type UpdateManyInput<TModel extends Model<any>> =
  FieldNames<TModel> extends never
    ? {}
    : {
        [K in FieldNames<TModel>]?: K extends keyof ModelFields<TModel>
          ? ModelFields<TModel>[K] extends Field
            ? FieldUpdateOperations<ModelFields<TModel>[K]>
            : never
          : never;
      };

/**
 * Input for updateMany operations within relations
 */
export type RelationUpdateManyInput<TModel extends Model<any>> = {
  where: import("./where-input").WhereInput<TModel>;
  data: UpdateManyInput<TModel>;
};
