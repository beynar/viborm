import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { resolvePolymorphicMutationIntent } from "@query-engine/builders/polymorphic-mutation";
import { variantCarrier } from "@query-engine/context";
import {
  isVariantRowCarrier,
  type VariantRowCarrierSlot,
} from "@query-engine/types";
import { s } from "@schema";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { describe, expect, test } from "vitest";

const article = s.model({ id: s.string().id(), title: s.string() });
const video = s.model({ id: s.string().id(), title: s.string() });
const reaction = s.model({
  id: s.string().id(),
  subject: s
    .toOne(
      { article: () => article, video: () => video },
      { values: { article: "subject.article", video: "subject.video" } }
    )
    .optional(),
});

prepareSchema({ article, video, reaction });

const scope = scopeFor(new PostgresAdapter(), reaction);
const resolvedSubject = variantCarrier(scope, "subject");
if (!(resolvedSubject && isVariantRowCarrier(resolvedSubject))) {
  throw new Error("Expected a row-held polymorphic subject relation.");
}
// DECLARED, not narrowed: this module's flow narrowing does not reach the
// closures below, and `resolvePolymorphicMutationIntent` takes the row carrier
// exactly — `variantCarrier` answers the junction arm and `undefined` too.
const subject: VariantRowCarrierSlot = resolvedSubject;

function targeted(payload: unknown) {
  const intent = resolvePolymorphicMutationIntent(subject, payload);
  if (intent.kind !== "targeted") {
    throw new Error("Expected a targeted polymorphic mutation.");
  }
  return intent;
}

describe("row-held polymorphic mutation intents", () => {
  test("resolves connect and create into the selected concrete target vocabulary", () => {
    const connect = targeted({
      connect: { type: "article", where: { id: "article-1" } },
    });
    const create = targeted({
      create: {
        type: "video",
        data: { id: "video-1", title: "Launch" },
      },
    });

    expect(connect.operation).toBe("connect");
    expect(connect.payload).toEqual({ id: "article-1" });
    expect(connect.edge.member.variant).toBe("article");
    expect(create.operation).toBe("create");
    expect(create.payload).toEqual({ id: "video-1", title: "Launch" });
    expect(create.edge.member.variant).toBe("video");
  });

  test("retains both connect-or-create arms and the optional update selector", () => {
    const connectOrCreate = targeted({
      connectOrCreate: {
        type: "article",
        where: { id: "article-1" },
        create: { id: "article-1", title: "Created" },
      },
    });
    const selectedUpdate = targeted({
      update: {
        type: "article",
        where: { title: { equals: "Old" } },
        data: { title: { set: "New" } },
      },
    });
    const correlatedUpdate = targeted({
      update: {
        type: "video",
        data: { title: { set: "New" } },
      },
    });

    expect(connectOrCreate).toMatchObject({
      operation: "connectOrCreate",
      payload: {
        where: { id: "article-1" },
        create: { id: "article-1", title: "Created" },
      },
    });
    expect(selectedUpdate.payload).toEqual({
      where: { title: { equals: "Old" } },
      data: { title: { set: "New" } },
    });
    expect(correlatedUpdate.payload).toEqual({
      data: { title: { set: "New" } },
    });
  });

  test("resolves upsert, delete, and targetless disconnect without losing intent", () => {
    const upsert = targeted({
      upsert: {
        type: "video",
        create: { id: "video-1", title: "Created" },
        update: { title: { set: "Updated" } },
      },
    });
    const deletion = targeted({ delete: { type: "article" } });
    const disconnect = resolvePolymorphicMutationIntent(subject, {
      disconnect: true,
    });

    expect(upsert).toMatchObject({
      operation: "upsert",
      payload: {
        create: { id: "video-1", title: "Created" },
        update: { title: { set: "Updated" } },
      },
    });
    expect(deletion.operation).toBe("delete");
    expect(deletion.payload).toBe(true);
    expect(disconnect).toEqual({ kind: "disconnect", carrier: subject });
  });
});

describe("coverage low value", () => {
  test("fails closed on malformed post-validation intent envelopes", () => {
    expect(() => resolvePolymorphicMutationIntent(subject, 1)).toThrow(
      "produced an invalid mutation payload"
    );
    expect(() => resolvePolymorphicMutationIntent(subject, {})).toThrow(
      "produced an invalid mutation payload"
    );
    expect(() =>
      resolvePolymorphicMutationIntent(subject, { connect: true })
    ).toThrow("produced an invalid connect mutation");
    expect(() =>
      resolvePolymorphicMutationIntent(subject, {
        connect: { type: "article" },
      })
    ).toThrow("produced an invalid connect target");
    expect(() =>
      resolvePolymorphicMutationIntent(subject, {
        connect: { type: "unknown", where: { id: "unknown-1" } },
      })
    ).toThrow("Unknown polymorphic target 'unknown'");
  });
});
