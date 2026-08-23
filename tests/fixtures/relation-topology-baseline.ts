/**
 * Pinned verdicts for `relation-topology-corpus.ts` (plan §10 A items 4-6).
 *
 * Captured from HEAD `d9ad74f5` by Package A, then RE-PINNED CELL BY CELL by
 * Package C against each case's `intended` field. The file was never
 * regenerated wholesale: an unchanged cell is byte-identical to A's capture, and
 * every changed cell carries the plan clause that changed it. A cell that moves
 * without a note beside it is a defect, not a re-pin.
 *
 * Inspectable data, not a digest of runtime discovery (§11.5.8): every entry
 * names the codes and the exact model/relation they were reported at.
 *
 * WHAT IS PINNED
 *   `valid`      — `ValidationResult.valid`, i.e. `errors.length === 0`.
 *   `errors`     — one `CODE @model.relation` line per reported error. A cell
 *                  whose refusal moved to the DECLARATION boundary pins the
 *                  construction refusal instead, as `V4002 @<builder> path=<p>`;
 *                  such a schema never reaches the definition gate at all.
 *   `warnings`   — the same for warnings. A severity flip between the two lists
 *                  is a verdict change even when the code survives.
 *
 * WHAT IS DELIBERATELY NOT PINNED
 *   Issue ORDER. The lists are sorted, because ruling D7 permits the diagnostic
 *   order to change (§6.1 fixes it to hydrated schema/model-field order) while
 *   forbidding a verdict change. Pinning the emission order here would go red
 *   for a permitted change and hide the forbidden one.
 *
 *   Message TEXT. §7.2 makes codes and one-diagnostic-per-invariant the
 *   contract and explicitly rewrites diagnostics; the corpus must not turn red
 *   for a reworded sentence.
 */

