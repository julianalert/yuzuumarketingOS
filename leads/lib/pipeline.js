/**
 * The pipeline.
 *
 *   sweep subreddits → drop already-seen → deterministic prefilter
 *   → Claude scores what is left → keep score >= threshold → store
 *   → build digest → email
 *
 * Every stage records what it dropped and why, so a quiet morning is
 * explainable rather than mysterious.
 */

import { config, subreddits } from '../config.js'
import { sweep as sweepOauth } from './reddit.js'
import { sweep as sweepRss } from './rss.js'
import { prefilter } from './prefilter.js'
import { scoreCandidates, estimateCost } from './score.js'
import { createStore } from './store.js'
import { buildDigest, sendDigest, digestSubject } from './digest.js'

export async function runScan({ notify = true, dryRun = false, maxSubs = 0, log = () => {} } = {}) {
  const startedAt = Date.now()
  const sinceMs = startedAt - config.lookbackHours * 3600_000
  const store = createStore()

  const hasOauth = Boolean(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET)
  const source = config.source === 'auto' ? (hasOauth ? 'oauth' : 'rss') : config.source
  const sweep = source === 'oauth' ? sweepOauth : sweepRss

  log(`store driver: ${store.driver} · reddit source: ${source}`)

  // 1 — fetch -----------------------------------------------------------------
  // maxSubs exists for debugging: the RSS source needs ~62s per subreddit, so a
  // full sweep is minutes long and a one-subreddit run proves the path in seconds.
  const targets = maxSubs > 0 ? subreddits.slice(0, maxSubs) : subreddits

  const { posts, errors: fetchErrors } = await sweep(targets, {
    limit: config.postsPerSubreddit,
    sinceMs,
  })
  log(`fetched ${posts.length} posts from ${targets.length} subreddits`)
  for (const e of fetchErrors) log(`  ! r/${e.subreddit}: ${e.error}`)

  // 2 — dedupe + deterministic filter ------------------------------------------
  const seen = await store.getSeen()
  const { candidates, stats } = prefilter(posts, { seen, sinceMs })
  stats.subredditErrors = fetchErrors.length
  log(`prefilter: ${stats.passed} candidates (${stats.alreadySeen} seen before, ${posts.length - stats.alreadySeen - stats.passed} filtered out)`)

  if (dryRun) {
    return {
      dryRun: true,
      startedAt,
      source,
      stats,
      candidates: candidates.map((c) => ({
        id: c.id, subreddit: c.subreddit, title: c.title, preScore: c.preScore, preReasons: c.preReasons, url: c.url,
      })),
    }
  }

  // 3 — Claude ------------------------------------------------------------------
  let scored = []
  let scoreErrors = []
  let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, batches: 0 }

  if (candidates.length > 0) {
    const result = await scoreCandidates(candidates)
    scored = result.scored
    scoreErrors = result.errors
    usage = result.usage
    log(`claude: scored ${scored.length} posts across ${usage.batches} batches`)
    for (const e of scoreErrors) log(`  ! batch failed: ${e.error}`)
  }

  // 4 — keep the good ones ------------------------------------------------------
  const qualified = scored
    .filter((l) => l.score >= config.minLeadScore)
    .sort((a, b) => b.score - a.score || b.createdUtc - a.createdUtc)
  log(`kept ${qualified.length} leads at >= ${config.minLeadScore}`)

  // 5 — persist -----------------------------------------------------------------
  // Only posts Claude actually saw are marked seen; a failed batch gets retried
  // tomorrow rather than being silently lost.
  const analyzed = new Set(scored.map((l) => l.id))
  await store.markSeen(candidates.filter((c) => analyzed.has(c.id)))
  // Posts the prefilter rejected are also seen — they will not improve with age.
  await store.markSeen(
    posts.filter((p) => !seen.has(p.id) && !candidates.some((c) => c.id === p.id)),
  )
  await store.saveLeads(qualified)

  const cost = estimateCost(usage)
  const run = {
    startedAt,
    finishedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    subreddits: targets.length,
    source,
    model: config.model,
    stats,
    scored: scored.length,
    qualified: qualified.length,
    usage,
    cost,
    errors: [...fetchErrors, ...scoreErrors],
  }

  // 6 — digest -------------------------------------------------------------------
  const html = buildDigest(qualified, run)
  let email = { sent: false, reason: 'notify disabled' }

  if (notify && !(config.digest.skipWhenEmpty && qualified.length === 0)) {
    email = await sendDigest({ html, subject: digestSubject(qualified) })
    log(email.sent ? `digest emailed to ${config.digest.to}` : `digest not sent: ${email.reason}`)
  } else if (notify) {
    email = { sent: false, reason: 'no qualified leads' }
    log('digest skipped — nothing qualified')
  }

  run.email = email

  const pruned = await store.prune()
  run.pruned = pruned
  await store.recordRun(run)

  return { ...run, leads: qualified, html }
}
