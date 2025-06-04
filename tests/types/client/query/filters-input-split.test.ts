import { describe, test, expectTypeOf } from "vitest";
import type {
  FieldFilter,
  StringFilter,
  NumberFilter,
} from "../../../../src/types/query";

describe("Filters Input Split", () => {
  test("Should be able to import FieldFilter from main filters-input module", () => {
    // This test verifies that the main filter mapping is still accessible
    expectTypeOf<FieldFilter<any>>().toBeUnknown();
  });

  test("Should be able to import specific field filters from re-exported field-filters", () => {
    // This test verifies that field-specific filters are accessible
    expectTypeOf<StringFilter>().toBeObject();
    expectTypeOf<NumberFilter>().toBeObject();
  });

  test("Both modules should be importable from the query index", () => {
    // This test verifies that the split doesn't break the main import path
    type TestFieldFilter = FieldFilter<any>;
    type TestStringFilter = StringFilter;

    expectTypeOf<TestFieldFilter>().toBeUnknown();
    expectTypeOf<TestStringFilter>().toBeObject();
  });
});
