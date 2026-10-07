CREATE TYPE "public"."manual_repayment_reason" AS ENUM('revoked', 'allowance-short', 'withdrawn-early');--> statement-breakpoint
ALTER TABLE "sweep_events" DROP CONSTRAINT "sweep_events_fields_match_kind";--> statement-breakpoint
ALTER TABLE "sweep_events" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."sweep_event_kind";--> statement-breakpoint
CREATE TYPE "public"."sweep_event_kind" AS ENUM('swept', 'skipped', 'manual');--> statement-breakpoint
ALTER TABLE "sweep_events" ALTER COLUMN "kind" SET DATA TYPE "public"."sweep_event_kind" USING "kind"::"public"."sweep_event_kind";--> statement-breakpoint
ALTER TABLE "sweep_events" ALTER COLUMN "withheld" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sweep_events" ALTER COLUMN "stable_per_trillion_reward" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sweep_events" ALTER COLUMN "deviation_bps" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sweep_events" ADD COLUMN "reason" "manual_repayment_reason";--> statement-breakpoint
ALTER TABLE "sweep_events" ADD COLUMN "reward_due" numeric(20, 0);--> statement-breakpoint
ALTER TABLE "sweep_events" ADD CONSTRAINT "sweep_events_fields_match_kind" CHECK (("sweep_events"."kind" = 'swept' and "sweep_events"."loan" is not null and "sweep_events"."withheld" is not null and "sweep_events"."paid" is not null and "sweep_events"."stable_per_trillion_reward" is not null and "sweep_events"."deviation_bps" is not null and "sweep_events"."remaining_debt" is not null and "sweep_events"."max_slippage_bps" is null and "sweep_events"."reason" is null and "sweep_events"."reward_due" is null)
        or ("sweep_events"."kind" = 'skipped' and "sweep_events"."loan" is null and "sweep_events"."withheld" is not null and "sweep_events"."paid" is null and "sweep_events"."stable_per_trillion_reward" is not null and "sweep_events"."deviation_bps" is not null and "sweep_events"."remaining_debt" is null and "sweep_events"."max_slippage_bps" is not null and "sweep_events"."reason" is null and "sweep_events"."reward_due" is null)
        or ("sweep_events"."kind" = 'manual' and "sweep_events"."loan" is not null and "sweep_events"."withheld" is null and "sweep_events"."paid" is null and "sweep_events"."stable_per_trillion_reward" is null and "sweep_events"."deviation_bps" is null and "sweep_events"."remaining_debt" is null and "sweep_events"."max_slippage_bps" is null and "sweep_events"."reason" is not null and "sweep_events"."reward_due" is not null));--> statement-breakpoint
DELETE FROM "sweep_journal_cursors";