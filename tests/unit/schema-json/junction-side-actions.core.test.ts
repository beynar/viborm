/**
 * Issue #46 — junction side actions in the schema document.
 *
 * The document keeps the legacy symmetric `onDelete` / `onUpdate` and adds one
 * explicit `onDeleteSides` / `onUpdateSides` map, each exclusive with its
 * symmetric key. The reader checks the shape; the builder, called with the
 * map, is the one normalization owner; the serializer writes ONE canonical
 * spelling back: the symmetric key for equal sides, the side map otherwise.
 */

import { ValidationError } from "@errors";
import { s } from "@schema";
import { parseSchema, serializeSchema } from "@schema/json";
import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import { serializeModels } from "@src/migrations/serializer";
import { hydrateSchemaNames } from "@src/schema/hydration";
import { validateSchema } from "@src/schema/validation";
import { describe, expect, it } from "vitest";

function refusal(input: object): ValidationError {
  try {
    parseSchema(input);
  } catch (thrown) {
    if (thrown instanceof ValidationError) return thrown;
    throw thrown;
  }
  throw new Error("parseSchema accepted a document it must refuse");
}

/** Every issue as `[code] pointer`, the pair a reader acts on. */
function issues(error: ValidationError): string[] {
  return error.issues.map(
    (issue) => `${issue.message.slice(0, 6)} ${issue.path}`
  );
}

/** `post` owns the junction; `junction` is its override node. */
function documentWith(junction: unknown) {
  return {
    version: 1,
    models: {
      label: {
        fields: {
          id: { type: "string", id: true },
          posts: { type: "toMany", target: "post" },
        },
      },
      post: {
        fields: {
          id: { type: "string", id: true },
          labels: { type: "toMany", target: "label", junction },
        },
      },
    },
  };
}

const junctionOf = (schema: ReturnType<typeof parseSchema>) =>
  schema.post?.["~"].state.relations.labels?.["~"].state.junction;

describe("canonical emission and round trip (witness: parse/serialize/parse)", () => {
  const asymmetric = () => {
    const label = s.model({ id: s.string().id(), posts: s.toMany(() => post) });
    const post = s.model({
      id: s.string().id(),
      labels: s
        .toMany(() => label)
        .onDelete({ source: "cascade", target: "noAction" })
        .onUpdate("restrict"),
    });
    return { label, post };
  };

  it("writes unequal sides as a side map and equal ones as the shorthand", () => {
    expect(serializeSchema(asymmetric()).models.post?.fields.labels).toEqual({
      type: "toMany",
      target: "label",
      junction: {
        onDeleteSides: { source: "cascade", target: "noAction" },
        onUpdate: "restrict",
      },
    });
  });

  it("spells each action on its own: the shorthand delete beside an update side map", () => {
    const label = s.model({ id: s.string().id(), posts: s.toMany(() => post) });
    const post = s.model({
      id: s.string().id(),
      labels: s
        .toMany(() => label)
        .onDelete("noAction")
        .onUpdate({ source: "cascade", target: "restrict" }),
    });
    const junction = serializeSchema({ label, post }).models.post?.fields
      .labels;
    expect(junction).toEqual({
      type: "toMany",
      target: "label",
      junction: {
        onDelete: "noAction",
        onUpdateSides: { source: "cascade", target: "restrict" },
      },
    });
  });

  it("writes an equal side map as the shorthand the builder normalized it to", () => {
    const label = s.model({ id: s.string().id(), posts: s.toMany(() => post) });
    const post = s.model({
      id: s.string().id(),
      labels: s
        .toMany(() => label)
        .onUpdate({
          source: "noAction",
          target: "noAction",
        }),
    });
    expect(serializeSchema({ label, post }).models.post?.fields.labels).toEqual(
      {
        type: "toMany",
        target: "label",
        junction: { onUpdate: "noAction" },
      }
    );
  });

  it("round-trips the effective actions and the document itself", () => {
    const document = serializeSchema(asymmetric());
    const parsed = parseSchema(JSON.parse(JSON.stringify(document)));
    expect(junctionOf(parsed)).toEqual({
      onDelete: { source: "cascade", target: "noAction" },
      onUpdate: { source: "restrict", target: "restrict" },
    });
    expect(serializeSchema(parsed)).toEqual(document);
  });

  it("reads a side map for both actions, and names beside them", () => {
    const parsed = parseSchema(
      documentWith({
        table: "post_labels",
        onDeleteSides: { source: "cascade", target: "restrict" },
        onUpdateSides: { source: "restrict", target: "cascade" },
      })
    );
    expect(junctionOf(parsed)).toEqual({
      table: "post_labels",
      onDelete: { source: "cascade", target: "restrict" },
      onUpdate: { source: "restrict", target: "cascade" },
    });
  });

  it("normalizes an equal side map at intake and writes it back canonically", () => {
    const parsed = parseSchema(
      documentWith({
        onDeleteSides: { source: "restrict", target: "restrict" },
      })
    );
    expect(serializeSchema(parsed).models.post?.fields.labels).toEqual({
      type: "toMany",
      target: "label",
      junction: { onDelete: "restrict" },
    });
  });

  it("produces the physical keys the builder declaration produces", () => {
    const fromDocument = parseSchema(serializeSchema(asymmetric()));
    const direct = asymmetric();
    hydrateSchemaNames(direct);
    expect(
      serializeModels(fromDocument, { migrationDriver: mysqlMigrationDriver })
    ).toEqual(
      serializeModels(direct, { migrationDriver: mysqlMigrationDriver })
    );
  });
});

