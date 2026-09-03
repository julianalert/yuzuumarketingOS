#!/usr/bin/env node
/**
 * Local runner.
 *
 *   node leads/scan.mjs --dry        prefilter only, no Claude call, no email
 *   node leads/scan.mjs --no-email   full scan, writes results, skips the email
 *   node leads/scan.mjs              full scan
 *   node leads/scan.mjs --preview    full scan, writes the digest to a file
 */

import { writeFile } from 'node:fs/promises'
import { runScan } from './lib/pipeline.js'

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry')
const notify = !args.has('--no-email') && !dryRun

const result = await runScan({
  dryRun,
  notify,
  log: (m) => console.log(`  ${m}`),
})

if (dryRun) {
  console.log(`\n${result.candidates.length} candidates would go to Claude:\n`)
  for (const c of result.candidates) {
    console.log(`  ${String(c.preScore).padStart(5)}  r/${c.subreddit.padEnd(20)} ${c.title.slice(0, 70)}`)
    console.log(`         ${c.preReasons.join(' · ')}`)
  }
  console.log('\nprefilter stats:', JSON.stringify(result.stats, null, 2))
} else {
  console.log(`\n${result.qualified} leads kept · $${result.cost} · ${Math.round(result.durationMs / 1000)}s\n`)
  for (const l of result.leads) {
    console.log(`  ${l.score.toFixed(1)}  r/${l.subreddit}`)
    console.log(`       ${l.title.slice(0, 80)}`)
    console.log(`       ${l.outreachAngle}`)
    console.log(`       ${l.url}\n`)
  }
  if (args.has('--preview')) {
    await writeFile('digest-preview.html', result.html)
    console.log('digest written to digest-preview.html')
  }
}
