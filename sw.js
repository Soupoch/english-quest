// Service worker : garde l'appli et son contenu en cache pour qu'elle marche même sans réseau.
// Stratégie : on répond tout de suite avec le cache, et on le met à jour en arrière-plan.
const VERSION = "20261024-113751";
const CACHE = "english-quest-" + VERSION;
const FICHIERS = ["./", "index.html", "style.css", "app.js", "config.js", "manifest.webmanifest",
  "icone-180.png", "icone-192.png", "icone-512.png",
  "lecons.json", "vocab.json", "verbes.json", "histoires.json", "cine.json"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FICHIERS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(cles => Promise.all(cles.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;   // la synchro Supabase passe directement
  e.respondWith(caches.open(CACHE).then(async c => {
    const enCache = await c.match(e.request, { ignoreSearch: true });
    const reseau = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => enCache);
    return enCache || reseau;
  }));
});
