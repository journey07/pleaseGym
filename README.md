# FIRST REP

A minimal workout calendar, 06:00 decision bridge, and OpenAI-powered personal trainer.

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Runtime

- Next.js on Vercel
- OpenAI Responses API with `gpt-5.6-luna`
- Neon Postgres through the Neon serverless HTTP driver and Drizzle ORM
- localStorage as an offline cache and one-time migration source

## Setup and deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md).

## Data contract

- `user_state`: one owner-scoped JSON snapshot containing workout history, favorites, and approved coach memory.
- `morning_events`: one owner/date record containing the user's decision and the generated coach plan.
- Explicit workout saves replace that date's session in the client snapshot.
- When Neon is unavailable, the browser continues to use localStorage and retries on the next app load.
