/**
 * Tests apply bare object literals with `$extends`, which a program may do
 * once something brought the code that runs extensions (`defineExtension()`,
 * `defineHooks()` or an official extension). This brings it for every test
 * file.
 *
 * `VIBORM_TEST_NO_HOST=1` leaves it out, to check that a client no extension
 * is applied to never asks for it. `VIBORM_TEST_NO_HOST=strict` also keeps
 * what builds a definition from bringing it, so every test that applies an
 * extension fails at once and what still runs is a client without
 * extensions: the coverage of that run is the engine such a client uses.
 */
import { withHost } from "@extensions/host";
import { vi } from "vitest";

if (process.env.VIBORM_TEST_NO_HOST === "strict")
  // Not hoisted: only this mode replaces the module.
  vi.doMock("@extensions/host", () => ({
    EXTENSION_HOST: {},
    enableExtensions: () => undefined,
    withHost: () => undefined,
  }));
else if (!process.env.VIBORM_TEST_NO_HOST) withHost();
