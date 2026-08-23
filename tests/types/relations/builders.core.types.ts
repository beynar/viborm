/**
 * Ordinary junction configuration: the fluent overrides a model-target
 * collection may state, what they do NOT put into the public type, and the two
 * refusals that are new at this surface.
 *
 * Plan §4.4 (ordinary junction configuration), falsifier §11.1.10.
 */

import { s } from "@src/schema";

type Expect<Value extends true> = Value;
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;

type StateOf<Relation> = Relation extends {
  readonly "~": { readonly state: infer State };
}
  ? State
  : never;

const target = s.model({ id: s.string().id() });

const base = s.toMany(() => target);
const configured = base
  .through("source_targets")
  .source("sourceId")
  .target("targetId")
  .onDelete("cascade")
  .onUpdate("restrict");

/**
 * Any subset may override its canonical default, and every override returns a
 * new value carrying the same declaration facts: which endpoint physically owns
 * the junction is a full-schema topology rule, so an override is never a public
 * type parameter and never a second declaration owner.
 */
type _overridesDoNotEnterThePublicType = Expect<
  Equal<StateOf<typeof configured>, StateOf<typeof base>>
>;

const named = configured.name("targets");
type _theLabelSurvivesTheOverrides = Expect<
  Equal<StateOf<typeof named>["name"], "targets">
>;

/** The same chain in the other order composes identically. */
const namedFirst = base.name("targets").through("source_targets");
type _theLabelSurvivesInEitherOrder = Expect<
  Equal<StateOf<typeof namedFirst>["name"], "targets">
>;

// @ts-expect-error - `setNull` cannot null a junction membership-key member
base.onDelete("setNull");

// @ts-expect-error - `setNull` cannot null a junction membership-key member
base.onUpdate("setNull");

// @ts-expect-error - referential actions are a closed public union
configured.onDelete("remove");

/**
 * §11.1.10 — a relation name is a PAIRING LABEL, not a SQL identifier. With an
 * explicit valid junction table, a label the database could never accept is
 * still a legal pair identity.
 */
const labelledPair = s
  .toMany(() => target)
  .name("Post tags/v2")
  .through("post_tags");

type _pairingLabelsAreNotIdentifiers = Expect<
  Equal<StateOf<typeof labelledPair>["name"], "Post tags/v2">
>;
