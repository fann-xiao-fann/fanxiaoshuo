CREATE TABLE "toolbox_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tool_id" varchar(64) NOT NULL,
	"book_id" uuid,
	"role" varchar(32) NOT NULL,
	"status" varchar(16) NOT NULL,
	"inputs_json" jsonb NOT NULL,
	"output_json" jsonb,
	"model_ref" varchar(256),
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"error_code" varchar(64),
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "toolbox_runs" ADD CONSTRAINT "toolbox_runs_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "toolbox_runs_created_idx" ON "toolbox_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "toolbox_runs_book_created_idx" ON "toolbox_runs" USING btree ("book_id","created_at");--> statement-breakpoint
CREATE INDEX "toolbox_runs_tool_created_idx" ON "toolbox_runs" USING btree ("tool_id","created_at");