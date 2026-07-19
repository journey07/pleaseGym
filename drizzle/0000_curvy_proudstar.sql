CREATE TABLE "morning_events" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"event_date" text NOT NULL,
	"decision" text NOT NULL,
	"model" text,
	"coach_plan" jsonb,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_state" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"workout_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"favorites" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"coach_memory" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "morning_events_owner_date_idx" ON "morning_events" USING btree ("owner_id","event_date");