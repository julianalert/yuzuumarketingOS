/**
 * Write the opening DM for one lead.
 *
 *   POST /api/message   { "id": "1ujnzov" }   → { message, model, usage }
 *
 * The lead is looked up in the store by id rather than posted in by the
 * browser: the request costs a model call, so what it writes about should come
 * from what we stored, not from whatever the page happened to send.
 *
 * Optional: set LEADS_ACCESS_TOKEN to require ?token= on every request.
 */

import { createStore } from '../leads/lib/store.js'
import { writeFirstMessage } from '../leads/lib/first-message.js'

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
  // The writer runs on OpenAI, not Claude — scoring is the only Anthropic path.
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY is not set on this deployment' })
  }

  try {
    const { id } = await readBody(req)
    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'body must be { "id": "<lead id>" }' })
    }

    const lead = await createStore().getLead(id)
    if (!lead) {
      return res.status(404).json({ error: `no stored lead with id ${id}` })
    }

    const result = await writeFirstMessage(lead)
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json(result)
  } catch (err) {
    console.error('[message] write failed', err)
    return res.status(500).json({ error: err.message })
  }
}
