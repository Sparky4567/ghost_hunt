const CACHE_NAME = 'ghost-hunt-v1'
const APP_SHELL = ['/', '/manifest.webmanifest', '/pwa-icon.svg', '/favicon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.allSettled(APP_SHELL.map((url) => cache.add(url))),
      ),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      ),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  const requestUrl = new URL(event.request.url)
  if (!['http:', 'https:'].includes(requestUrl.protocol)) return

  event.respondWith(
    caches
      .match(event.request)
      .then((cached) => {
        if (cached) return cached
        return fetch(event.request).then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone()
            event.waitUntil(
              caches
                .open(CACHE_NAME)
                .then((cache) => cache.put(event.request, copy))
                .catch(() => undefined),
            )
          }
          return response
        })
      })
      .catch(() => fetch(event.request)),
  )
})
