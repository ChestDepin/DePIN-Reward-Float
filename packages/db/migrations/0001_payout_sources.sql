ALTER TABLE "networks" ADD COLUMN "payout_sources" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "source" text NOT NULL;