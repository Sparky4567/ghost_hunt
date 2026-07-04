const DB_NAME = 'ghost-hunt-field-db'
const DB_VERSION = 1
const STORE_NAME = 'sessions'

let dbPromise

const requestToPromise = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

export const openDatabase = () => {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

  return dbPromise
}

const withStore = async (mode, action) => {
  const db = await openDatabase()
  const transaction = db.transaction(STORE_NAME, mode)
  const store = transaction.objectStore(STORE_NAME)
  const result = await action(store)

  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })

  return result
}

export const listSessions = () =>
  withStore('readonly', async (store) => {
    const records = await requestToPromise(store.getAll())
    return records.sort((a, b) => b.createdAt - a.createdAt)
  })

export const saveSession = (record) =>
  withStore('readwrite', (store) => requestToPromise(store.put(record)))

export const deleteSession = (id) =>
  withStore('readwrite', (store) => requestToPromise(store.delete(id)))

export const importSessions = (records) =>
  withStore('readwrite', async (store) => {
    await Promise.all(records.map((record) => requestToPromise(store.put(record))))
    return records.length
  })

export const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    if (!blob) {
      resolve(null)
      return
    }

    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })

export const dataUrlToBlob = async (dataUrl) => {
  if (!dataUrl) return null
  const response = await fetch(dataUrl)
  return response.blob()
}

export const exportableSession = async (record) => ({
  ...record,
  audioBlob: await blobToDataUrl(record.audioBlob),
  videoBlob: await blobToDataUrl(record.videoBlob),
})

export const importedSession = async (record) => ({
  ...record,
  audioBlob: await dataUrlToBlob(record.audioBlob),
  videoBlob: await dataUrlToBlob(record.videoBlob),
})

export const sqliteStatus = () => ({
  available: false,
  detail:
    'SQLite needs a bundled WASM driver or browser-specific storage backend; IndexedDB is active.',
})
