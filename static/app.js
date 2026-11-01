"use strict";
// ---------- утилиты
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fl = (x) => String(x).replace(".", ",") + " л";
const uid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2));
const fdt = (ts) => { const d = new Date(ts); return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }) + " " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }); };
const fd = (ts) => (ts ? new Date(ts).toLocaleDateString("ru-RU") : "—");

let S = {
  role: null, drinks: [], shop: "", setup_needed: false, local: false, tls_port: 0,
  offline: true, sync: "LOCAL_ONLY", syncError: "", storageError: "", reauthRequired: false,
};
let C = null;          // открытая карточка клиента
let cart = {};         // drink id -> половинки литра
let selDrink = null;
let busy = false;
let searchMode = "tel";
let lastQuery = "";
let qrFresh = false;
let qrObjectUrl = null;
let CS = { data: null, sort: "paid", q: "", open: null };

const host = location.hostname.toLowerCase();
const isPagesHost = host.endsWith(".github.io") ||
  (location.protocol === "https:" && !["localhost", "127.0.0.1", "::1"].includes(host) &&
   !/^10\./.test(host) && !/^192\.168\./.test(host) && !/^172\.(1[6-9]|2\d|3[01])\./.test(host) &&
   !/^169\.254\./.test(host) && !host.endsWith(".local"));
async function serverAddress() {
  const configured = await Offline.serverUrl();
  if (configured) return configured;
  return isPagesHost ? "" : location.origin;
}
function validateServerAddress(value) {
  let url;
  try { url = new URL(value.trim()); } catch (e) { throw new Error("Введите полный адрес, например https://192.168.1.25:8443"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash ||
      (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("Нужен HTTPS-адрес сервера без пути, например https://192.168.1.25:8443");
  }
  return url.origin;
}
async function apiUrl(path) {
  const base = await serverAddress();
  if (!base) throw new Error("Сначала укажите HTTPS-адрес сервера ноутбука в локальной сети.");
  return base + "/api/" + path;
}
async function api(path, body, mutation) {
  const headers = {};
  const token = await Offline.getAuthToken();
  if (token) headers.Authorization = "Bearer " + token;
  const opt = { credentials: "omit", headers };
  const controller = new AbortController();
  opt.signal = controller.signal;
  const timeout = setTimeout(() => controller.abort(), 15000);
  if (body !== undefined) {
    opt.method = "POST";
    opt.headers = Object.assign(headers, { "Content-Type": "application/json", "X-Requested-With": "pivo" });
    opt.body = JSON.stringify(body);
  }
  let r;
  try { r = await fetch(await apiUrl(path), opt); } catch (e) {
    const err = new Error(mutation ? "Ответ от сервера не получен. Операция могла записаться: проверьте историю клиента. Повторное нажатие безопасно, дубля не будет."
      : "Нет связи с сервером. Проверьте Wi-Fi, HTTPS-сертификат и адрес сервера в локальной сети.");
    err.net = true; throw err;
  } finally {
    clearTimeout(timeout);
  }
  let j = {};
  try { j = await r.json(); } catch (e) { /* не JSON */ }
  if (r.status === 401 && path !== "login") {
    await Offline.clearAuthToken();
    S.reauthRequired = true;
    render();
    const err = new Error("Серверная сессия закончилась. Офлайн-работа и очередь сохранены; войдите снова для синхронизации.");
    err.auth = true; err.status = r.status; throw err;
  }
  if (r.status === 503 && j.locked) { S.locked = j.locked; render(); throw new Error(j.error); }
  if (!r.ok) {
    const err = new Error(j.error || "Ошибка сервера (" + r.status + ")");
    err.status = r.status; throw err;
  }
  return j;
}
async function apiBlob(path) {
  const headers = {};
  const token = await Offline.getAuthToken();
  if (token) headers.Authorization = "Bearer " + token;
  const response = await fetch(await apiUrl(path), { credentials: "omit", headers });
  if (response.status === 401) {
    await Offline.clearAuthToken();
    S.reauthRequired = true;
    render();
    throw new Error("Сессия закончилась. Войдите снова.");
  }
  if (!response.ok) throw new Error("Не удалось получить файл от сервера (" + response.status + ")");
  return response.blob();
}
async function mut(key, path, body) {
  let type = null, customerId = null, payload = body;
  if (path === "customers") {
    type = "register";
    customerId = await Offline.newCustomerId();
  } else if (path.endsWith("/purchase")) {
    type = "purchase";
    customerId = path.split("/")[1];
  } else if (path.endsWith("/redeem")) {
    type = "redemption";
    customerId = path.split("/")[1];
  }
  if (type) {
    const operationId = await Offline.requestIdForKey("offline:" + key);
    const queued = await Offline.enqueue(type, customerId, payload, operationId);
    if (queued.customer && type !== "register") C = queued.customer;
    S.sync = "PENDING";
    S.offline = true;
    await updateOfflineStatus();
    if (type === "register" && S.role && !S.reauthRequired) {
      S.sync = "SYNCING";
      refreshSyncNotice();
      try {
        await synchronizeOperation(operationId);
        await finishSyncState();
      } catch (error) {
        await failSyncState(error);
        scheduleSynchronizationRetry();
      }
    } else {
      retrySynchronization();
    }
    if (type === "register") {
      const syncedCustomer = await Offline.getCustomer(queued.operation.customer_id);
      const stillPending = (await Offline.pending()).some((entry) => entry.operation_id === operationId);
      if (syncedCustomer) syncedCustomer.pending = stillPending;
      return syncedCustomer;
    }
    const syncedCustomer = queued.customer || await Offline.getCustomer(queued.operation.customer_id);
    return {
      customer: syncedCustomer,
      offers: queued.offers || [],
      replay: !!queued.existing,
      pending: true,
      syncError: S.syncError,
    };
  }
  const requestId = await Offline.requestIdForKey(key);
  try {
    const result = await api(path, Object.assign({}, body, { request_id: requestId }), true);
    await Offline.clearRequestIdForKey(key);
    return result;
  } catch (e) {
    if (!e.net) await Offline.clearRequestIdForKey(key);
    throw e;
  }
}
function toast(msg, err) {
  const t = $("#toast");
  t.className = "toast" + (err ? " bad" : "");
  t.innerHTML = `<span class="ic">${err ? "⚠️" : "✓"}</span><span>${esc(msg)}</span>`;
  t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), err ? 6000 : 1800);
}
$("#toast").addEventListener("click", () => ($("#toast").hidden = true));
const fio = (c) => `${c.surname || ""} ${c.name || ""}`.trim();
function modal(html) { const m = $("#modal"); m.innerHTML = "<div>" + html + "</div>"; m.hidden = false; }
function closeModal() {
  $("#modal").hidden = true; $("#modal").innerHTML = ""; stopScan();
  if (qrObjectUrl) URL.revokeObjectURL(qrObjectUrl);
  qrObjectUrl = null;
}
async function guard(fn) {
  if (busy) return; busy = true;
  try { await fn(); } catch (e) { toast(e.message, true); } finally { busy = false; }
}
async function refreshState() {
  const localRole = S.role;
  const state = await api("state");
  Object.assign(S, state);
  if (!S.role && localRole) S.role = localRole;
  if (S.role) await Offline.cacheProducts(S);
}

