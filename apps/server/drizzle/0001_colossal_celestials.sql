CREATE TABLE "books" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"author_pen_name" text DEFAULT '' NOT NULL,
	"genre" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"synopsis" text DEFAULT '' NOT NULL,
	"target_chapter_words" integer DEFAULT 3000 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chapter_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chapter_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"source" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"title_snapshot" text NOT NULL,
	"content_text" text NOT NULL,
	"content_json" jsonb,
	"word_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chapters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"book_id" uuid NOT NULL,
	"volume_id" uuid,
	"title" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"content_text" text DEFAULT '' NOT NULL,
	"content_json" jsonb,
	"word_count" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "volumes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"book_id" uuid NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chapter_revisions" ADD CONSTRAINT "chapter_revisions_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_volume_id_volumes_id_fk" FOREIGN KEY ("volume_id") REFERENCES "public"."volumes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volumes" ADD CONSTRAINT "volumes_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "books_deleted_at_idx" ON "books" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "books_updated_at_idx" ON "books" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "chapter_revisions_chapter_created_idx" ON "chapter_revisions" USING btree ("chapter_id","created_at");--> statement-breakpoint
CREATE INDEX "chapters_book_volume_sort_idx" ON "chapters" USING btree ("book_id","volume_id","sort_order");--> statement-breakpoint
CREATE INDEX "chapters_book_deleted_idx" ON "chapters" USING btree ("book_id","deleted_at");--> statement-breakpoint
CREATE INDEX "volumes_book_sort_idx" ON "volumes" USING btree ("book_id","sort_order");