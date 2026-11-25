CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "book_outlines" (
	"book_id" uuid PRIMARY KEY NOT NULL,
	"main_plot" text DEFAULT '' NOT NULL,
	"world_setting" text DEFAULT '' NOT NULL,
	"style_guide" text DEFAULT '' NOT NULL,
	"ending_plan" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chapter_summaries" (
	"chapter_id" uuid PRIMARY KEY NOT NULL,
	"book_id" uuid NOT NULL,
	"outline" text DEFAULT '' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"key_events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"characters_present" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"book_id" uuid NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"embedding" vector,
	"embedding_model_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "book_outlines" ADD CONSTRAINT "book_outlines_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapter_summaries" ADD CONSTRAINT "chapter_summaries_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapter_summaries" ADD CONSTRAINT "chapter_summaries_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_cards" ADD CONSTRAINT "knowledge_cards_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chapter_summaries_book_idx" ON "chapter_summaries" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "knowledge_cards_book_category_sort_idx" ON "knowledge_cards" USING btree ("book_id","category","sort_order");--> statement-breakpoint
CREATE INDEX "knowledge_cards_book_pinned_idx" ON "knowledge_cards" USING btree ("book_id","pinned");