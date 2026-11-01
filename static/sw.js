"use strict";

const CACHE = "pivo-shell-v2";
const BASE = new URL(".", self.registration.scope);
const APP_SHELL = [
  "", "index.html", "style.css", "qrdec.js", "offline.js", "app.js",
  "manifest.webmanifest", "icon.svg", "icon-180.png", "icon-192.png", "icon-512.png",
].map((path) => new URL(path, BASE).href);
const APP_PATHS = new Set(APP_SHELL.map((path) => new URL(path).pathname));

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith("pivo-shell-") && key !== CACHE).map((key) => caches.delete(key)),
  )).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin ||
      url.pathname.startsWith("/api/") || url.pathname === "/ca.crt") return;
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok && APP_PATHS.has(url.pathname)) {
        const cache = await caches.open(CACHE);
        await cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      const cached = await caches.match(request) || (request.mode === "navigate" ? await caches.match(new URL("index.html", BASE).href) : null);
      if (cached) return cached;
      throw error;
    }
  })());
});
