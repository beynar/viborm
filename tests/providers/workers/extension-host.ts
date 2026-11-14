/**
 * The Workers lane's twin of `tests/fixtures/extension-host.ts`: these tests
 * apply bare object literals with `$extends`, some declaring `rows`, which a
 * program may do once something brought the code that runs extensions.
 */
import { enableExtensions } from "@extensions/define";

enableExtensions();
