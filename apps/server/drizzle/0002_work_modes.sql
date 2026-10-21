ALTER TABLE "accounts" ALTER COLUMN "human_accepting" SET DEFAULT true;--> statement-breakpoint
-- The switch now pauses taking orders instead of marking the 接单台 open, so it starts on.
UPDATE "accounts" SET "human_accepting" = true;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "active_at" timestamp with time zone;--> statement-breakpoint
UPDATE "accounts" SET "active_at" = greatest("human_seen_at", "listener_seen_at");--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "human_seen_at";--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "work_mode" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "delivery_hours" integer;--> statement-breakpoint
-- Listings from the web 接单台 were always a person doing the job; give them the type's old time limit.
UPDATE "listings" SET "work_mode" = 'manual', "delivery_hours" = CASE "capability_type" WHEN 'photo.onsite' THEN 2 ELSE 1 END WHERE "accept_mode" = 'ask';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "work_timeout_ms" integer;
