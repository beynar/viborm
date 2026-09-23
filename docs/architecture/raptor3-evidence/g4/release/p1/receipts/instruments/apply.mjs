import { readFileSync, writeFileSync } from "node:fs";
const [file, oldFile, newFile] = process.argv.slice(2);
const src = readFileSync(file, "utf8");
const oldText = readFileSync(oldFile, "utf8");
const newText = readFileSync(newFile, "utf8");
const n = src.split(oldText).length - 1;
if (n !== 1) { console.error(`match count ${n}, expected 1`); process.exit(1); }
writeFileSync(file, src.replace(oldText, newText));
console.log("applied");