// ---------- маршрутизация
const route = () => (location.hash.replace(/^#/, "") || "/").split("?")[0].split("/").filter(Boolean);
const go = (h) => { if (location.hash === "#" + h) render(); else location.hash = h; };
window.addEventListener("hashchange", () => { cart = {}; selDrink = null; render(); });

async function boot() {
  try {
    await Offline.open();
    await Offline.persistentStorage();
    if ("serviceWorker" in navigator) registerApplicationWorker();
    const cached = await Offline.bootstrap();
    S.server_url = cached.server_url;
    if (cached.authenticated && cached.config) {
      S.role = "staff";
      S.shop = cached.config.shop;
      S.drinks = cached.config.drinks.filter((drink) => drink.active !== false);
      S.sync = "LOCAL_ONLY";
      S.offline = true;
      await updateOfflineStatus();
    }
    if (isPagesHost && !S.server_url && !S.role) {
      $("#app").innerHTML = viewConnection();
      return;
    }
    await render();
    if (S.server_url) probeServer();
  } catch (e) {
    S.storageError = Offline.storageError ? Offline.storageError.message : e.message;
    $("#app").innerHTML = viewStorageFailure();
    toast(S.storageError, true);
    return;
  }
}

function registerApplicationWorker() {
  navigator.serviceWorker.register("./sw.js").then((registration) => {
    const activateVerifiedUpdate = (worker) => {
      if (worker && worker.state === "installed" && navigator.serviceWorker.controller) {
        worker.postMessage("ACTIVATE_AFTER_VERIFY");
      }
    };
    activateVerifiedUpdate(registration.waiting);
    registration.addEventListener("updatefound", () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => activateVerifiedUpdate(registration.waiting));
    });
    registration.update().catch(() => {});
  }).catch((error) => {
    console.error("Service worker registration failed", error);
  });
}

async function probeServer() {
  try {
    const state = await api("state");
    const wasAuthenticated = !!S.role;
    Object.assign(S, state);
    if (wasAuthenticated) S.role = "staff";
    if (S.role) {
      await Offline.cacheProducts(S);
      await retrySynchronization();
    } else {
      S.sync = "LOCAL_ONLY";
      S.offline = true;
      if (!wasAuthenticated) render();
    }
  } catch (error) {
    S.sync = "LOCAL_ONLY";
    S.offline = true;
    S.syncError = error.message;
    if (S.role) render();
  }
}

function viewStorageFailure() {
  return `<div class="top"><div class="t">Локальные данные недоступны</div></div>
    <div class="warn"><b>Работа остановлена.</b> ${esc(S.storageError || "Не удалось безопасно открыть локальную базу.")}</div>
    <div class="card">Не очищайте данные сайта и не переустанавливайте PWA. Проверьте прежний адрес сайта/браузер или восстановите клиентов с ноутбука. Если операции ожидают отправки, сначала используйте экспорт на исходном устройстве.</div>`;
}

function offlineNotice() {
  if (S.sync === "ONLINE" && !S.pendingCount) return "";
  const states = {
    LOCAL_ONLY: ["Нет связи с сервером.", "Локальные данные доступны; операции останутся на этом телефоне."],
    SYNCING: ["Синхронизация.", "Локальные операции сохранены."],
    PENDING: [`Ожидает синхронизации: ${S.pendingCount}.`, "Операции сохранены на телефоне."],
    SYNC_ERROR: ["Ошибка синхронизации.", "Данные и очередь сохранены; повтор будет выполнен автоматически."],
    CONFLICT: ["Есть конфликт синхронизации.", "Откройте настройки, просмотрите ошибку и экспортируйте очередь."],
  };
  const [heading, detail] = states[S.sync] || states.LOCAL_ONLY;
  return `<div class="warn offline-note"><b>${heading}</b> ${detail}${S.syncError ? `<br>${esc(S.syncError)}` : ""}${S.pendingError ? `<br>⚠ ${esc(S.pendingError)}` : ""}${S.reauthRequired ? `<br><button class="btn sm" data-act="reauth">Войти на сервер снова</button>` : ""}</div>`;
}
function refreshSyncNotice() {
  const notice = document.querySelector(".offline-note");
  const html = offlineNotice();
  if (notice) {
    if (html) notice.outerHTML = html;
    else notice.remove();
  } else if (html) {
    const top = document.querySelector("#app .top");
    if (top) top.insertAdjacentHTML("afterend", html);
  }
}
async function updateOfflineStatus() {
  const entries = await Offline.pending();
  S.pendingCount = entries.length;
  const failed = entries.find((entry) => entry.last_error) || null;
  S.pendingError = failed ? failed.last_error.message : "";
  if (failed && failed.last_error.conflict) S.sync = "CONFLICT";
  else if (S.sync === "ONLINE" && entries.length) S.sync = "PENDING";
}

async function render() {
  const app = $("#app");
  app.style.paddingBottom = "";
  if (S.storageError) return (app.innerHTML = viewStorageFailure());
  if (S.locked) return await viewLocked();
  if (isPagesHost && !(await Offline.serverUrl()) && !S.role) return (app.innerHTML = viewConnection());
  if (S.setup_needed) return (app.innerHTML = viewSetup());
  if (!S.role) return (app.innerHTML = viewLogin());
  const r = route();
  try {
    if (r[0] === "c" && r[1]) return await viewCustomer(r[1]);
    if (r[0] === "new") return (app.innerHTML = viewNew());
    if (r[0] === "stats") return await viewStats("week");
    if (r[0] === "customers") return await viewCustomers();
    if (r[0] === "settings") return await viewSettings();
    app.innerHTML = viewHome(); loadSearch(lastQuery);
  } catch (e) { toast(e.message, true); if (r.length) go("/"); }
}

function hdr(title, back) {
  return `<div class="top">${back ? `<button class="iconbtn" data-act="back">←</button>` : ""}<div class="t">${esc(title)}</div><button class="iconbtn" data-act="menu">☰</button></div>`;
}

// ---------- база повреждена: изменения остановлены, восстановление только на компьютере магазина
async function viewLocked() {
  const L = S.locked;
  let body = `<div class="card">Восстановление выполняется на компьютере магазина: откройте <b>https://localhost:${S.tls_port || 8443}</b> в браузере на этом компьютере.</div>`;
  if (S.local) {
    const rec = await api("recovery").catch(() => null);
    const list = rec ? rec.candidates : [];
    body = `<h2>Выберите копию для восстановления</h2>` + (list.map((c) => `<div class="card"><b>${esc(c.name)}</b><div class="mute">файл от ${fdt(c.mtime)}</div>
      ${c.ok ? `<div style="margin-top:6px">операций: <b>${c.ops}</b> · клиентов: <b>${c.customers}</b><br>последняя операция: <b>${c.last_op_ts ? fdt(c.last_op_ts) : "—"}</b></div>
      <button class="btn primary block" style="margin-top:10px" data-act="rpick" data-k="${esc(c.key)}" data-n="${esc(c.name)}" data-ops="${c.ops}" data-last="${esc(c.last_op_ts || "")}">Восстановить из этой копии</button>`
      : `<div class="warn">Копия повреждена: ${esc(c.error)}</div>`}</div>`).join("") || `<div class="card">Копий не найдено.</div>`);
  }
  $("#app").innerHTML = `<div class="top"><div class="t">⛔ База данных повреждена</div></div>
  <div class="warn"><b>Все изменения остановлены.</b> ${esc(L.reason)}</div>
  <div class="card mute">Ничего не удалено и не перезаписано.${L.saved_copy ? " Исходный файл сохранён отдельно: " + esc(L.saved_copy) + "." : ""}</div>${body}`;
}

