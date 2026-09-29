/**
 * Dev-server endpoints for the Game song screen: import a song, split stems, serve them, keep wrap ratings,
 * and export the game files. Everything lives under /__game-song.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { demucsInstalled, DEMUCS_INSTALL, splitStems, stemFiles, stemsReady } from './stems.ts'
import { exportGameSong } from './exportGameSong.ts'
import { isExportRequest, type StemStatus } from '../src/gameSong/api.ts'
import { gameSongRatings, isGameSongRating, mergeRatedJoins, oldPackApprovedJoins, oldPackRatings } from '../src/gameSong/ratings.ts'

const AUDIO = /\.(mp3|wav|flac|ogg|m4a|aac)$/i

type SplitJob = { state: 'running' | 'error'; progress: number; message: string }

function sendJson(res: ServerResponse, value: unknown, status = 200) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(value))
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { body += chunk; if (body.length > limit) { req.destroy(); reject(new Error('Too large')) } })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

export function gameSongPlugin(root: string): Plugin {
  const songsDir = path.join(root, 'sample_songs')
  const analysisDir = path.join(root, 'analysis')
  const ratingsFile = path.join(root, 'game-song-ratings.jsonl')
  const stagingRoot = path.join(os.tmpdir(), 'audio-editor-game-song')
  const jobs = new Map<string, SplitJob>()
  const read = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''

  const songName = (value: string | null) => {
    const name = path.basename(value ?? '')
    return name && AUDIO.test(name) ? name : null
  }
  const baseName = (name: string) => name.replace(/\.[^.]+$/, '')
  const layersDir = (name: string) => path.join(analysisDir, `${baseName(name)}.layers`)

  const status = (name: string): StemStatus => {
    const job = jobs.get(name)
    const common = { demucsInstalled: demucsInstalled(), installCommand: DEMUCS_INSTALL }
    if (job?.state === 'running') return { ...common, state: 'running', progress: job.progress, message: job.message }
    if (stemsReady(path.join(songsDir, name), layersDir(name))) {
      const version = Object.values(stemFiles(layersDir(name))).map(file => {
        const stat = fs.statSync(file)
        return `${stat.size}-${stat.mtimeMs}`
      }).join('_')
      return { ...common, state: 'ready', progress: 1, message: 'Stems ready', version }
    }
    if (job?.state === 'error') return { ...common, state: 'error', progress: 0, message: job.message }
    return { ...common, state: 'missing', progress: 0, message: 'Not split yet' }
  }

  return {
    name: 'game-song',
    configureServer(server) {
      server.middlewares.use('/__game-song', (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://local')
        const route = `${req.method} ${url.pathname}`
        const source = songName(url.searchParams.get('source'))
        void (async () => {
          switch (route) {
            case 'GET /songs': {
              const names = fs.existsSync(songsDir) ? fs.readdirSync(songsDir).filter(n => AUDIO.test(n)).sort() : []
              sendJson(res, names.map(name => ({ name, stems: status(name).state === 'ready' })))
              return
            }
            case 'POST /import': {
              const name = songName(url.searchParams.get('name'))
              if (!name) { sendJson(res, { error: 'Only audio files can be imported.' }, 400); return }
              const chunks: Buffer[] = []
              for await (const chunk of req) chunks.push(chunk as Buffer)
              const bytes = Buffer.concat(chunks)
              const file = path.join(songsDir, name)
              fs.mkdirSync(songsDir, { recursive: true })
              // Rewriting an identical file would make existing stems look stale.
              if (!fs.existsSync(file) || fs.statSync(file).size !== bytes.length) fs.writeFileSync(file, bytes)
              sendJson(res, { name, stems: status(name) })
              return
            }
            case 'GET /status': {
              if (!source) { sendJson(res, { error: 'Unknown song' }, 400); return }
              sendJson(res, status(source))
              return
            }
            case 'POST /split': {
              if (!source) { sendJson(res, { error: 'Unknown song' }, 400); return }
              const song = path.join(songsDir, source)
              if (!fs.existsSync(song)) { sendJson(res, { error: 'Import the song first.' }, 404); return }
              const current = status(source)
              if (current.state === 'running' || current.state === 'ready') { sendJson(res, current); return }
              if (!demucsInstalled()) { sendJson(res, current); return }
              const job: SplitJob = { state: 'running', progress: 0, message: 'Starting' }
              jobs.set(source, job)
              splitStems(song, layersDir(source), p => { job.progress = p.progress; job.message = p.message })
                .then(summary => { server.config.logger.info(summary); jobs.delete(source) })
                .catch((err: unknown) => {
                  jobs.set(source, { state: 'error', progress: 0, message: err instanceof Error ? err.message : String(err) })
                })
              sendJson(res, status(source))
              return
            }
            case 'GET /stem': {
              const stem = url.searchParams.get('stem')
              if (!source || (stem !== 'base' && stem !== 'top')) { sendJson(res, { error: 'Unknown stem' }, 400); return }
              const file = stemFiles(layersDir(source))[stem]
              if (!fs.existsSync(file)) { sendJson(res, { error: 'Stems not split yet' }, 404); return }
              const stat = fs.statSync(file)
              const etag = `W/"${stat.size}-${stat.mtimeMs}"`
              res.setHeader('Content-Type', 'audio/wav')
              res.setHeader('Cache-Control', 'private, no-cache')
              res.setHeader('ETag', etag)
              res.setHeader('Last-Modified', stat.mtime.toUTCString())
              if (req.headers['if-none-match']?.split(',').map(value => value.trim()).includes(etag)) {
                res.statusCode = 304
                res.end()
                return
              }
              res.setHeader('Content-Length', String(stat.size))
              const stream = fs.createReadStream(file)
              res.on('close', () => stream.destroy())
              stream.on('error', () => res.destroy())
              stream.pipe(res)
              return
            }
            case 'GET /ratings': {
              if (!source) { sendJson(res, { error: 'Unknown song' }, 400); return }
              const older = [...oldPackApprovedJoins(read(path.join(analysisDir, `${baseName(source)}.pack.json`))),
                ...oldPackRatings(read(path.join(root, 'pack-ratings.jsonl')), source)]
              const current = [...gameSongRatings(read(ratingsFile), source).values()]
              sendJson(res, { current, all: mergeRatedJoins(current, older) })
              return
            }
            case 'POST /ratings': {
              const record: unknown = JSON.parse(await readBody(req, 10_000))
              if (!isGameSongRating(record)) { sendJson(res, { error: 'Invalid rating' }, 400); return }
              fs.appendFileSync(ratingsFile, `${JSON.stringify(record)}\n`)
              sendJson(res, { ok: true })
              return
            }
            case 'POST /export': {
              const request: unknown = JSON.parse(await readBody(req, 20_000))
              if (!isExportRequest(request) || !songName(request.sourceName)) { sendJson(res, { error: 'Invalid export request' }, 400); return }
              sendJson(res, await exportGameSong(request, layersDir(request.sourceName), stagingRoot))
              return
            }
            case 'GET /exported': {
              const id = path.basename(url.searchParams.get('id') ?? '')
              const file = path.basename(url.searchParams.get('file') ?? '')
              const full = path.join(stagingRoot, id, file)
              if (!id || !file || !fs.existsSync(full)) { sendJson(res, { error: 'Export again first' }, 404); return }
              res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'audio/mpeg')
              res.setHeader('Cache-Control', 'no-store')
              fs.createReadStream(full).pipe(res)
              return
            }
            default:
              next()
          }
        })().catch((err: unknown) => {
          if (!res.headersSent) sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500)
        })
      })
    },
  }
}
