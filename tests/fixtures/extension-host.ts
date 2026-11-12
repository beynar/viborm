/**
 * Tests apply bare object literals with `$extends`, which a program may do
 * once something brought the code that runs extensions (`defineExtension()`,
 * `defineHooks()` or an official extension). This brings it for every test
 * file. `VIBORM_TEST_NO_HOST=1` leaves it out, to check that a client no
 * extension is applied to never asks for it.
 */
import { withHost } from "@extensions/host";

if (!process.env.VIBORM_TEST_NO_HOST) withHost();
