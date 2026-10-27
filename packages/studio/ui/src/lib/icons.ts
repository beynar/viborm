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
