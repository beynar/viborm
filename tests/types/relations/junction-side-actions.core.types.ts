/**
 * Issue #46 — the public junction action surface, probed at the call sites a
 * user writes: fresh literals and maps held in variables, every refused key
 * BESIDE the two real ones (a typo alone proves nothing, root AGENTS.md), and
 * mutually recursive models whose inference must not collapse to `any`.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@src/schema";
import type { JunctionDocument } from "@src/schema/json";
import type { JunctionSideActions } from "@src/schema/relation";

type Expect<Value extends true> = Value;
type IsAny<Value> = 0 extends 1 & Value ? true : false;

const topic = s.model({ id: s.string().id() });
const junction = () => s.toMany(() => topic);

// ---------------------------------------------------------------------------
// Accepted: the shorthand, a fresh map, a map held in a variable
// ---------------------------------------------------------------------------

junction().onDelete("cascade").onUpdate("noAction");
junction()
  .onDelete({ source: "cascade", target: "noAction" })
  .onUpdate({ source: "cascade", target: "restrict" });

const annotated: JunctionSideActions = {
  source: "cascade",
  target: "restrict",
};
junction().onDelete(annotated);

const constant = { source: "restrict", target: "cascade" } as const;
junction().onUpdate(constant);

// ---------------------------------------------------------------------------
// Refused: a key beside both sides, fresh and non-fresh
// ---------------------------------------------------------------------------

junction().onDelete({
  source: "cascade",
  target: "noAction",
  // @ts-expect-error - the side map is exact; `extra` sits beside two real keys
  extra: "cascade",
});

const withExtra = {
  source: "cascade",
  target: "noAction",
  extra: "cascade",
} as const;
// @ts-expect-error - held in a variable, the extra key is still refused structurally
junction().onUpdate(withExtra);

// A union whose clean member would satisfy the check alone: the extra key of
// its other member is still refused.
declare const eitherMap:
  | JunctionSideActions
  | { source: "cascade"; target: "cascade"; extra: 1 };
// @ts-expect-error - one clean member does not vouch for the member with `extra`
junction().onDelete(eitherMap);

// Unions without an extra key stay accepted: a map or the shorthand.
declare const mapOrShorthand: JunctionSideActions | "cascade";
junction().onUpdate(mapOrShorthand);

// ---------------------------------------------------------------------------
// Refused: a missing side, `setNull` on either side, a stranger action
// ---------------------------------------------------------------------------

// @ts-expect-error - a side map states both sides
junction().onDelete({ source: "cascade" });

const oneSided = { target: "cascade" } as const;
// @ts-expect-error - a side map states both sides, in a variable too
junction().onUpdate(oneSided);

// @ts-expect-error - `setNull` would null a membership-key member (source side)
junction().onDelete({ source: "setNull", target: "cascade" });

// @ts-expect-error - `setNull` would null a membership-key member (target side)
junction().onUpdate({ source: "cascade", target: "setNull" });

// @ts-expect-error - the shorthand keeps refusing `setNull`
junction().onDelete("setNull");

// @ts-expect-error - an action outside the junction vocabulary
junction().onDelete({ source: "cascade", target: "SET NULL" });

// ---------------------------------------------------------------------------
// The map belongs to the junction owner alone
// ---------------------------------------------------------------------------

s.toOne(() => topic)
  .fields("topicId")
  .references("id")
  // @ts-expect-error - a row-reference owner has one key and one action
  .onDelete({ source: "cascade", target: "cascade" });

// @ts-expect-error - a variant collection carries no junction action
s.toMany({ topic: () => topic }).onDelete({
  source: "cascade",
  target: "cascade",
});

// ---------------------------------------------------------------------------
// Schema JSON: each action has one spelling, beside every other junction key
// ---------------------------------------------------------------------------

const _eachActionOnce: JunctionDocument = {
  table: "post_labels",
  onDelete: "cascade",
  onUpdateSides: { source: "cascade", target: "restrict" },
};

const _deleteSpelledTwice: JunctionDocument = {
  table: "post_labels",
  onDelete: "cascade",
  // @ts-expect-error - `onDelete` and `onDeleteSides` are exclusive
  onDeleteSides: { source: "cascade", target: "noAction" },
};

const _updateSpelledTwice: JunctionDocument = {
  onDelete: "cascade",
  onUpdate: "cascade",
  // @ts-expect-error - `onUpdate` and `onUpdateSides` are exclusive
  onUpdateSides: { source: "cascade", target: "noAction" },
};

// ---------------------------------------------------------------------------
// Recursive getters keep their inference
// ---------------------------------------------------------------------------

const label = s.model({
  id: s.string().id(),
  name: s.string(),
  posts: s.toMany(() => post),
});
const post = s.model({
  id: s.string().id(),
  title: s.string(),
  labels: s
    .toMany(() => label)
    .onDelete({ source: "cascade", target: "noAction" })
    .onUpdate({ source: "cascade", target: "restrict" }),
});

type _labelIsNotAny = Expect<IsAny<typeof label> extends false ? true : false>;
type _postIsNotAny = Expect<IsAny<typeof post> extends false ? true : false>;

const client = createClient({
  schema: { label, post },
  driver: new PGliteDriver(),
});

const _readsThroughTheJunction = async () => {
  const found = await client.post.findFirstOrThrow({
    include: { labels: true },
  });
  const name: string | undefined = found.labels[0]?.name;
  // @ts-expect-error - the included label is typed, not `any`
  const wrong: number | undefined = found.labels[0]?.name;
  return [name, wrong];
};
