/**
 * Names kept only because the package entries still export them, until the
 * entries are rewritten for the new contract. Nothing reads them: a unit's
 * facts are read on demand by the words of `unit-facts/`, and `observes`,
 * which a definition may still spell, is refused when it is applied (no part
 * reads it). Types only: this module emits no runtime code.
 */

/** Formerly what core asked the official observer; nothing asks now. */
export type ObservationNeed = never;

/** Formerly the declaration of the one observer handed facts. */
export interface OfficialObservationCapability {
  wants(need: ObservationNeed): boolean;
}

/** Formerly the facts handed to that observer; a unit's are read by words. */
export type OfficialLifecycleFacts = never;
