import { copyFileSync, mkdirSync } from 'node:fs'
import { defineConfig } from 'vite'

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

export default defineConfig({
  plugins: [leadsDashboard()],
  server: {
    port: 5174,
    open: true,
  },
})
