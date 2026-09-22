import fs from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { isTransitionRating, parseTransitionRatings, transitionRecordKey } from './src/adaptive/transitionRatings'

const RATINGS_FILE = path.resolve(__dirname, 'loop-ratings.jsonl')

function loopRatingsPlugin(): Plugin {
  return {
    name: 'loop-ratings',
    configureServer(server) {
      const transitionFile = path.resolve(__dirname, 'transition-ratings.jsonl')
      server.middlewares.use('/__transition-ratings', (req, res, next) => {
        if (req.method === 'GET') {
          res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          res.end(fs.existsSync(transitionFile) ? fs.readFileSync(transitionFile, 'utf8') : '')
          return
        }
        if (req.method !== 'POST') { next(); return }
        let body = ''
        req.setEncoding('utf8')
        req.on('data', (chunk: string) => { body += chunk; if (body.length > 100_000) req.destroy() })
        req.on('end', () => {
          try {
            const record: unknown = JSON.parse(body)
            if (!isTransitionRating(record)) { res.statusCode = 400; res.end('Invalid transition rating'); return }
            const key = transitionRecordKey(record)
            // Other local dev-server instances may have appended since this server started.
            const known = new Set(parseTransitionRatings(fs.existsSync(transitionFile)
              ? fs.readFileSync(transitionFile, 'utf8') : '').map(transitionRecordKey))
            if (!known.has(key)) { fs.appendFileSync(transitionFile, `${JSON.stringify(record)}\n`); known.add(key) }
            res.end('ok')
          } catch { res.statusCode = 500; res.end('Could not save transition rating') }
        })
      })
      server.middlewares.use('/__loop-ratings', (req, res, next) => {
        if (req.method === 'GET') {
          res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
          res.end(fs.existsSync(RATINGS_FILE) ? fs.readFileSync(RATINGS_FILE, 'utf8') : '')
          return
        }
        if (req.method !== 'POST') {
          next()
          return
        }
        let body = ''
        req.setEncoding('utf8')
        req.on('data', (chunk: string) => {
          body += chunk
          if (body.length > 8000) req.destroy()
        })
        req.on('end', () => {
          const line = body.trim()
          if (!line.startsWith('{') || !line.endsWith('}')) {
            res.statusCode = 400
            res.end('expected one json object')
            return
          }
          fs.appendFileSync(RATINGS_FILE, `${line}\n`)
          res.setHeader('Content-Type', 'text/plain; charset=utf-8')
          res.end('ok')
        })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), loopRatingsPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
