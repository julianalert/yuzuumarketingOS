/**
 * Cron entrypoint — Vercel calls this once a morning (see vercel.json).
 *
 * Vercel signs cron invocations with `Authorization: Bearer $CRON_SECRET` when
 * that env var is set; anything else is rejected so the endpoint cannot be
 * used to burn API credit from the outside.
 */

import { runScan } from '../../leads/lib/pipeline.js'

export const maxDuration = 300

function authorized(req) {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const header = req.headers.authorization || ''
  const query = new URL(req.url, 'http://localhost').searchParams.get('key')
  return header === `Bearer ${secret}` || query === secret
}

export default async function handler(req, res) {
  if (!authorized(req)) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  const url = new URL(req.url, 'http://localhost')
  const dryRun = url.searchParams.get('dry') === '1'
  const notify = url.searchParams.get('notify') !== '0'
  // ?subs=1 fetches only the first subreddit — a seconds-long smoke test of the
  // whole path, rather than waiting out a multi-minute sweep to learn nothing.
  const maxSubs = Number(url.searchParams.get('subs')) || 0

  const startedAt = Date.now()
  const logs = []
  try {
    const result = await runScan({ dryRun, notify, maxSubs, log: (m) => logs.push(m) })
    // The digest HTML is large and already in the inbox — don't echo it.
    const { html, ...rest } = result
    return res.status(200).json({ ok: true, elapsedMs: Date.now() - startedAt, logs, ...rest })
  } catch (err) {
    console.error('[leads] scan failed', err)
    return res
      .status(500)
      .json({ ok: false, error: err.message, elapsedMs: Date.now() - startedAt, logs })
  }
}
