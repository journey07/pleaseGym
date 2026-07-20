# FIRST REP deployment

## Required Vercel environment variables

- `OPENAI_API_KEY`: OpenAI API project key. **Required** — the morning coach returns a 503 without it.
- `DATABASE_URL`: Neon pooled Postgres connection string. Auto-injected by the Vercel ↔ Neon integration (see below).
- `FIRST_REP_OWNER_ID`: a private random identifier used to partition this personal app's rows.

> The OpenAI model is hardcoded in code (`OPENAI_MODEL = "gpt-5.6-luna"` in `app/api/morning-coach/route.ts`).
> It is **not** an environment variable anymore — any leftover `OPENAI_MODEL` var in Vercel is ignored and can be removed.

## Connect Neon via the Vercel integration

1. Vercel dashboard → project **first-rep-site** → **Storage** → **Create Database** → **Neon** → follow the prompts.
   This provisions the database and injects `DATABASE_URL` (plus Neon's own vars) into Production, Preview, and Development automatically.
2. Settings → Environment Variables → add `OPENAI_API_KEY` to all three environments.
3. Run the Neon migration (below) to create the tables.
4. Redeploy: `npx vercel deploy --prod --yes` (or push to the deploy branch).

## Neon migration

The migration creates `user_state` and `morning_events`. Run it locally with the Neon `DATABASE_URL` in scope
(put it in `.dev.vars` or `.env` — both are gitignored):

```bash
# DATABASE_URL is read from the environment by drizzle.config.ts
export DATABASE_URL="postgresql://...neon.tech/...?sslmode=require"
npm run db:migrate
```

The first browser visit imports existing local workout history and favorites when Neon has no row yet.
After that, Neon is the source of truth and localStorage is an offline cache.

## Access control

This is a single-owner MVP. Enable Vercel Deployment Protection before adding `DATABASE_URL`.
Log in once from the browser profile used by the morning routine. `FIRST_REP_OWNER_ID` partitions records,
but it is not authentication by itself.
