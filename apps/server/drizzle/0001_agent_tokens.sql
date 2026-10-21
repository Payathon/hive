ALTER TABLE "orders" ADD COLUMN "created_by_token" text;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "id" text;--> statement-breakpoint
UPDATE "tokens" SET "id" = 'tok_' || substr("token_hash", 1, 16);--> statement-breakpoint
ALTER TABLE "tokens" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_id_unique" UNIQUE("id");
