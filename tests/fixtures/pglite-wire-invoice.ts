import { s } from "@schema";

/** The invoice model the postgres.js suites drive through the PGlite wire bridge. */
export const wireInvoice = s
  .model({
    id: s.int().id().increment(),
    customer: s.string(),
    amountCents: s.int(),
    status: s.string().default("open"),
    paid: s.boolean().default(false),
    createdAt: s.dateTime().now(),
    updatedAt: s.dateTime().updatedAt(),
  })
  .map("pgjs_wire_invoice");