// ---------- настройка / вход
function viewSetup() {
  if (!S.local) return `<div class="card center"><h2>Нужна первая настройка</h2><p>Откройте этот сайт на самом компьютере по адресу <b>https://localhost:8443</b> и задайте PIN.</p></div>`;
  return `<div class="top"><div class="t">Первая настройка</div></div>
  <div class="card"><label>Придумайте PIN для входа (4–12 цифр, лучше 6)</label><input id="s_pin" inputmode="numeric" autocomplete="off">
  <p class="mute">PIN нужен продавцу для входа на телефоне. Забыли PIN: удалите файл data/config.json и откройте сайт на ПК — клиенты сохранятся.</p>
  <button class="btn primary block" data-act="setup">Сохранить</button></div>`;
}
function viewLogin() {
  const serverForm = isPagesHost || S.server_url ? `<div class="card"><b>Сервер ноутбука</b>
  <label>HTTPS-адрес в сети Wi-Fi</label><input id="server_url" type="url" inputmode="url" value="${esc(S.server_url || "")}" placeholder="https://192.168.1.25:8443" autocomplete="url">
  <button class="btn block" style="margin-top:10px" data-act="connectserver">Сохранить адрес сервера</button></div>` : "";
  return `<div class="top"><div class="t">${esc(S.shop)}</div></div>
  <div class="card center"><h2>Введите PIN</h2><input id="pin" class="pin" type="password" inputmode="numeric" autocomplete="off">
  <button class="btn primary block" style="margin-top:12px" data-act="login">Войти</button></div>${serverForm}`;
}
function viewConnection() {
  return `<div class="top"><div class="t">Подключение к серверу магазина</div></div>
  <div class="card"><p>Укажите HTTPS-адрес ноутбука, запущенного в той же Wi-Fi сети, например <b>https://192.168.1.25:8443</b>.</p>
  <label>Адрес локального сервера</label><input id="server_url" type="url" inputmode="url" placeholder="https://192.168.1.25:8443" autocomplete="url">
  <p class="mute">Перед подключением установите сертификат ноутбука на iPhone: откройте в Safari адрес сервера с <code>/ca.crt</code>, установите профиль и включите доверие сертификату в настройках iOS.</p>
  <button class="btn primary block" data-act="connectserver">Сохранить и подключиться</button></div>`;
}

// ---------- главная: поиск
function viewHome() {
  return `${hdr(S.shop)}
  ${offlineNotice()}
  ${(S.warnings || []).map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join("")}
  <div class="row"><div class="grow"><input id="q" type="search" inputmode="${searchMode}" placeholder="Телефон или фамилия" autocomplete="off" value="${esc(lastQuery)}"></div>
  <button class="iconbtn" style="height:54px" data-act="mode">${searchMode === "tel" ? "Аб" : "123"}</button></div>
  <div class="row" style="margin-top:10px"><button class="btn grow" data-act="scan">📷 Сканировать QR</button><button class="btn primary grow" data-act="newc">＋ Новый</button></div>
  <div id="results"></div>`;
}
let sTimer;
async function loadSearch(q) {
  lastQuery = q;
  const box = $("#results"); if (!box) return;
  let j;
  if (S.sync !== "ONLINE") {
    try { j = await Offline.search(q); }
    catch (e) { box.innerHTML = `<div class="warn">${esc(e.message)}</div>`; return; }
    if (q !== lastQuery || !$("#results")) return;
    paintSearchResults(box, j);
    return;
  }
  try { j = await api("search?q=" + encodeURIComponent(q)); }
  catch (e) {
    if (!e.net && !e.auth) { toast(e.message, true); return; }
    try { j = await Offline.search(q); S.offline = true; await updateOfflineStatus(); }
    catch (e) { box.innerHTML = `<div class="warn">${esc(e.message)}</div>`; return; }
    S.sync = "LOCAL_ONLY";
  }
  if (!j || q !== lastQuery || !$("#results")) return;
  paintSearchResults(box, j);
}
function paintSearchResults(box, j) {
  if (!j.results.length) {
    box.innerHTML = lastQuery ? `<div class="card center mute">Не найдено.<br><button class="btn primary" style="margin-top:10px" data-act="newc">Зарегистрировать</button></div>` : `<div class="card center mute">Введите номер телефона или фамилию, либо отсканируйте QR</div>`;
    return;
  }
  box.innerHTML = (j.recent ? `<h2>Недавние</h2>` : "") + `<div class="list">` + j.results.map((c) =>
    `<div class="item" data-act="open" data-id="${esc(c.id)}"><div class="grow"><b>${esc(fio(c))}</b><div class="mute">${esc(c.phone_fmt)}</div></div>${c.gifts_avail > 0 ? `<span class="badge">🎁 ${fl(c.gifts_avail)}</span>` : ""}</div>`).join("") + `</div>`;
}

// ---------- регистрация
function viewNew() {
  const q = new URLSearchParams(location.hash.split("?")[1] || "").get("phone") || "";
  return `${hdr("Новый клиент", true)}
  <div class="card"><label>Телефон</label><input id="n_phone" type="tel" inputmode="tel" placeholder="050 123 45 67" value="${esc(q)}">
  <label>Имя</label><input id="n_name" autocomplete="off"><label>Фамилия <span class="mute">(необязательно)</span></label><input id="n_sur" autocomplete="off">
  <button class="btn primary block" style="margin-top:16px" data-act="register">Зарегистрировать</button></div>`;
}
function qrModal(c, fresh) {
  qrFresh = fresh;
  modal(`<h2 class="center">${fresh ? "Клиент добавлен" : "QR-код клиента"}</h2>
  <div class="center"><b>${esc(fio(c))}</b><div class="mute">${esc(c.phone_fmt)}</div></div>
  ${c.pending ? `<div class="warn">Клиент сохранён на телефоне. QR-код появится после синхронизации с сервером.</div>` : `
  <img class="qr" id="qr-image" alt="QR" src="">
  <p class="mute center">В QR записан только код клиента. Клиент сохраняет картинку в телефон; при визите продавец сканирует её кнопкой «Сканировать QR».</p>
  <div class="row"><button class="btn grow" data-act="downloadqr" data-id="${esc(c.id)}">⬇ Скачать</button><button class="btn grow" data-act="shareqr" data-id="${esc(c.id)}">↗ Отправить</button></div>`}
  <button class="btn primary block" style="margin-top:10px" data-act="closem">${fresh ? "Открыть карточку" : "Закрыть"}</button>`);
  if (!c.pending) loadQrImage(c.id);
}
async function loadQrImage(id) {
  try {
    const blob = await apiBlob("qr/" + encodeURIComponent(id) + ".png");
    if ($("#qr-image")) {
      qrObjectUrl = URL.createObjectURL(blob);
      $("#qr-image").src = qrObjectUrl;
    }
  } catch (e) { toast(e.message, true); }
}

