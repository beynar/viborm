/**
 * Type System Tests using @ark/attest
 *
 * Tests that the type system correctly infers types from schema definitions.
 * Uses the existing comprehensive schema from tests/schema.ts
 */
import { describe, it } from "vitest";
import { attest } from "@ark/attest";
import {
  testUser,
  testPost,
  testProfile,
  string,
  nullableString,
  stringWithDefault,
  number,
  nullableNumber,
  boolean,
  nullableBoolean,
  bigint,
  nullableBigint,
  dateTime,
  nullableDateTime,
  json,
  nullableJson,
  enumField,
  nullableEnumField,
} from "../test-models.js";
import type {
  ModelWhereInput,
  ModelUpdateInput,
  ModelWhereUniqueInput,
} from "../../src/schema/model/types/index.js";

// =============================================================================
// TYPE ALIASES FROM EXISTING SCHEMA
// =============================================================================

type UserFields = (typeof testUser)["~"]["fields"];
type PostFields = (typeof testPost)["~"]["fields"];

type UserWhere = ModelWhereInput<UserFields>;
type UserUpdate = ModelUpdateInput<UserFields>;
type UserWhereUnique = ModelWhereUniqueInput<UserFields>;

type PostWhere = ModelWhereInput<PostFields>;
type PostUpdate = ModelUpdateInput<PostFields>;

// =============================================================================
// FIELD TYPE INFERENCE TESTS
// =============================================================================

describe("Field Type Inference", () => {
  describe("String fields", () => {
    it("infers base string type", () => {
      attest<(typeof string)["~"]["state"]["type"]>("string");
    });

    it("infers nullable string", () => {
      attest<(typeof nullableString)["~"]["state"]["nullable"]>(true);
    });

    it("infers string with default has hasDefault", () => {
      attest<(typeof stringWithDefault)["~"]["state"]["hasDefault"]>(true);
    });
  });

  describe("Number fields", () => {
    it("infers int type", () => {
      attest<(typeof number)["~"]["state"]["type"]>("int");
    });

    it("infers nullable number", () => {
      attest<(typeof nullableNumber)["~"]["state"]["nullable"]>(true);
    });
  });

  describe("Boolean fields", () => {
    it("infers boolean type", () => {
      attest<(typeof boolean)["~"]["state"]["type"]>("boolean");
    });

    it("infers nullable boolean", () => {
      attest<(typeof nullableBoolean)["~"]["state"]["nullable"]>(true);
    });
  });

  describe("BigInt fields", () => {
    it("infers bigint type", () => {
      attest<(typeof bigint)["~"]["state"]["type"]>("bigint");
    });

    it("infers nullable bigint", () => {
      attest<(typeof nullableBigint)["~"]["state"]["nullable"]>(true);
    });
  });

  describe("DateTime fields", () => {
    it("infers datetime type", () => {
      attest<(typeof dateTime)["~"]["state"]["type"]>("datetime");
    });

    it("infers nullable datetime", () => {
      attest<(typeof nullableDateTime)["~"]["state"]["nullable"]>(true);
    });
  });

  describe("Enum fields", () => {
    it("infers enum type", () => {
      attest<(typeof enumField)["~"]["state"]["type"]>("enum");
    });

    it("infers nullable enum", () => {
      attest<(typeof nullableEnumField)["~"]["state"]["nullable"]>(true);
    });
  });
});

// =============================================================================
// WHERE INPUT TYPE TESTS
// =============================================================================

