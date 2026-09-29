import fs from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { gameSongPlugin } from './server/gameSongPlugin'
import { editorStemPlugin } from './server/editorStemPlugin'

const RATINGS_FILE = path.resolve(__dirname, 'loop-ratings.jsonl')

function loopRatingsPlugin(): Plugin {
  return {
    name: 'loop-ratings',
    configureServer(server) {
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
  plugins: [react(), loopRatingsPlugin(), gameSongPlugin(__dirname), editorStemPlugin()],
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
