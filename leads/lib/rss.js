/**
 * Reddit via public Atom feeds — the no-credentials source.
 *
 * Reddit's Responsible Builder Policy (Nov 2025) gates OAuth API access behind
 * manual approval, and the old unauthenticated `.json` endpoints now 403. The
 * per-subreddit Atom feed at /r/{sub}/new.rss is still public and carries the
 * full selftext, which is everything the prefilter and Claude actually read.
 *
 * Two things it does not carry: upvote and comment counts. Both surface as
 * null and are simply not displayed.
 *
 * The feed is aggressively rate limited — roughly one request per 16s window —
 * so this fetches subreddits serially with a pause between them and backs off
 * when Reddit says to.
 */

// Reddit allows roughly one anonymous feed request per minute per IP
// (x-ratelimit-remaining hits 0 after a single call, reset ~44-60s). Pacing at
// the limit is far faster than hammering and eating the backoff.
const FEED_DELAY_MS = Number(process.env.LEADS_RSS_DELAY_MS || 62_000)
const MAX_RETRIES = 2

/**
 * Wall-clock ceiling for the whole fetch phase.
 *
 * Vercel kills the function at 300s and returns nothing at all — no logs, no
 * partial result. Retrying a stubborn subreddit until the platform pulls the
 * plug loses the posts we already have, so fetching stops at this deadline and
 * the run continues with whatever it collected.
 */
const DEFAULT_BUDGET_MS = Number(process.env.LEADS_FETCH_BUDGET_MS || 205_000)

function userAgent() {
  return process.env.REDDIT_USER_AGENT || 'nodejs:co.yuzuu.leadengine:1.0 (by /u/yuzuu)'
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- tiny Atom helpers ------------------------------------------------------
// The feed is small and machine-generated, so regex beats pulling in a parser.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'", nbsp: ' ' }

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, code) => {
    if (code in ENTITIES) return ENTITIES[code]
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole
    }
    return whole
  })
}

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))
  return m ? decodeEntities(m[1].trim()) : ''
}

const attr = (xml, pattern) => {
  const m = xml.match(pattern)
  return m ? decodeEntities(m[1]) : ''
}

/** Feed content is escaped HTML — unescape, strip tags, unescape again. */
function htmlToText(escaped) {
  const html = decodeEntities(escaped)
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
  return decodeEntities(text).replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim()
}

function parseEntry(entry, subreddit) {
  const rawId = tag(entry, 'id') // "t3_1w6ksgx"
  const id = rawId.replace(/^t3_/, '')
  const author = tag(entry, 'name').replace(/^\/u\//, '') || '[deleted]'
  const published = tag(entry, 'published') || tag(entry, 'updated')
  const body = htmlToText(entry.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] ?? '')

  return {
    id,
    subreddit: attr(entry, /<category[^>]*term="([^"]+)"/) || subreddit,
    title: tag(entry, 'title'),
    body,
    author,
    url: attr(entry, /<link[^>]*href="([^"]+)"/),
    createdUtc: published ? Date.parse(published) : Date.now(),
    // Not present in the feed. Nulls, not zeros — zero would read as "no traction".
    upvotes: null,
    comments: null,
    flair: null,
    // The feed only lists live, visible posts, so these are structurally false.
    stickied: false,
    over18: false,
    removed: false,
    locked: false,
  }
}

/**
 * Reddit's own link body for a link post is just the URL again; treat a body
 * that is nothing but the permalink as empty so the prefilter's length gate
 * sees it honestly.
 */
function cleanBody(post) {
  if (!post.body) return post
  const stripped = post.body.replace(/\[link\]|\[comments\]/g, '').trim()
  return { ...post, body: /^https?:\/\/\S+$/.test(stripped) ? '' : stripped }
}

async function fetchFeed(subreddit, limit, deadline = Infinity) {
  const url = `https://www.reddit.com/r/${subreddit}/new.rss?limit=${limit}`

  for (let attemptNo = 0; attemptNo <= MAX_RETRIES; attemptNo++) {
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent(), Accept: 'application/atom+xml, application/xml;q=0.9' },
    })

    if (res.status === 429) {
      // Reddit tells us exactly how long to wait; trust it, with a small margin.
      const reset = Number(res.headers.get('x-ratelimit-reset') || 0)
      const wait = Math.min(60_000, (reset > 0 ? reset : 2 ** attemptNo * 5) * 1000 + 1000)
      if (attemptNo === MAX_RETRIES) throw new Error(`rate limited after ${MAX_RETRIES} retries`)
      if (Date.now() + wait > deadline) throw new Error('rate limited, no time left to retry')
      await sleep(wait)
      continue
    }

    // A 403 from a datacenter IP is usually transient — Reddit shedding load
    // rather than a standing ban — and a later subreddit in the same sweep
    // often succeeds. Back off and retry before writing the subreddit off.
    if (res.status === 403) {
      if (attemptNo === MAX_RETRIES) {
        throw new Error(`403 after ${MAX_RETRIES} retries — this IP is being refused by Reddit`)
      }
      const wait = (attemptNo + 1) * 15_000
      if (Date.now() + wait > deadline) throw new Error('403, no time left to retry')
      await sleep(wait)
      continue
    }
    if (!res.ok) throw new Error(`feed returned ${res.status}`)

    return res.text()
  }
}

/** Fetch the newest posts for one subreddit. */
export async function fetchNew(subreddit, { limit = 100, sinceMs = 0, deadline = Infinity } = {}) {
  const xml = await fetchFeed(subreddit, Math.min(100, limit), deadline)
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? []

  return entries
    .map((e) => cleanBody(parseEntry(e, subreddit)))
    .filter((p) => p.id && p.createdUtc >= sinceMs)
}

/**
 * Sweep every configured subreddit, serially and politely. One subreddit
 * failing must never take the run down.
 */
export async function sweep(subs, { limit, sinceMs, budgetMs = DEFAULT_BUDGET_MS }) {
  const deadline = Date.now() + budgetMs
  const posts = []
  const errors = []

  for (const [i, sub] of subs.entries()) {
    const name = typeof sub === 'string' ? sub : sub.name

    // Leave room for at least one request; a fetch we cannot finish is worse
    // than one we never start, because it takes the whole run down with it.
    if (Date.now() + 10_000 > deadline) {
      errors.push({ subreddit: name, error: 'skipped — fetch budget exhausted' })
      continue
    }

    if (i > 0) {
      await sleep(Math.max(0, Math.min(FEED_DELAY_MS, deadline - Date.now() - 10_000)))
    }

    try {
      const found = await fetchNew(name, { limit, sinceMs, deadline })
      posts.push(...found.map((p) => ({ ...p, weight: (typeof sub === 'object' && sub.weight) || 1 })))
    } catch (err) {
      errors.push({ subreddit: name, error: err.message })
    }
  }

  return { posts, errors }
}
