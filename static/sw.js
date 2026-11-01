"use strict";

const CACHE = "pivo-shell-v5";
const BASE = new URL(".", self.registration.scope);
const LOCAL_ADMIN_HOST = new Set(["localhost", "127.0.0.1", "::1"]).has(self.location.hostname);
const APP_SHELL = [
  ...(LOCAL_ADMIN_HOST ? [] : [""]),
  "index.html", "style.css", "qrdec.js", "offline.js", "app.js",
  "manifest.webmanifest", "icon.svg", "icon-180.png", "icon-192.png", "icon-512.png",
].map((path) => new URL(path, BASE).href);
const APP_PATHS = new Set(APP_SHELL.map((path) => new URL(path).pathname));

async function verifyShellCache() {
  const cache = await caches.open(CACHE);
  for (const url of APP_SHELL) {
    const response = await cache.match(url);
    if (!response || !response.ok) return false;
  }
  return true;
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE)
    .then((cache) => cache.addAll(APP_SHELL))
    .then(async () => {
      if (!(await verifyShellCache())) throw new Error("Incomplete PWA application shell");
    }));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    if (!(await verifyShellCache())) throw new Error("Refusing to activate an incomplete PWA application shell");
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith("pivo-shell-") && key !== CACHE)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data !== "ACTIVATE_AFTER_VERIFY") return;
  event.waitUntil(verifyShellCache().then((valid) => {
    if (valid) return self.skipWaiting();
    throw new Error("Refusing to activate an incomplete PWA application shell");
  }));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin ||
      url.pathname.startsWith("/api/") || url.pathname === "/ca.crt") return;
  if (LOCAL_ADMIN_HOST && (url.pathname === "/" || url.pathname === "/admin.html")) return;
  if (!APP_PATHS.has(url.pathname) && request.mode !== "navigate") return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request) ||
      (request.mode === "navigate" ? await cache.match(new URL("index.html", BASE).href) : null);
    if (cached) {
      event.waitUntil(fetch(request).then(async (response) => {
        if (response.ok && APP_PATHS.has(url.pathname)) await cache.put(request, response);
      }).catch(() => {}));
      return cached;
    }
    try {
      const response = await fetch(request);
      if (response.ok && APP_PATHS.has(url.pathname)) await cache.put(request, response.clone());
      return response;
    } catch (error) {
      throw error;
    }
  })());
});
