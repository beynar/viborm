import {
  createClient as createPGliteClient,
  PGliteDriver,
} from "@drivers/pglite";
import { s } from "@schema";
import { createClient } from "@src/index";
import { instrumentation } from "@src/instrumentation/exports";

type ExpectFalse<Value extends false> = Value;
type _rootInstrumentationIsAbsent = ExpectFalse<
  "instrumentation" extends keyof typeof import("@src/index") ? true : false
>;

const user = s.model({ id: s.string().id(), email: s.string() });
const schema = { user };

const _removedFreshCoreConfig = () =>
  createClient({
    schema,
    driver: new PGliteDriver(),
    // @ts-expect-error - instrumentation is configured only through $extends
    instrumentation: { tracing: true },
  });

const heldRemovedCoreConfig = {
  schema,
  driver: new PGliteDriver(),
  instrumentation: { logging: true },
} as const;
// @ts-expect-error - held config cannot restore the removed core key
const _removedHeldCoreConfig = createClient(heldRemovedCoreConfig);

const _removedWrapperConfig = () =>
  createPGliteClient({
    schema,
    // @ts-expect-error - wrapper entrypoints inherit the removed core key
    instrumentation: { tracing: true },
  });

const _officialInstrumentation = () =>
  instrumentation({
    diagnostics: { includeSql: true },
    logging: { error: true },
    tracing: { includeParams: true },
  });

const _officialTopLevelTypo = () =>
  instrumentation({
    tracing: true,
    // @ts-expect-error - "loging" is refused beside the real "tracing"
    loging: true,
  });

const _officialNestedTypo = () =>
  instrumentation({
    // @ts-expect-error - "includeSqll" is not a TracingConfig key
    tracing: { includeSql: true, includeSqll: true },
  });

const heldOfficialTypo = {
  logging: { query: true, queyr: true },
} as const;
// @ts-expect-error - held nested instrumentation typos are refused structurally
const _heldOfficialTypo = instrumentation(heldOfficialTypo);

const _privateOfficialSurface = instrumentation({ tracing: true });
// @ts-expect-error - the official capability is not a public extension member
_privateOfficialSurface.instrumentationCapability;
// @ts-expect-error - lifecycle facts stay behind the protected runner
_privateOfficialSurface.lifecycleFacts;
