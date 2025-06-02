// // SQL Compilation Readiness Tests
// // Tests that verify AST structure is ready for SQL generation by database adapters

// import { DefaultSchemaRegistry } from "../../src/query/ast";
// import { DefaultQueryParser } from "../../src/query/parser";
// import { s } from "../../src/schema";

// describe("SQL Compilation Readiness Tests", () => {
//   let registry: DefaultSchemaRegistry;
//   let parser: DefaultQueryParser;

//   const userModel = s.model("user", {
//     id: s.string().id(),
//     name: s.string(),
//     email: s.string().unique(),
//     age: s.int(),
//     salary: s.float(),
//     isActive: s.boolean(),
//     metadata: s.json(),
//     createdAt: s.dateTime(),
//     updatedAt: s.dateTime(),
//   });

//   const postModel = s.model("post", {
//     id: s.string().id(),
//     title: s.string(),
//     content: s.string(),
//     published: s.boolean(),
//     likes: s.int(),
//     authorId: s.string(),
//     createdAt: s.dateTime(),
//   });

//   const commentModel = s.model("comment", {
//     id: s.string().id(),
//     content: s.string(),
//     approved: s.boolean(),
//     postId: s.string(),
//     authorId: s.string(),
//     createdAt: s.dateTime(),
//   });

//   beforeEach(() => {
//     registry = new DefaultSchemaRegistry();
//     registry.registerModel(userModel);
//     registry.registerModel(postModel);
//     registry.registerModel(commentModel);
//     parser = new DefaultQueryParser(registry);
//   });

//   describe("SELECT Query AST Structure", () => {
//     test("findMany produces complete SELECT AST structure", () => {
//       const result = parser.parse("user", "findMany", {
//         where: {
//           AND: [
//             { age: { gte: 18 } },
//             { isActive: true },
//             { email: { contains: "@company.com" } },
//           ],
//         },
//         select: {
//           id: true,
//           name: true,
//           email: true,
//           age: true,
//         },
//         orderBy: [{ createdAt: "desc" }, { name: "asc" }],
//         take: 50,
//         skip: 100,
//       });

//       // Should have all components needed for SELECT compilation
//       expect(result.operation).toBe("findMany");
//       expect(result.model.name).toBe("user");

//       // WHERE clause - should compile to WHERE with proper joins
//       expect(result.args.where).toHaveLength(1);
//       const andCondition = result.args.where![0]!;
//       expect(andCondition.target.type).toBe("LOGICAL");
//       expect(andCondition.nested).toHaveLength(3);

//       // SELECT clause - should compile to SELECT fields
//       expect(result.args.select?.type).toBe("SELECTION");
//       if (result.args.select?.type === "SELECTION") {
//         expect(result.args.select.fields).toHaveLength(4);
//         expect(
//           result.args.select.fields.every((f) => f.field.model.name === "user")
//         ).toBe(true);
//       }

//       // ORDER BY - should compile to ORDER BY clause
//       expect(result.args.orderBy).toHaveLength(2);
//       expect(result.args.orderBy![0]!.target.type).toBe("FIELD");
//       expect(result.args.orderBy![0]!.direction).toBe("desc");

//       // LIMIT/OFFSET - should compile to LIMIT and OFFSET
//       expect(result.args.take).toBe(50);
//       expect(result.args.skip).toBe(100);
//     });

//     test("findUnique produces simple SELECT with WHERE", () => {
//       const result = parser.parse("user", "findUnique", {
//         where: { id: "user_123" },
//         select: {
//           name: true,
//           email: true,
//         },
//       });

//       expect(result.operation).toBe("findUnique");
//       expect(result.args.where).toHaveLength(1);
//       expect(result.args.select?.type).toBe("SELECTION");
//       expect(result.args.take).toBeUndefined(); // Should not have LIMIT for findUnique
//     });
//   });

//   describe("INSERT Query AST Structure", () => {
//     test("create produces complete INSERT AST structure", () => {
//       const result = parser.parse("user", "create", {
//         data: {
//           name: "John Doe",
//           email: "john@example.com",
//           age: 30,
//           salary: 75000.5,
//           isActive: true,
//           metadata: { role: "admin", permissions: ["read", "write"] },
//         },
//       });

//       expect(result.operation).toBe("create");
//       expect(result.args.data).toBeDefined();

//       if (Array.isArray(result.args.data)) {
//         expect(result.args.data).toHaveLength(1);
//         const dataFields = result.args.data[0]!.fields;

