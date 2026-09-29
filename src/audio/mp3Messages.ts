export type Mp3Request =
  | { kind: 'init'; channels: number; sampleRate: number; bitrateKbps: number }
  | { kind: 'chunk'; left: Float32Array; right?: Float32Array }
  | { kind: 'finish' }

export type Mp3Response =
  | { kind: 'ready' }
  | { kind: 'done'; blob: Blob }
  | { kind: 'error'; error: string }
