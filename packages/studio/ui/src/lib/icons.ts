// Each column type's icon, before its name, in the diagram and the rows' headers.

import { bracketsCurlyIcon } from "entasis/icons/bracketsCurly";
import { calculatorIcon } from "entasis/icons/calculator";
import { calendarBlankIcon } from "entasis/icons/calendarBlank";
import { clockIcon } from "entasis/icons/clock";
import { fileCodeIcon } from "entasis/icons/fileCode";
import { hashIcon } from "entasis/icons/hash";
import { listBulletsIcon } from "entasis/icons/listBullets";
import { mapPinIcon } from "entasis/icons/mapPin";
import { textTIcon } from "entasis/icons/textT";
import { toggleLeftIcon } from "entasis/icons/toggleLeft";
import type { StudioField } from "./api";

export const TYPE_ICONS: Record<StudioField["type"], typeof textTIcon> = {
  string: textTIcon,
  int: hashIcon,
  bigint: hashIcon,
  number: calculatorIcon,
  decimal: calculatorIcon,
  boolean: toggleLeftIcon,
  datetime: clockIcon,
  date: calendarBlankIcon,
  time: clockIcon,
  enum: listBulletsIcon,
  json: bracketsCurlyIcon,
  blob: fileCodeIcon,
  point: mapPinIcon,
  vector: listBulletsIcon,
};

// Type families keep the same accent wherever their icon appears.
export const TYPE_COLORS: Record<StudioField["type"], string> = {
  string: "text-emerald-700 dark:text-emerald-400",
  int: "text-sky-700 dark:text-sky-400",
  bigint: "text-sky-700 dark:text-sky-400",
  number: "text-sky-700 dark:text-sky-400",
  decimal: "text-sky-700 dark:text-sky-400",
  boolean: "text-violet-700 dark:text-violet-400",
  datetime: "text-amber-700 dark:text-amber-400",
  date: "text-amber-700 dark:text-amber-400",
  time: "text-amber-700 dark:text-amber-400",
  enum: "text-rose-700 dark:text-rose-400",
  json: "text-orange-700 dark:text-orange-400",
  blob: "text-slate-600 dark:text-slate-400",
  point: "text-teal-700 dark:text-teal-400",
  vector: "text-fuchsia-700 dark:text-fuchsia-400",
};
