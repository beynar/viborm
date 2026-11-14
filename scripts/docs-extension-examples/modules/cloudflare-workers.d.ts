/** The Workers runtime module the tracing page imports: its tracer. */
declare module "cloudflare:workers" {
  import type { TracingConfig } from "viborm/instrumentation";
  export const tracing: NonNullable<TracingConfig["tracer"]>;
}
