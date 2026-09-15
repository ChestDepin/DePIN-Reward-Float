ALTER TABLE "credit_profiles" DROP CONSTRAINT "credit_profiles_limit_only_when_available";--> statement-breakpoint
ALTER TABLE "credit_profiles" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."credit_profile_status";--> statement-breakpoint
CREATE TYPE "public"."credit_profile_status" AS ENUM('available', 'ineligible', 'no_recent_price');--> statement-breakpoint
ALTER TABLE "credit_profiles" ALTER COLUMN "status" SET DATA TYPE "public"."credit_profile_status" USING "status"::"public"."credit_profile_status";--> statement-breakpoint
ALTER TABLE "credit_profiles" ADD CONSTRAINT "credit_profiles_limit_only_when_available" CHECK (("credit_profiles"."status" = 'available') = ("credit_profiles"."limit_usd" is not null));