//         // Should have all fields for INSERT statement
//         expect(dataFields.length).toBeGreaterThan(0);

//         // Each field should have proper structure for SQL compilation
//         dataFields.forEach((field) => {
//           expect(field.type).toBe("DATA_FIELD");
//           expect(field.target.type).toBe("FIELD");
//           expect(field.operation).toBe("set");
//           expect(field.value).toBeDefined();
//         });
//       }
//     });

//     test("createMany produces batch INSERT AST structure", () => {
//       const result = parser.parse("user", "createMany", {
//         data: [
//           { name: "User 1", email: "user1@example.com", age: 25 },
//           { name: "User 2", email: "user2@example.com", age: 30 },
//           { name: "User 3", email: "user3@example.com", age: 35 },
//         ],
//         skipDuplicates: true,
//       });

//       expect(result.operation).toBe("createMany");
//       expect(result.args.data?.type).toBe("BATCH_DATA");

//       if (result.args.data?.type === "BATCH_DATA") {
//         expect(result.args.data.operation).toBe("createMany");
//         expect(result.args.data.items).toHaveLength(3);
//         expect(result.args.data.options?.skipDuplicates).toBe(true);

//         // Each item should be a complete DataAST for INSERT
//         result.args.data.items.forEach((item) => {
//           expect(item.type).toBe("DATA");
//           expect(item.fields.length).toBeGreaterThan(0);
//         });
//       }
//     });
//   });

//   describe("UPDATE Query AST Structure", () => {
//     test("update produces complete UPDATE AST structure", () => {
//       const result = parser.parse("user", "update", {
//         where: { id: "user_123" },
//         data: {
//           name: "Updated Name",
//           age: 31,
//           salary: { increment: 5000 },
//           updatedAt: new Date(),
//         },
//       });

//       expect(result.operation).toBe("update");
//       expect(result.args.where).toHaveLength(1);
//       expect(result.args.data).toBeDefined();

//       if (Array.isArray(result.args.data)) {
//         const dataFields = result.args.data[0]!.fields;

//         // Should handle different operation types for UPDATE SET clause
//         const setOperations = dataFields.filter((f) => f.operation === "set");
//         const incrementOperations = dataFields.filter(
//           (f) => f.operation === "increment"
//         );

//         expect(setOperations.length).toBeGreaterThan(0);
//         expect(incrementOperations.length).toBeGreaterThan(0);
//       }
//     });

//     test("updateMany produces bulk UPDATE AST structure", () => {
//       const result = parser.parse("user", "updateMany", {
//         where: { isActive: false },
//         data: { isActive: true, updatedAt: new Date() },
//       });

//       expect(result.operation).toBe("updateMany");
//       expect(result.args.where).toHaveLength(1);
//       expect(result.args.data?.type).toBe("BATCH_DATA");

//       if (result.args.data?.type === "BATCH_DATA") {
//         expect(result.args.data.operation).toBe("updateMany");
//         expect(result.args.data.items).toHaveLength(1);
//       }
//     });
//   });

//   describe("DELETE Query AST Structure", () => {
//     test("delete produces complete DELETE AST structure", () => {
//       const result = parser.parse("user", "delete", {
//         where: { id: "user_123" },
//       });

//       expect(result.operation).toBe("delete");
//       expect(result.args.where).toHaveLength(1);
//       expect(result.args.data).toBeUndefined(); // DELETE doesn't need data
//     });

//     test("deleteMany produces bulk DELETE AST structure", () => {
//       const result = parser.parse("user", "deleteMany", {
//         where: { isActive: false },
//       });

//       expect(result.operation).toBe("deleteMany");
//       expect(result.args.where).toHaveLength(1);
//       expect(result.args.data?.type).toBe("BATCH_DATA");

//       if (result.args.data?.type === "BATCH_DATA") {
//         expect(result.args.data.operation).toBe("deleteMany");
//         expect(result.args.data.items).toHaveLength(0); // DELETE doesn't need data items
//       }
//     });
//   });

//   describe("Aggregation Query AST Structure", () => {
//     test("count produces COUNT query AST structure", () => {
//       const result = parser.parse("user", "count", {
//         where: { isActive: true },
//       });

//       expect(result.operation).toBe("count");
//       expect(result.args.where).toHaveLength(1);
//       expect(result.args.select?.type).toBe("AGGREGATION");

