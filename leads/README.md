# Lead Engine

Reads Reddit every morning, throws away the noise, has Claude score what's
left, and emails the creators worth a DM to hello@yuzuu.co.

```
06:00 UTC — Vercel cron hits /api/cron/scan
     ↓
sweep 3 subreddits via public Atom feeds (/r/{sub}/new.rss)
     ↓
drop post ids already analyzed          ← store
     ↓
STAGE 1 — deterministic filter          ← free
   structural junk, kill-list, signal gate, pre-score
   ~600 posts in → ~70 out
     ↓
STAGE 2 — Claude scores in batches of 10
   → { score, reason, pain_point, creator_signal, creator_type, outreach_angle }
     ↓
keep score >= 7
     ↓
store → build HTML digest → email via Resend
     ↓
dashboard at /leads
```

Two stages is the whole trick. Stage 1 costs nothing and kills ~80% of the
sweep, so stage 2 only ever reads plausible leads. Measured on live data:
108 posts fetched, 21 reaching Claude, about **$0.01** a run.

## Where posts come from

Reddit's Responsible Builder Policy (Nov 2025) put the OAuth API behind manual
approval, and the unauthenticated `.json` endpoints now return 403. The public
per-subreddit Atom feed still works and carries the full selftext, so that is
the default source. It costs two things:

- **Rate limit: ~1 request per 60s per IP.** The sweep paces itself at that
  rate, which is why 3 subreddits take ~124s. Each extra subreddit adds ~62s,
  and Vercel's function ceiling is 300s — that limit, not usefulness, is why
  the list is short.
- **No upvote or comment counts.** Nothing in the scoring path used them; they
  show as empty in the dashboard and CSV.

`config.source` selects between them: `rss` (default when no Reddit credentials
exist), `oauth` (if your app gets approved — richer data, no rate-limit pain),
or `auto`.

## Files

| Path | What it does |
|---|---|
| `config.js` | Subreddits, thresholds, signal dictionary, model. The only file you routinely edit. |
| `lib/reddit.js` | OAuth `client_credentials` + `/r/{sub}/new`. No HTML scraping. |
| `lib/prefilter.js` | Stage 1. Deterministic, testable, free. |
| `lib/score.js` | Stage 2. Batched Claude calls with a JSON schema and a cached system prompt. |
| `lib/store.js` | Upstash/Vercel KV in production, a local JSON file otherwise. |
| `lib/digest.js` | The morning email. |
| `lib/pipeline.js` | Orchestrates the above and records every run. |
| `dashboard.html` | Served at `/leads` (copied into the build by `vite.config.js`). |
| `scan.mjs` | Local runner. |
| `../api/cron/scan.js` | Cron entrypoint, guarded by `CRON_SECRET`. |
| `../api/leads.js` | Read API for the dashboard + CSV export. |

## Setup

**1. Reddit** — nothing to do. The RSS source needs no credentials.

