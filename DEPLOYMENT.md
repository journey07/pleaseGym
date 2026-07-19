# FIRST REP deployment

## Required Vercel environment variables

- `OPENAI_API_KEY`: OpenAI API project key.
- `OPENAI_MODEL`: `gpt-5.6-luna`.
- `DATABASE_URL`: Neon pooled Postgres connection string.
- `FIRST_REP_OWNER_ID`: a private random identifier used to partition this personal app's rows.

`OPENAI_MODEL` and `FIRST_REP_OWNER_ID` are already configured in Vercel. Add the two remaining secrets to Production, Preview, and Development, then redeploy.

## Neon migration

After adding `DATABASE_URL` to the linked Vercel project, run:

```bash
npx vercel env run -e production -- npm run db:migrate
npx vercel deploy --prod --yes
```

This creates `user_state` and `morning_events`. The first browser visit imports existing local workout history and favorites when Neon has no row yet. After that, Neon is the source of truth and localStorage is an offline cache.

## Access control

This is a single-owner MVP. Enable Vercel Deployment Protection before adding `DATABASE_URL`. Log in once from the Brave profile used by the morning routine. `FIRST_REP_OWNER_ID` partitions records, but it is not authentication by itself.
