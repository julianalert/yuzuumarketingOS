/**
 * Yuzuu lead engine — configuration.
 *
 * Everything tunable lives here. The pipeline reads this once per run, so a
 * change here (plus a deploy) is the whole knob-turning story.
 */

/** Subreddits to watch. `weight` nudges the deterministic pre-score. */
export const subreddits = [
  { name: 'DigitalProductSellers', weight: 1.2 },
  { name: 'ContentCreators', weight: 1.1 },
  { name: 'InstagramMarketing', weight: 1 },
  { name: 'socialmedia', weight: 0.8 },
]

export const config = {
  /** Posts pulled per subreddit per run (Reddit caps a listing page at 100). */
  postsPerSubreddit: 100,
  /** Ignore anything older than this. Overlaps the daily cron on purpose. */
  lookbackHours: 30,
  /** Deterministic stage-1 bar. Below this, Claude never sees the post. */
  minPreScore: 5,
  /** Hard ceiling on posts sent to Claude in one run (cost guard). */
  maxToClaude: 140,
  /** Posts per Claude request. Small enough to stay sharp, big enough to be cheap. */
  claudeBatchSize: 10,
  /** Stage-2 bar. Leads scoring below this are recorded as noise, not surfaced. */
  minLeadScore: 7,
  /** Days of history the dashboard and digest look back over. */
  retentionDays: 45,

  /**
   * Where posts come from.
   *   'rss'   public Atom feeds — no credentials, no approval, ~25 posts/sub
   *   'oauth' the official API — needs a Reddit app approved under the
   *           Responsible Builder Policy, and returns richer data
   *   'auto'  oauth when credentials are present, rss otherwise
   */
  source: process.env.LEADS_REDDIT_SOURCE || 'auto',

  model: process.env.LEADS_MODEL || 'claude-sonnet-5',

  digest: {
    to: process.env.DIGEST_TO || 'hello@yuzuu.co',
    from: process.env.DIGEST_FROM || 'Yuzuu Leads <leads@yuzuu.co>',
    /** Don't send an email when a run turns up nothing. */
    skipWhenEmpty: true,
  },

  dashboardUrl: process.env.LEADS_DASHBOARD_URL || 'https://yuzuumarketingos.vercel.app/leads',
}

/**
 * Stage-1 signal dictionary. Deliberately dumb and deliberately free — this
 * exists so Claude only ever reads plausible leads.
 */
export const signals = {
  /** Evidence the poster already has an audience. */
  audience: [
    /\bmy (audience|followers?|subs|subscribers?|channel|newsletter|podcast|list|community|viewers?|readers?|listeners?|page|account|blog|brand)\b/i,
    /\bmy (ig|instagram|tiktok|youtube|yt|twitch|substack)\b/i,
    /\b(i|we) (have|hit|reached|passed|got to|grew to)\b[^.!?]{0,30}\b(followers?|subs|subscribers?|members?|readers?|listeners?|views?|sign\s?ups?)\b/i,
    /\b(email|mailing) list\b/i,
    /\b(engaged|loyal|small but) (audience|following|community)\b/i,
    /\bmonthly (views|listeners|readers)\b/i,
  ],

  /** Numeric audience proof — "12k followers", "150,000 subs". Worth extra. */
  audienceSize: /\b(\d{1,3}(?:[.,]\d{3})+|\d+(?:\.\d+)?\s?[km]|\d{4,})\s*\+?\s*(followers?|subs\b|subscribers?|members?|readers?|listeners?|views?|sign\s?ups?)/i,

  /** Evidence they want to turn that audience into money. */
  intent: [
    /\bmonetiz(e|ing|ation)\b/i,
    /\b(digital|info) products?\b/i,
    /\b(online )?courses?\b/i,
    /\bmembership|paid community|paywall|subscription tier\b/i,
    /\b(ebook|e-book|workbook|templates?|presets?|lut pack|notion template)\b/i,
    /\b(passive|recurring|audience) (income|revenue)\b/i,
    /\bmake money (from|off|with)\b/i,
    /\b(sell|selling|launch|launching|pricing|price) (a |my |an )?(product|offer|course|template|guide|thing)\b/i,
    /\b(gumroad|patreon|kajabi|teachable|podia|beehiiv|ko-fi|whop|stan store)\b/i,
    /\b(first|1st) (product|offer|launch)\b/i,
    /\bwhat (should|can|could) i sell\b/i,
    /\bcoaching|1:1|consulting offer\b/i,
  ],

  /** Evidence of a real problem rather than idle curiosity. */
  problem: [
    /\b(how do i|how should i|what should i|what do i|where do i)\b/i,
    /\b(no idea|not sure|don'?t know|dont know|clueless|lost)\b/i,
    /\b(struggl|stuck|overwhelm|paralyz|spinning my wheels)/i,
    /\b(any (advice|tips|ideas|thoughts)|need help|help me|looking for advice)\b/i,
    /\b(flopped|isn'?t working|not working|failed|nobody bought|no sales|zero sales)\b/i,
  ],

  /** Instant disqualifiers. Cheap, blunt, and the reason the bill stays small. */
  kill: [
    /\b(check out my|link in bio|subscribe to my|sub ?4 ?sub|sub for sub|follow for follow|f4f|l4l)\b/i,
    /\b(rate my|roast my|review my) (channel|page|profile|account|feed)\b/i,
    /\b(shameless plug|self ?promo|promo thread|promote my)\b/i,
    /\b(hiring|for hire|\[hiring\]|\[for hire\]|job opening|looking for a job)\b/i,
    /\b(crypto|nft|forex|dropship|mlm|casino|betting|sports ?book)\b/i,
    /\b(onlyfans|only ?fans|adult content|nsfw content)\b/i,
    /\b(giveaway|megathread|weekly thread|monthly thread|daily thread|ama\b)/i,
    /\bdm me\b/i,
    /\bguaranteed (income|results|money)\b/i,
    /\bi (will|can) (grow|manage) your\b/i,
  ],

  /** Soft negatives — allowed through, but pushed down the queue. */
  soft: [
    /\bi (built|made|created|launched) (a|an|my) (tool|app|saas|platform|extension)\b/i,
    /\b(algorithm|shadowban|reach is down|views dropped)\b/i,
    /\bwhat do you (guys )?think of\b/i,
  ],
}