// ---------- карточка клиента
async function viewCustomer(id) {
  if (S.sync !== "ONLINE") {
    C = await Offline.getCustomer(id);
    if (C) {
      S.sync = S.sync || "LOCAL_ONLY";
      S.offline = true;
      paintCustomer();
      return;
    }
  }
  try {
    C = await api("customers/" + encodeURIComponent(id));
    await Offline.cacheCustomer(C);
  } catch (e) {
    if (!e.net && !e.auth) throw e;
    S.sync = "LOCAL_ONLY";
    S.offline = true;
    C = await Offline.getCustomer(id);
    if (!C) throw new Error("Клиент не сохранён на этом телефоне. Подключитесь к серверу и повторите.");
  }
  if (S.drinks.length === 1 && !selDrink) selDrink = S.drinks[0].id;
  paintCustomer();
}
function tile(d, per, qty) {
  const p = per[d.id] || { paid: 0, gift_used: 0 };
  return `<button class="tile ${selDrink === d.id ? "on" : ""}" style="--c:${esc(d.color)}" data-act="seld" data-d="${esc(d.id)}">
    <span class="em">${esc(d.emoji)}</span><span class="nm">${esc(d.name)}</span>
    <span class="sub" style="margin-top:auto">куплено ${fl(p.paid)}</span>
    ${qty ? `<span class="qty">+${fl(qty / 2)}</span>` : ""}${p.gift_used > 0 ? `<span class="gf">🎁 ${fl(p.gift_used)}</span>` : ""}</button>`;
}
function progressCard(c) {
  return `<div class="card"><div class="row"><b class="grow">До подарка</b><span>${fl(c.progress)} из 6</span></div>
    <span class="meter" style="display:block;margin-top:8px"><i style="width:${Math.min(100, (c.progress / 6) * 100)}%;background:var(--green)"></i></span>
    <div class="mute" style="margin-top:6px">6 л любого пива = 1 л любого в подарок</div></div>`;
}
function paintCustomer() {
  const c = C, per = Object.fromEntries(c.per_drink.map((p) => [p.drink, p]));
  const sel = S.drinks.find((d) => d.id === selDrink);
  $("#app").innerHTML = `${hdr(fio(c), true)}
  ${offlineNotice()}
  <div class="card"><div class="row"><div class="grow"><div class="mute">${esc(c.phone_fmt)}</div><div class="mute">Клиент с ${fd(c.created)} · визитов: ${c.visits}</div></div>
    ${S.offline || c.pending ? "" : `<button class="iconbtn" data-act="showqr">QR</button><button class="iconbtn" data-act="editc">✎</button>`}</div></div>
  <div class="kpi three"><div><span class="mute">Куплено всего</span><b>${fl(c.total_paid)}</b></div>
    <div><span class="mute">Подарок доступен</span><b style="color:var(--green)">${fl(c.gifts_avail)}</b></div>
    <div><span class="mute">Подарок списан</span><b>${fl(c.gifts_used)}</b></div></div>
  ${c.gifts_avail > 0 ? `<div class="gift"><div class="grow"><b>🎁 Бесплатно: ${fl(c.gifts_avail)}</b><div class="mute">любое пиво, на выбор клиента</div></div><button class="btn green sm" data-act="redeem">Списать</button></div>` : ""}
  ${progressCard(c)}
  <h2>Добавить покупку</h2>
  <div class="tiles">${S.drinks.map((d) => tile(d, per, cart[d.id])).join("")}</div>
  <div class="volhead">${sel ? `${esc(sel.emoji)} ${esc(sel.name)}: сколько литров?` : "Выберите напиток, затем объём"}</div>
  <div class="vols">${[0.5, 1, 1.5, 2, 3].map((v) => `<button class="btn" ${sel ? "" : "disabled"} data-act="vol" data-v="${v}">+${String(v).replace(".", ",")}</button>`).join("")}
    <button class="btn" ${sel && cart[selDrink] ? "" : "disabled"} data-act="volminus">−0,5</button></div>
  <h2>История</h2><div class="card hist">${(c.history || []).map((h) =>
    `<div class="it ${h.undone ? "undone" : ""}"><div class="grow">${h.type === "redeem" ? "🎁 Подарок: " : ""}${h.items.map((i) => esc(i.emoji) + " " + esc(i.name) + " " + fl(i.liters)).join(", ")}
    <div class="mute">${fdt(h.ts)}${h.undone ? " · отменено" : ""}${h.pending ? " · ожидает синхронизации" : ""}</div></div>${h.undone || h.pending || S.offline ? "" : `<button class="btn sm danger" data-act="undo" data-id="${h.id}">Отмена</button>`}</div>`).join("") || `<div class="mute">Пока пусто</div>`}</div>
  ${cartBar()}`;
  fitCart();
}
function fitCart() {   // список покупки закреплён внизу: оставляем под ним место, чтобы страница прокручивалась до конца
  const sb = $(".sticky"), app = $("#app");
  app.style.paddingBottom = sb ? sb.offsetHeight + 16 + "px" : "";
}
window.addEventListener("resize", () => { if ($(".sticky")) fitCart(); });
function cartBar() {
  const ids = Object.keys(cart).filter((k) => cart[k] > 0);
  if (!ids.length) return "";
  const dm = Object.fromEntries(S.drinks.map((d) => [d.id, d]));
  const add = ids.reduce((a, k) => a + cart[k], 0), paid = C.total_paid * 2, gain = Math.floor((paid + add) / 12) - Math.floor(paid / 12);
  const lines = ids.map((id) => `<div class="row" style="margin-bottom:4px"><div class="grow"><b>${esc(dm[id].emoji)} ${esc(dm[id].name)}</b> +${fl(cart[id] / 2)}</div>
    <button class="iconbtn" style="height:36px;min-width:36px" data-act="rmline" data-d="${esc(id)}">✕</button></div>`).join("");
  const tot = `<div class="mute" style="margin-bottom:6px">Всего +${fl(add / 2)} · ${gain ? `<span class="badge">🎁 +${gain} л в подарок</span>` : `будет ${fl(((paid + add) % 12) / 2)} из 6`}</div>`;
  return `<div class="sticky"><div class="in"><div class="cartlines">${lines}</div>${tot}<button class="btn primary block" style="margin-top:6px" data-act="buy">✓ Подтвердить покупку</button></div></div>`;
}

// ---------- списание подарка
let RD = { avail: 0, drink: null, from: false, items: {} };   // items: {drink: половинки литра}
const rdSum = () => Object.values(RD.items).reduce((a, b) => a + b, 0);
function redeemModal(avail, fromPurchase, keep) {
  if (!keep) RD.items = {};
  if (!S.drinks.some((d) => d.id === RD.drink)) RD.drink = (S.drinks.find((d) => d.id === selDrink) || S.drinks[0] || {}).id;
  RD.avail = avail; RD.from = fromPurchase;
  const left = Math.round(avail * 2) - rdSum(), dm = Object.fromEntries(S.drinks.map((d) => [d.id, d])), ids = Object.keys(RD.items);
  const vb = (v) => `<button class="btn" ${left >= v * 2 ? "" : "disabled"} data-act="rvol" data-v="${v}">+${String(v).replace(".", ",")}</button>`;
  modal(`<h2 class="center">🎁 Подарочные литры</h2>
  <p class="center mute">${fromPurchase ? "Предложите клиенту списать бесплатное пиво сейчас. Решает клиент." : "Соберите список: любое пиво, в сумме не больше доступного."}</p>
  <div class="card"><b>Доступно: ${fl(avail)}</b> · осталось выбрать: ${fl(left / 2)}
    <div class="mute" style="margin:10px 0 6px">Пиво:</div>
    <div class="row" style="flex-wrap:wrap;gap:6px">${S.drinks.map((d) => `<button class="btn sm ${RD.drink === d.id ? "primary" : ""}" data-act="rsel" data-d="${esc(d.id)}">${esc(d.emoji)} ${esc(d.name)}${RD.items[d.id] ? " · " + fl(RD.items[d.id] / 2) : ""}</button>`).join("")}</div>
    <div class="vols" style="margin-top:12px">${[0.5, 1, 1.5, 2].map(vb).join("")}
      <button class="btn" ${left > 0 ? "" : "disabled"} data-act="rrest">Весь остаток</button>
      <button class="btn" ${RD.items[RD.drink] ? "" : "disabled"} data-act="rminus">−0,5</button></div></div>
  ${ids.length ? `<div class="card">${ids.map((id) => `<div class="row" style="margin-bottom:4px"><div class="grow"><b>${esc(dm[id] ? dm[id].emoji : "")} ${esc(dm[id] ? dm[id].name : id)}</b> ${fl(RD.items[id] / 2)}</div>
    <button class="iconbtn" style="height:36px;min-width:36px" data-act="rrm" data-d="${esc(id)}">✕</button></div>`).join("")}
    <button class="btn green block" style="margin-top:8px" data-act="doredeem">✓ Подтвердить списание · ${fl(rdSum() / 2)}</button></div>` : ""}
  <button class="btn block" data-act="closem">${fromPurchase ? "Не сейчас — оставить на потом" : "Закрыть"}</button>`);
}
function parseLiters(txt, max) {
  const t = String(txt).trim().replace(",", ".");
  if (!t) return { v: null, err: "" };
  const v = Number(t);
  if (!isFinite(v) || v <= 0) return { v: null, err: "Введите число, например 1,5" };
  if (Math.abs(v * 2 - Math.round(v * 2)) > 1e-9) return { v: null, err: "Количество должно быть кратно 0,5 л" };
  if (v > max) return { v: null, err: "Доступно только " + fl(max) };
  return { v, err: "" };
}
function undoModal(p) {
  const line = (o) => `${o.type === "redeem" ? "🎁 Подарок" : "🍺 Покупка"}: ${o.items.map((i) => esc(i.emoji) + " " + esc(i.name) + " " + fl(i.liters)).join(", ")}<div class="mute">${fdt(o.ts)}</div>`;
  modal(`<h2>Отменить операцию?</h2><div class="card">${line(p.op)}</div>
  ${p.cascade.length ? `<div class="warn"><b>Вместе с ней отменится списание подарка</b>, которое после этого перестанет быть оплаченным:${p.cascade.map((o) => `<div style="margin-top:6px">${line(o)}</div>`).join("")}</div>` : ""}
  <div class="row"><button class="btn grow" data-act="closem">Нет</button><button class="btn danger grow" data-act="undook" data-id="${p.op.id}">Да, отменить</button></div>`);
}

