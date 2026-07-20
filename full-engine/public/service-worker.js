// Service Worker for PREV Player
// Handles offline support, caching, and auto-updates

const CACHE_NAME = 'prev-player-v1';
const RUNTIME_CACHE = 'prev-runtime-v1';
const ASSET_CACHE = 'prev-assets-v1';

// Files to cache immediately on install
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/index.css',
];

// Install event - cache essential files
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS).catch(() => {
        // It's okay if some files fail to cache (not all may be available)
        return Promise.resolve();
      });
    }).then(() => {
      // Force the waiting service worker to become the active service worker
      return self.skipWaiting();
    })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          // Delete old caches
          if (cacheName !== CACHE_NAME && 
              cacheName !== RUNTIME_CACHE && 
              cacheName !== ASSET_CACHE) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      // Claim all clients immediately
      return self.clients.claim();
    })
  );
});

// Fetch event - network first with fallback to cache
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip chrome extensions and other non-http protocols
  if (!url.protocol.startsWith('http')) {
    return;
  }

  // Strategy: Network first, fall back to cache
  event.respondWith(
    fetch(request)
      .then((response) => {
        // Don't cache non-successful responses
        if (!response || response.status !== 200 || response.type === 'error') {
          return response;
        }

        // Clone the response
        const responseToCache = response.clone();

        // Determine which cache to use
        let cacheName = RUNTIME_CACHE;
        if (request.destination === 'style' || 
            request.destination === 'script' ||
            request.destination === 'font') {
          cacheName = ASSET_CACHE;
        }

        // Cache the response
        caches.open(cacheName).then((cache) => {
          cache.put(request, responseToCache);
        });

        return response;
      })
      .catch(() => {
        // Network request failed, try to get from cache
        return caches.match(request).then((response) => {
          if (response) {
            return response;
          }

          // Return offline page or generic response
          if (request.destination === 'document') {
            return caches.match('/index.html');
          }

          // Return a placeholder for images
          if (request.destination === 'image') {
            return new Response(
              '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="#f0f0f0" width="100" height="100"/></svg>',
              { headers: { 'Content-Type': 'image/svg+xml' } }
            );
          }

          return new Response('Offline - Resource not available', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: new Headers({
              'Content-Type': 'text/plain',
            }),
          });
        });
      })
  );
});

// Handle messages from clients (for auto-update detection)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data && event.data.type === 'CHECK_UPDATE') {
    // Check if a new version is available
    fetch('/index.html').then((response) => {
      if (response.status === 200) {
        // Send update available message to all clients
        self.clients.matchAll().then((clients) => {
          clients.forEach((client) => {
            client.postMessage({
              type: 'UPDATE_AVAILABLE',
            });
          });
        });
      }
    }).catch(() => {
      // No network, can't check for updates
    });
  }
});
