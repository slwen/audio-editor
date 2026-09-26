// Runs a TypeScript script that exports `main(args)` with the app's `@/` alias.
// Usage: node scripts/run-ts.mjs scripts/analyze-song.ts [args...]
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
const [script, ...args] = process.argv.slice(2)
if (!script) throw new Error('Usage: node scripts/run-ts.mjs <script.ts> [args...]')
const server = await createServer({
  configFile: false,
  resolve: { alias: [{ find: '@', replacement: fileURLToPath(new URL('../src', import.meta.url)) }] },
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true, include: [] },
})
try {
  const { main } = await server.ssrLoadModule(`/${script.replace(/^\.?\//, '')}`)
  await main(args)
} finally {
  await server.close()
}
