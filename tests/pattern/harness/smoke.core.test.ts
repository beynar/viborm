/** Day-0 smoke: the oracle harness dumps a real operation on both substrates. */
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { validateSchemaOrThrow } from "@schema/validation";
import { describe, expect, test } from "vitest";
import { dumpOperation, serializeDump } from "./dump";

const schema = (() => {
  const user = s
    .model({
      id: s.string().id(),
      name: s.string(),
      posts: s.toMany(() => post),
    })
    .map("k4_users");
  const tag = s
    .model({
      id: s.string().id(),
      label: s.string(),
      posts: s.toMany(() => post),
    })
    .map("k4_tags");
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      authorId: s.string().nullable(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
      tags: s.toMany(() => tag),
    })
    .map("k4_posts");
  return { user, tag, post };
})();
hydrateSchemaNames(schema);
validateSchemaOrThrow(schema);

const args = {
  where: { id: "p1" },
  data: {
    title: "t",
    author: { connect: { id: "u1" } },
    tags: { connect: [{ id: "a" }, { id: "b" }] },
  },
  select: { id: true },
};

describe("K4 oracle harness", () => {
  test.each([
    ["transaction", "found"],
    ["batch", "found"],
    ["transaction", "missing"],
    ["batch", "missing"],
  ] as const)("dumps update on %s / %s", (substrate, world) => {
    const dump = dumpOperation(
      schema as Record<string, Model<any>>,
      schema.post,
      "post",
      "update",
      args,
      "postgresql",
      substrate,
      world
    );
    const text = serializeDump(dump);
    expect(JSON.parse(text)).toEqual(JSON.parse(text));
    // eslint-disable-next-line no-console
    console.log(
      `${substrate}/${world}: planning ${dump.planning.length}, final ${dump.final.length}` +
        (dump.error
          ? `  ERROR ${dump.error.name}: ${dump.error.message}`
          : "") +
        "\n" +
        [...dump.planning, ...dump.final]
          .map(
            (step) =>
              `  [${step.kind}] ${step.id}${step.expects ? " (required)" : ""}${step.sql ? `  ${step.sql.slice(0, 80)}` : ""}`
          )
          .join("\n")
    );
    expect(dump.kind).toBe("operation");
    if (world === "found") {
      expect(dump.error).toBeUndefined();
      expect(dump.planning.length).toBe(4);
      expect(dump.final.length).toBe(substrate === "batch" ? 7 : 3);
      return;
    }
    // A missing connect target is refused at compile: the refusal IS the
    // contract the differential must reproduce, so it is dumped, not thrown.
    expect(dump.error).toMatchObject({
      name: "NestedWriteError",
      code: "V7001",
    });
  });
});
