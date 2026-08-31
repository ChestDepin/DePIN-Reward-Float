CREATE TYPE "public"."credit_profile_status" AS ENUM('available', 'ineligible', 'data_unavailable', 'incomplete_prices');--> statement-breakpoint
CREATE TYPE "public"."payout_cadence" AS ENUM('daily', 'weekly', 'monthly');--> statement-breakpoint
CREATE TABLE "attestations" (
	"wallet" text NOT NULL,
	"nonce" numeric(20, 0) NOT NULL,
	"limit_usd" numeric(20, 6) NOT NULL,
	"attestor" text NOT NULL,
	"signature" text NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "attestations_wallet_nonce_pk" PRIMARY KEY("wallet","nonce")
);
--> statement-breakpoint
CREATE TABLE "credit_profiles" (
	"wallet" text PRIMARY KEY NOT NULL,
	"network_id" text NOT NULL,
	"status" "credit_profile_status" NOT NULL,
	"limit_usd" numeric(20, 6),
	"factors" jsonb,
	"reason" text,
	"eligible_at" date,
	"computed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "credit_profiles_limit_only_when_available" CHECK (("credit_profiles"."status" = 'available') = ("credit_profiles"."limit_usd" is not null))
);
--> statement-breakpoint
CREATE TABLE "indexer_cursors" (
	"wallet" text NOT NULL,
	"network_id" text NOT NULL,
	"last_signature" text,
	"last_slot" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "indexer_cursors_wallet_network_id_pk" PRIMARY KEY("wallet","network_id")
);
--> statement-breakpoint
CREATE TABLE "networks" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"token_mint" text NOT NULL,
	"token_symbol" text NOT NULL,
	"token_decimals" smallint NOT NULL,
	"distributors" text[] NOT NULL,
	"payout_cadence" "payout_cadence" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"signature" text NOT NULL,
	"wallet" text NOT NULL,
	"network_id" text NOT NULL,
	"distributor" text NOT NULL,
	"amount" numeric(20, 0) NOT NULL,
	"slot" bigint NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"value_usd" numeric(20, 6),
	CONSTRAINT "payouts_signature_wallet_pk" PRIMARY KEY("signature","wallet")
);
--> statement-breakpoint
CREATE TABLE "price_points" (
	"mint" text NOT NULL,
	"day" date NOT NULL,
	"price_usd" numeric(38, 18) NOT NULL,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_points_mint_day_pk" PRIMARY KEY("mint","day")
);
--> statement-breakpoint
ALTER TABLE "credit_profiles" ADD CONSTRAINT "credit_profiles_network_id_networks_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."networks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexer_cursors" ADD CONSTRAINT "indexer_cursors_network_id_networks_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."networks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_network_id_networks_id_fk" FOREIGN KEY ("network_id") REFERENCES "public"."networks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payouts_wallet_block_time_idx" ON "payouts" USING btree ("wallet","block_time");