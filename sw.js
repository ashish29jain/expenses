// Keeps the app on the phone so it opens instantly and works offline.
// Bump VERSION (and APP_VERSION in app.js) whenever you upload a new version of the app.
const VERSION = 'expenses-v12';
const CHART_JS = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png', CHART_JS];

self.addEventListener('install', e => {
  // cache: 'reload' = always download fresh files, never reuse the browser's (possibly old) copy.
  e.waitUntil(caches.open(VERSION)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// App files only: answer from the phone's copy straight away, refresh it in the background.
// Calls to the Google Sheet (POST) are never cached.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope);
  const own = url.origin === location.origin && SHELL.includes(url.pathname.slice(scope.pathname.length) || './');
  if (req.mode !== 'navigate' && !own && req.url !== CHART_JS) return; // only the app's own files
  const key = req.mode === 'navigate' ? 'index.html' : req;
  e.respondWith(caches.open(VERSION).then(async cache => {
    const hit = await cache.match(key, { ignoreSearch: true });
    // Background refresh asks GitHub whether the file changed (no-cache), instead of reusing an old copy.
    const fresh = fetch(req.url === CHART_JS ? req : new Request(req.mode === 'navigate' ? 'index.html' : req.url, { cache: 'no-cache' })).then(res => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    }).catch(() => hit);
    if (hit) { e.waitUntil(fresh); return hit; }
    return fresh;
  }));
});
