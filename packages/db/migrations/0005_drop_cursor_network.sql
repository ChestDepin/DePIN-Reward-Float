ALTER TABLE "indexer_cursors" DROP CONSTRAINT "indexer_cursors_network_id_networks_id_fk";
--> statement-breakpoint
ALTER TABLE "indexer_cursors" DROP COLUMN "network_id";