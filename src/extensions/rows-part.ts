/**
 * The parts that read rows, by what they read: filters (`rows.ts`), kept
 * rows (`kept.ts`), default data (`stamps.ts`) and default order
 * (`order.ts`), each bringing only its own code; and what reads a `rows`
 * member's `verbs` and `confine`, apart from the filters.
 */
import { admitRows } from "./admission";
import type { ExtensionPart } from "./chain";
import { keptRowsPart } from "./kept";
import { defaultOrderPart } from "./order";
import { filtersPart } from "./rows";
import { defaultDataPart } from "./stamps";
import { VERBS } from "./verbs";

/** The four together: `rows`, `deletion`, `data` and `order`. */
export const rowsPart: ExtensionPart = {
  uses: [filtersPart, keptRowsPart, defaultDataPart, defaultOrderPart],
};

/**
 * What reads a `rows` member's `verbs` and `confine`: what judges the rows a
 * write produces and what a read carries beside them or hides. It admits a
 * member that declares either; an extension whose rows only filter does not
 * carry it.
 */
export const verbsPart: ExtensionPart = {
  uses: [filtersPart],
  admit(application) {
    const { definition, schema, registry } = application;
    const { rows } = definition;
    if (rows?.verbs === undefined && rows?.confine === undefined) return;
    application.definition = Object.freeze({
      ...definition,
      rows: admitRows(rows, schema, definition.name, registry, VERBS),
    });
  },
};
