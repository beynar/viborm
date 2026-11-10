ALTER TYPE "public"."fx_gadget_fx_level_enum" ADD VALUE 'mid' BEFORE 'high'

ALTER TABLE "public"."fx_gadget" ALTER COLUMN "fx_level" TYPE text USING "fx_level"::text

DROP TYPE "public"."fx_gadget_fx_level_enum"

CREATE TYPE "public"."fx_gadget_fx_level_enum" AS ENUM ('low', 'high')

ALTER TABLE "public"."fx_gadget" ALTER COLUMN "fx_level" TYPE "public"."fx_gadget_fx_level_enum" USING "fx_level"::"public"."fx_gadget_fx_level_enum"