/**
 * One-shot diagnostic: can this deployment reach Reddit at all?
 *
 * Reddit's public feeds are rate limited per IP and datacenter ranges are
 * often blocked outright, so the answer differs between a laptop and Vercel.
 * Hit this once after deploying, before wiring up the cron schedule.
 *
 *   GET /api/probe?key=$CRON_SECRET
 */

export const maxDuration = 60

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET
  const url = new URL(req.url, 'http://localhost')
  if (!secret || url.searchParams.get('key') !== secret) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  const sub = url.searchParams.get('sub') || 'InstagramMarketing'
  const target = `https://www.reddit.com/r/${sub}/new.rss?limit=100`
  const startedAt = Date.now()

  try {
    const r = await fetch(target, {
      headers: {
        'User-Agent': process.env.REDDIT_USER_AGENT || 'nodejs:co.yuzuu.leadengine:1.0 (by /u/yuzuu)',
        Accept: 'application/atom+xml, application/xml;q=0.9',
      },
    })
    const body = await r.text()
    const entries = (body.match(/<entry>/g) || []).length

    return res.status(200).json({
      target,
      status: r.status,
      ok: r.ok,
      entries,
      bytes: body.length,
      elapsedMs: Date.now() - startedAt,
      rateLimit: {
        used: r.headers.get('x-ratelimit-used'),
        remaining: r.headers.get('x-ratelimit-remaining'),
        resetSeconds: r.headers.get('x-ratelimit-reset'),
      },
      verdict:
        r.status === 200 && entries > 0
          ? `WORKS — Reddit served ${entries} posts to this deployment`
          : r.status === 429
            ? 'RATE LIMITED — reachable, but this IP is over its budget right now. Retry in a minute.'
            : r.status === 403
              ? 'BLOCKED — Reddit refuses this IP. The RSS source will not work from Vercel.'
              : `UNEXPECTED ${r.status}`,
      // A blocked response is an HTML error page; the first line identifies it.
      snippet: r.ok ? undefined : body.slice(0, 200),
    })
  } catch (err) {
    return res.status(500).json({ target, error: err.message, elapsedMs: Date.now() - startedAt })
  }
}
