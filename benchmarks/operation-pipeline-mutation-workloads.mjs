/** Scalar and relation-bearing mutation workload construction. */

import {
  benchmarkOperation,
  consumeScalarRows,
  preparedWitness,
} from "./operation-pipeline-harness.mjs";
import { assertSemanticDigest } from "./operation-pipeline-semantics.mjs";

export async function buildMutationWorkload(
  name,
  fixture,
  fullFixture,
  stage,
  operationCount
) {
  const { client, driver } = fixture;
  const sequences = new WeakMap();
  const nextSequence = (targetClient) => {
    const current = sequences.get(targetClient) ?? 0;
    sequences.set(targetClient, current + 1);
    return current;
  };
  if (name.startsWith("wide-create-") || name.startsWith("wide-update-")) {
    const isCreate = name.startsWith("wide-create-");
    const fieldCount = Number(name.slice(name.lastIndexOf("-") + 1));
    const fields = Object.fromEntries(
      Array.from({ length: fieldCount }, (_, index) => [
        `field${String(index + 1).padStart(3, "0")}`,
        `${isCreate ? "created" : "updated"}_${String(index + 1).padStart(3, "0")}`,
      ])
    );
    const makeOperation = (targetClient = client) =>
      isCreate
        ? targetClient.wideWrite.create({
            data: fields,
            select: { id: true },
          })
        : targetClient.wideWrite.update({
            where: { id: 1 },
            data: fields,
            select: { id: true },
          });
    return createMutationHarness(
      fixture,
      fullFixture,
      stage,
      makeOperation,
      (row) => row.id ?? 0,
      operationCount,
      { writtenScalarFields: Object.keys(fields).length }
    );
  }
  if (name === "flat-create-explicit-id") {
    const makeOperation = (targetClient = client) => {
      const current = nextSequence(targetClient);
      return targetClient.user.create({
        data: {
          id: `explicit_${current}`,
          name: "Explicit",
          email: `explicit_${current}@example.com`,
          age: 30,
        },
      });
    };
    return createMutationHarness(
      fixture,
      fullFixture,
      stage,
      makeOperation,
      (row) => row.age ?? 0,
      operationCount
    );
  }
  if (name === "flat-create-generated-id") {
    const makeOperation = (targetClient = client) =>
      targetClient.generated.create({
        data: { label: `Generated ${nextSequence(targetClient)}`, score: 7 },
      });
    return createMutationHarness(
      fixture,
      fullFixture,
      stage,
      makeOperation,
      (row) => row.id ?? 0,
      operationCount
    );
  }
  if (name === "flat-scalar-update") {
    const makeOperation = (targetClient = client) =>
      targetClient.user.update({
        where: { id: "update_target" },
        data: { age: { increment: 1 } },
      });
    return createMutationHarness(
      fixture,
      fullFixture,
      stage,
      makeOperation,
      (row) => row.age ?? 0,
      operationCount
    );
  }
  if (name === "fixed-rowref-create") {
    const makeOperation = (targetClient = client) => {
      const current = nextSequence(targetClient);
      return targetClient.user.create({
        data: {
          id: `nested_user_${current}`,
          name: "Nested",
          email: `nested_${current}@example.com`,
          age: 30,
          posts: {
            create: {
              id: `nested_post_${current}`,
              title: "Nested post",
              published: false,
              views: current,
            },
          },
        },
      });
    };
    return createComposedMutationHarness(
      fixture,
      fullFixture,
      makeOperation,
      (row) => row.id.charCodeAt(0),
      (targetClient) =>
        targetClient.user.findUnique({
          where: { id: "nested_user_0" },
          select: {
            id: true,
            posts: { select: { id: true, title: true, views: true } },
          },
        }),
      (state) => {
        if (state?.posts?.[0]?.id !== "nested_post_0") {
          throw new Error("Nested create did not persist its row reference");
        }
      }
    );
  }
  if (name === "fixed-rowref-update") {
    const makeOperation = (targetClient = client) => {
      const current = nextSequence(targetClient);
      return targetClient.user.update({
        where: { id: "relation_update_target" },
        data: {
          posts: {
            create: {
              id: `update_nested_post_${current}`,
              title: "Nested update post",
              published: false,
              views: current,
            },
          },
        },
      });
    };
    return createComposedMutationHarness(
      fixture,
      fullFixture,
      makeOperation,
      (row) => row.id.charCodeAt(0),
      (targetClient) =>
        targetClient.user.findUnique({
          where: { id: "relation_update_target" },
          select: {
            id: true,
            posts: { select: { id: true, title: true, views: true } },
          },
        }),
      (state) => {
        if (state?.posts?.[0]?.id !== "update_nested_post_0") {
          throw new Error("Nested update did not persist its row reference");
        }
      }
    );
  }
  if (name === "variant-singular-create") {
    const makeOperation = (targetClient = client) => {
      const current = nextSequence(targetClient);
      return targetClient.comment.create({
        data: {
          id: `variant_comment_${current}`,
          body: "Variant singular create",
          subject: {
            connect: {
              type: "article",
              where: { id: `article_${current % 1000}` },
            },
          },
        },
      });
    };
    return createComposedMutationHarness(
      fixture,
      fullFixture,
      makeOperation,
      (row) => row.id.charCodeAt(0),
      (targetClient) =>
        targetClient.comment.findUnique({
          where: { id: "variant_comment_0" },
          select: {
            id: true,
            body: true,
            subject: {
              article: { select: { id: true, title: true } },
              clip: { select: { id: true, title: true } },
            },
          },
        }),
      (state) => {
        if (state?.subject?.data?.id !== "article_0") {
          throw new Error("Variant singular create did not persist its target");
        }
      }
    );
  }
  if (name === "variant-singular-update") {
    const makeOperation = (targetClient = client) =>
      targetClient.comment.update({
        where: { id: "comment_0" },
        data: {
          subject: {
            connect: { type: "clip", where: { id: "clip_0" } },
          },
        },
      });
    return createComposedMutationHarness(
      fixture,
      fullFixture,
      makeOperation,
      (row) => row.id.charCodeAt(0),
      (targetClient) =>
        targetClient.comment.findUnique({
          where: { id: "comment_0" },
          select: {
            id: true,
            body: true,
            subject: {
              article: { select: { id: true, title: true } },
              clip: { select: { id: true, title: true } },
            },
          },
        }),
      (state) => {
        if (state?.subject?.data?.id !== "clip_0") {
          throw new Error("Variant singular update did not persist its target");
        }
      }
    );
  }
  if (name === "variant-collection-create") {
    const makeOperation = (targetClient = client) => {
      const current = nextSequence(targetClient);
      return targetClient.shelf.create({
        data: {
          id: `variant_shelf_${current}`,
          items: {
            connect: [
              {
                type: "clip",
                where: { id: `clip_${current % 1000}` },
              },
            ],
          },
        },
      });
    };
    return createComposedMutationHarness(
      fixture,
      fullFixture,
      makeOperation,
      (row) => row.id.charCodeAt(0),
      (targetClient) =>
        targetClient.shelf.findUnique({
          where: { id: "variant_shelf_0" },
          select: {
            id: true,
            items: {
              variants: {
                article: { select: { id: true, title: true } },
                clip: { select: { id: true, title: true } },
              },
            },
          },
        }),
      (state) => {
        if (state?.items?.[0]?.data?.id !== "clip_0") {
          throw new Error(
            "Variant collection create did not persist its junction row"
          );
        }
      }
    );
  }
  if (name === "variant-collection-update") {
    const makeOperation = (targetClient = client) => {
      const current = nextSequence(targetClient);
      return targetClient.shelf.update({
        where: { id: "shelf_0" },
        data: {
          items: {
            set: [
              {
                type: "clip",
                where: { id: `clip_${current % 1000}` },
              },
            ],
          },
        },
      });
    };
    return createComposedMutationHarness(
      fixture,
      fullFixture,
      makeOperation,
      (row) => row.id.charCodeAt(0),
      (targetClient) =>
        targetClient.shelf.findUnique({
          where: { id: "shelf_0" },
          select: {
            id: true,
            items: {
              variants: {
                article: { select: { id: true, title: true } },
                clip: { select: { id: true, title: true } },
              },
            },
          },
        }),
      (state) => {
        if (
          state?.items?.length !== 1 ||
          state.items[0]?.data?.id !== "clip_0"
        ) {
          throw new Error(
            "Variant collection update did not replace its junction rows"
          );
        }
      }
    );
  }
  if (name === "fixed-junction-create") {
    const makeOperation = (targetClient = client) => {
      const current = nextSequence(targetClient);
      return targetClient.article.create({
        data: {
          id: `fixed_article_${current}`,
          title: "Fixed junction create",
          shelf: { connect: { id: `shelf_${1000 + (current % 1000)}` } },
        },
      });
    };
    return createComposedMutationHarness(
      fixture,
      fullFixture,
      makeOperation,
      (row) => row.id.charCodeAt(0),
      (targetClient) =>
        targetClient.article.findUnique({
          where: { id: "fixed_article_0" },
          select: { id: true, title: true, shelf: { select: { id: true } } },
        }),
      (state) => {
        if (state?.shelf?.id !== "shelf_1000") {
          throw new Error(
            "Fixed singular create did not persist its junction row"
          );
        }
      }
    );
  }
  if (name === "fixed-junction-update") {
    const makeOperation = (targetClient = client) => {
      const current = nextSequence(targetClient);
      return targetClient.clip.update({
        where: { id: "clip_0" },
        data: {
          shelves: { set: [{ id: `shelf_${1000 + (current % 1000)}` }] },
        },
      });
    };
    return createComposedMutationHarness(
      fixture,
      fullFixture,
      makeOperation,
      (row) => row.id.charCodeAt(0),
      (targetClient) =>
        targetClient.clip.findUnique({
          where: { id: "clip_0" },
          select: { id: true, title: true, shelves: { select: { id: true } } },
        }),
      (state) => {
        if (
          state?.shelves?.length !== 1 ||
          state.shelves[0]?.id !== "shelf_1000"
        ) {
          throw new Error(
            "Fixed collection update did not replace its junction rows"
          );
        }
      }
    );
  }
  if (name === "nested-transaction-0-reference") {
    if (driver.supportsTransactions || !driver.supportsBatch) {
      throw new Error("Nested reference workload requires batch-only SQLite");
    }
    const makeOperation = (targetClient = client) => {
      const current = nextSequence(targetClient);
      return targetClient.user.create({
        data: {
          id: `zero_ref_user_${current}`,
          name: "Zero reference",
          email: `zero_ref_${current}@example.com`,
          age: 30,
          posts: {
            create: {
              id: `zero_ref_post_${current}`,
              title: "Zero reference child",
              published: false,
              views: current,
            },
          },
        },
      });
    };
    return createComposedMutationHarness(
      fixture,
      fullFixture,
      makeOperation,
      (row) => row.id.charCodeAt(0),
      (targetClient) =>
        targetClient.user.findUnique({
          where: { id: "zero_ref_user_0" },
          select: {
            id: true,
            posts: { select: { id: true, title: true, views: true } },
          },
        }),
      (state) => {
        if (state?.posts?.[0]?.id !== "zero_ref_post_0") {
          throw new Error("Zero-reference batch did not persist its child row");
        }
      }
    );
  }
  if (name === "nested-transaction-1-reference") {
    if (driver.supportsTransactions || !driver.supportsBatch) {
      throw new Error("Nested reference workload requires batch-only SQLite");
    }
    const makeOperation = (targetClient = client) => {
      const current = nextSequence(targetClient);
      return targetClient.generatedParent.create({
        data: {
          label: `Generated parent ${current}`,
          children: {
            create: {
              id: `generated_child_${current}`,
              label: "Generated child",
            },
          },
        },
      });
    };
    return createComposedMutationHarness(
      fixture,
      fullFixture,
      makeOperation,
      (row) => row.id ?? 0,
      (targetClient, row) =>
        targetClient.generatedParent.findUnique({
          where: { id: row.id },
          select: {
            id: true,
            label: true,
            children: { select: { id: true, parentId: true, label: true } },
          },
        }),
      (state) => {
        if (
          state?.children?.[0]?.id !== "generated_child_0" ||
          state.children[0].parentId !== state.id
        ) {
          throw new Error(
            "Generated-reference batch did not bind its child row"
          );
        }
      }
    );
  }
  return undefined;
}

