import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

const DB_NAME = 'audio-editor-v1'
const STORE = 'kv'
const SOURCES = 'sources'

type Schema = DBSchema & {
  [STORE]: {
    key: string
    value: unknown
  }
  [SOURCES]: { key: string; value: ArrayBuffer }
}

let dbPromise: Promise<IDBPDatabase<Schema>> | null = null

function getDb(): Promise<IDBPDatabase<Schema>> {
  if (!dbPromise) {
    dbPromise = openDB<Schema>(DB_NAME, 2, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
        if (!db.objectStoreNames.contains(SOURCES)) db.createObjectStore(SOURCES)
      },
    })
  }
  return dbPromise
}

export type PersistedProject = {
  version: 1
  clips: import('@/types').Clip[]
  bufferMeta: import('@/types').BufferMeta[]
  playhead: number
  masterGain: number
  /** bufferId -> array buffer of WAV/encoded? store raw decoded as float32 is huge - store original file bytes */
  fileBytes: Record<string, ArrayBuffer>
}

const writtenSources = new Map<string, ArrayBuffer>()
let writes = Promise.resolve()

function serializeWrite(operation: () => Promise<void>): Promise<void> {
  const next = writes.then(operation)
  writes = next.catch(() => {})
  return next
}

export function saveProject(data: PersistedProject): Promise<void> {
  return serializeWrite(async () => {
    const db = await getDb()
    const tx = db.transaction([STORE, SOURCES], 'readwrite')
    const sources = tx.objectStore(SOURCES)
    const live = new Set(data.bufferMeta.map(meta => meta.id))
    const existing = await sources.getAllKeys()
    for (const id of existing) if (!live.has(id)) void sources.delete(id)
    for (const id of live) {
      const bytes = data.fileBytes[id]
      if (bytes && (writtenSources.get(id) !== bytes || !existing.includes(id))) void sources.put(bytes, id)
    }
    // Small metadata saves no longer serialize all the immutable audio again.
    void tx.objectStore(STORE).put({ ...data, fileBytes: {} }, 'project')
    await tx.done
    writtenSources.clear()
    for (const id of live) if (data.fileBytes[id]) writtenSources.set(id, data.fileBytes[id]!)
  })
}

export async function loadProject(): Promise<PersistedProject | undefined> {
  const db = await getDb()
  const tx = db.transaction([STORE, SOURCES], 'readonly')
  const data = await tx.objectStore(STORE).get('project') as PersistedProject | undefined
  if (!data) return undefined
  const fileBytes: Record<string, ArrayBuffer> = {}
  await Promise.all(data.bufferMeta.map(async ({ id }) => {
    // Legacy version-1 projects migrate atomically on the next save.
    const bytes = data.fileBytes?.[id] ?? await tx.objectStore(SOURCES).get(id)
    if (bytes) fileBytes[id] = bytes
  }))
  await tx.done
  writtenSources.clear()
  for (const [id, bytes] of Object.entries(fileBytes)) writtenSources.set(id, bytes)
  return { ...data, fileBytes }
}

export function clearStoredProject(): Promise<void> {
  return serializeWrite(async () => {
    const db = await getDb()
    const tx = db.transaction([STORE, SOURCES], 'readwrite')
    void tx.objectStore(STORE).delete('project')
    void tx.objectStore(SOURCES).clear()
    await tx.done
    writtenSources.clear()
  })
}
