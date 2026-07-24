import {
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const userState = pgTable("user_state", {
  ownerId: text("owner_id").primaryKey(),
  workoutHistory: jsonb("workout_history")
    .$type<unknown[]>()
    .notNull()
    .default([]),
  favorites: jsonb("favorites").$type<unknown[]>().notNull().default([]),
  coachMemory: jsonb("coach_memory").$type<unknown[]>().notNull().default([]),
  morningVideos: jsonb("morning_videos")
    .$type<unknown[]>()
    .notNull()
    .default([]),
  bodyweightLog: jsonb("bodyweight_log")
    .$type<{ date: string; kg: number }[]>()
    .notNull()
    .default([]),
  morningSchedule: jsonb("morning_schedule")
    .$type<{ enabled: boolean; hour: number; minute: number }>()
    .notNull()
    .default({ enabled: true, hour: 7, minute: 29 }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const morningEvents = pgTable(
  "morning_events",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    eventDate: text("event_date").notNull(),
    decision: text("decision").notNull(),
    model: text("model"),
    coachPlan: jsonb("coach_plan").$type<Record<string, unknown> | null>(),
    decidedAt: timestamp("decided_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("morning_events_owner_date_idx").on(
      table.ownerId,
      table.eventDate,
    ),
  ],
);
