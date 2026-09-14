ALTER TYPE "public"."credit_profile_status" ADD VALUE 'no_recent_price';--> statement-breakpoint
ALTER TABLE "credit_profiles" DROP CONSTRAINT "credit_profiles_pkey";--> statement-breakpoint
ALTER TABLE "credit_profiles" ADD CONSTRAINT "credit_profiles_wallet_network_id_pk" PRIMARY KEY("wallet","network_id");
