CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"per_order_cap_fen" integer,
	"daily_cap_fen" integer,
	"paused" boolean DEFAULT false NOT NULL,
	"human_accepting" boolean DEFAULT false NOT NULL,
	"human_seen_at" timestamp with time zone,
	"listener_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_logins" (
	"id" text PRIMARY KEY NOT NULL,
	"user_code" text NOT NULL,
	"secret_hash" text NOT NULL,
	"label" text,
	"account_id" text,
	"pending_token" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_logins_user_code_unique" UNIQUE("user_code")
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" text PRIMARY KEY NOT NULL,
	"seller_account_id" text NOT NULL,
	"capability_type" text NOT NULL,
	"accept_mode" text NOT NULL,
	"daily_limit" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"price_fen" integer,
	"sku_id" text,
	"payment_status" text DEFAULT 'NOT_CONFIGURED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"kind" text NOT NULL,
	"order_id" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"capability_type" text NOT NULL,
	"buyer_account_id" text NOT NULL,
	"created_by_actor" text NOT NULL,
	"input" jsonb NOT NULL,
	"max_price_fen" integer,
	"status" text NOT NULL,
	"deadline" timestamp with time zone,
	"offered_to" text[] DEFAULT '{}' NOT NULL,
	"offer_kind" text,
	"passed_by" text[] DEFAULT '{}' NOT NULL,
	"seller_account_id" text,
	"listing_id" text,
	"price_fen" integer,
	"purchase_request_no" text,
	"purchase_url" text,
	"purchase_qr_code" text,
	"payment_ref" text,
	"paid_at" timestamp with time zone,
	"delivery_attempts" integer DEFAULT 0 NOT NULL,
	"last_delivery_error" text,
	"output" jsonb,
	"verdict" text,
	"cancel_reason" text,
	"fail_reason" text,
	"refund_eligible" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"status" text NOT NULL,
	"amount_fen" integer NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"actor" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "device_logins" ADD CONSTRAINT "device_logins_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_seller_account_id_accounts_id_fk" FOREIGN KEY ("seller_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_account_id_accounts_id_fk" FOREIGN KEY ("buyer_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_seller_account_id_accounts_id_fk" FOREIGN KEY ("seller_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "listings_seller_type" ON "listings" USING btree ("seller_account_id","capability_type");--> statement-breakpoint
CREATE INDEX "notifications_account" ON "notifications" USING btree ("account_id","id");--> statement-breakpoint
CREATE INDEX "orders_status_deadline" ON "orders" USING btree ("status","deadline");--> statement-breakpoint
CREATE INDEX "orders_buyer" ON "orders" USING btree ("buyer_account_id");--> statement-breakpoint
CREATE INDEX "orders_seller" ON "orders" USING btree ("seller_account_id");