//       if (result.args.select?.type === "AGGREGATION") {
//         expect(result.args.select.aggregations).toHaveLength(1);
//         expect(result.args.select.aggregations[0]!.operation).toBe("_count");
//       }
//     });

//     test("aggregate produces complex aggregation AST structure", () => {
//       const result = parser.parse("user", "aggregate", {
//         where: { isActive: true },
//         _count: { id: true },
//         _avg: { age: true, salary: true },
//         _sum: { salary: true },
//         _min: { createdAt: true },
//         _max: { createdAt: true },
//       });

//       expect(result.operation).toBe("aggregate");
//       expect(result.args.select?.type).toBe("AGGREGATION");

//       if (result.args.select?.type === "AGGREGATION") {
//         const aggregations = result.args.select.aggregations;

//         // Should have all aggregation types for SQL compilation
//         expect(aggregations.some((a) => a.operation === "_count")).toBe(true);
//         expect(aggregations.some((a) => a.operation === "_avg")).toBe(true);
//         expect(aggregations.some((a) => a.operation === "_sum")).toBe(true);
//         expect(aggregations.some((a) => a.operation === "_min")).toBe(true);
//         expect(aggregations.some((a) => a.operation === "_max")).toBe(true);

//         // Each aggregation should have proper field references
//         aggregations.forEach((agg) => {
//           expect(agg.type).toBe("AGGREGATION_FIELD");
//           expect(agg.operation).toMatch(/^_(count|avg|sum|min|max)$/);
//           if (agg.operation !== "_count" || agg.field) {
//             expect(agg.field).toBeDefined();
//           }
//         });
//       }
//     });

//     test("groupBy produces GROUP BY with aggregations AST structure", () => {
//       const result = parser.parse("user", "groupBy", {
//         groupBy: ["isActive", "age"],
//         where: { createdAt: { gte: new Date("2024-01-01") } },
//         _count: { id: true },
//         _avg: { salary: true },
//         having: {
//           _count: { id: { gte: 5 } },
//           _avg: { salary: { gte: 50000 } },
//         },
//         orderBy: [{ _count: { id: "desc" } }, { isActive: "asc" }],
//       });

//       expect(result.operation).toBe("groupBy");

//       // GROUP BY fields
//       expect(result.args.groupBy).toHaveLength(2);
//       result.args.groupBy!.forEach((group) => {
//         expect(group.type).toBe("GROUP_BY");
//         expect(group.field).toBeDefined();
//       });

//       // WHERE clause (before GROUP BY)
//       expect(result.args.where).toHaveLength(1);

//       // HAVING clause (after GROUP BY)
//       expect(result.args.having).toHaveLength(1);

//       // Aggregations in SELECT
//       expect(result.args.select?.type).toBe("AGGREGATION");

//       // ORDER BY with aggregations
//       expect(result.args.orderBy).toHaveLength(2);
//       expect(result.args.orderBy![0]!.target.type).toBe("AGGREGATE");
//       expect(result.args.orderBy![1]!.target.type).toBe("FIELD");
//     });
//   });

//   describe("Complex Condition AST Structure", () => {
//     test("handles complex WHERE conditions for SQL compilation", () => {
//       const result = parser.parse("user", "findMany", {
//         where: {
//           OR: [
//             {
//               AND: [
//                 { age: { gte: 18, lte: 65 } },
//                 { salary: { gte: 30000 } },
//                 { isActive: true },
//               ],
//             },
//             {
//               AND: [{ age: { gte: 65 } }, { salary: { gte: 20000 } }],
//             },
//           ],
//           NOT: {
//             email: { contains: "@blocked.com" },
//           },
//         },
//       });

//       expect(result.args.where).toHaveLength(2); // OR and NOT conditions

//       // Verify structure for SQL compilation with proper parentheses
//       const orCondition = result.args.where!.find(
//         (c) => c.target.type === "LOGICAL" && c.target.operator === "OR"
//       );
//       expect(orCondition).toBeDefined();
//       expect(orCondition!.nested).toHaveLength(2);

//       const notCondition = result.args.where!.find((c) => c.negated === true);
//       expect(notCondition).toBeDefined();
//     });

//     test("handles array and JSON operations for SQL compilation", () => {
//       const result = parser.parse("user", "findMany", {
//         where: {
//           id: { in: ["id1", "id2", "id3"] },
//           age: { notIn: [16, 17] },
//           email: { contains: "@company.com" },
//           name: { startsWith: "John" },
//           metadata: {
//             jsonPath: ["role"],
//             jsonContains: { permissions: ["admin"] },
//           },
//         },
//       });