// ---------- статистика магазина
async function viewStats(period) {
  if (S.offline) {
    $("#app").innerHTML = `${hdr("Статистика", true)}${offlineNotice()}<div class="card mute">Статистика магазина будет доступна после подключения к серверу.</div>`;
    return;
  }
  const j = await api("stats?period=" + period), max = Math.max(1, ...j.days.map((d) => d.liters));
  $("#app").innerHTML = `${hdr("Статистика", true)}
  <div class="tabs">${[["today", "Сегодня"], ["week", "7 дней"], ["month", "30 дней"], ["all", "Всё"]].map(([k, n]) => `<button class="chip ${k === period ? "on" : ""}" data-act="period" data-p="${k}">${n}</button>`).join("")}</div>
  <div class="kpi"><div><span class="mute">Продано (оплачено)</span><b>${fl(j.liters_paid)}</b></div><div><span class="mute">Выдано подарком</span><b>${fl(j.gifts_used)}</b></div>
  <div><span class="mute">Покупок</span><b>${j.purchases}</b></div><div><span class="mute">Новых клиентов</span><b>${j.new_customers}</b></div>
  <div><span class="mute">Покупали клиентов</span><b>${j.active_customers}</b></div><div><span class="mute">Подарков ждёт списания</span><b>${fl(j.gifts_pending)}</b></div></div>
  <h2>Литры по дням</h2><div class="card"><div class="bar">${j.days.map((d) => `<i title="${d.day}: ${d.liters} л" style="height:${Math.round((d.liters / max) * 100)}%"></i>`).join("")}</div>
  <div class="row mute" style="justify-content:space-between"><span>${j.days[0].day.slice(5)}</span><span>${j.days[j.days.length - 1].day.slice(5)}</span></div></div>
  <h2>По напиткам</h2><div class="card"><table><tr><th>Напиток</th><th class="n">Оплачено</th><th class="n">Подарок</th></tr>
  ${j.drinks.map((d) => `<tr><td>${esc(d.emoji)} ${esc(d.name)}</td><td class="n">${fl(d.paid)}</td><td class="n">${fl(d.gifts_used)}</td></tr>`).join("") || `<tr><td colspan="3" class="mute">Нет данных</td></tr>`}</table></div>
  <h2>Лучшие клиенты периода</h2><div class="list">${j.top.map((t, i) => `<div class="item" data-act="open" data-id="${esc(t.id)}"><span class="mute">${i + 1}</span><div class="grow">${esc(t.name)}</div><b>${fl(t.liters)}</b></div>`).join("") || `<div class="item mute">Нет данных</div>`}</div>
  <button class="btn block" data-act="nav" data-h="/customers">👥 Все покупатели: полная статистика</button>`;
}

// ---------- все покупатели (отдельная полная статистика)
const SORTS = {
  paid: ["По литрам", (a, b) => b.total_paid - a.total_paid],
  gifts: ["Подарки", (a, b) => b.gifts_avail - a.gifts_avail || b.total_paid - a.total_paid],
  visits: ["Визиты", (a, b) => b.visits - a.visits],
  last: ["Свежие", (a, b) => (b.last_visit || "").localeCompare(a.last_visit || "")],
  name: ["Имя", (a, b) => fio(a).localeCompare(fio(b), "ru")],
};
async function viewCustomers() {
  if (S.offline) {
    $("#app").innerHTML = `${hdr("Все покупатели", true)}${offlineNotice()}<div class="card mute">Полная сводная статистика будет доступна после подключения к серверу. Клиентов можно искать в основном окне.</div>`;
    return;
  }
  CS.data = await api("customers-stats"); CS.open = null;
  const t = CS.data.totals;
  $("#app").innerHTML = `${hdr("Все покупатели", true)}
  <div class="kpi"><div><span class="mute">Покупателей</span><b>${t.customers}</b></div><div><span class="mute">Куплено всего</span><b>${fl(t.paid)}</b></div>
  <div><span class="mute">Подарков заработано</span><b>${t.gifts_earned} л</b></div><div><span class="mute">Подарок списан</span><b>${fl(t.gifts_used)}</b></div>
  <div><span class="mute">Ждёт списания</span><b>${fl(t.gifts_avail)}</b></div><div><span class="mute">Визитов</span><b>${t.visits}</b></div></div>
  <div style="margin-top:12px"><input id="cq" type="search" placeholder="Поиск по имени или телефону" value="${esc(CS.q)}" autocomplete="off"></div>
  <div class="chips" style="margin:10px 0">${Object.entries(SORTS).map(([k, v]) => `<button class="chip ${CS.sort === k ? "on" : ""}" data-act="csort" data-k="${k}">${v[0]}</button>`).join("")}</div>
  <div id="cl" class="list"></div>
  <button class="btn block" data-act="exportcsv">⬇ Выгрузить всех в Excel</button>`;
  paintCl();
}
function paintCl() {
  const q = CS.q.trim().toLowerCase(), qd = q.replace(/\D/g, "");
  let rows = CS.data.customers.filter((c) => !q || (fio(c).toLowerCase().includes(q) || (qd.length >= 3 && c.phone_fmt.replace(/\D/g, "").includes(qd))));
  rows = rows.sort(SORTS[CS.sort][1]);
  const shown = rows.slice(0, 400);
  $("#cl").innerHTML = shown.map((c) => `<div class="rowc ${CS.open === c.id ? "open" : ""}" data-act="rowtoggle" data-id="${esc(c.id)}">
    <div class="row"><div class="grow"><b>${esc(fio(c))}</b><div class="mute">${esc(c.phone_fmt)}</div></div>
    <div style="text-align:right"><b>${fl(c.total_paid)}</b><div class="mute">визитов: ${c.visits}</div></div></div>
    <div class="mute" style="margin-top:4px">${c.gifts_avail > 0 ? `<span class="badge">🎁 ${fl(c.gifts_avail)}</span> ` : ""}заработано ${c.gifts_earned} л · списано ${fl(c.gifts_used)} · был ${fd(c.last_visit)}</div>
    <div class="d">${c.per_drink.map((p) => `<div class="row" style="padding:3px 0"><span class="grow">${esc(p.emoji)} ${esc(p.name)}</span><span>${fl(p.paid)}</span>${p.gift_used > 0 ? `<span class="mute">🎁 ${fl(p.gift_used)}</span>` : ""}</div>`).join("") || `<div class="mute">Покупок ещё не было</div>`}
    <button class="btn primary sm block" style="margin-top:8px" data-act="open" data-id="${esc(c.id)}">Открыть карточку</button></div></div>`).join("")
    || `<div class="item mute">Никого не найдено</div>`;
  if (rows.length > shown.length) $("#cl").insertAdjacentHTML("beforeend", `<div class="item mute">Показаны первые ${shown.length} из ${rows.length}: уточните поиск</div>`);
}

