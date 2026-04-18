import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

const DB_NAME = 'audio-editor-v1'
const STORE = 'kv'

type Schema = DBSchema & {
  [STORE]: {
    key: string
    value: unknown
  }
}

let dbPromise: Promise<IDBPDatabase<Schema>> | null = null

function getDb(): Promise<IDBPDatabase<Schema>> {
  if (!dbPromise) {
    dbPromise = openDB<Schema>(DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
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

export async function saveProject(data: PersistedProject): Promise<void> {
  const db = await getDb()
  await db.put(STORE, data, 'project')
}

export async function loadProject(): Promise<PersistedProject | undefined> {
  const db = await getDb()
  const v = await db.get(STORE, 'project')
  return v as PersistedProject | undefined
}

export async function clearStoredProject(): Promise<void> {
  const db = await getDb()
  await db.delete(STORE, 'project')
}