//       expect(result.args.where).toHaveLength(1);
//       const andCondition = result.args.where![0]!;
//       expect(andCondition.nested).toHaveLength(5);

//       // Verify operators are properly structured for SQL compilation
//       andCondition.nested!.forEach((condition) => {
//         expect(condition.operator).toMatch(
//           /^(in|notIn|contains|startsWith|jsonPath|jsonContains)$/
//         );
//         expect(condition.value).toBeDefined();
//       });
//     });
//   });

//   describe("Cursor Pagination AST Structure", () => {
//     test("produces cursor pagination AST for SQL compilation", () => {
//       const result = parser.parse("user", "findMany", {
//         cursor: { createdAt: new Date("2024-01-01") },
//         take: 20,
//         orderBy: { createdAt: "desc" },
//       });

//       expect(result.args.cursor?.type).toBe("CURSOR");
//       expect(result.args.cursor?.field.name).toBe("createdAt");
//       expect(result.args.cursor?.value.valueType).toBe("dateTime");
//       expect(result.args.take).toBe(20);
//       expect(result.args.orderBy).toHaveLength(1);

//       // Cursor field should match orderBy field for proper SQL compilation
//       if (result.args.orderBy![0]!.target.type === "FIELD") {
//         expect(result.args.orderBy![0]!.target.field.name).toBe("createdAt");
//       }
//     });
//   });

//   describe("SQL Operator Mapping Verification", () => {
//     test("all condition operators map to valid SQL operators", () => {
//       const testCases = [
//         { field: "age", op: "equals", value: 25 },
//         { field: "age", op: "not", value: 25 },
//         { field: "age", op: "gt", value: 18 },
//         { field: "age", op: "gte", value: 18 },
//         { field: "age", op: "lt", value: 65 },
//         { field: "age", op: "lte", value: 65 },
//         { field: "id", op: "in", value: ["id1", "id2"] },
//         { field: "id", op: "notIn", value: ["id1", "id2"] },
//         { field: "name", op: "contains", value: "John" },
//         { field: "name", op: "startsWith", value: "J" },
//         { field: "name", op: "endsWith", value: "son" },
//         { field: "name", op: "isNull", value: null },
//         { field: "name", op: "isNotNull", value: null },
//       ];

//       testCases.forEach((testCase) => {
//         const whereClause = {
//           [testCase.field]: { [testCase.op]: testCase.value },
//         };

//         expect(() => {
//           const result = parser.parse("user", "findMany", {
//             where: whereClause,
//           });
//           expect(result.args.where).toHaveLength(1);
//         }).not.toThrow();
//       });
//     });

//     test("all data operations map to valid SQL operations", () => {
//       const testCases = [
//         { field: "name", op: "set", value: "New Name" },
//         { field: "age", op: "increment", value: 1 },
//         { field: "age", op: "decrement", value: 1 },
//         { field: "salary", op: "multiply", value: 1.1 },
//         { field: "salary", op: "divide", value: 2 },
//       ];

//       testCases.forEach((testCase) => {
//         const dataClause = {
//           [testCase.field]: { [testCase.op]: testCase.value },
//         };

//         expect(() => {
//           const result = parser.parse("user", "update", {
//             where: { id: "test" },
//             data: dataClause,
//           });
//           expect(result.args.data).toBeDefined();
//         }).not.toThrow();
//       });
//     });
//   });

//   describe("Performance for SQL Compilation", () => {
//     test("large query AST remains manageable for SQL compilation", () => {
//       const largeWhere = {
//         OR: Array.from({ length: 50 }, (_, i) => ({
//           [`field_${i}`]: `value_${i}`,
//         })),
//       };

//       const result = parser.parse("user", "findMany", {
//         where: largeWhere,
//         select: Object.fromEntries(
//           Array.from({ length: 20 }, (_, i) => [`field_${i}`, true])
//         ),
//         orderBy: Array.from({ length: 5 }, (_, i) => ({
//           [`field_${i}`]: "asc" as const,
//         })),
//         take: 100,
//       });

//       // Should produce manageable AST structure
//       expect(result.args.where).toHaveLength(1);
//       expect(result.args.select?.type).toBe("SELECTION");
//       expect(result.args.orderBy).toHaveLength(5);

//       // Memory usage should be reasonable
//       const jsonSize = JSON.stringify(result).length;
//       expect(jsonSize).toBeLessThan(100000); // Under 100KB for large query
//     });
//   });
// });
