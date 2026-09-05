/**
 * Mark a lead as reached out, or undo it.
 *
 *   POST /api/reached   { "id": "1ujnzov", "reached": true }   → { id, reachedOutAt }
 *   POST /api/reached   { "id": "1ujnzov", "reached": false }  → { id, reachedOutAt: null }
 *
 * The flag lives in its own hash, not on the lead — see `store.getReached()`.
 *
 * Optional: set LEADS_ACCESS_TOKEN to require ?token= on every request.
 */

import { createStore } from '../leads/lib/store.js'

/**
 * Vercel parses a JSON body for you; the dev shim in vite.config.js hands over
 * the raw Node request untouched. Handle both rather than only working in prod.
 */
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}')

  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

export default async function handler(req, res) {
  const gate = process.env.LEADS_ACCESS_TOKEN
  const url = new URL(req.url, 'http://localhost')

  if (gate && url.searchParams.get('token') !== gate) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'use POST' })
  }

  try {
    const { id, reached } = await readBody(req)
    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'body must be { "id": "<lead id>", "reached": true|false }' })
    }

    const store = createStore()
    if (!(await store.getLead(id))) {
      return res.status(404).json({ error: `no stored lead with id ${id}` })
    }

    // Anything but an explicit false marks it — the button's normal direction.
    const at = reached === false ? null : Date.now()
    await store.setReached(id, at)

    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json({ id, reachedOutAt: at })
  } catch (err) {
    console.error('[reached] write failed', err)
    return res.status(500).json({ error: err.message })
  }
}
