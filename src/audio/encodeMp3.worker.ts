import { createMp3Encoder } from './encodeMp3'
import type { Mp3Request, Mp3Response } from './mp3Messages'

let encoder: ReturnType<typeof createMp3Encoder> | undefined
const reply = (message: Mp3Response) => self.postMessage(message)
self.onmessage = (event: MessageEvent<Mp3Request>) => {
  try {
    const message = event.data
    if (message.kind === 'init') {
      encoder = createMp3Encoder(message.channels, message.sampleRate, message.bitrateKbps)
      reply({ kind: 'ready' })
    } else if (message.kind === 'chunk') {
      if (!encoder) throw new Error('Encoder not initialized')
      encoder.append(message.left, message.right)
      reply({ kind: 'ready' })
    } else {
      if (!encoder) throw new Error('Encoder not initialized')
      reply({ kind: 'done', blob: encoder.finish() })
      encoder = undefined
    }
  } catch (error) {
    reply({ kind: 'error', error: error instanceof Error ? error.message : 'MP3 encoding failed' })
  }
}
