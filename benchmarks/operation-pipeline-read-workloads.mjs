/** Read and driver-floor workload construction. */

import {
  benchmarkOperation,
  consumeFixedCollectionJunction,
  consumeFixedCollectionRelation,
  consumeFixedSingularJunction,
  consumeFixedSingularRelation,
  consumeScalarRows,
  consumeVariantCollectionRelation,
  consumeVariantSingularRelation,
  createReadHarness,
  preparedWitness,
  rawCarrierConsumer,
} from "./operation-pipeline-harness.mjs";
import {
  assertSemanticDigest,
  freezeRawResult,
} from "./operation-pipeline-semantics.mjs";

const RELATION_PROJECTION_WORKLOAD_PATTERN =
  /^relation-projection-(2|20|100)-depth-(1|2|3)$/;

function selectedWideFields(fieldCount) {
  return Object.fromEntries(
    Array.from({ length: fieldCount }, (_, index) => [
      `field${String(index + 1).padStart(3, "0")}`,
      true,
    ])
  );
}

function nestedWideProjection(fieldCount, depth) {
  const scalarFieldCount = depth === 1 ? fieldCount : fieldCount - 1;
  return {
    ...selectedWideFields(scalarFieldCount),
    ...(depth === 1
      ? {}
      : {
          children: {
            select: nestedWideProjection(fieldCount, depth - 1),
          },
        }),
  };
}

function consumeWideProjection(rows, depth) {
  let level = rows[0];
  for (let currentDepth = 1; currentDepth < depth; currentDepth += 1) {
    level = level?.children?.[0];
  }
  const value = level?.field001;
  if (typeof value !== "string") {
    throw new Error("Expected the deepest wide projection scalar");
  }
  return rows.length + value.charCodeAt(0);
}

