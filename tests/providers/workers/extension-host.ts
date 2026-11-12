/**
 * The Workers lane's twin of `tests/fixtures/extension-host.ts`: these tests
 * apply bare object literals with `$extends`, some declaring `rows`, which a
 * program may do once something brought the code that runs extensions and
 * reads those declarations.
 */
import { withHost } from "@extensions/host";
import { withRows } from "@extensions/rows-runtime";

withHost();
withRows();
