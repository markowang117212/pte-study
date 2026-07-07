const C = "pte-v1";
const ASSETS = ["./", "./index.html", "./app.js", "./bank.js", "./manifest.json", "./icon-192.png", "./icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(C).then(c => c.addAll(ASSETS))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(fetch(e.request).then(res => { const cl = res.clone(); caches.open(C).then(c => c.put(e.request, cl)); return res; }).catch(() => caches.match(e.request)));
});
