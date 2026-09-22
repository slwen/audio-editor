import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
const server = await createServer({
  configFile: false,
  resolve: { alias: [
    { find: '@/loop/detectLoops', replacement: process.env.LOOP_DETECTOR_FILE ?? fileURLToPath(new URL('../src/loop/detectLoops.ts', import.meta.url)) },
    { find: '@', replacement: fileURLToPath(new URL('../src', import.meta.url)) },
  ] },
  server: { middlewareMode: true, hmr: false },
  optimizeDeps: { noDiscovery: true, include: [] },
})
try {
  const { main } = await server.ssrLoadModule('/scripts/eval-ratings.ts')
  await main()
} finally {
  await server.close()
}