describe("Where Input Types", () => {
  describe("Scalar filters", () => {
    it("accepts shorthand string value", () => {
      const where: UserWhere = { name: "Alice" };
      attest(where);
    });

    it("accepts explicit equals", () => {
      const where: UserWhere = { name: { equals: "Alice" } };
      attest(where);
    });

    it("accepts string-specific filters", () => {
      const where: UserWhere = {
        name: { contains: "ali", mode: "insensitive" },
      };
      attest(where);
    });

    it("accepts nullable field with null shorthand", () => {
      const where: UserWhere = { bio: null };
      attest(where);
    });

    it("accepts number shorthand", () => {
      const where: UserWhere = { age: 25 };
      attest(where);
    });

    it("accepts number comparison", () => {
      const where: UserWhere = { age: { gte: 18, lt: 65 } };
      attest(where);
    });

    it("accepts datetime shorthand", () => {
      const where: UserWhere = { createdAt: new Date() };
      attest(where);
    });

    it("accepts datetime ISO string", () => {
      const where: UserWhere = { createdAt: "2024-01-01T00:00:00Z" };
      attest(where);
    });

    it("accepts array has filter", () => {
      const where: UserWhere = { tags: { has: "typescript" } };
      attest(where);
    });

    it("rejects wrong type for string field", () => {
      // @ts-expect-error - number not assignable to string filter
      const where: UserWhere = { name: 123 };
    });

    it("rejects wrong type for number field", () => {
      // @ts-expect-error - string not assignable to number filter
      const where: UserWhere = { age: "twenty" };
    });
  });

  describe("Relation filters", () => {
    it("rejects to-one shorthand (must use is/isNot)", () => {
      // @ts-expect-error - shorthand not allowed, must use is/isNot
      const where: PostWhere = { author: { name: "Alice" } };
      attest(where);
    });

    it("accepts to-one explicit is", () => {
      const where: PostWhere = { author: { is: { name: "Alice" } } };
      attest(where);
    });

    it("accepts to-one isNot", () => {
      const where: PostWhere = { author: { isNot: { name: "Bob" } } };
      attest(where);
    });

    it("accepts to-many some", () => {
      const where: UserWhere = {
        posts: { some: { title: { contains: "TypeScript" } } },
      };
      attest(where);
    });

    it("accepts to-many every", () => {
      const where: UserWhere = {
        posts: { every: { published: true } },
      };
      attest(where);
    });

    it("accepts to-many none", () => {
      const where: UserWhere = {
        posts: { none: { title: "Deleted" } },
      };
      attest(where);
    });
  });

  describe("Logical operators", () => {
    it("accepts AND array", () => {
      const where: UserWhere = {
        AND: [{ name: "Alice" }, { age: { gte: 18 } }],
      };
      attest(where);
    });

    it("accepts OR array", () => {
      const where: UserWhere = {
        OR: [{ name: "Alice" }, { name: "Bob" }],
      };
      attest(where);
    });

    it("accepts NOT", () => {
      const where: UserWhere = {
        NOT: { name: "Anonymous" },
      };
      attest(where);
    });
  });
});

// =============================================================================
// UPDATE INPUT TYPE TESTS
// =============================================================================

describe("Update Input Types", () => {
  it("accepts shorthand update", () => {
    const update: UserUpdate = { name: "Bob" };
    attest(update);
  });

  it("accepts explicit set", () => {
    const update: UserUpdate = { name: { set: "Bob" } };
    attest(update);
  });

  it("accepts null to clear nullable field", () => {
    const update: UserUpdate = { bio: null };
    attest(update);
  });

  it("accepts empty update", () => {
    const update: UserUpdate = {};
    attest(update);
  });

  it("rejects wrong type", () => {
    // @ts-expect-error - name should be string
    const update: UserUpdate = { name: 123 };
  });
});

// =============================================================================
// WHERE UNIQUE INPUT TYPE TESTS
// =============================================================================

describe("Where Unique Input Types", () => {
  it("accepts id field", () => {
    const where: UserWhereUnique = { id: "user-123" };
    attest(where);
  });

  it("accepts unique email field", () => {
    const where: UserWhereUnique = { email: "alice@example.com" };
    attest(where);
  });
});

// =============================================================================
// NESTED RELATION UPDATE TESTS
// =============================================================================

describe("Nested Relation Update", () => {
  it("accepts nested update", () => {
    const update: PostUpdate = {
      author: {
        update: { name: "Bob" },
      },
    };
    attest(update);
  });

  it("accepts nested connect", () => {
    const update: PostUpdate = {
      author: {
        connect: { id: "user-456" },
      },
    };
    attest(update);
  });
});