async function createMutationHarness(
  fixture,
  fullFixture,
  stage,
  makeOperation,
  parsedConsumer,
  operationCount,
  workloadShape
) {
  const prepareForRawExecution = (operation) => {
    const capability = benchmarkOperation(operation);
    const prepared = capability.prepare();
    if (prepared) return { capability, prepared };
    const statement = operation.buildStatement();
    if (!statement) {
      throw new Error(
        "Mutation workload did not build one executable statement"
      );
    }
    return { capability, prepared: fixture.driver._prepare(statement) };
  };
  const semanticOperation = makeOperation(fixture.client);
  const semanticEntry = prepareForRawExecution(semanticOperation);
  const semanticRaw = await fixture.driver._executeRaw(
    semanticEntry.prepared.sql,
    semanticEntry.prepared.params
  );
  const semanticValue = semanticEntry.capability.parseResult(semanticRaw);
  parsedConsumer(semanticValue);
  const fullSemantic = await makeOperation(fullFixture.client);
  parsedConsumer(fullSemantic);
  const digest = assertSemanticDigest(
    "mutation prepared/raw versus public full",
    semanticValue,
    fullSemantic
  );
  const preparedOperations =
    stage === "execute" || stage === "raw-parse"
      ? Array.from({ length: operationCount }, () => {
          const operation = makeOperation(fixture.client);
          return prepareForRawExecution(operation);
        })
      : [];
  let preparedIndex = 0;
  const nextPrepared = () => {
    const entry = preparedOperations[preparedIndex++];
    if (!entry) throw new Error("Mutation prepared-operation pool exhausted");
    return entry;
  };
  return {
    witness: preparedWitness(semanticEntry.prepared, workloadShape),
    semanticDigest: digest,
    prepare: () => {
      const { prepared } = prepareForRawExecution(makeOperation());
      return prepared.sql.length + (prepared.params?.length ?? 0);
    },
    execute: async () => {
      const { prepared } = nextPrepared();
      const raw = await fixture.driver._executeRaw(
        prepared.sql,
        prepared.params
      );
      return consumeScalarRows(raw.rows, Object.keys(raw.rows[0] ?? {})[0]);
    },
    "raw-parse": async () => {
      const { capability, prepared } = nextPrepared();
      const raw = await fixture.driver._executeRaw(
        prepared.sql,
        prepared.params
      );
      return parsedConsumer(capability.parseResult(raw));
    },
    full: async () => parsedConsumer(await makeOperation()),
  };
}

async function createComposedMutationHarness(
  fixture,
  fullFixture,
  makeOperation,
  parsedConsumer,
  readPostState,
  validatePostState
) {
  const semanticValue = await makeOperation(fixture.client);
  parsedConsumer(semanticValue);
  const semanticPostState = await readPostState(fixture.client, semanticValue);
  validatePostState(semanticPostState);
  const fullValue = await makeOperation(fullFixture.client);
  parsedConsumer(fullValue);
  const fullPostState = await readPostState(fullFixture.client, fullValue);
  validatePostState(fullPostState);
  return {
    witness: {
      statementCount: null,
      statements: [],
      unavailable:
        "The public single-statement preparation seam declines this composed operation.",
    },
    semanticDigest: assertSemanticDigest(
      "composed mutation result and post-state across fresh fixtures",
      { result: semanticValue, postState: semanticPostState },
      { result: fullValue, postState: fullPostState }
    ),
    full: async () => parsedConsumer(await makeOperation()),
  };
}
