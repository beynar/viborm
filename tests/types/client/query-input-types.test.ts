import { describe, test, expectTypeOf } from "vitest";
import type {
  WhereInput,
  WhereUniqueInput,
  OrderByInput,
  SelectInput,
  IncludeInput,
  FindManyArgs,
  FindUniqueArgs,
  CreateArgs,
  UpdateArgs,
} from "../../../src/types/client";
import { testUser, testPost, testProfile } from "../../schema";

describe("Query Input Types", () => {
  describe("WhereInput", () => {
    test("should allow filtering by scalar fields", () => {
      type UserWhere = WhereInput<typeof testUser>;

      const userWhere: UserWhere = {
        name: "John",
        email: { contains: "@example.com" },
        age: { gte: 18 },
      };

      expectTypeOf(userWhere).toMatchTypeOf<UserWhere>();
    });

    test("should allow logical operators", () => {
      type UserWhere = WhereInput<typeof testUser>;

      const complexWhere: UserWhere = {
        AND: [{ name: "John" }, { age: { gte: 18 } }],
        OR: [
          { email: { contains: "gmail" } },
          { email: { contains: "hotmail" } },
        ],
        NOT: {
          age: { lt: 13 },
        },
      };

      expectTypeOf(complexWhere).toMatchTypeOf<UserWhere>();
    });

    test("should allow relation filtering", () => {
      type UserWhere = WhereInput<typeof testUser>;

      const relationWhere: UserWhere = {
        posts: {
          some: {
            title: { contains: "TypeScript" },
          },
        },
        profile: {
          bio: { not: null },
        },
      };

      expectTypeOf(relationWhere).toMatchTypeOf<UserWhere>();
    });
  });

  describe("WhereUniqueInput", () => {
    test("should only allow unique fields", () => {
      type UserWhereUnique = WhereUniqueInput<typeof testUser>;

      const uniqueWhere: UserWhereUnique = {
        id: "user-123",
      };

      expectTypeOf(uniqueWhere).toMatchTypeOf<UserWhereUnique>();
    });
  });

  describe("OrderByInput", () => {
    test("should allow ordering by scalar fields", () => {
      type UserOrderBy = OrderByInput<typeof testUser>;

      const orderBy: UserOrderBy = {
        name: "asc",
        age: "desc",
        createdAt: "asc",
      };

      expectTypeOf(orderBy).toMatchTypeOf<UserOrderBy>();
    });
  });

  describe("SelectInput", () => {
    test("should allow selecting scalar fields", () => {
      type UserSelect = SelectInput<typeof testUser>;

      const select: UserSelect = {
        id: true,
        name: true,
        email: true,
      };

      expectTypeOf(select).toMatchTypeOf<UserSelect>();
    });

    test("should allow nested relation selection", () => {
      type UserSelect = SelectInput<typeof testUser>;

      const nestedSelect: UserSelect = {
        id: true,
        name: true,
        posts: {
          select: {
            id: true,
            title: true,
          },
        },
        profile: {
          select: {
            bio: true,
          },
        },
      };

      expectTypeOf(nestedSelect).toMatchTypeOf<UserSelect>();
    });
  });

  describe("IncludeInput", () => {
    test("should allow including relations", () => {
      type UserInclude = IncludeInput<typeof testUser>;

      const include: UserInclude = {
        posts: true,
        profile: true,
      };

      expectTypeOf(include).toMatchTypeOf<UserInclude>();
    });

    test("should allow nested includes", () => {
      type UserInclude = IncludeInput<typeof testUser>;

      const nestedInclude: UserInclude = {
        posts: {
          include: {
            author: true,
          },
        },
      };

      expectTypeOf(nestedInclude).toMatchTypeOf<UserInclude>();
    });
  });

  describe("FindManyArgs", () => {
    test("should combine all query input types", () => {
      type UserFindManyArgs = FindManyArgs<typeof testUser>;

      const findManyArgs: UserFindManyArgs = {
        where: {
          age: { gte: 18 },
          posts: {
            some: {
              title: { contains: "TypeScript" },
            },
          },
        },
        orderBy: {
          name: "asc",
        },
        select: {
          id: true,
          name: true,
          posts: {
            select: {
              title: true,
            },
          },
        },
        take: 10,
        skip: 0,
      };

      expectTypeOf(findManyArgs).toMatchTypeOf<UserFindManyArgs>();
    });
  });

  describe("FindUniqueArgs", () => {
    test("should require unique where clause", () => {
      type UserFindUniqueArgs = FindUniqueArgs<typeof testUser>;

      const findUniqueArgs: UserFindUniqueArgs = {
        where: {
          id: "user-123",
        },
        include: {
          posts: true,
          profile: true,
        },
      };

      expectTypeOf(findUniqueArgs).toMatchTypeOf<UserFindUniqueArgs>();
    });
  });

  describe("CreateArgs", () => {
    test("should allow creating with data", () => {
      type UserCreateArgs = CreateArgs<typeof testUser>;

      const createArgs: UserCreateArgs = {
        data: {
          name: "John Doe",
          email: "john@example.com",
          age: 25,
          posts: {
            create: [
              {
                title: "First Post",
                content: "Hello World",
                authorId: "user-123",
              },
            ],
          },
        },
        select: {
          id: true,
          name: true,
        },
      };

      expectTypeOf(createArgs).toMatchTypeOf<UserCreateArgs>();
    });
  });

  describe("UpdateArgs", () => {
    test("should allow updating with where and data", () => {
      type UserUpdateArgs = UpdateArgs<typeof testUser>;

      const updateArgs: UserUpdateArgs = {
        where: {
          id: "user-123",
        },
        data: {
          name: "Jane Doe",
          age: { increment: 1 },
          posts: {
            create: {
              title: "New Post",
              content: "Content",
              authorId: "user-123",
            },
            updateMany: {
              where: {
                published: false,
              },
              data: {
                published: true,
              },
            },
          },
        },
      };

      expectTypeOf(updateArgs).toMatchTypeOf<UserUpdateArgs>();
    });
  });
});