export interface TopologyVerdict {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export const relationTopologyBaseline: Readonly<
  Record<string, TopologyVerdict>
> = {
  "one-one-single-owner": { valid: true, errors: [], warnings: [] },
  // C re-pin (§9.4 fourth becomes-valid bullet): paired to-one slots derive the
  // physical unique constraint, so FK008's demand for a separately declared
  // unique key is gone and FK008 has no successor.
  "one-one-derived-unique-missing": { valid: true, errors: [], warnings: [] },
  // C re-pin (§6.3 refused shapes / §9.4 ownerless bullet): an edge that stores
  // nothing is a definition error. FK004 keeps its HEAD invariant ("this edge
  // has no foreign-key owner") and is promoted to error (D6); it is reported at
  // the canonically first endpoint of the pair.
  "one-one-zero-owners": {
    valid: false,
    errors: ["FK004 @user.profile"],
    warnings: [],
  },
  // C re-pin (§6.3 refused shapes / §9.4 two-FK-owners bullet): CM003 keeps its
  // HEAD invariant and is promoted to error (D6). It moves from the
  // alphabetically-first MODEL to the canonically first ENDPOINT of the pair.
  "one-one-two-owners": {
    valid: false,
    errors: ["CM003 @user.profile"],
    warnings: [],
  },
  "one-many-required-fk": { valid: true, errors: [], warnings: [] },
  "one-many-nullable-fk-optional": { valid: true, errors: [], warnings: [] },
  "to-one-nullable-fk-without-optional": {
    valid: true,
    errors: [],
    warnings: [],
  },
  "to-one-required-fk-with-optional": {
    valid: true,
    errors: [],
    warnings: [],
  },
  // C re-pin (§9.4 ownerless bullet): severity only — FK004 becomes an error.
  "many-one-without-fields": {
    valid: false,
    errors: ["FK004 @post.author"],
    warnings: [],
  },
  // C re-pin (§4.3/§11.1.8): `.fields()` requires a non-empty tuple, so this
  // schema is refused where it is WRITTEN and never reaches the gate.
  "zero-argument-fields": {
    valid: false,
    errors: ["V4002 @s.toOne path=fields"],
    warnings: [],
  },
  // C re-pin (§7.1 / D20): R008 and P021 both die with no successor — non-owner
  // to-one nullability is derived, so the guard has no invalid state left.
  "one-one-inverse-without-optional": { valid: true, errors: [], warnings: [] },
  "many-many-default": { valid: true, errors: [], warnings: [] },
  // C re-pin (§9.3/§9.4 both-endpoints bullet): one physical junction has one
  // configuration owner, whether the two endpoints agree or not.
  "many-many-equal-overrides-on-both-endpoints": {
    valid: false,
    errors: ["R011 @post.tags"],
    warnings: [],
  },
  // C re-pin (D6): still refused; JT004's cross-side reconciliation invariant is
  // gone with the mirroring itself, and the surviving refusal is R011.
  "many-many-conflicting-overrides": {
    valid: false,
    errors: ["R011 @post.tags"],
    warnings: [],
  },
  // C re-pin (§4.4/§9.4 setNull bullet): a junction action is
  // cascade/restrict/noAction, refused at the modifier for hostile runtime input.
  "many-many-junction-set-null": {
    valid: false,
    errors: ["V4002 @s.toMany path=onDelete"],
    warnings: [],
  },
  // C re-pin (§6.3 refused shapes / §9.4 contradicting-uniqueness bullet): new
  // code FK009 for an invariant HEAD had no rule for.
  "unique-fk-facing-remote-to-many": {
    valid: false,
    errors: ["FK009 @post.author"],
    warnings: [],
  },
  // C re-pin (D19): the verdict is unchanged; FK005's compound-key blindness is
  // fixed, so referencing the target's own compound `.id([...])` no longer warns
  // once per member. This case is that fix's named witness.
  "mixed-nullability-compound-fk": { valid: true, errors: [], warnings: [] },
  "missing-inverse-one-to-one": {
    valid: false,
    errors: ["R002 @user.profile"],
    warnings: [],
  },
  // C re-pin (D6): R003 absorbed into R002.
  "missing-inverse-one-to-many": {
    valid: false,
    errors: ["R002 @user.posts"],
    warnings: [],
  },
  // C re-pin (D6): R004 absorbed into R002.
  "missing-inverse-many-to-one": {
    valid: false,
    errors: ["R002 @post.author"],
    warnings: [],
  },
  // C re-pin (D6): R005 absorbed into R002.
  "missing-inverse-many-to-many": {
    valid: false,
    errors: ["R002 @post.tags"],
    warnings: [],
  },
  // C re-pin (§6.2 ambiguity): a definition error at the slot that cannot
  // choose, with its competing candidate paths — not a warning plus a silent
  // first-candidate answer.
  "ambiguous-unnamed-candidates": {
    valid: false,
    errors: ["R009 @user.posts"],
    warnings: [],
  },
  "named-multi-pair": { valid: true, errors: [], warnings: [] },
  // C re-pin (§6.2 rule 3): a one-sided name is `nameMismatch`, reported once at
  // the canonically first of the endpoints that disagree.
  "name-on-one-side-only": {
    valid: false,
    errors: ["R010 @user.posts"],
    warnings: [],
  },
  // C re-pin (§6.2 rule 3): two disagreeing names are `nameMismatch`.
  "names-mismatched-on-both-sides": {
    valid: false,
    errors: ["R010 @user.posts"],
    warnings: [],
  },
  // C re-pin (§6.2 rule 6): neither candidate wins by being ordinary.
  "ambiguous-ordinary-versus-variant": {
    valid: false,
    errors: ["R009 @post.comments"],
    warnings: [],
  },
  "self-parent-children": { valid: true, errors: [], warnings: [] },
  // C re-pin (§6.4/§9.4 lone-self bullet): the asking slot is excluded from its
  // own candidate set, so a lone self slot has no inverse at all.
  "self-many-to-many-lone": {
    valid: false,
    errors: ["R002 @node.links"],
    warnings: [],
  },
  // C re-pin (§6.4/§9.4 second becomes-valid bullet): the default side token is
  // the endpoint FIELD key plus `Id` for a scalar row key, so a paired self
  // junction needs no explicit tokens. JT004 dies with the mirroring rule.
  "self-many-to-many-paired-default-tokens": {
    valid: true,
    errors: [],
    warnings: [],
  },
  // C re-pin (§9.3/§9.4 both-endpoints bullet): the self instance of the
  // one-configuration-owner rule. HEAD REQUIRED this mirrored spelling; the
  // final API refuses it and conversion consolidates it onto one endpoint.
  "self-many-to-many-paired-explicit-tokens": {
    valid: false,
    errors: ["R011 @node.following"],
    warnings: [],
  },
  "two-named-self-pairs": { valid: true, errors: [], warnings: [] },
  "extends-shared-relation": { valid: true, errors: [], warnings: [] },
  "variant-row-direct-only": { valid: true, errors: [], warnings: [] },
  "variant-row-to-one-inverse": { valid: true, errors: [], warnings: [] },
  "variant-row-to-many-inverse": { valid: true, errors: [], warnings: [] },
  "variant-row-mixed-inverses": {
    valid: false,
    errors: ["P012 @comment.subject"],
    warnings: [],
  },
  "variant-row-optional": { valid: true, errors: [], warnings: [] },
  "variant-repeated-target-direct-only": {
    valid: true,
    errors: [],
    warnings: [],
  },
  // C re-pin (D20): still refused, now with EXACTLY ONE diagnostic. P010 and
  // R003 were two spellings of one fact; the surviving owner is the resolver's
  // ambiguity code, because "an inverse that cannot choose a member" is the same
  // invariant as every other ambiguous partner.
  "variant-repeated-target-with-inverse": {
    valid: false,
    errors: ["R009 @doc.audits"],
    warnings: [],
  },
  "variant-row-incompatible-identity": {
    valid: false,
    errors: ["P002 @comment.subject"],
    warnings: [],
  },
  "variant-member-direct-only": { valid: true, errors: [], warnings: [] },
  "variant-member-to-one-inverse": { valid: true, errors: [], warnings: [] },
  "variant-member-to-many-inverse": { valid: true, errors: [], warnings: [] },
  "variant-member-mixed-inverses": { valid: true, errors: [], warnings: [] },
  // C re-pin (D6): still refused, now as one ambiguity diagnostic at the member
  // that two inverses compete for — P015 and the R007 warning both die.
  "variant-member-two-inverses": {
    valid: false,
    errors: ["R009 @shelf.items"],
    warnings: [],
  },
  // C re-pin (D6): still refused, now as the one misplaced-modifier diagnostic.
  "variant-member-inverse-configures-junction": {
    valid: false,
    errors: ["R012 @book.shelves"],
    warnings: [],
  },
  // C re-pin (§7.1 / D20): valid. HEAD spelled ONE invariant twice (P021, R008)
  // and both die with no successor.
  "variant-member-singular-inverse-required": {
    valid: true,
    errors: [],
    warnings: [],
  },
  // C re-pin (§4.2/§9.4 first becomes-valid bullet): a one-key map is valid and
  // has no warning.
  "variant-single-key-map": { valid: true, errors: [], warnings: [] },
  // C re-pin (D6): still refused, now as the one misplaced-modifier diagnostic —
  // a slot that owns a foreign key cannot also be a view over carrier storage.
  "variant-inverse-with-completed-fk": {
    valid: false,
    errors: ["R012 @book.shelf"],
    warnings: [],
  },
  // C re-pin (§6.2 rule 6): still refused, now as ambiguity — the ordinary
  // junction slot and the variant member are both compatible candidates and
  // nothing prefers one.
  "variant-member-inverse-with-ordinary-partner": {
    valid: false,
    errors: ["R009 @book.shelves"],
    warnings: [],
  },
};
