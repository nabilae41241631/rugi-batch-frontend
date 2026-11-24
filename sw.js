/* ================================================================
   RUGI-BATCH AI — sw.js  (Service Worker)
   Strategi: Cache-First untuk aset statis, Network-First untuk API.
   Versi cache dinaikkan setiap kali ada perubahan berkas statis.
   ================================================================ */
'use strict';

const CACHE_NAME     = 'rugibatch-v1';
const OFFLINE_URL    = '/index.html';

/** Aset statis yang dicache saat install */
const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './sw.js',
];

/* ----------------------------------------------------------------
   INSTALL — cache semua aset statis
   ---------------------------------------------------------------- */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())   // aktifkan SW baru segera
  );
});

/* ----------------------------------------------------------------
   ACTIVATE — hapus cache versi lama
   ---------------------------------------------------------------- */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())  // ambil alih tab yang sudah terbuka
  );
});

/* ----------------------------------------------------------------
   FETCH — strategi berdasarkan tipe request
   ---------------------------------------------------------------- */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Abaikan request non-HTTP/HTTPS (chrome-extension dll.)
  if (!request.url.startsWith('http')) return;

  // === API request (abiliya.pythonanywhere.com) ===
  // Strategi: Network-First, timeout 8 detik, lalu tolak (app.js tangani cache LS)
  if (url.hostname === 'abiliya.pythonanywhere.com') {
    event.respondWith(networkFirst(request));
    return;
  }

  // === Aset statis (file lokal) ===
  // Strategi: Cache-First, fallback ke network, fallback ke offline page
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // === Request lain (CDN font, Tailwind, dll.) ===
  // Strategi: Stale-While-Revalidate
  event.respondWith(staleWhileRevalidate(request));
});

/* ----------------------------------------------------------------
   Helper: Network-First (timeout 8 detik)
   ---------------------------------------------------------------- */
async function networkFirst(request) {
  const timeoutSignal = AbortSignal.timeout
    ? AbortSignal.timeout(8000)
    : (() => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 8000);
        return controller.signal;
      })();

  try {
    const response = await fetch(request, { signal: timeoutSignal });
    return response;
  } catch (_) {
    // Kembalikan 503 agar app.js bisa catch dan pakai cache localStorage
    return new Response(
      JSON.stringify({ error: 'offline', status: 'gagal', message: 'Tidak ada koneksi internet.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/* ----------------------------------------------------------------
   Helper: Cache-First
   ---------------------------------------------------------------- */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (_) {
    // Fallback ke halaman offline jika meminta dokumen HTML
    if (request.destination === 'document') {
      return caches.match(OFFLINE_URL);
    }
    return new Response('Offline', { status: 503 });
  }
}

/* ----------------------------------------------------------------
   Helper: Stale-While-Revalidate
   ---------------------------------------------------------------- */
async function staleWhileRevalidate(request) {
  const cache  = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then(response => {
    if (response && response.status === 200) {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);

  return cached || fetchPromise;
}

/* ----------------------------------------------------------------
   Pesan dari halaman utama (mis. force-update cache)
   ---------------------------------------------------------------- */
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
