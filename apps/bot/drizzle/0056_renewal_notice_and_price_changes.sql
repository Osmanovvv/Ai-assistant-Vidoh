CREATE TABLE "billing_price_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rail" text NOT NULL,
	"plan" "billing_plan" NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"announced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"notified" integer DEFAULT 0 NOT NULL,
	"canceled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "renewal_noticed_for" timestamp with time zone;