CREATE TYPE "public"."sweep_event_kind" AS ENUM('swept', 'skipped');--> statement-breakpoint
CREATE TABLE "sweep_events" (
	"signature" text NOT NULL,
	"event_index" smallint NOT NULL,
	"kind" "sweep_event_kind" NOT NULL,
	"operator" text NOT NULL,
	"reward_mint" text NOT NULL,
	"loan" text,
	"withheld" numeric(20, 0) NOT NULL,
	"paid" numeric(20, 0),
	"stable_per_trillion_reward" numeric(20, 0) NOT NULL,
	"deviation_bps" integer NOT NULL,
	"max_slippage_bps" integer,
	"remaining_debt" numeric(20, 0),
	"slot" bigint NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	CONSTRAINT "sweep_events_signature_event_index_pk" PRIMARY KEY("signature","event_index"),
	CONSTRAINT "sweep_events_fields_match_kind" CHECK (("sweep_events"."kind" = 'swept') = ("sweep_events"."loan" is not null and "sweep_events"."paid" is not null and "sweep_events"."remaining_debt" is not null and "sweep_events"."max_slippage_bps" is null)
        and ("sweep_events"."kind" = 'skipped') = ("sweep_events"."loan" is null and "sweep_events"."paid" is null and "sweep_events"."remaining_debt" is null and "sweep_events"."max_slippage_bps" is not null))
);
--> statement-breakpoint
CREATE TABLE "sweep_journal_cursors" (
	"program" text PRIMARY KEY NOT NULL,
	"last_signature" text NOT NULL,
	"last_slot" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sweep_events_operator_slot_idx" ON "sweep_events" USING btree ("operator","slot");