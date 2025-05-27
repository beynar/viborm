import { assertType, expectTypeOf } from "vitest";

// const sum = (a: number, b: number) => a + b;

// describe("sum", () => {
//   test("adds 1 + 2 to equal 3", () => {
//     expect(sum(1, 2)).toBe(3);
//   });
//   test("adds 4 + 5 to equal 9", () => {
//     expect(sum(4, 5)).toBe(9);
//   });
// });

describe("test", () => {
  test("test", () => {
    expectTypeOf({ a: 3 }).toEqualTypeOf<{ a: number }>();
    expectTypeOf({ a: 1 }).toEqualTypeOf({ a: 1 });
    expectTypeOf({ a: 1 }).not.toEqualTypeOf<{ a: 2 }>();
    expectTypeOf({ a: 1, b: 1 }).not.toEqualTypeOf<{ a: number }>();
  });

  // pnpm vitest --typecheck run tests/test.test.ts
});

// pnpm vitest --typecheck run tests/test.test-d.ts
