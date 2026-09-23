/**
 * The engine's ONE owner of internal invariants (N4, plan §4, D-52).
 *
 * A refusal is a sentence a caller can reach with an admitted payload; an
 * invariant is a state the code cannot be in when it is right, established
 * upstream by a type or by an earlier owner. The two are told apart by CLASS,
 * never by message text: a public refusal is a `VibORMError`, an invariant
 * failure is this internal class, so the refusal census counts one and not
 * the other by construction. Where a type can say the invariant (an
 * exhaustive `switch` over a closed union), {@link unreachable} makes the
 * compiler prove it; where it cannot, {@link assertInvariant} states it in
 * one place with the fact it rests on.
 */
export class EngineInvariantError extends Error {
  override readonly name = "EngineInvariantError";
}

/** The narrow assertion of a fact an earlier owner established. */
export function assertInvariant(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new EngineInvariantError(message);
}

/** A `switch` arm the type system already closed: the value has no members. */
export function unreachable(value: never, message: string): never {
  throw new EngineInvariantError(`${message}: ${String(value)}`);
}
