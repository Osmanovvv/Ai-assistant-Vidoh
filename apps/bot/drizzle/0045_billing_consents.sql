CREATE TABLE "billing_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"rail" text NOT NULL,
	"plan" "billing_plan" NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"offer_url" text NOT NULL,
	"invoice_id" uuid,
	"consented_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_consents" ADD CONSTRAINT "billing_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_consents" ADD CONSTRAINT "billing_consents_invoice_id_billing_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."billing_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_consents_user_idx" ON "billing_consents" USING btree ("user_id");