describe("refusals at the document boundary (witness: wrong keys, missing side, setNull)", () => {
  it("refuses a symmetric action beside its side map", () => {
    expect(
      issues(
        refusal(
          documentWith({
            onDelete: "cascade",
            onDeleteSides: { source: "cascade", target: "noAction" },
          })
        )
      )
    ).toEqual(["[J004] /models/post/fields/labels/junction/onDeleteSides"]);
    expect(
      issues(
        refusal(
          documentWith({
            onUpdate: "cascade",
            onUpdateSides: { source: "cascade", target: "noAction" },
          })
        )
      )
    ).toEqual(["[J004] /models/post/fields/labels/junction/onUpdateSides"]);
  });

  it("allows the shorthand for one action beside the side map of the other", () => {
    const parsed = parseSchema(
      documentWith({
        onDelete: "restrict",
        onUpdateSides: { source: "cascade", target: "noAction" },
      })
    );
    expect(junctionOf(parsed)).toEqual({
      onDelete: { source: "restrict", target: "restrict" },
      onUpdate: { source: "cascade", target: "noAction" },
    });
  });

  it("refuses an unknown key inside a side map", () => {
    expect(
      issues(
        refusal(
          documentWith({
            onDeleteSides: { source: "cascade", target: "noAction", both: 1 },
          })
        )
      )
    ).toEqual([
      "[J003] /models/post/fields/labels/junction/onDeleteSides/both",
    ]);
  });

  it("refuses a side map that omits a side", () => {
    expect(
      issues(refusal(documentWith({ onDeleteSides: { source: "cascade" } })))
    ).toEqual([
      "[J004] /models/post/fields/labels/junction/onDeleteSides/target",
    ]);
    expect(issues(refusal(documentWith({ onUpdateSides: {} })))).toEqual([
      "[J004] /models/post/fields/labels/junction/onUpdateSides/source",
      "[J004] /models/post/fields/labels/junction/onUpdateSides/target",
    ]);
  });

  it("refuses `setNull` or an unknown action on either side", () => {
    expect(
      issues(
        refusal(
          documentWith({
            onDeleteSides: { source: "setNull", target: "cascade" },
          })
        )
      )
    ).toEqual([
      "[J004] /models/post/fields/labels/junction/onDeleteSides/source",
    ]);
    const error = refusal(
      documentWith({ onUpdateSides: { source: "cascade", target: "SET NULL" } })
    );
    expect(issues(error)).toEqual([
      "[J004] /models/post/fields/labels/junction/onUpdateSides/target",
    ]);
    expect(error.issues[0]?.message).toContain("`onUpdateSides.target`");
  });

  it("refuses a side map that is not an object", () => {
    expect(issues(refusal(documentWith({ onDeleteSides: "cascade" })))).toEqual(
      ["[J004] /models/post/fields/labels/junction/onDeleteSides"]
    );
    expect(
      issues(refusal(documentWith({ onDeleteSides: ["cascade", "noAction"] })))
    ).toEqual(["[J004] /models/post/fields/labels/junction/onDeleteSides"]);
  });

  it("leaves a side map on row-reference storage to the topology owner, R012", () => {
    // The document is well formed; whether its collection resolves to a
    // junction is a graph fact, judged where every other graph fact is.
    const parsed = parseSchema({
      version: 1,
      models: {
        author: {
          fields: {
            id: { type: "string", id: true },
            books: {
              type: "toMany",
              target: "book",
              junction: {
                onDeleteSides: { source: "cascade", target: "restrict" },
              },
            },
          },
        },
        book: {
          fields: {
            id: { type: "string", id: true },
            authorId: { type: "string" },
            author: {
              type: "toOne",
              target: "author",
              fields: ["authorId"],
              references: ["id"],
            },
          },
        },
      },
    });
    hydrateSchemaNames(parsed);
    expect(validateSchema(parsed).errors.map((issue) => issue.code)).toEqual([
      "R012",
    ]);
  });
});
