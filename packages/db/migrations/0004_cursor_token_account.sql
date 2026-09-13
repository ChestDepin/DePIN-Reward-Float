ALTER TABLE "indexer_cursors" DROP CONSTRAINT "indexer_cursors_wallet_network_id_pk";--> statement-breakpoint
ALTER TABLE "indexer_cursors" ADD COLUMN "token_account" text NOT NULL;--> statement-breakpoint
ALTER TABLE "indexer_cursors" ALTER COLUMN "last_signature" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "indexer_cursors" ALTER COLUMN "last_slot" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "indexer_cursors" ADD CONSTRAINT "indexer_cursors_wallet_token_account_pk" PRIMARY KEY("wallet","token_account");
