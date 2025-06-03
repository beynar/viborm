import { describe, test, expectTypeOf } from "vitest";
import type {
  UpdateInput,
  UpdateManyInput,
} from "../../../../src/types/client/query";

describe("Update Input Split", () => {
  test("UpdateManyInput should be a different type from UpdateInput", () => {
    // Simple type existence test
    expectTypeOf<UpdateManyInput<any>>().toBeObject();
    expectTypeOf<UpdateInput<any>>().toBeObject();

    // They should be different types
    expectTypeOf<UpdateManyInput<any>>().not.toEqualTypeOf<UpdateInput<any>>();
  });

  test("Both types should be importable from the query module", () => {
    // This test verifies that the split doesn't break imports
    type TestUpdateInput = UpdateInput<any>;
    type TestUpdateManyInput = UpdateManyInput<any>;

    expectTypeOf<TestUpdateInput>().toBeObject();
    expectTypeOf<TestUpdateManyInput>().toBeObject();
  });
});
