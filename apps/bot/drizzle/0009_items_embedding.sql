CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "embedding" vector(256);--> statement-breakpoint
CREATE INDEX "items_embedding_idx" ON "items" USING hnsw ("embedding" vector_cosine_ops);