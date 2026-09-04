/**
 * Storage.
 *
 * Two drivers behind one interface:
 *   - redis: Upstash / Vercel KV over REST (works from serverless, no pooling)
 *   - file:  .leads-data.json next to the repo, for local runs and testing
 *
 * The driver is chosen from the environment, so `node leads/scan.mjs` works on
 * a laptop with no infrastructure at all.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { config } from '../config.js'

const KEYS = {
  seen: 'yuzuu:leads:seen', // hash  postId -> createdAt ms
  leads: 'yuzuu:leads:items', // hash  postId -> lead json
  runs: 'yuzuu:leads:runs', // list  run summaries, newest first
}

// ---------------------------------------------------------------------------
// Redis driver (Upstash REST — also what Vercel KV speaks)
// ---------------------------------------------------------------------------

/**
 * Find the Redis REST credentials.
 *
 * Vercel's own KV integration injects KV_REST_API_URL/TOKEN and the Upstash
 * marketplace one injects UPSTASH_REDIS_REST_URL/TOKEN — but when a store is
 * connected under a custom name, both get prefixed with it
 * (LEADS_KV_REST_API_URL and so on). So fall back to pattern-matching any
 * URL/TOKEN pair rather than silently dropping to the file driver.
 */
export function redisEnv() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
  if (url && token) return { url, token, via: 'standard' }

  const urlKey = Object.keys(process.env).find(
    (k) => /(REST_API_URL|REDIS_REST_URL)$/.test(k) && process.env[k],
  )
  if (!urlKey) return null

  const tokenKey = urlKey.replace(/URL$/, 'TOKEN')
  const prefixed = process.env[tokenKey]
  return prefixed ? { url: process.env[urlKey], token: prefixed, via: urlKey } : null
}

function createRedisDriver({ url, token }) {
  async function send(body, path = '') {
    const res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`KV error (${res.status}): ${(await res.text()).slice(0, 200)}`)
    return res.json()
  }

  const cmd = async (...args) => (await send(args)).result
  const pipeline = async (commands) => {
    if (commands.length === 0) return []
    const out = await send(commands, '/pipeline')
    return out.map((r) => r.result)
  }

  return {
    kind: 'redis',

    async hgetall(key) {
      const flat = await cmd('HGETALL', key)
      if (!flat) return {}
      // Upstash returns a flat [field, value, field, value] array.
      if (Array.isArray(flat)) {
        const obj = {}
        for (let i = 0; i < flat.length; i += 2) obj[flat[i]] = flat[i + 1]
        return obj
      }
      return flat
    },

    async hset(key, entries) {
      const flat = Object.entries(entries).flat()
      if (flat.length === 0) return
      await cmd('HSET', key, ...flat)
    },

    async hdel(key, fields) {
      if (fields.length === 0) return
      await cmd('HDEL', key, ...fields)
    },

    async pushRun(run) {
      await pipeline([
        ['LPUSH', KEYS.runs, JSON.stringify(run)],
        ['LTRIM', KEYS.runs, '0', '59'],
      ])
    },

    async listRuns(n) {
      const raw = (await cmd('LRANGE', KEYS.runs, '0', String(n - 1))) || []
      return raw.map((r) => (typeof r === 'string' ? JSON.parse(r) : r))
    },
  }
}

// ---------------------------------------------------------------------------
// File driver (local development)
// ---------------------------------------------------------------------------

function createFileDriver(path) {
  const file = resolve(path)
  let cache = null

  async function load() {
    if (cache) return cache
    try {
      cache = JSON.parse(await readFile(file, 'utf8'))
    } catch {
      cache = { [KEYS.seen]: {}, [KEYS.leads]: {}, [KEYS.runs]: [] }
    }
    cache[KEYS.seen] ??= {}
    cache[KEYS.leads] ??= {}
    cache[KEYS.runs] ??= []
    return cache
  }

  async function flush() {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(cache, null, 2))
  }

  return {
    kind: 'file',
    async hgetall(key) {
      return { ...(await load())[key] }
    },
    async hset(key, entries) {
      const db = await load()
      Object.assign(db[key], entries)
      await flush()
    },
    async hdel(key, fields) {
      const db = await load()
      for (const f of fields) delete db[key][f]
      await flush()
    },
    async pushRun(run) {
      const db = await load()
      db[KEYS.runs].unshift(run)
      db[KEYS.runs] = db[KEYS.runs].slice(0, 60)
      await flush()
    },
    async listRuns(n) {
      return (await load())[KEYS.runs].slice(0, n)
    },
  }
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export function createStore() {
  const redis = redisEnv()
  const driver = redis
    ? createRedisDriver(redis)
    : createFileDriver(process.env.LEADS_DATA_FILE || '.leads-data.json')

  return {
    driver: driver.kind,
    via: redis?.via ?? null,

    /** Ids of every post already analyzed, so we never pay to score one twice. */
    async getSeen() {
      return new Set(Object.keys(await driver.hgetall(KEYS.seen)))
    },

    /** Mark posts as analyzed. Value is the post's own timestamp, used for pruning. */
    async markSeen(posts) {
      const entries = Object.fromEntries(posts.map((p) => [p.id, String(p.createdUtc)]))
      await driver.hset(KEYS.seen, entries)
    },

    async saveLeads(leads) {
      if (leads.length === 0) return
      await driver.hset(KEYS.leads, Object.fromEntries(leads.map((l) => [l.id, JSON.stringify(l)])))
    },

    /**
     * Every stored lead, best first.
     *
     * Hand-added leads (`manual: true`) ignore the date window: they were
     * curated on purpose, often from posts older than the lookback, and
     * hiding them behind a `days=` filter would defeat the point of adding them.
     */
    async getLeads({ sinceMs = 0, minScore = 0 } = {}) {
      const raw = await driver.hgetall(KEYS.leads)
      return Object.values(raw)
        .map((v) => (typeof v === 'string' ? JSON.parse(v) : v))
        .filter((l) => (l.manual || l.createdUtc >= sinceMs) && l.score >= minScore)
        .sort((a, b) => b.score - a.score || b.createdUtc - a.createdUtc)
    },

    async recordRun(run) {
      await driver.pushRun(run)
    },

    /** Newest run first — the dashboard's "last run" line depends on this order. */
    async getRuns(n = 20) {
      const runs = await driver.listRuns(n)
      return runs.sort((a, b) => b.startedAt - a.startedAt)
    },

    /** Drop history past the retention window so the hashes stay small. */
    async prune(retentionDays = config.retentionDays) {
      const cutoff = Date.now() - retentionDays * 864e5
      const seen = await driver.hgetall(KEYS.seen)
      const staleSeen = Object.entries(seen)
        .filter(([, ts]) => Number(ts) < cutoff)
        .map(([id]) => id)

      const leads = await driver.hgetall(KEYS.leads)
      const staleLeads = Object.entries(leads)
        .map(([id, v]) => [id, typeof v === 'string' ? JSON.parse(v) : v])
        // Manual leads are never pruned — someone put them there deliberately.
        .filter(([, l]) => !l.manual && l.createdUtc < cutoff)
        .map(([id]) => id)

      await driver.hdel(KEYS.seen, staleSeen)
      await driver.hdel(KEYS.leads, staleLeads)
      return { seen: staleSeen.length, leads: staleLeads.length }
    },
  }
}
