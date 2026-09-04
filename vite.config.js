import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'

/**
 * The lead engine's dashboard lives in /leads alongside its pipeline code, so
 * the whole tool is one folder. This copies it into the static build at /leads.
 */
function leadsDashboard() {
  return {
    name: 'yuzuu-leads-dashboard',
    apply: 'build',
    closeBundle() {
      mkdirSync('dist/leads', { recursive: true })
      copyFileSync('leads/dashboard.html', 'dist/leads/index.html')
    },
  }
}

/**
 * Dev-only: reproduce what Vercel does in production.
 *
 * In production `vercel.json` rewrites /leads to the built dashboard and runs
 * everything under api/ as a serverless function. Vite knows about neither, so
 * without this `/leads` fell through to the root index.html and `/api/leads`
 * served its own source as a JS module — the dashboard then failed on
 * `res.json()`. This mounts both the way the deployed site has them.
 */
function leadsDev() {
  return {
    name: 'yuzuu-leads-dev',
    apply: 'serve',

    configureServer(server) {
      // /leads → the dashboard itself, not the marketing index.
      //
      // Served verbatim, exactly as the build copies it. Running it through
      // transformIndexHtml instead would hoist the page's inline module into a
      // `/leads?html-proxy` request that this very middleware would answer with
      // HTML, and the script would die on a MIME check. The page imports
      // nothing, so it has no use for the transform anyway.
      server.middlewares.use(async (req, res, next) => {
        const path = req.url.split('?')[0]
        if (path !== '/leads' && path !== '/leads/') return next()
        try {
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(await readFile(resolve('leads/dashboard.html'), 'utf8'))
        } catch (err) {
          next(err)
        }
      })

      // /api/* → run the handler in this process, behind a Vercel-shaped `res`.
      server.middlewares.use(async (req, res, next) => {
        const path = req.url.split('?')[0]
        if (!path.startsWith('/api/')) return next()

        const file = resolve(`.${path}.js`)
        if (!existsSync(file)) return next()

        // Re-import per request so editing a handler doesn't need a restart.
        const url = `${pathToFileURL(file).href}?t=${Date.now()}`

        try {
          const { default: handler } = await import(url)
          if (typeof handler !== 'function') {
            throw new Error(`${path}.js has no default export to call`)
          }
          await handler(req, vercelResponse(res))
        } catch (err) {
          // Answer in the shape the dashboard's error path expects, and print
          // it — an unhandled throw here would take the dev server with it.
          server.config.logger.error(`[api] ${path} failed: ${err.stack ?? err.message}`)
          if (!res.headersSent) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
          }
          res.end(JSON.stringify({ error: err.message }))
        }
      })
    },
  }
}

/** The three response helpers the api/ handlers actually use. */
function vercelResponse(res) {
  res.status = (code) => {
    res.statusCode = code
    return res
  }
  res.json = (body) => {
    if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(body))
    return res
  }
  res.send = (body) => {
    res.end(body)
    return res
  }
  return res
}

export default defineConfig(({ mode }) => {
  // The api/ handlers read process.env directly (KV credentials, tokens), and
  // Vite only puts .env files on import.meta.env. Without this, a dev run with
  // `vercel env pull` still silently falls back to the local file store.
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''))

  return {
    plugins: [leadsDashboard(), leadsDev()],
    server: {
      port: 5174,
      open: true,
    },
  }
})
