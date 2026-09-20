import { readFileSync, writeFileSync } from "node:fs";
const [file, from, to] = process.argv.slice(2);
const s = readFileSync(file, "utf8");
const n = s.split(from).length - 1;
if (n !== 1) { console.error(`falsifier match count ${n}`); process.exit(1); }
writeFileSync(file, s.replace(from, to));
console.log("mutated");
