/**
 * Read API for the dashboard.
 *
 *   GET /api/leads?days=14&min=7          → { leads, runs, meta }
 *   GET /api/leads?format=csv             → CSV download
 *
 * Optional: set LEADS_ACCESS_TOKEN to require ?token= on every request.
 */

import { createStore } from '../leads/lib/store.js'
import { config, subreddits } from '../leads/config.js'

const CSV_COLUMNS = [
  ['score', (l) => l.score],
  ['subreddit', (l) => `r/${l.subreddit}`],
  ['title', (l) => l.title],
  ['creator_type', (l) => l.creatorType],
  ['pain_point', (l) => l.painPoint],
  ['creator_signal', (l) => l.creatorSignal],
  ['outreach_angle', (l) => l.outreachAngle],
  ['reason', (l) => l.reason],
  ['author', (l) => `u/${l.author}`],
  ['upvotes', (l) => l.upvotes],
  ['comments', (l) => l.comments],
  ['posted_at', (l) => new Date(l.createdUtc).toISOString()],
  ['url', (l) => l.url],
]

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`

export default async function handler(req, res) {
  const gate = process.env.LEADS_ACCESS_TOKEN
  const url = new URL(req.url, 'http://localhost')

  if (gate && url.searchParams.get('token') !== gate) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  const days = Math.min(90, Number(url.searchParams.get('days')) || 14)
  const minScore = Number(url.searchParams.get('min')) || config.minLeadScore
  const sinceMs = Date.now() - days * 864e5

  try {
    const store = createStore()
    const leads = await store.getLeads({ sinceMs, minScore })

    if (url.searchParams.get('format') === 'csv') {
      const rows = [
        CSV_COLUMNS.map(([name]) => name).join(','),
        ...leads.map((l) => CSV_COLUMNS.map(([, get]) => csvCell(get(l))).join(',')),
      ]
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="yuzuu-leads-${new Date().toISOString().slice(0, 10)}.csv"`,
      )
      return res.status(200).send(rows.join('\n'))
    }

    const runs = await store.getRuns(14)
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json({
      leads,
      runs: runs.map(({ startedAt, stats, qualified, cost, model, email }) => ({
        startedAt, stats, qualified, cost, model, emailed: Boolean(email?.sent),
      })),
      meta: {
        days,
        minScore,
        threshold: config.minLeadScore,
        subreddits: subreddits.map((s) => s.name),
        driver: store.driver,
        generatedAt: Date.now(),
      },
    })
  } catch (err) {
    console.error('[leads] read failed', err)
    return res.status(500).json({ error: err.message })
  }
}
