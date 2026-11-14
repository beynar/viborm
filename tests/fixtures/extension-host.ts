/**
 * Tests apply bare object literals with `$extends`, which a program may do
 * once it called `enableExtensions()`: a literal carries no parts. This
 * brings them for every test file.
 *
 * `VIBORM_TEST_NO_HOST=1` leaves it out, to check that a client no extension
 * is applied to never asks for it. `VIBORM_TEST_NO_HOST=strict` also keeps
 * a built definition from finding its parts, so every test that applies an
 * extension fails at once and what still runs is a client without
 * extensions: the coverage of that run is the engine such a client uses.
 */

import { ClientInitializationError } from "@errors";
import { enableExtensions } from "@extensions/define";
import { vi } from "vitest";

if (process.env.VIBORM_TEST_NO_HOST === "strict")
  // Not hoisted: only this mode replaces the module. No definition, built
  // or not, finds the parts that apply it.
  vi.doMock("@extensions/host-slot", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    extensionParts: () => {
      throw new ClientInitializationError(
        "VIBORM_TEST_NO_HOST=strict: no extension is applied."
      );
    },
  }));
else if (!process.env.VIBORM_TEST_NO_HOST) enableExtensions();
