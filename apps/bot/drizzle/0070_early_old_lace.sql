ALTER TABLE "messages_raw" ADD COLUMN "reply_to_message_id" bigint;--> statement-breakpoint
ALTER TABLE "messages_raw" ADD COLUMN "reply_to_text" text;