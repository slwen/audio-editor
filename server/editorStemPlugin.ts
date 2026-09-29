/** Temporary local stem jobs for clips selected in the timeline editor. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { demucsInstalled, DEMUCS_INSTALL, editorStemNames, splitStems, type StemLayout, type StemQuality } from './stems.ts'

const MAX_AUDIO_BYTES = 512 * 1024 * 1024
const JOB_TTL_MS = 60 * 60 * 1000

type Job = {
  dir: string
  layout: StemLayout
  quality: StemQuality
  state: 'running' | 'ready' | 'error'
  progress: number
  message: string
}

function sendJson(res: ServerResponse, value: unknown, status = 200): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(value))
}

async function writeUpload(req: IncomingMessage, destination: string): Promise<void> {
  const handle = await fs.promises.open(destination, 'w')
  let total = 0
  try {
    for await (const part of req) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part)
      total += chunk.length
      if (total > MAX_AUDIO_BYTES) throw new Error('Audio exceeds the 512 MB upload limit.')
      let offset = 0
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset)
        if (!bytesWritten) throw new Error('Could not write uploaded audio.')
        offset += bytesWritten
      }
    }
    if (!total) throw new Error('No audio was uploaded.')
  } finally {
    await handle.close()
  }
}

export function editorStemPlugin(): Plugin {
  const jobs = new Map<string, Job>()
  const remove = (id: string) => {
    const job = jobs.get(id)
    if (!job || job.state === 'running') return false
    jobs.delete(id)
    fs.rmSync(job.dir, { recursive: true, force: true })
    return true
  }

  return {
    name: 'editor-stems',
    configureServer(server) {
      server.middlewares.use('/__editor-stems', (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://local')
        const route = `${req.method} ${url.pathname}`
        const id = url.searchParams.get('id') ?? ''
        void (async () => {
          if (route === 'POST /jobs') {
            const layout = url.searchParams.get('layout')
            if (layout !== 'two' && layout !== 'four') {
              sendJson(res, { error: 'Choose two or four layers.' }, 400)
              return
            }
            const quality = url.searchParams.get('quality') ?? 'standard'
            if (quality !== 'standard' && quality !== 'high') {
              sendJson(res, { error: 'Unknown separation quality.' }, 400)
              return
            }
            if (!demucsInstalled()) {
              sendJson(res, { error: `Demucs is not installed. Run: ${DEMUCS_INSTALL}` }, 503)
              return
            }
            if (Number(req.headers['content-length']) > MAX_AUDIO_BYTES) {
              sendJson(res, { error: 'Audio exceeds the 512 MB upload limit.' }, 413)
              return
            }
            const ext = path.extname(url.searchParams.get('name') ?? '').toLowerCase()
            const safeExt = /^(\.mp3|\.wav|\.flac|\.ogg|\.m4a|\.aac)$/.test(ext) ? ext : '.wav'
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-editor-stems-'))
            try {
              const source = path.join(dir, `source${safeExt}`)
              await writeUpload(req, source)
              const jobId = randomUUID()
              const job: Job = { dir, layout, quality, state: 'running', progress: 0, message: 'Starting separation' }
              jobs.set(jobId, job)
              void splitStems(source, path.join(dir, 'stems'), p => {
                job.progress = p.progress
                job.message = p.message
              }, layout, quality).then(() => {
                job.state = 'ready'
                job.progress = 1
                job.message = 'Layers ready'
              }).catch((err: unknown) => {
                job.state = 'error'
                job.message = err instanceof Error ? err.message : String(err)
              }).finally(() => {
                setTimeout(() => remove(jobId), JOB_TTL_MS).unref()
              })
              sendJson(res, { id: jobId, state: job.state, progress: job.progress, message: job.message })
            } catch (err) {
              fs.rmSync(dir, { recursive: true, force: true })
              throw err
            }
            return
          }

          const job = jobs.get(id)
          if (!job) { sendJson(res, { error: 'Stem job not found.' }, 404); return }
          if (route === 'GET /jobs') {
            sendJson(res, { id, state: job.state, progress: job.progress, message: job.message,
              stems: editorStemNames(job.layout) })
            return
          }
          if (route === 'GET /stem') {
            const stem = url.searchParams.get('stem') ?? ''
            if (!editorStemNames(job.layout).includes(stem)) {
              sendJson(res, { error: 'Unknown stem.' }, 400)
              return
            }
            if (job.state !== 'ready') { sendJson(res, { error: 'Layers are not ready.' }, 409); return }
            const file = path.join(job.dir, 'stems', `${stem}.wav`)
            res.setHeader('Content-Type', 'audio/wav')
            res.setHeader('Content-Length', String(fs.statSync(file).size))
            res.setHeader('Cache-Control', 'no-store')
            fs.createReadStream(file).pipe(res)
            return
          }
          if (route === 'DELETE /jobs') {
            if (!remove(id)) { sendJson(res, { error: 'The split is still running.' }, 409); return }
            sendJson(res, { ok: true })
            return
          }
          next()
        })().catch((err: unknown) => {
          if (!res.headersSent) {
            const message = err instanceof Error ? err.message : String(err)
            sendJson(res, { error: message }, message.includes('upload limit') ? 413 : 500)
          }
        })
      })
    },
  }
}
