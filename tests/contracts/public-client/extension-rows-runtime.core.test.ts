import { ClientInitializationError } from "@errors";
import { builtPart, extension } from "@extensions/extension";
import { filtersPart } from "@extensions/rows";
import { verbsPart } from "@extensions/rows-part";
import { s } from "@schema";
import { appendResolvedExtension } from "@tests/fixtures/host-definition";
import { expect, test } from "vitest";

const schema = { post: s.model({ id: s.string().id() }) };
const rows = {
  control: "visibility",
  default: "visible",
  models: { post: { visible: { root: { id: "one" } } } },
};
const judged = [
  { verbs: { post: { predicates: {} } } },
  { confine: { post: { id: "one" } } },
].map((member) => ({ ...rows, ...member }));

/** An extension whose one part hands `members` to the host parts `host`. */
const builtWith = (
  host: Parameters<typeof builtPart>[0],
  members: Readonly<Record<string, unknown>>
) =>
  extension(
    "filter",
    builtPart(host, (draft) => {
      Object.assign(draft, members);
    })
  );

const applied = (definition: unknown) =>
  appendResolvedExtension(undefined, definition, schema);

test("what is built with the filters part admits its rows where it is applied", () => {
  const chain = applied(builtWith([filtersPart], { rows }));
  expect(chain.rows?.[0]?.models.post?.visible?.root).toEqual({
    id: { equals: "one" },
  });
  expect(
    chain.callRows?.call("post", undefined).domain.root.get("post")
  ).toEqual([{ id: { equals: "one" } }]);
});

test("verbs and confinements built without what reads them are refused, not read as filters alone", () => {
  for (const given of judged) {
    const alone = () => applied(builtWith([filtersPart], { rows: given }));
    expect(alone).toThrow(ClientInitializationError);
    expect(alone).toThrow("must be built with defineExtension()");
    expect(
      applied(builtWith([filtersPart, verbsPart], { rows: given })).rows
    ).toHaveLength(1);
  }
});