export async function buildReadWorkload(name, fixture, fullFixture) {
  const { client, driver } = fixture;
  if (name === "driver-raw") {
    const operation = client.user.findUnique({ where: { id: "user_42" } });
    const capability = benchmarkOperation(operation);
    const prepared = capability.prepare();
    if (!prepared) throw new Error("findUnique raw floor did not prepare");
    const { sql, params } = prepared;
    const semanticFixture = freezeRawResult(
      await driver._executeRaw(sql, params)
    );
    const canonicalValue = capability.parseResult(semanticFixture);
    const fullValue = await fullFixture.client.user.findUnique({
      where: { id: "user_42" },
    });
    await driver._executeRaw(sql, params);
    const providerClient = driver.client;
    if (!providerClient)
      throw new Error("Driver provider client was not initialized");
    return {
      witness: preparedWitness(prepared),
      semanticDigest: assertSemanticDigest(
        "driver raw floor versus public findUnique",
        canonicalValue,
        fullValue
      ),
      "provider-execute": async () => {
        const raw = await driver.executeRaw(providerClient, sql, params);
        return consumeScalarRows(raw.rows, "age");
      },
      "driver-wrapper": async () => {
        const raw = await driver._executeRaw(sql, params);
        return consumeScalarRows(raw.rows, "age");
      },
    };
  }

  if (name === "scalar-find-unique") {
    return createReadHarness(
      fixture,
      fullFixture,
      (targetClient = client) =>
        targetClient.user.findUnique({ where: { id: "user_42" } }),
      (value) => consumeScalarRows(value ? [value] : [], "age"),
      (rows) => consumeScalarRows(rows, "age")
    );
  }
  if (name === "scalar-find-many-20" || name === "scalar-cursor-take") {
    const makeOperation = (targetClient = client) =>
      targetClient.post.findMany({
        where: { published: true },
        select: { id: true, title: true, views: true },
        orderBy: { views: "desc" },
        ...(name === "scalar-cursor-take" ? { cursor: { id: "post_20" } } : {}),
        take: 20,
      });
    return createReadHarness(
      fixture,
      fullFixture,
      makeOperation,
      (rows) => consumeScalarRows(rows, "views"),
      (rows) => consumeScalarRows(rows, "views")
    );
  }
  if (name === "scalar-find-many-1" || name === "scalar-find-many-1000") {
    const take = name === "scalar-find-many-1" ? 1 : 1000;
    return createReadHarness(
      fixture,
      fullFixture,
      (targetClient = client) => targetClient.post.findMany({ take }),
      (rows) => consumeScalarRows(rows, "views"),
      (rows) => consumeScalarRows(rows, "views")
    );
  }
  if (name.startsWith("wide-scalar-select-")) {
    const fieldCount = Number(name.slice("wide-scalar-select-".length));
    return createReadHarness(
      fixture,
      fullFixture,
      (targetClient = client) =>
        targetClient.levelOne.findMany({
          select: selectedWideFields(fieldCount),
          take: 1,
        }),
      (rows) => consumeScalarRows(rows, "field001"),
      (rows) => consumeScalarRows(rows, "field001"),
      { selectedScalarFields: fieldCount }
    );
  }
  if (name === "wide-scalar-predicates-10") {
    const where = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [
        `field${String(index + 1).padStart(3, "0")}`,
        `value_${String(index + 1).padStart(3, "0")}`,
      ])
    );
    return createReadHarness(
      fixture,
      fullFixture,
      (targetClient = client) =>
        targetClient.levelOne.findMany({
          where,
          select: { id: true },
          take: 1,
        }),
      (rows) => consumeScalarRows(rows, "id"),
      (rows) => consumeScalarRows(rows, "id"),
      { scalarPredicates: Object.keys(where).length }
    );
  }
  if (name.startsWith("relation-projection-")) {
    const match = RELATION_PROJECTION_WORKLOAD_PATTERN.exec(name);
    if (!match) {
      throw new Error(`Malformed relation projection workload ${name}`);
    }
    const fieldCount = Number(match[1]);
    const depth = Number(match[2]);
    return createReadHarness(
      fixture,
      fullFixture,
      (targetClient = client) =>
        targetClient.levelRoot.findMany({
          select: {
            children: { select: nestedWideProjection(fieldCount, depth) },
          },
          take: 1,
        }),
      (rows) => consumeWideProjection(rows[0]?.children ?? [], depth),
      rawCarrierConsumer("value_"),
      { projectedFieldsPerRelationObject: fieldCount, relationDepth: depth }
    );
  }
  if (name.startsWith("fixed-singular-rowref-")) {
    const take = name.endsWith("1000") ? 1000 : 20;
    return createReadHarness(
      fixture,
      fullFixture,
      (targetClient = client) =>
        targetClient.post.findMany({
          select: {
            id: true,
            title: true,
            author: { select: { id: true, name: true } },
          },
          take,
        }),
      consumeFixedSingularRelation,
      rawCarrierConsumer("User ")
    );
  }
  if (name.startsWith("fixed-collection-rowref-")) {
    const take = name.endsWith("1000") ? 1000 : 20;
    return createReadHarness(
      fixture,
      fullFixture,
      (targetClient = client) =>
        targetClient.user.findMany({
          where: { id: { startsWith: "user_" } },
          select: {
            id: true,
            posts: { select: { title: true } },
          },
          take,
        }),
      consumeFixedCollectionRelation,
      rawCarrierConsumer("Post ")
    );
  }
  if (name.startsWith("variant-singular-rowref-")) {
    const take = name.endsWith("1000") ? 1000 : 20;
    return createReadHarness(
      fixture,
      fullFixture,
      (targetClient = client) =>
        targetClient.comment.findMany({
          select: {
            id: true,
            body: true,
            subject: {
              article: { select: { title: true } },
              clip: { select: { title: true } },
            },
          },
          take,
        }),
      consumeVariantSingularRelation,
      rawCarrierConsumer("Article ")
    );
  }
  if (name.startsWith("variant-collection-junction-")) {
    const take = name.endsWith("1000") ? 1000 : 20;
    return createReadHarness(
      fixture,
      fullFixture,
      (targetClient = client) =>
        targetClient.shelf.findMany({
          select: {
            id: true,
            items: {
              variants: {
                article: { select: { title: true } },
                clip: { select: { title: true } },
              },
            },
          },
          take,
        }),
      consumeVariantCollectionRelation,
      rawCarrierConsumer("Article ")
    );
  }
  if (name === "fixed-singular-junction") {
    return createReadHarness(
      fixture,
      fullFixture,
      (targetClient = client) =>
        targetClient.article.findMany({
          select: { id: true, shelf: { select: { id: true } } },
          take: 20,
        }),
      consumeFixedSingularJunction,
      rawCarrierConsumer("shelf_")
    );
  }
  if (name === "fixed-collection-junction") {
    return createReadHarness(
      fixture,
      fullFixture,
      (targetClient = client) =>
        targetClient.clip.findMany({
          select: { id: true, shelves: { select: { id: true } } },
          take: 20,
        }),
      consumeFixedCollectionJunction,
      rawCarrierConsumer("shelf_")
    );
  }
  if (name.startsWith("enum-heavy-")) {
    const take = name.endsWith("1000") ? 1000 : 20;
    return createReadHarness(
      fixture,
      fullFixture,
      (targetClient = client) => targetClient.enumRecord.findMany({ take }),
      (rows) => consumeScalarRows(rows, "status"),
      (rows) => consumeScalarRows(rows, "status")
    );
  }

  return undefined;
}