If you later get an app approved under the Responsible Builder Policy
(https://www.reddit.com/prefs/apps → *create another app* → type **script**),
set `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` and the engine switches to
OAuth on its own — no code change.

**2. Resend** — verify `yuzuu.co` at https://resend.com/domains, then create an
API key. Until the domain is verified, set `DIGEST_FROM` to
`onboarding@resend.dev`.

**3. Storage** — in the Vercel dashboard: Storage → Create → Upstash Redis (or
KV). Attaching it to the project injects `KV_REST_API_URL` and
`KV_REST_API_TOKEN` automatically. Without them the engine falls back to a
local JSON file, which is fine on a laptop and useless on serverless.

**4. Environment variables** (Vercel → Settings → Environment Variables):

| Variable | Required | Notes |
|---|---|---|
| `REDDIT_CLIENT_ID` | no | only if your Reddit app gets approved; presence switches the source to OAuth |
| `REDDIT_CLIENT_SECRET` | no | as above |
| `REDDIT_USER_AGENT` | recommended | e.g. `nodejs:co.yuzuu.leadengine:1.0 (by /u/yourname)` |
| `ANTHROPIC_API_KEY` | yes | |
| `CRON_SECRET` | yes | any long random string; Vercel sends it as a bearer token |
| `RESEND_API_KEY` | yes | omit to skip the email and keep everything else |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | yes | injected by the storage integration |
| `DIGEST_TO` | no | defaults to `hello@yuzuu.co` |
| `DIGEST_FROM` | no | defaults to `Yuzuu Leads <leads@yuzuu.co>` |
| `LEADS_MODEL` | no | defaults to `claude-sonnet-5` |
| `LEADS_DASHBOARD_URL` | no | the link at the bottom of the email |
| `LEADS_ACCESS_TOKEN` | no | set it and `/api/leads` requires `?token=…`, so the dashboard needs `/leads?token=…` |
| `LEADS_REDDIT_SOURCE` | no | `rss`, `oauth`, or `auto` (default) |
| `LEADS_RSS_DELAY_MS` | no | pause between feeds, default 62000. Lower it and you will eat 429 backoff instead |

**5. Deploy.** The cron is declared in `vercel.json` and starts on the next
deploy. Note that Vercel's Hobby plan runs crons once a day at an approximate
time; Pro runs them on the minute.

## Running it by hand

```bash
npm run leads:dry
```

Fetches and prefilters only — no Claude call, no email, no writes. This is the
one to use when tuning `config.js`: it prints every candidate with the signals
that got it through.

```bash
npm run leads:preview
```

Full scan against the local JSON store, writes `digest-preview.html` instead of
sending it. `npm run leads:scan` does the real thing, email included.

You can also trigger the deployed cron directly:

```bash
# one subreddit, ~1s — proves the whole path without waiting out a sweep
curl -sS -w '\n--- %{http_code} in %{time_total}s ---\n' \
  "https://your-domain.vercel.app/api/cron/scan?key=$CRON_SECRET&dry=1&subs=1"
```

Drop `&subs=1` for the full sweep, `&dry=1` for a real run, add `&notify=0` to
skip the email. Always pass `-w`: a full sweep prints nothing for minutes and
then dumps everything at once, which looks exactly like a hang.

Check `logs[0]` in the response — it names the store driver. If it says `file`
rather than `redis`, nothing is persisting and every run will re-score the same
posts.

## Tuning

Everything lives in `config.js`.

- **Too few leads** — lower `minPreScore` (stage 1) before `minLeadScore`
  (stage 2). Widening stage 1 is cheap; lowering the Claude bar just fills the
  inbox with 6s.
- **Too much junk reaching Claude** — add a pattern to `signals.kill`, then
  re-run `npm run leads:dry` to see what it removes.
- **Costs creeping up** — `maxToClaude` is a hard ceiling per run. Candidates
  are sorted by pre-score first, so the cap always cuts the weakest tail.
- **Runs timing out** — each subreddit costs ~62s of rate-limit waiting. Three
  fit inside Vercel's 300s with room; four measured 242s on the *dry* path
  alone, before Claude. Add a subreddit only if you also raise `maxDuration`
  (Pro allows more) or split fetching from scoring across invocations.
- **New subreddit** — add it to `subreddits` with a `weight`. A subreddit that
  is private, banned or renamed logs an error and the run continues.

The `weight` multiplies the stage-1 pre-score, so a high-signal subreddit like
r/PartneredYoutube gets more of its posts through to Claude than r/socialmedia.

## Data

Three keys, all pruned past `retentionDays` (45) on every run:

- `yuzuu:leads:seen` — post id → timestamp. Why nothing is scored twice.
- `yuzuu:leads:items` — post id → the qualified lead.
- `yuzuu:leads:runs` — the last 60 run summaries, behind the dashboard's run log.

Only posts Claude actually read are marked seen. If a batch fails, those posts
are retried on the next run rather than lost.
