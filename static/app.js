"use strict";
// ---------- утилиты
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fl = (x) => String(x).replace(".", ",") + " л";
const uid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2));
const fdt = (ts) => { const d = new Date(ts); return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }) + " " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }); };
const fd = (ts) => (ts ? new Date(ts).toLocaleDateString("ru-RU") : "—");

let S = { role: null, drinks: [], shop: "", setup_needed: false, local: false, tls_port: 0 };
let C = null;          // открытая карточка клиента
let cart = {};         // drink id -> половинки литра
let selDrink = null;
let busy = false;
let searchMode = "tel";
let lastQuery = "";
let qrFresh = false;
let CS = { data: null, sort: "paid", q: "", open: null };

async function api(path, body, mutation) {
  const opt = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "pivo" }, body: JSON.stringify(body) };
  let r;
  try { r = await fetch("/api/" + path, opt); } catch (e) {
    const err = new Error(mutation ? "Ответ от сервера не получен. Операция могла записаться: проверьте историю клиента. Повторное нажатие безопасно, дубля не будет." : "Нет связи с сервером. Проверьте Wi-Fi и что программа на ПК запущена.");
    err.net = true; throw err;
  }
  let j = {};
  try { j = await r.json(); } catch (e) { /* не JSON */ }
  if (r.status === 401 && path !== "login") { S.role = null; render(); throw new Error("Сессия закончилась. Введите PIN."); }
  if (r.status === 503 && j.locked) { S.locked = j.locked; render(); throw new Error(j.error); }
  if (!r.ok) throw new Error(j.error || "Ошибка сервера (" + r.status + ")");
  return j;
}
// Идентификатор операции хранится, пока нет окончательного ответа: повтор после потери ответа не создаёт дубль
let PEND = {};
try { PEND = JSON.parse(sessionStorage.getItem("pend") || "{}"); } catch (e) { PEND = {}; }
const savePend = () => { try { sessionStorage.setItem("pend", JSON.stringify(PEND)); } catch (e) { /* без хранилища ID живёт до перезагрузки */ } };
async function mut(key, path, body) {
  if (!PEND[key]) { PEND[key] = uid(); savePend(); }
  try {
    const j = await api(path, Object.assign({}, body, { request_id: PEND[key] }), true);
    delete PEND[key]; savePend(); return j;
  } catch (e) { if (!e.net) { delete PEND[key]; savePend(); } throw e; }
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
function closeModal() { $("#modal").hidden = true; $("#modal").innerHTML = ""; stopScan(); }
async function guard(fn) {
  if (busy) return; busy = true;
  try { await fn(); } catch (e) { toast(e.message, true); } finally { busy = false; }
}
async function refreshState() { Object.assign(S, await api("state")); }

// ---------- маршрутизация
const route = () => (location.hash.replace(/^#/, "") || "/").split("?")[0].split("/").filter(Boolean);
const go = (h) => { if (location.hash === "#" + h) render(); else location.hash = h; };
window.addEventListener("hashchange", () => { cart = {}; selDrink = null; render(); });

async function boot() { try { await refreshState(); } catch (e) { toast(e.message, true); } render(); }

async function render() {
  const app = $("#app");
  app.style.paddingBottom = "";
  if (S.locked) return await viewLocked();
  if (S.setup_needed) return (app.innerHTML = viewSetup());
  if (!S.role) return (app.innerHTML = viewLogin());
  const r = route();
  try {
    if (r[0] === "c" && r[1]) return await viewCustomer(r[1]);
    if (r[0] === "new") return (app.innerHTML = viewNew());
    if (r[0] === "stats") return await viewStats("week");
    if (r[0] === "customers") return await viewCustomers();
    if (r[0] === "settings") return await viewSettings();
    await refreshState().catch(() => 0);
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
  return `<div class="top"><div class="t">${esc(S.shop)}</div></div>
  <div class="card center"><h2>Введите PIN</h2><input id="pin" class="pin" type="password" inputmode="numeric" autocomplete="off">
  <button class="btn primary block" style="margin-top:12px" data-act="login">Войти</button></div>`;
}

// ---------- главная: поиск
function viewHome() {
  return `${hdr(S.shop)}
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
  const j = await api("search?q=" + encodeURIComponent(q)).catch(() => null);
  if (!j || q !== lastQuery || !$("#results")) return;
  if (!j.results.length) {
    box.innerHTML = q ? `<div class="card center mute">Не найдено.<br><button class="btn primary" style="margin-top:10px" data-act="newc">Зарегистрировать</button></div>` : `<div class="card center mute">Введите номер телефона или фамилию, либо отсканируйте QR</div>`;
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
  <img class="qr" alt="QR" src="/api/qr/${esc(c.id)}.png?t=${Date.now()}">
  <p class="mute center">В QR записан только код клиента. Клиент сохраняет картинку в телефон; при визите продавец сканирует её кнопкой «Сканировать QR».</p>
  <div class="row"><a class="btn grow" href="/api/qr/${esc(c.id)}.png" download="qr-${esc(c.id)}.png">⬇ Скачать</a><button class="btn grow" data-act="shareqr" data-id="${esc(c.id)}">↗ Отправить</button></div>
  <button class="btn primary block" style="margin-top:10px" data-act="closem">${fresh ? "Открыть карточку" : "Закрыть"}</button>`);
}

// ---------- карточка клиента
async function viewCustomer(id) {
  await refreshState();
  C = await api("customers/" + encodeURIComponent(id));
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
  <div class="card"><div class="row"><div class="grow"><div class="mute">${esc(c.phone_fmt)}</div><div class="mute">Клиент с ${fd(c.created)} · визитов: ${c.visits}</div></div>
    <button class="iconbtn" data-act="showqr">QR</button><button class="iconbtn" data-act="editc">✎</button></div></div>
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
    <div class="mute">${fdt(h.ts)}${h.undone ? " · отменено" : ""}</div></div>${h.undone ? "" : `<button class="btn sm danger" data-act="undo" data-id="${h.id}">Отмена</button>`}</div>`).join("") || `<div class="mute">Пока пусто</div>`}</div>
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
  CS.data = await api("customers-stats"); CS.open = null;
  const t = CS.data.totals;
  $("#app").innerHTML = `${hdr("Все покупатели", true)}
  <div class="kpi"><div><span class="mute">Покупателей</span><b>${t.customers}</b></div><div><span class="mute">Куплено всего</span><b>${fl(t.paid)}</b></div>
  <div><span class="mute">Подарков заработано</span><b>${t.gifts_earned} л</b></div><div><span class="mute">Подарок списан</span><b>${fl(t.gifts_used)}</b></div>
  <div><span class="mute">Ждёт списания</span><b>${fl(t.gifts_avail)}</b></div><div><span class="mute">Визитов</span><b>${t.visits}</b></div></div>
  <div style="margin-top:12px"><input id="cq" type="search" placeholder="Поиск по имени или телефону" value="${esc(CS.q)}" autocomplete="off"></div>
  <div class="chips" style="margin:10px 0">${Object.entries(SORTS).map(([k, v]) => `<button class="chip ${CS.sort === k ? "on" : ""}" data-act="csort" data-k="${k}">${v[0]}</button>`).join("")}</div>
  <div id="cl" class="list"></div>
  <a class="btn block" href="/api/export.csv">⬇ Выгрузить всех в Excel</a>`;
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
  const j = await api("settings");
  $("#app").innerHTML = `${hdr("Настройки", true)}
  <div class="card"><b>Напитки и название магазина</b>
  <p class="mute">Список редактируется в файле <b>settings.json</b> (в папке программы) обычным Блокнотом: добавьте строку напитка, сохраните файл и обновите страницу. Название, эмодзи и цвет плитки задаются там же.</p>
  ${j.settings_error ? `<div class="warn">⚠ Ошибка в файле: ${esc(j.settings_error)}<br>Пока она не исправлена, действует прежний список.</div>` : ""}
  <div class="chips">${j.drinks.map((d) => `<span class="chip ${d.active ? "" : "mute"}" style="${d.active ? "" : "opacity:.5"}">${esc(d.emoji)} ${esc(d.name)}${d.active ? "" : " (скрыт)"}</span>`).join("")}</div></div>
  <div class="card"><b>Сменить PIN</b><label>Текущий PIN</label><input id="p_cur" type="password" inputmode="numeric" autocomplete="off">
  <label>Новый PIN (4–12 цифр)</label><input id="p_new" type="password" inputmode="numeric" autocomplete="off">
  <button class="btn primary block" style="margin-top:12px" data-act="savepin">Сохранить PIN</button></div>
  <div class="card"><b>Сертификат (чтобы не было предупреждений)</b>
  <div class="mute"><b>iPhone:</b> откройте <a href="/ca.crt">/ca.crt</a> → «Разрешить» → Настройки → вверху «Профиль загружен» → Установить. Затем Настройки → Основные → Об этом устройстве → Доверие сертификатам → включите «Pivo Loyalty Local CA». Делается один раз.<br>
  <b>Windows:</b> запустите install-cert.bat из папки программы. После этого перезапустите браузер.<br>
  Сертификат сервера продлевается сам, повторно ставить ничего не нужно.</div></div>
  <div class="card"><b>Резервные копии</b><div class="mute">Копий: ${j.backups}. Последняя: ${esc(j.last_backup || "—")} ${j.backup_ok === true ? "· проверена ✓" : j.backup_ok === false ? "· <b>не прошла проверку</b>: " + esc(j.backup_error) : ""}<br>Папка с данными: ${esc(j.data_dir)}</div>
  <button class="btn block" style="margin-top:10px" data-act="backup">Сделать копию сейчас</button></div>`;
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
async function doLogin() { const j = await api("login", { pin: $("#pin").value }); S.role = j.role; await refreshState(); render(); }

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
    case "logout": return run(async () => { closeModal(); await api("logout", {}); S.role = null; S.drinks = []; render(); });
    case "setup": return run(async () => { await api("setup", { pin: $("#s_pin").value }); await refreshState(); toast("Готово. Войдите с PIN"); render(); });
    case "login": return run(doLogin);
    case "mode": searchMode = searchMode === "tel" ? "text" : "tel"; $("#app").innerHTML = viewHome(); $("#q").focus(); return loadSearch(lastQuery);
    case "open": return go("/c/" + d.id);
    case "newc": { const digits = lastQuery.replace(/\D/g, ""); return go("/new" + (digits.length >= 3 ? "?phone=" + digits : "")); }
    case "scan": return startScan();
    case "register": return run(async () => {
      const f = { phone: $("#n_phone").value, name: $("#n_name").value, surname: $("#n_sur").value };
      C = await mut("reg:" + JSON.stringify(f), "customers", f);
      toast(C.replay ? "Клиент уже был добавлен: повтор не создан" : "Клиент добавлен"); qrModal(C, true);
    });
    case "showqr": return qrModal(C, false);
    case "shareqr": return run(async () => {
      const b = await (await fetch("/api/qr/" + d.id + ".png")).blob(), f = new File([b], "qr-" + d.id + ".png", { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [f] })) await navigator.share({ files: [f], title: "QR-карта" });
      else toast("Нажмите «Скачать» и отправьте файл клиенту");
    });
    case "seld": selDrink = d.d; return paintCustomer();
    case "vol": if (!selDrink) return toast("Сначала выберите напиток", true); cart[selDrink] = (cart[selDrink] || 0) + Math.round(parseFloat(d.v) * 2); return paintCustomer();
    case "volminus": if (selDrink && cart[selDrink]) { cart[selDrink] -= 1; if (cart[selDrink] <= 0) delete cart[selDrink]; } return paintCustomer();
    case "rmline": delete cart[d.d]; return paintCustomer();
    case "buy": return run(async () => {
      const items = Object.keys(cart).filter((k) => cart[k] > 0).map((k) => ({ drink: k, liters: cart[k] / 2 }));
      const j = await mut("buy:" + C.id + JSON.stringify(items), "customers/" + C.id + "/purchase", { items });
      C = j.customer; cart = {}; paintCustomer(); toast(j.replay ? "Эта покупка уже была записана: повтор не создан" : "Записано");
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
      C = j.customer; closeModal(); paintCustomer(); toast(j.replay ? "Это списание уже было записано: повтор не создан" : "Подарок списан");
    });
    case "undo": return run(async () => undoModal((await api("ops/" + d.id + "/undo", {})).preview));
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
  }
});

boot();
