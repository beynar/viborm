import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";

const user = s.model({ id: s.string().id(), email: s.string() });
const schema = { user };

const _keyed = () =>
  createClient({
    schema,
    driver: new PGliteDriver(),
    instrumentation: {
      diagnostics: { includeSql: true },
      logging: { query: true },
      tracing: { includeSql: true },
    },
  });

const _typoAlone = () =>
  createClient({
    schema,
    driver: new PGliteDriver(),
    // @ts-expect-error - "enabld" is not an instrumentation key
    instrumentation: { enabld: true },
  });

const _typoBesideReal = () =>
  createClient({
    schema,
    driver: new PGliteDriver(),
    instrumentation: {
      tracing: true,
      // @ts-expect-error - "loging" is refused beside the real "tracing"
      loging: true,
    },
  });

const _tracingTypo = () =>
  createClient({
    schema,
    driver: new PGliteDriver(),
    instrumentation: {
      // @ts-expect-error - "includeSqll" is not a TracingConfig key
      tracing: { includeSql: true, includeSqll: true },
    },
  });

const _loggingTypo = () =>
  createClient({
    schema,
    driver: new PGliteDriver(),
    instrumentation: {
      // @ts-expect-error - "queyr" is not a LoggingConfig key
      logging: { query: true, queyr: true },
    },
  });

const _diagnosticsTypo = () =>
  createClient({
    schema,
    driver: new PGliteDriver(),
    instrumentation: {
      // @ts-expect-error - "includeSqll" is not a DiagnosticDisclosure key
      diagnostics: { includeSql: true, includeSqll: true },
    },
  });

const _structuralContext = () =>
  createClient({
    schema,
    driver: new PGliteDriver(),
    instrumentation: {
      // @ts-expect-error - resolved contexts are internal, not public config
      config: {},
      tracer: {
        async startActiveSpan(_options: never, run: () => unknown) {
          return run();
        },
        startActiveSpanSync(_options: never, run: () => unknown) {
          return run();
        },
        isEnabled: () => true,
      },
    },
  });

void _keyed;
void _typoAlone;
void _typoBesideReal;
void _tracingTypo;
void _loggingTypo;
void _diagnosticsTypo;
void _structuralContext;
