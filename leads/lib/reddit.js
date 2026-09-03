/**
 * Reddit client — OAuth only, no HTML scraping.
 *
 * Uses the `client_credentials` grant from a "script" app, which is enough for
 * every read-only public endpoint we need (/r/{sub}/new, /r/{sub}/search).
 */

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token'
const API = 'https://oauth.reddit.com'

let cachedToken = null // { value, expiresAt }

function userAgent() {
  return process.env.REDDIT_USER_AGENT || 'nodejs:co.yuzuu.leadengine:1.0 (by /u/yuzuu)'
}

async function getToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value

  const id = process.env.REDDIT_CLIENT_ID
  const secret = process.env.REDDIT_CLIENT_SECRET
  if (!id || !secret) {
    throw new Error('Missing REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET')
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent(),
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  })

  if (!res.ok) {
    throw new Error(`Reddit auth failed (${res.status}): ${await res.text()}`)
  }

  const json = await res.json()
  cachedToken = {
    value: json.access_token,
    // Refresh a minute early rather than discover expiry mid-run.
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
  }
  return cachedToken.value
}

async function api(path, params = {}) {
  const token = await getToken()
  const url = new URL(API + path)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
  }
  url.searchParams.set('raw_json', '1')

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': userAgent() },
  })

  if (res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset') || 5)
    throw Object.assign(new Error('Reddit rate limited'), { retryAfter: reset })
  }
  if (!res.ok) {
    throw new Error(`Reddit ${path} failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  }
  return res.json()
}

/** Flatten Reddit's listing envelope into the shape the rest of the pipeline wants. */
function normalize(child, subreddit) {
  const d = child.data
  return {
    id: d.id,
    subreddit: d.subreddit || subreddit,
    title: d.title || '',
    body: d.selftext || '',
    author: d.author || '[deleted]',
    url: `https://www.reddit.com${d.permalink}`,
    createdUtc: d.created_utc * 1000,
    upvotes: d.ups ?? 0,
    comments: d.num_comments ?? 0,
    flair: d.link_flair_text || null,
    // Structural junk the prefilter drops without thinking about it.
    stickied: Boolean(d.stickied || d.pinned),
    over18: Boolean(d.over_18),
    removed: Boolean(d.removed_by_category) || d.selftext === '[removed]' || d.selftext === '[deleted]',
    locked: Boolean(d.locked),
  }
}

/**
 * Fetch the newest posts from a subreddit, paginating until we have `limit`
 * posts or run past `sinceMs`.
 */
export async function fetchNew(subreddit, { limit = 100, sinceMs = 0 } = {}) {
  const out = []
  let after = null

  while (out.length < limit) {
    const page = await api(`/r/${subreddit}/new`, {
      limit: Math.min(100, limit - out.length),
      after,
    })
    const children = page?.data?.children ?? []
    if (children.length === 0) break

    let reachedFloor = false
    for (const child of children) {
      const post = normalize(child, subreddit)
      if (post.createdUtc < sinceMs) {
        reachedFloor = true
        continue
      }
      out.push(post)
    }

    after = page.data.after
    if (!after || reachedFloor) break
  }

  return out
}

/** Keyword search within a subreddit — used for targeted top-ups, not the daily sweep. */
export async function search(subreddit, query, { limit = 50, sort = 'new', time = 'week' } = {}) {
  const page = await api(`/r/${subreddit}/search`, {
    q: query,
    restrict_sr: 1,
    sort,
    t: time,
    limit,
  })
  return (page?.data?.children ?? []).map((c) => normalize(c, subreddit))
}

/**
 * Sweep every configured subreddit. One subreddit failing (private, banned,
 * renamed) must never take the whole run down, so failures are collected.
 */
export async function sweep(subs, { limit, sinceMs }) {
  const posts = []
  const errors = []

  for (const sub of subs) {
    const name = typeof sub === 'string' ? sub : sub.name
    try {
      const found = await fetchNew(name, { limit, sinceMs })
      posts.push(...found.map((p) => ({ ...p, weight: (typeof sub === 'object' && sub.weight) || 1 })))
    } catch (err) {
      errors.push({ subreddit: name, error: err.message })
    }
  }

  return { posts, errors }
}
