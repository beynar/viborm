/**
 * What a client asks before it applies an extension: the parts the
 * definition was built with, which carry the code that applies and runs it.
 * The client brings none of that code, so a program that applies no
 * extension does not carry it.
 */
import { ClientInitializationError } from "@errors";
import type { PartSet } from "./chain";

const PARTS = Symbol("viborm.parts");

/**
 * The prototype of a definition built from parts: it inherits them, so its
 * own members are exactly the definition's.
 */
export class PartCarrier {
  readonly [PARTS]: PartSet;
  constructor(parts: PartSet) {
    this[PARTS] = parts;
  }
}

/**
 * The parts `enableExtensions()` brought for definitions written as object
 * literals, which carry none. The one slot of this kind, until definitions
 * are all built from parts.
 */
let enabled: PartSet | undefined;

export const enableParts = (parts: PartSet): void => {
  enabled = parts;
};

/** The parts `value` was built with, or those brought for object literals. */
export function extensionParts(value: unknown): PartSet {
  const parts = value instanceof PartCarrier ? value[PARTS] : enabled;
  if (parts === undefined)
    throw new ClientInitializationError(
      "An extension was applied to a client, and nothing brought the code that runs extensions: build its definition with defineExtension() or defineHooks(), or call enableExtensions() once."
    );
  return parts;
}
