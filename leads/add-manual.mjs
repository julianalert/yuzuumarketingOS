/**
 * Hand-add leads the scanner never saw.
 *
 * The scanner only reads the last ~30 hours of four subreddits. Anything found
 * by hand — an older post, a subreddit not on the watchlist, research done
 * elsewhere — has no way into the dashboard otherwise. This puts it there.
 *
 *   node leads/add-manual.mjs                    # write leads/manual.json to the store
 *   node leads/add-manual.mjs --dry              # print what would be written
 *   node leads/add-manual.mjs path/to/other.json
 *
 * Entries land with `manual: true`, which pins them: they ignore the
 * dashboard's date window and survive pruning. Their id is the Reddit post id,
 * so they are also marked seen and the scanner will not re-score them.
 *
 * Re-running is safe — an entry with the same id overwrites its previous copy.
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Load .env.local BEFORE the store is imported — it picks its driver from the
// environment at import time, so a later load would come too late and the run
// would quietly write to the local file instead of the deployed store.
for (const name of ['.env.local', '.env']) {
  const file = resolve(process.cwd(), name)
  if (!existsSync(file)) continue
  try {
    process.loadEnvFile(file)
    console.log(`loaded ${name}`)
  } catch (err) {
    console.warn(`could not read ${name}: ${err.message}`)
  }
  break
}

const { createStore } = await import('./lib/store.js')

const here = dirname(fileURLToPath(import.meta.url))

const REQUIRED = ['id', 'subreddit', 'title', 'url', 'score', 'reason']

const CREATOR_TYPES = [
  'youtube', 'instagram', 'tiktok', 'newsletter',
  'podcast', 'twitch', 'blog', 'multi-platform', 'unclear',
]

/** Turn a loose hand-written entry into the exact shape the pipeline stores. */
function normalize(entry, i) {
  const missing = REQUIRED.filter((k) => entry[k] === undefined || entry[k] === '')
  if (missing.length) throw new Error(`entry ${i} is missing: ${missing.join(', ')}`)

  const score = Number(entry.score)
  if (!Number.isFinite(score) || score < 0 || score > 10) {
    throw new Error(`entry ${i} (${entry.id}) has score ${entry.score}, expected 0-10`)
  }
  if (entry.creatorType && !CREATOR_TYPES.includes(entry.creatorType)) {
    throw new Error(`entry ${i} (${entry.id}) has creatorType "${entry.creatorType}"`)
  }

  // postedAt is the post's own date; without one, the card would claim the
  // lead was found today.
  const createdUtc = entry.postedAt ? Date.parse(entry.postedAt) : Date.now()
  if (!Number.isFinite(createdUtc)) throw new Error(`entry ${i} (${entry.id}) has an unparseable postedAt`)

  return {
    id: entry.id,
    subreddit: entry.subreddit.replace(/^r\//, ''),
    title: entry.title,
    body: (entry.body ?? '').slice(0, 2000),
    author: (entry.author ?? 'unknown').replace(/^u\//, ''),
    url: entry.url,
    createdUtc,
    upvotes: entry.upvotes ?? null,
    comments: entry.comments ?? null,
    preScore: null,
    preReasons: ['added by hand'],
    score,
    reason: entry.reason,
    painPoint: entry.painPoint ?? '',
    creatorSignal: entry.creatorSignal ?? '',
    creatorType: entry.creatorType ?? 'unclear',
    outreachAngle: entry.outreachAngle ?? '',
    scoredAt: Date.now(),
    model: 'manual',
    manual: true,
    addedBy: entry.addedBy ?? 'manual import',
  }
}

async function main() {
  const args = process.argv.slice(2)
  const dry = args.includes('--dry')
  const file = resolve(args.find((a) => !a.startsWith('--')) ?? `${here}/manual.json`)

  const raw = JSON.parse(await readFile(file, 'utf8'))
  const entries = Array.isArray(raw) ? raw : raw.leads
  if (!Array.isArray(entries)) throw new Error(`${file} should hold an array of leads`)

  const leads = entries.map(normalize)

  const dupes = leads.map((l) => l.id).filter((id, i, all) => all.indexOf(id) !== i)
  if (dupes.length) throw new Error(`duplicate ids in ${file}: ${[...new Set(dupes)].join(', ')}`)

  console.log(`${leads.length} lead(s) from ${file}`)
  for (const l of leads) {
    console.log(`  ${String(l.score).padStart(4)}  r/${l.subreddit}  u/${l.author}  ${l.title.slice(0, 60)}`)
  }

  if (dry) return console.log('\n--dry: nothing written')

  const store = createStore()
  if (store.driver === 'file') {
    // The dashboard reads Redis in production. Writing to the local JSON file
    // looks like success and changes nothing anyone can see.
    console.warn(
      '\n!  store driver is "file" — this writes to .leads-data.json, not the live dashboard.' +
      '\n   For production, run with the Redis env vars set (e.g. `vercel env pull`).',
    )
  }

  await store.saveLeads(leads)
  // Seen markers are pruned by their timestamp, and these posts are often
  // months old — stamp them with now so the marker outlives the retention
  // window rather than disappearing on the next run.
  const handledAt = Date.now()
  await store.markSeen(leads.map((l) => ({ id: l.id, createdUtc: handledAt })))
  console.log(`\nwrote ${leads.length} lead(s) to the ${store.driver} store${store.via ? ` (via ${store.via})` : ''}`)
}

main().catch((err) => {
  console.error(`add-manual failed: ${err.message}`)
  process.exit(1)
})
