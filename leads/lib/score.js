/**
 * Stage 2 — Claude qualification.
 *
 * Only posts that survived the deterministic prefilter reach this file. They
 * arrive in small batches, come back as validated JSON, and cost roughly a
 * fraction of a cent each.
 */

import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'

const client = new Anthropic()

const SYSTEM_PROMPT = `You are a lead qualification agent for Yuzuu.

Yuzuu builds digital products for creators who already have an audience. The
creator brings the audience and the credibility; Yuzuu figures out what to
build, then builds and ships it for them.

A HIGH VALUE lead is someone who:
- is a creator, or clearly has an audience of their own
- wants to monetize that audience
- does not know what product to create, or has tried and it did not land
- mentions courses, digital products, memberships, monetization, passive
  income, audience revenue, launching an offer, or similar
- expresses a real, specific problem rather than generic curiosity

A LOW VALUE lead is someone who:
- is promoting themselves, selling a service, or recruiting
- has no audience and is asking how to get one (that is a different problem)
- is asking a purely technical or platform question (algorithm, shadowbans, gear)
- is another agency, freelancer, or tool builder looking for clients
- is speculating hypothetically with no stake in the outcome

Scoring guide:
  9-10  explicit audience + explicit monetization intent + explicit "what do I build"
  7-8   clear audience and clear monetization intent; the gap is inferable
  5-6   one strong signal, the other missing or weak
  3-4   creator-adjacent but no monetization angle
  0-2   promo, spam, off-topic, or no audience at all

Be strict. Most posts are 3-6. A 9 should be rare and obvious.

For each post return:
- score: integer 0-10
- reason: one sentence, why this score, referencing the post's own specifics
- pain_point: the underlying problem in the poster's own framing (or "" if none)
- creator_signal: the concrete evidence of an audience, quoting numbers or
  platform where the post states them (or "" if none)
- creator_type: one of "youtube", "instagram", "tiktok", "newsletter",
  "podcast", "twitch", "blog", "multi-platform", "unclear"
- outreach_angle: one sentence you could actually open a DM with — specific to
  this person, no template language, no pitch deck voice

Return an entry for every post id you are given, in the same order.`

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          score: { type: 'integer' }, // 0-10; structured outputs reject minimum/maximum
          reason: { type: 'string' },
          pain_point: { type: 'string' },
          creator_signal: { type: 'string' },
          creator_type: {
            type: 'string',
            enum: ['youtube', 'instagram', 'tiktok', 'newsletter', 'podcast', 'twitch', 'blog', 'multi-platform', 'unclear'],
          },
          outreach_angle: { type: 'string' },
        },
        required: ['id', 'score', 'reason', 'pain_point', 'creator_signal', 'creator_type', 'outreach_angle'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
}

const chunk = (arr, size) =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size))

/** Keep bodies bounded — a 10k-word rant does not score better than its first 1200 words. */
function renderPost(post) {
  const body = post.body.replace(/\s+\n/g, '\n').trim().slice(0, 1200)
  const traction =
    post.upvotes == null ? null : `upvotes: ${post.upvotes} · comments: ${post.comments}`

  return [
    `<post id="${post.id}">`,
    `subreddit: r/${post.subreddit}`,
    `title: ${post.title}`,
    traction,
    `body: ${body || '(no body — title only)'}`,
    '</post>',
  ].filter(Boolean).join('\n')
}

async function scoreBatch(posts) {
  const response = await client.messages.create({
    model: config.model,
    max_tokens: 8000,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    output_config: { format: { type: 'json_schema', schema: RESULT_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: `Score these ${posts.length} Reddit posts.\n\n${posts.map(renderPost).join('\n\n')}`,
      },
    ],
  })

  const text = response.content.find((b) => b.type === 'text')?.text ?? '{}'
  const parsed = JSON.parse(text)
  return {
    results: parsed.results ?? [],
    usage: response.usage,
  }
}

/**
 * Score every candidate. Batches run sequentially so a rate limit degrades the
 * run rather than killing it — partial results still produce a digest.
 */
export async function scoreCandidates(candidates) {
  const byId = new Map(candidates.map((p) => [p.id, p]))
  const scored = []
  const errors = []
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, batches: 0 }

  for (const batch of chunk(candidates, config.claudeBatchSize)) {
    try {
      const { results, usage: u } = await scoreBatch(batch)
      usage.batches++
      usage.input += u.input_tokens ?? 0
      usage.output += u.output_tokens ?? 0
      usage.cacheRead += u.cache_read_input_tokens ?? 0
      usage.cacheWrite += u.cache_creation_input_tokens ?? 0

      for (const r of results) {
        const post = byId.get(r.id)
        if (!post) continue // model invented an id; ignore rather than trust it

        // The schema can no longer pin the range, so enforce it here. An
        // out-of-range score would otherwise sail past the >= 7 gate.
        const score = Math.max(0, Math.min(10, Math.round(Number(r.score) || 0)))

        scored.push({
          id: post.id,
          subreddit: post.subreddit,
          title: post.title,
          body: post.body.slice(0, 2000),
          author: post.author,
          url: post.url,
          createdUtc: post.createdUtc,
          upvotes: post.upvotes,
          comments: post.comments,
          preScore: post.preScore,
          preReasons: post.preReasons,
          score,
          reason: r.reason,
          painPoint: r.pain_point,
          creatorSignal: r.creator_signal,
          creatorType: r.creator_type,
          outreachAngle: r.outreach_angle,
          scoredAt: Date.now(),
          model: config.model,
        })
      }
    } catch (err) {
      errors.push({ ids: batch.map((p) => p.id), error: err.message })
    }
  }

  return { scored, errors, usage }
}

/** Rough USD cost of a run, for the dashboard's "what did this cost" line. */
export function estimateCost(usage, model = config.model) {
  const rates = {
    'claude-sonnet-5': { in: 2, out: 10 },
    'claude-sonnet-4-6': { in: 3, out: 15 },
    'claude-haiku-4-5': { in: 1, out: 5 },
    'claude-opus-5': { in: 5, out: 25 },
  }
  const rate = rates[model] ?? rates['claude-sonnet-5']
  const dollars =
    (usage.input / 1e6) * rate.in +
    (usage.cacheWrite / 1e6) * rate.in * 1.25 +
    (usage.cacheRead / 1e6) * rate.in * 0.1 +
    (usage.output / 1e6) * rate.out
  return Math.round(dollars * 10000) / 10000
}
