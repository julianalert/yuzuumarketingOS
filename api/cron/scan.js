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

  const logs = []
  try {
    const result = await runScan({ dryRun, notify, log: (m) => logs.push(m) })
    // The digest HTML is large and already in the inbox — don't echo it.
    const { html, ...rest } = result
    return res.status(200).json({ ok: true, logs, ...rest })
  } catch (err) {
    console.error('[leads] scan failed', err)
    return res.status(500).json({ ok: false, error: err.message, logs })
  }
}
