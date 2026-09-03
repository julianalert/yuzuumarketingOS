/**
 * Stage 1 — deterministic filtering.
 *
 * Runs on every post, costs nothing, and is the reason stage 2 is affordable:
 * a typical overnight sweep of ~600 posts leaves ~60-80 for Claude to read.
 */

import { config, signals } from '../config.js'

const countMatches = (patterns, text) => patterns.reduce((n, re) => (re.test(text) ? n + 1 : n), 0)
const firstMatch = (patterns, text) => patterns.find((re) => re.test(text)) || null

/**
 * Score a single post. Returns the pre-score plus the evidence behind it, so a
 * rejected post can always be explained without re-running anything.
 */
export function prescore(post) {
  const text = `${post.title}\n${post.body}`
  const haystack = text.slice(0, 4000) // regex on a 40k selftext is wasted work

  const reasons = []
  let score = 0

  // --- Structural disqualifiers ---------------------------------------------
  if (post.stickied) return { score: -1, drop: 'stickied', reasons }
  if (post.over18) return { score: -1, drop: 'nsfw', reasons }
  if (post.removed) return { score: -1, drop: 'removed', reasons }
  if (post.author === '[deleted]') return { score: -1, drop: 'deleted-author', reasons }
  if (post.title.length < 12) return { score: -1, drop: 'title-too-short', reasons }
  if (haystack.trim().length < 80) return { score: -1, drop: 'too-thin', reasons }

  // --- Hard kill list --------------------------------------------------------
  const killed = firstMatch(signals.kill, haystack)
  if (killed) return { score: -1, drop: `kill:${killed.source.slice(0, 40)}`, reasons }

  // --- Positive signals ------------------------------------------------------
  const audience = countMatches(signals.audience, haystack)
  const intent = countMatches(signals.intent, haystack)
  const problem = countMatches(signals.problem, haystack)
  const sizeMatch = haystack.match(signals.audienceSize)

  if (audience > 0) {
    score += Math.min(4, 2 + audience)
    reasons.push(`audience×${audience}`)
  }
  if (sizeMatch) {
    score += 2
    reasons.push(`size:${sizeMatch[0].trim()}`)
  }
  if (intent > 0) {
    score += Math.min(4, 2 + intent)
    reasons.push(`intent×${intent}`)
  }
  if (problem > 0) {
    score += Math.min(3, 1 + problem)
    reasons.push(`problem×${problem}`)
  }

  // Someone writing 400+ words about their situation is asking a real question.
  if (post.body.length > 300) {
    score += 1
    reasons.push('detailed')
  }
  if (/\?/.test(post.title)) {
    score += 1
    reasons.push('question')
  }

  // --- Soft negatives --------------------------------------------------------
  const soft = countMatches(signals.soft, haystack)
  if (soft > 0) {
    score -= soft * 2
    reasons.push(`soft−${soft}`)
  }

  score *= post.weight ?? 1

  // The gate: real audience evidence, or monetization intent stated twice over.
  const qualifies = audience > 0 || Boolean(sizeMatch) || intent >= 2
  if (!qualifies) return { score, drop: 'no-creator-or-intent-signal', reasons }

  return { score: Math.round(score * 10) / 10, drop: null, reasons, audience, intent, problem }
}

/**
 * Run the whole sweep through stage 1.
 *
 * @param posts    normalized Reddit posts
 * @param seen     Set of post ids already analyzed on a previous run
 * @param sinceMs  ignore anything older than this
 */
export function prefilter(posts, { seen = new Set(), sinceMs = 0 } = {}) {
  const stats = { fetched: posts.length, alreadySeen: 0, tooOld: 0, dropped: {}, passed: 0 }
  const candidates = []

  for (const post of posts) {
    if (seen.has(post.id)) {
      stats.alreadySeen++
      continue
    }
    if (post.createdUtc < sinceMs) {
      stats.tooOld++
      continue
    }

    const result = prescore(post)
    if (result.drop) {
      const key = result.drop.startsWith('kill:') ? 'kill-list' : result.drop
      stats.dropped[key] = (stats.dropped[key] || 0) + 1
      continue
    }
    if (result.score < config.minPreScore) {
      stats.dropped['below-prescore'] = (stats.dropped['below-prescore'] || 0) + 1
      continue
    }

    candidates.push({ ...post, preScore: result.score, preReasons: result.reasons })
  }

  // Best-looking posts first, so the maxToClaude ceiling cuts the weakest tail.
  candidates.sort((a, b) => b.preScore - a.preScore)
  const capped = candidates.slice(0, config.maxToClaude)
  stats.passed = capped.length
  stats.overflow = candidates.length - capped.length

  return { candidates: capped, stats }
}
