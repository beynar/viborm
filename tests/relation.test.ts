import { describe, test, expect, expectTypeOf } from "vitest";
import { s } from "../src/schema/index.js";

describe("Recursive Schema Support with Standard Relationship Types", () => {
  test("should support all four standard database relationship types", () => {
    const User = s.model("User", {
      id: s.string(),
      email: s.string(),
      profile: s.relation.oneToOne(() => Profile).onDelete("CASCADE"),
    });

    const Profile = s.model("Profile", {
      id: s.string(),
      bio: s.string(),
      user: s.relation.manyToOne(() => User).onDelete("CASCADE"),
    });
  });
  test("should support all four standard database relationship types", () => {
    const User = s.model("User", {
      id: s.string(),
      email: s.string(),
      profile: s.relation((r) => r.oneToOne(Profile).onDelete("CASCADE")),
    });

    const Profile = s.model("Profile", {
      id: s.string(),
      bio: s.string(),
      user: s.relation((r) => r.manyToOne((User).onDelete("CASCADE")),
    });
  });
});