// ---------- настройки
async function viewSettings() {
  const configuredServer = await Offline.serverUrl();
  let j = null;
  if (S.sync === "ONLINE") {
    try { j = await api("settings"); }
    catch (e) { if (!e.net && !e.auth) throw e; }
  }
  await updateOfflineStatus();
  if (!j) {
    const cached = await Offline.bootstrap();
    $("#app").innerHTML = `${hdr("Настройки", true)}${offlineNotice()}
      <div class="card"><b>Сервер ноутбука</b><label>HTTPS-адрес в сети Wi-Fi</label>
      <input id="server_url" type="url" inputmode="url" value="${esc(configuredServer)}" placeholder="https://192.168.1.25:8443" autocomplete="url">
      <button class="btn block" style="margin-top:10px" data-act="connectserver">Сохранить адрес сервера</button>
      <p class="mute">Нужен адрес HTTPS из окна программы. Для смены сервера сначала синхронизируйте или экспортируйте очередь.</p></div>
      <div class="card"><b>Локальные данные</b><div class="mute">Сохранено напитков: ${cached.config ? cached.config.drinks.length : 0}<br>Последний применённый курсор: ${cached.cursor}</div>
      <button class="btn primary block" style="margin-top:10px" data-act="syncnow">Синхронизировать сейчас</button>
      <button class="btn block" style="margin-top:8px" data-act="exportpending">Экспортировать ожидающие операции</button></div>
      ${S.reauthRequired ? `<div class="card"><b>Требуется вход на сервер</b><p class="mute">Локальная сессия и ожидающие операции сохранены.</p><button class="btn primary block" data-act="reauth">Войти на сервер</button></div>` : ""}
      <div class="card mute">PIN и серверные настройки доступны при подключении к компьютеру магазина.</div>`;
    return;
  }
  $("#app").innerHTML = `${hdr("Настройки", true)}
  ${offlineNotice()}
  <div class="card"><b>Напитки и название магазина</b>
  <p class="mute">Список редактируется в файле <b>settings.json</b> (в папке программы) обычным Блокнотом: добавьте строку напитка, сохраните файл и обновите страницу. Название, эмодзи и цвет плитки задаются там же.</p>
  ${j.settings_error ? `<div class="warn">⚠ Ошибка в файле: ${esc(j.settings_error)}<br>Пока она не исправлена, действует прежний список.</div>` : ""}
  <div class="chips">${j.drinks.map((d) => `<span class="chip ${d.active ? "" : "mute"}" style="${d.active ? "" : "opacity:.5"}">${esc(d.emoji)} ${esc(d.name)}${d.active ? "" : " (скрыт)"}</span>`).join("")}</div></div>
  <div class="card"><b>Сменить PIN</b><label>Текущий PIN</label><input id="p_cur" type="password" inputmode="numeric" autocomplete="off">
  <label>Новый PIN (4–12 цифр)</label><input id="p_new" type="password" inputmode="numeric" autocomplete="off">
  <button class="btn primary block" style="margin-top:12px" data-act="savepin">Сохранить PIN</button></div>
  <div class="card"><b>Сервер ноутбука</b><label>HTTPS-адрес в сети Wi-Fi</label>
  <input id="server_url" type="url" inputmode="url" value="${esc(configuredServer)}" placeholder="https://192.168.1.25:8443" autocomplete="url">
  <button class="btn block" style="margin-top:10px" data-act="connectserver">Сохранить адрес сервера</button>
  <p class="mute">Для безопасности смена адреса доступна только при пустой очереди синхронизации. При смене сервера локальный кэш очищается.</p></div>
  <div class="card"><b>Сертификат (чтобы не было предупреждений)</b>
  <div class="mute"><b>iPhone:</b> откройте <a href="${esc((configuredServer || location.origin) + "/ca.crt")}" target="_blank" rel="noopener">сертификат локального сервера</a> → «Разрешить» → Настройки → «Профиль загружен» → Установить. Затем Настройки → Основные → Об этом устройстве → Доверие сертификатам → включите «Pivo Loyalty Local CA». Делается один раз.<br>
  <b>Windows:</b> запустите install-cert.bat из папки программы. После этого перезапустите браузер.<br>
  Сертификат сервера продлевается сам, повторно ставить ничего не нужно.</div></div>
  <div class="card"><b>Резервные копии</b><div class="mute">Копий: ${j.backups}. Последняя: ${esc(j.last_backup || "—")} ${j.backup_ok === true ? "· проверена ✓" : j.backup_ok === false ? "· <b>не прошла проверку</b>: " + esc(j.backup_error) : ""}<br>Папка с данными: ${esc(j.data_dir)}</div>
  <button class="btn block" style="margin-top:10px" data-act="backup">Сделать копию сейчас</button></div>
  <div class="card"><b>Офлайн-синхронизация</b><div class="mute">Ожидает отправки: ${S.pendingCount || 0}</div>
  <button class="btn primary block" style="margin-top:10px" data-act="syncnow">Синхронизировать сейчас</button>
  <button class="btn block" style="margin-top:8px" data-act="exportpending">Экспортировать ожидающие операции</button></div>`;
}

