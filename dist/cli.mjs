#!/usr/bin/env node
import"./sql-CFtZ-oR0.mjs";import{a as e}from"./push-CGBkIIGQ.mjs";import{Command as t}from"commander";import*as n from"@clack/prompts";import{existsSync as r}from"node:fs";import{resolve as i}from"node:path";import{pathToFileURL as a}from"node:url";const o=async e=>{let t=new Map;for(let r of e){if(r.type===`ambiguousColumn`){let e=await n.select({message:`Column "${r.droppedColumn.name}" was removed and "${r.addedColumn.name}" was added in table "${r.tableName}". Is this a rename?`,options:[{value:`rename`,label:`Rename: ${r.droppedColumn.name} → ${r.addedColumn.name}`,hint:`Data will be preserved`},{value:`addAndDrop`,label:`Add + Drop: Create new column, delete old one`,hint:`Data in old column will be LOST`}]});n.isCancel(e)&&(n.cancel(`Operation cancelled.`),process.exit(0)),t.set(r,{type:e})}if(r.type===`ambiguousTable`){let e=await n.select({message:`Table "${r.droppedTable}" was removed and "${r.addedTable}" was added. Is this a rename?`,options:[{value:`rename`,label:`Rename: ${r.droppedTable} → ${r.addedTable}`,hint:`Data will be preserved`},{value:`addAndDrop`,label:`Add + Drop: Create new table, delete old one`,hint:`ALL DATA in old table will be LOST`}]});n.isCancel(e)&&(n.cancel(`Operation cancelled.`),process.exit(0)),t.set(r,{type:e})}}return t};async function s(e){n.note(e.join(`
`),`Destructive changes detected`);let t=await n.confirm({message:`Do you want to proceed with these destructive changes?`,initialValue:!1});return n.isCancel(t)&&(n.cancel(`Operation cancelled.`),process.exit(0)),t}function c(e){if(e.length===0){n.note(`No changes detected. Your database is up to date.`,`Status`);return}let t=[],r=new Map,i=[],a=[];for(let t of e)if(t.type===`createTable`||t.type===`dropTable`||t.type===`renameTable`)i.push(t);else if(t.type===`createEnum`||t.type===`dropEnum`||t.type===`alterEnum`)a.push(t);else{let e=l(t);if(e){let n=r.get(e)||[];n.push(t),r.set(e,n)}}if(a.length>0){t.push(`Enums:`);for(let e of a)t.push(`  ${u(e)}`);t.push(``)}if(i.length>0){t.push(`Tables:`);for(let e of i)t.push(`  ${u(e)}`);t.push(``)}for(let[e,n]of r){t.push(`Table: ${e}`);for(let e of n)t.push(`  ${u(e)}`);t.push(``)}n.note(t.join(`
`),`Pending changes`)}function l(e){switch(e.type){case`addColumn`:case`dropColumn`:case`renameColumn`:case`alterColumn`:case`createIndex`:case`addForeignKey`:case`dropForeignKey`:case`addUniqueConstraint`:case`dropUniqueConstraint`:case`addPrimaryKey`:case`dropPrimaryKey`:return e.tableName;default:return null}}function u(e){switch(e.type){case`createTable`:return`✓ Create table "${e.table.name}"`;case`dropTable`:return`✗ Drop table "${e.tableName}"`;case`renameTable`:return`~ Rename table: ${e.from} → ${e.to}`;case`addColumn`:return`+ Add column: ${e.column.name} (${e.column.type})`;case`dropColumn`:return`- Drop column: ${e.columnName}`;case`renameColumn`:return`~ Rename column: ${e.from} → ${e.to}`;case`alterColumn`:return`~ Alter column: ${e.columnName}`;case`createIndex`:return`+ Add index: ${e.index.name}`;case`dropIndex`:return`- Drop index: ${e.indexName}`;case`addForeignKey`:return`+ Add foreign key: ${e.fk.name}`;case`dropForeignKey`:return`- Drop foreign key: ${e.fkName}`;case`addUniqueConstraint`:return`+ Add unique constraint: ${e.constraint.name}`;case`dropUniqueConstraint`:return`- Drop unique constraint: ${e.constraintName}`;case`addPrimaryKey`:return`+ Add primary key`;case`dropPrimaryKey`:return`- Drop primary key: ${e.constraintName}`;case`createEnum`:return`✓ Create enum "${e.enumDef.name}"`;case`dropEnum`:return`✗ Drop enum "${e.enumName}"`;case`alterEnum`:{let t=[];return e.addValues?.length&&t.push(`+${e.addValues.join(`, `)}`),e.removeValues?.length&&t.push(`-${e.removeValues.join(`, `)}`),`~ Alter enum "${e.enumName}": ${t.join(` `)}`}default:return`Unknown operation`}}function d(e){if(e.length===0)return;let t=e.map(e=>`  ${e};`).join(`

`);n.note(t,`SQL to execute`)}const f=[`viborm.config.ts`,`viborm.config.mts`,`viborm.config.js`,`viborm.config.mjs`];function p(e,t){for(let n of t){let t=i(e,n);if(r(t))return t}return null}async function m(e={}){let t=process.cwd(),n=e.config?i(t,e.config):p(t,f);if(!(n&&r(n))){let t=e.config?[e.config]:f;throw Error(`Could not find VibORM configuration file.

Searched for:\n${t.map(e=>`  - ${e}`).join(`
`)}\n\nCreate a viborm.config.ts file:

  import { defineConfig } from "viborm/config";\n  import { driver } from "./src/db";\n  import * as schema from "./src/schema";\n\n  export default defineConfig({
    driver,
    schema,
  });
`)}let a=await h(n),o=a.default||a.config||a;if(!o.driver)throw Error(`Missing "driver" in ${n}.\n\nYour config should include a database driver:

  export default defineConfig({
    driver: yourDriver,
    schema: { ... },
  });
`);if(!o.schema||typeof o.schema!=`object`)throw Error(`Missing "schema" in ${n}.\n\nYour config should include schema models:

  import * as schema from "./src/schema";\n\n  export default defineConfig({
    driver,
    schema,
  });
`);let s=g(o.schema);if(Object.keys(s).length===0)throw Error(`No models found in schema from ${n}.\n\nMake sure your schema exports VibORM models:

  // src/schema.ts
  import { model, string, int } from "viborm";\n\n  export const user = model({
    id: string().id(),
    name: string(),
  });
`);return{driver:o.driver,models:s}}async function h(e){try{return await import(a(e).href)}catch(t){throw e.endsWith(`.ts`)||e.endsWith(`.mts`)?Error(`Failed to load ${e}.\n\nMake sure you're running with a TypeScript loader:\n\n  # Using bun (recommended)
  bun viborm push

  # Using tsx
  npx tsx node_modules/.bin/viborm push

  # Using ts-node
  npx ts-node --esm node_modules/.bin/viborm push
`):t}}function g(e){let t={};for(let[n,r]of Object.entries(e))_(r)&&(t[n]=r);return t}function _(e){return typeof e==`object`&&!!e&&`~`in e&&typeof e[`~`]==`object`&&`state`in e[`~`]&&`fields`in e[`~`].state}const v=new t(`push`).description(`Push schema changes directly to database`).option(`--config <path>`,`Path to viborm.config.ts file`).option(`--accept-data-loss`,`Ignore data loss warnings (required for destructive changes)`,!1).option(`--force-reset`,`Reset the database before pushing (drops all tables)`,!1).option(`--strict`,`Always ask for approval before executing SQL statements`,!1).option(`--verbose`,`Print all SQL statements prior to execution`,!1).option(`--dry-run`,`Preview SQL without executing`,!1).action(async t=>{let r=Date.now();n.intro(`viborm push`);try{let i=n.spinner();i.start(`Loading configuration...`);let{driver:a,models:l}=await m({config:t.config});if(i.stop(`Configuration loaded`),a.connect&&(i.start(`Connecting to database...`),await a.connect(),i.stop(`Connected to database`)),t.forceReset){let e=await n.confirm({message:`This will DROP ALL TABLES and reset the database. Are you sure?`,initialValue:!1});(n.isCancel(e)||!e)&&(n.cancel(`Operation cancelled.`),a.disconnect&&await a.disconnect(),process.exit(0)),i.start(`Resetting database...`),await a.executeRaw(`
          DO $$ DECLARE
            r RECORD;
          BEGIN
            FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
              EXECUTE 'DROP TABLE IF EXISTS "' || r.tablename || '" CASCADE';
            END LOOP;
          END $$;
        `),await a.executeRaw(`
          DO $$ DECLARE
            r RECORD;
          BEGIN
            FOR r IN (SELECT typname FROM pg_type t JOIN pg_namespace n ON t.typnamespace = n.oid WHERE n.nspname = 'public' AND t.typtype = 'e') LOOP
              EXECUTE 'DROP TYPE IF EXISTS "' || r.typname || '" CASCADE';
            END LOOP;
          END $$;
        `),i.stop(`Database reset complete`)}i.start(`Comparing schemas...`);let u=await e(a,l,{force:t.acceptDataLoss,dryRun:!0,resolver:o,onDestructive:async e=>t.acceptDataLoss?!0:s(e)});if(i.stop(`Schema comparison complete`),c(u.operations),t.verbose&&u.sql.length>0&&d(u.sql),u.operations.length===0){let e=Date.now()-r;n.outro(`Done in ${y(e)}`),a.disconnect&&await a.disconnect();return}if(t.dryRun){t.verbose||d(u.sql);let e=Date.now()-r;n.outro(`Dry run complete in ${y(e)}`),a.disconnect&&await a.disconnect();return}if(t.strict){t.verbose||d(u.sql);let e=await n.confirm({message:`Execute these SQL statements?`,initialValue:!1});(n.isCancel(e)||!e)&&(n.cancel(`Operation cancelled.`),a.disconnect&&await a.disconnect(),process.exit(0))}else{let e=await n.confirm({message:`Apply ${u.operations.length} change(s)?`,initialValue:!0});(n.isCancel(e)||!e)&&(n.cancel(`Operation cancelled.`),a.disconnect&&await a.disconnect(),process.exit(0))}i.start(`Applying changes...`);let f=await e(a,l,{force:!0,dryRun:!1,resolver:o});i.stop(`Applied ${f.operations.length} change(s)`),a.disconnect&&await a.disconnect();let p=Date.now()-r;n.outro(`Done in ${y(p)}`)}catch(e){e instanceof Error?n.log.error(e.message):n.log.error(String(e)),process.exit(1)}});function y(e){return e<1e3?`${e}ms`:`${(e/1e3).toFixed(1)}s`}const b=new t;b.name(`viborm`).description(`VibORM - Type-safe ORM for PostgreSQL, MySQL and SQLite`).version(`0.1.0`),b.addCommand(v),b.parse();export{};
//# sourceMappingURL=cli.mjs.map