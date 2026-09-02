import { defineMeta } from "blume";

export default defineMeta({
  title: "Client",
  icon: "terminal",
  order: 2,
  pages: [
    "index",
    "create",
    "read",
    "update",
    "delete",
    "nested-writes",
    "filtering",
    "selecting",
    "omit",
    "sorting",
    "pagination",
    "transactions",
    "raw-sql",
    "errors",
    "compatibility",
  ],
});