// ---------- сканер QR (камера + запасной вариант: фото)
let scanStream = null, scanOn = false;
function stopScan() { scanOn = false; if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; } }
function onScanned(text) {
  const id = String(text || "").trim().toUpperCase();
  if (!/^[A-Z2-9]{8}$/.test(id)) return false;
  if (navigator.vibrate) navigator.vibrate(60);
  closeModal(); go("/c/" + id); return true;
}
const PHOTO_BTN = `<label class="btn block" for="qrfile">🖼 Сфотографировать QR</label><input id="qrfile" type="file" accept="image/*" capture="environment" hidden>`;
async function startScan() {
  const can = window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
  if (!can) {
    const link = S.tls_port ? `https://${location.hostname}:${S.tls_port}` : "";
    return modal(`<h2 class="center">Сканирование QR</h2>
    <p>Живая камера в браузере работает только на защищённом адресе.${link ? ` Откройте <b>${esc(link)}</b> (если браузер предупредит о сертификате, установите его по инструкции в «Настройки» или в README).` : ""}</p>
    <p class="mute">Пока можно сфотографировать QR клиента:</p><div class="stack">${PHOTO_BTN}<button class="btn block" data-act="closem">Закрыть</button></div>`);
  }
  modal(`<h2 class="center">Наведите камеру на QR клиента</h2><video id="vid" playsinline muted autoplay></video><div class="errtxt center" id="scanmsg"></div>
  <div class="stack" style="margin-top:10px">${PHOTO_BTN}<button class="btn block" data-act="closem">Отмена</button></div>`);
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false });
    const v = $("#vid"); v.srcObject = scanStream; await v.play();
    const cv = document.createElement("canvas"), ctx = cv.getContext("2d", { willReadFrequently: true });
    const det = "BarcodeDetector" in window ? new BarcodeDetector({ formats: ["qr_code"] }) : null;
    scanOn = true; let lastBad = 0;
    const tick = async () => {
      if (!scanOn) return;
      try {
        if (v.videoWidth) {
          let text = null;
          if (det) { const r = await det.detect(v); if (r.length) text = r[0].rawValue; }
          if (!text) { const sc = Math.min(1, 640 / v.videoWidth); cv.width = Math.round(v.videoWidth * sc); cv.height = Math.round(v.videoHeight * sc); ctx.drawImage(v, 0, 0, cv.width, cv.height); text = QRDec.decode(ctx.getImageData(0, 0, cv.width, cv.height)); }
          if (text && onScanned(text)) return;
          if (text && Date.now() - lastBad > 1500) { lastBad = Date.now(); const m = $("#scanmsg"); if (m) m.textContent = "Это не QR клиента"; }
        }
      } catch (e) { /* кадр не готов */ }
      setTimeout(tick, 120);
    };
    tick();
  } catch (e) { toast(e.name === "NotAllowedError" ? "Разрешите доступ к камере для этого сайта в настройках браузера" : "Не удалось включить камеру", true); }
}
async function scanPhoto(file) {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return toast("Не удалось открыть фото", true);
  const cv = document.createElement("canvas"), ctx = cv.getContext("2d", { willReadFrequently: true });
  for (const maxSide of [1000, 640, 1600, 420]) {
    const sc = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    cv.width = Math.round(bmp.width * sc); cv.height = Math.round(bmp.height * sc);
    ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
    const text = QRDec.decode(ctx.getImageData(0, 0, cv.width, cv.height));
    if (text) return onScanned(text) || toast("Это не QR клиента", true);
  }
  toast("QR на фото не найден. Снимите ближе и ровнее", true);
}
document.addEventListener("change", (e) => { if (e.target.id === "qrfile" && e.target.files[0]) guard(() => scanPhoto(e.target.files[0])); });

