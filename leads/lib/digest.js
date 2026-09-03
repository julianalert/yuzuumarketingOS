/**
 * Morning digest — HTML email.
 *
 * Table-based and inline-styled on purpose: email clients are not browsers.
 */

import { config } from '../config.js'

const esc = (s = '') =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const INK = '#16201B'
const SOFT = '#3D4B43'
const SAGE = '#6E7C73'
const LINE = '#D9DED4'
const PAPER = '#F4F5F0'
const ZEST = '#B9CC3A'

const heatColor = (score) => (score >= 9 ? '#C25B3A' : score >= 8 ? '#8A9B2E' : SAGE)

function leadRow(lead, index) {
  return `
  <tr><td style="padding:0 0 14px">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid ${LINE};border-radius:10px">
      <tr><td style="padding:20px 22px">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="font:600 22px/1 -apple-system,Segoe UI,sans-serif;color:${heatColor(lead.score)};width:52px;vertical-align:top">
            ${lead.score.toFixed(1)}
          </td>
          <td style="vertical-align:top">
            <div style="font:500 11px/1.4 ui-monospace,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;color:${SAGE};padding-bottom:6px">
              ${String(index + 1).padStart(2, '0')} &middot; r/${esc(lead.subreddit)} &middot; ${esc(lead.creatorType)}
            </div>
            <div style="font:400 17px/1.35 Georgia,serif;color:${INK};padding-bottom:10px">
              ${esc(lead.title)}
            </div>
            <div style="font:400 14px/1.55 -apple-system,Segoe UI,sans-serif;color:${SOFT};padding-bottom:8px">
              ${esc(lead.reason)}
            </div>
            ${lead.painPoint ? `<div style="font:400 13px/1.5 -apple-system,Segoe UI,sans-serif;color:${SOFT};padding:8px 0 0;border-top:1px solid ${LINE}"><strong style="color:${INK}">Pain</strong> &mdash; ${esc(lead.painPoint)}</div>` : ''}
            ${lead.creatorSignal ? `<div style="font:400 13px/1.5 -apple-system,Segoe UI,sans-serif;color:${SOFT};padding-top:4px"><strong style="color:${INK}">Audience</strong> &mdash; ${esc(lead.creatorSignal)}</div>` : ''}
            ${lead.outreachAngle ? `<div style="margin-top:12px;padding:12px 14px;background:${PAPER};border-left:3px solid ${ZEST};border-radius:0 6px 6px 0;font:400 13.5px/1.55 -apple-system,Segoe UI,sans-serif;color:${INK}"><strong>Open with</strong> &mdash; ${esc(lead.outreachAngle)}</div>` : ''}
            <div style="padding-top:14px">
              <a href="${esc(lead.url)}" style="font:500 13px/1 -apple-system,Segoe UI,sans-serif;color:${INK};text-decoration:none;border-bottom:2px solid ${ZEST};padding-bottom:2px">Open on Reddit &rarr;</a>
              <span style="font:400 12px/1 ui-monospace,Menlo,monospace;color:${SAGE};padding-left:14px">u/${esc(lead.author)}${lead.upvotes == null ? '' : ` &middot; ${lead.upvotes}&#9650; &middot; ${lead.comments} comments`}</span>
            </div>
          </td>
        </tr></table>
      </td></tr>
    </table>
  </td></tr>`
}

export function digestSubject(leads) {
  if (leads.length === 0) return 'Yuzuu leads — nothing today'
  const top = leads[0]
  return `Yuzuu leads — ${leads.length} today, top ${top.score}/10 in r/${top.subreddit}`
}

export function buildDigest(leads, run) {
  const subject = digestSubject(leads)
  const date = new Date(run.startedAt).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
  })
  const hot = leads.filter((l) => l.score >= 9)

  const statLine = [
    `${run.stats.fetched} fetched`,
    `${run.stats.passed} to Claude`,
    `${leads.length} kept`,
    run.cost ? `$${run.cost.toFixed(3)}` : null,
  ].filter(Boolean).join(' &middot; ')

  const body = leads.length
    ? leads.map(leadRow).join('')
    : `<tr><td style="padding:40px;text-align:center;background:#fff;border:1px dashed ${LINE};border-radius:10px;font:400 14px/1.5 -apple-system,sans-serif;color:${SAGE}">
         Nothing cleared ${config.minLeadScore}/10 overnight. ${run.stats.passed} posts were read and none were worth your morning.
       </td></tr>`

  return `<!doctype html><html><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light only">
  <title>${esc(subject)}</title>
  </head><body style="margin:0;padding:0;background:${PAPER}">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};padding:32px 16px">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:620px">

        <tr><td style="padding-bottom:28px">
          <div style="font:500 11px/1 ui-monospace,Menlo,monospace;letter-spacing:.13em;text-transform:uppercase;color:${SAGE};padding-bottom:12px">
            Yuzuu &middot; Lead Engine &middot; ${esc(date)}
          </div>
          <div style="font:400 30px/1.15 Georgia,serif;color:${INK};letter-spacing:-.02em">
            ${leads.length} lead${leads.length === 1 ? '' : 's'} worth a DM today${hot.length ? `, ${hot.length} of them hot` : ''}.
          </div>
          <div style="font:400 13px/1.5 ui-monospace,Menlo,monospace;color:${SAGE};padding-top:12px">
            ${statLine}
          </div>
        </td></tr>

        ${body}

        <tr><td style="padding-top:20px;border-top:1px solid ${LINE}">
          <a href="${esc(config.dashboardUrl)}" style="font:500 13px/1 -apple-system,Segoe UI,sans-serif;color:${INK};text-decoration:none">Open the dashboard &rarr;</a>
          <div style="font:400 12px/1.6 ui-monospace,Menlo,monospace;color:${SAGE};padding-top:12px">
            Watching ${run.subreddits} subreddits &middot; scored by ${esc(run.model)}
            ${run.errors?.length ? `<br>${run.errors.length} subreddit${run.errors.length === 1 ? '' : 's'} errored this run` : ''}
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
  </body></html>`
}

/** Send via Resend. Returns null when no API key is configured (local runs). */
export async function sendDigest({ html, subject }) {
  const key = process.env.RESEND_API_KEY
  if (!key) return { sent: false, reason: 'RESEND_API_KEY not set' }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: config.digest.from,
      to: [config.digest.to],
      subject,
      html,
    }),
  })

  if (!res.ok) {
    return { sent: false, reason: `Resend ${res.status}: ${(await res.text()).slice(0, 200)}` }
  }
  return { sent: true, id: (await res.json()).id }
}
