import { describe, test, expect, expectTypeOf } from "vitest";
import { s } from "../src/schema/index.js";

describe("Recursive Schema Support with Standard Relationship Types", () => {
  test("should support all four standard database relationship types", () => {
    const User = s.model("User", {
      id: s.string(),
      email: s.string(),
      profile: s.relation({ onField: "test" }).oneToOne(() => Profile),
    });

    const Profile = s.model("Profile", {
      id: s.string(),
      bio: s.string(),
      user: s
        .relation({ onDelete: "CASCADE", onField: "test" })
        .manyToOne(() => User),
    });

    type O = (typeof User.infer)["profile"]["id"];
  });
});
