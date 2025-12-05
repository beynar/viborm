import { type, scope } from "arktype";

const datebase = type({
  set: "Date",
})
  .or(type.Date)
  .pipe((t) => {
    if (t instanceof Date || t === null) {
      return {
        set: t,
      };
    }
    return t;
  });
const out = datebase({ set: new Date() });
const out2 = datebase(new Date());

console.log(out);
console.log(out2);