// ---------- действия
document.addEventListener("input", (e) => {
  const t = e.target;
  if (t.id === "q") { clearTimeout(sTimer); const v = t.value; sTimer = setTimeout(() => loadSearch(v), 180); }
  else if (t.id === "cq") { CS.q = t.value; paintCl(); }

});
document.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.id === "pin") guard(doLogin); });
async function doLogin() {
  const j = await api("login", { pin: $("#pin").value });
  S.role = j.role;
  S.reauthRequired = false;
  await Offline.rememberAuthentication(true, j.token);
  await refreshState();
  try {
    S.sync = "SYNCING";
    await Offline.synchronize(api);
    await finishSyncState();
  } catch (e) {
    await failSyncState(e);
  }
  await updateOfflineStatus();
  render();
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]"); if (!el || el.tagName === "A") return;
  e.preventDefault();
  const a = el.dataset.act, d = el.dataset, run = (fn) => guard(fn);
  switch (a) {
    case "back": return history.length > 1 ? history.back() : go("/");
    case "menu": return modal(`<h2 class="center">Меню</h2><div class="stack">
      <button class="btn block" data-act="nav" data-h="/">🔍 Поиск клиента</button>
      <button class="btn block" data-act="nav" data-h="/stats">📊 Статистика магазина</button>
      <button class="btn block" data-act="nav" data-h="/customers">👥 Все покупатели</button>
      <button class="btn block" data-act="nav" data-h="/settings">⚙ Настройки</button>
      <button class="btn block danger" data-act="logout">Выйти</button>
      <button class="btn block" data-act="closem">Закрыть</button></div>`);
    case "nav": closeModal(); return go(d.h);
    case "rpick": return modal(`<h2>Восстановить базу?</h2><p>Копия: <b>${esc(d.n)}</b><br>В ней ${esc(d.ops)} операций, последняя от <b>${d.last ? fdt(d.last) : "—"}</b>.</p>
      <div class="warn"><b>Операции, сделанные после этого момента, будут потеряны.</b> Повреждённый файл остаётся сохранённым в папке data/corrupt.</div>
      <label>Введите PIN для подтверждения</label><input id="r_pin" type="password" inputmode="numeric" autocomplete="off">
      <div class="stack" style="margin-top:12px"><button class="btn danger block" data-act="rdo" data-k="${esc(d.k)}">Восстановить</button><button class="btn block" data-act="closem">Отмена</button></div>`);
    case "rdo": return run(async () => {
      await api("recovery/restore", { name: d.k, pin: $("#r_pin").value }, true);
      closeModal(); await refreshState(); toast("База восстановлена"); render();
    });
    case "closem": { const f = qrFresh; qrFresh = false; closeModal(); if (f && C) go("/c/" + C.id); return; }
    case "logout": return run(async () => {
      closeModal();
      await api("logout", {}).catch(() => 0);
      await Offline.rememberAuthentication(false);
      S.role = null; S.drinks = []; S.sync = "LOCAL_ONLY"; render();
    });
    case "reauth": return modal(`<h2>Войти на сервер</h2><p class="mute">Локальные данные и ожидающие операции остаются на телефоне.</p>
      <label>PIN</label><input id="reauth_pin" type="password" inputmode="numeric" autocomplete="off">
      <div class="stack" style="margin-top:12px"><button class="btn primary block" data-act="reauthsubmit">Войти</button><button class="btn block" data-act="closem">Отмена</button></div>`);
    case "reauthsubmit": return run(async () => {
      const login = await api("login", { pin: $("#reauth_pin").value });
      await Offline.rememberAuthentication(true, login.token);
      S.reauthRequired = false;
      closeModal();
      await probeServer();
      render();
    });
    case "connectserver": return run(async () => {
      const address = validateServerAddress($("#server_url").value);
      await Offline.setServerUrl(address);
      S.server_url = address;
      S.role = null;
      S.offline = false;
      await Offline.rememberAuthentication(false);
      Object.assign(S, await api("state"));
      toast("Адрес сервера сохранён");
      render();
    });
    case "setup": return run(async () => { await api("setup", { pin: $("#s_pin").value }); await refreshState(); toast("Готово. Войдите с PIN"); render(); });
    case "login": return run(doLogin);
    case "mode": searchMode = searchMode === "tel" ? "text" : "tel"; $("#app").innerHTML = viewHome(); $("#q").focus(); return loadSearch(lastQuery);
    case "open": return go("/c/" + d.id);
    case "newc": { const digits = lastQuery.replace(/\D/g, ""); return go("/new" + (digits.length >= 3 ? "?phone=" + digits : "")); }
    case "scan": return startScan();
    case "register": return run(async () => {
      const f = { phone: $("#n_phone").value, name: $("#n_name").value, surname: $("#n_sur").value };
      C = await mut("reg:" + JSON.stringify(f), "customers", f);
      await updateOfflineStatus();
      toast(C.pending ? "Клиент сохранён на телефоне; ожидает синхронизации" : "Клиент добавлен");
      qrModal(C, true);
    });
    case "showqr": return qrModal(C, false);
    case "shareqr": return run(async () => {
      const b = await apiBlob("qr/" + encodeURIComponent(d.id) + ".png"), f = new File([b], "qr-" + d.id + ".png", { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [f] })) await navigator.share({ files: [f], title: "QR-карта" });
      else toast("Нажмите «Скачать» и отправьте файл клиенту");
    });
    case "downloadqr": return run(async () => {
      const blob = await apiBlob("qr/" + encodeURIComponent(d.id) + ".png");
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = "qr-" + d.id + ".png"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    case "exportcsv": return run(async () => {
      const blob = await apiBlob("export.csv"), url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = "klienty.csv"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    case "seld": selDrink = d.d; return paintCustomer();
    case "vol": if (!selDrink) return toast("Сначала выберите напиток", true); cart[selDrink] = (cart[selDrink] || 0) + Math.round(parseFloat(d.v) * 2); return paintCustomer();
    case "volminus": if (selDrink && cart[selDrink]) { cart[selDrink] -= 1; if (cart[selDrink] <= 0) delete cart[selDrink]; } return paintCustomer();
    case "rmline": delete cart[d.d]; return paintCustomer();
    case "buy": return run(async () => {
      const items = Object.keys(cart).filter((k) => cart[k] > 0).map((k) => ({ drink: k, liters: cart[k] / 2 }));
      const j = await mut("buy:" + C.id + JSON.stringify(items), "customers/" + C.id + "/purchase", { items });
      C = j.customer; cart = {}; await updateOfflineStatus(); paintCustomer();
      toast(C.pending ? "Покупка сохранена на телефоне; ожидает синхронизации" : "Записано");
      if (j.offers.length) redeemModal(j.offers[0].avail, true);
    });
    case "redeem": return redeemModal(C.gifts_avail, false);
    case "rsel": RD.drink = d.d; return redeemModal(RD.avail, RD.from, true);
    case "rvol": RD.items[RD.drink] = (RD.items[RD.drink] || 0) + Math.round(parseFloat(d.v) * 2); return redeemModal(RD.avail, RD.from, true);
    case "rrest": RD.items[RD.drink] = (RD.items[RD.drink] || 0) + Math.round(RD.avail * 2) - rdSum(); return redeemModal(RD.avail, RD.from, true);
    case "rminus": if (RD.items[RD.drink]) { RD.items[RD.drink] -= 1; if (RD.items[RD.drink] <= 0) delete RD.items[RD.drink]; } return redeemModal(RD.avail, RD.from, true);
    case "rrm": delete RD.items[d.d]; return redeemModal(RD.avail, RD.from, true);
    case "doredeem": return run(async () => {
      const items = Object.keys(RD.items).map((k) => ({ drink: k, liters: RD.items[k] / 2 })), body = { items };
      if (!items.length) return toast("Выберите пиво и объём", true);
      const j = await mut("red:" + C.id + JSON.stringify(items), "customers/" + C.id + "/redeem", body);
      C = j.customer; await updateOfflineStatus(); closeModal(); paintCustomer();
      toast(C.pending ? "Списание сохранено на телефоне; ожидает синхронизации" : "Подарок списан");
    });
    case "undo": return run(async () => {
      if (S.sync !== "ONLINE") throw new Error("Отмена доступна после подключения к серверу.");
      return undoModal((await api("ops/" + d.id + "/undo", {})).preview);
    });
    case "undook": return run(async () => {
      const j = await mut("undo:" + d.id, "ops/" + d.id + "/undo", { confirm: true });
      C = j.customer; closeModal(); paintCustomer(); toast("Операция отменена");
    });
    case "editc": return modal(`<h2>Данные клиента</h2><label>Телефон</label><input id="e_phone" value="${esc(C.phone)}"><label>Имя</label><input id="e_name" value="${esc(C.name)}"><label>Фамилия (необязательно)</label><input id="e_sur" value="${esc(C.surname)}">
      <div class="stack" style="margin-top:12px"><button class="btn primary block" data-act="saveedit">Сохранить</button><button class="btn block" data-act="closem">Отмена</button></div>`);
    case "saveedit": return run(async () => {
      C = await api("customers/" + C.id + "/edit", { phone: $("#e_phone").value, name: $("#e_name").value, surname: $("#e_sur").value });
      closeModal(); paintCustomer(); toast("Сохранено");
    });
    case "period": return run(() => viewStats(d.p));
    case "csort": CS.sort = d.k; document.querySelectorAll("[data-act=csort]").forEach((b) => b.classList.toggle("on", b.dataset.k === CS.sort)); return paintCl();
    case "rowtoggle": CS.open = CS.open === d.id ? null : d.id; return paintCl();
    case "savepin": return run(async () => { await api("settings", { current_pin: $("#p_cur").value, new_pin: $("#p_new").value }); toast("PIN изменён"); await viewSettings(); });
    case "backup": return run(async () => { const j = await api("backup", {}); toast("Копия создана: " + j.name); await viewSettings(); });
    case "syncnow": return run(async () => {
      S.sync = "SYNCING";
      refreshSyncNotice();
      try {
        await Offline.synchronize(api);
        await finishSyncState();
        await updateOfflineStatus();
        refreshSyncNotice();
        toast(S.pendingCount ? `Осталось синхронизировать: ${S.pendingCount}` : "Синхронизация завершена");
      } catch (error) {
        await failSyncState(error);
        refreshSyncNotice();
        throw error;
      }
    });
    case "exportpending": return run(async () => { await Offline.exportPending(); toast("Экспорт ожидающих операций создан"); });
  }
});

let retryDelay = 1000, retryTimer = null;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function synchronizeOperation(operationId) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await Offline.synchronize(api);
    const entry = (await Offline.pending()).find((item) => item.operation_id === operationId);
    if (!entry || entry.last_error) return;
    if (result.synchronized === false && result.reason !== "busy") return;
    if (attempt < 19) await wait(250);
  }
}
function scheduleSynchronizationRetry() {
  if (retryTimer || !S.role) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryDelay = Math.min(retryDelay * 2, 300000);
    retrySynchronization();
  }, retryDelay);
}
async function finishSyncState() {
  S.syncError = "";
  S.reauthRequired = false;
  await updateOfflineStatus();
  S.sync = S.pendingError && (await Offline.pending()).some((entry) => entry.last_error && entry.last_error.conflict)
    ? "CONFLICT" : (S.pendingCount ? "PENDING" : "ONLINE");
  S.offline = S.sync !== "ONLINE";
  refreshSyncNotice();
}
async function failSyncState(error) {
  S.syncError = error.message;
  S.reauthRequired = !!error.auth;
  await updateOfflineStatus();
  const entries = await Offline.pending();
  S.sync = entries.some((entry) => entry.last_error && entry.last_error.conflict) ? "CONFLICT"
    : (error.auth ? "SYNC_ERROR" : (error.net ? "LOCAL_ONLY" : "SYNC_ERROR"));
  S.offline = S.sync !== "ONLINE";
  refreshSyncNotice();
}
async function retrySynchronization() {
  if (!S.role || S.reauthRequired) return;
  try {
    S.sync = "SYNCING";
    await Offline.synchronize(api);
    retryDelay = 1000;
    await finishSyncState();
    await updateOfflineStatus();
    const r = route();
    if (r[0] === "c" && r[1]) {
      C = await Offline.getCustomer(r[1]) || C;
      if (C) paintCustomer();
    } else if (r[0] === "settings") {
      await viewSettings();
    } else {
      refreshSyncNotice();
    }
  } catch (e) {
    await failSyncState(e);
    refreshSyncNotice();
    if (e.net) scheduleSynchronizationRetry();
  }
}
window.addEventListener("online", () => { if (S.server_url) retrySynchronization(); });
window.addEventListener("offline", () => { S.sync = "LOCAL_ONLY"; S.offline = true; render(); });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && S.server_url) retrySynchronization();
});
setInterval(() => { if (S.server_url && S.role) retrySynchronization(); }, 30000);

boot();
