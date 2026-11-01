"use strict";
const root = document.querySelector("#admin");
const toastEl = document.querySelector("#toast");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let state = null;
let drinks = [];
let toastTimer;

function toast(message, error = false) {
  toastEl.textContent = message;
  toastEl.className = "toast" + (error ? " bad" : "");
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4500);
}

async function api(path, body) {
  const options = { credentials: "same-origin", headers: {} };
  if (body !== undefined) {
    options.method = "POST";
    options.headers = { "Content-Type": "application/json", "X-Requested-With": "pivo" };
    options.body = JSON.stringify(body);
  }
  const response = await fetch("/api/" + path, options);
  let result = {};
  try { result = await response.json(); } catch (_) { /* report the HTTP error below */ }
  if (!response.ok) throw new Error(result.error || `Ошибка сервера (${response.status})`);
  return result;
}

function renderGate() {
  const setup = state.setup_needed;
  root.innerHTML = `<header class="admin-head"><h1>Панель управления</h1></header>
    <section class="admin-card">
      <h2>${setup ? "Первичная настройка" : "Вход администратора"}</h2>
      <p class="admin-help">${setup
        ? "Создайте PIN для входа в панель и приложение на телефоне. PIN хранится на ноутбуке в виде хеша."
        : "Войдите с PIN, который используется в приложении лояльности."}</p>
      <form id="gate-form">
        <label for="gate-pin">${setup ? "Новый PIN (4–12 цифр)" : "PIN"}</label>
        <input id="gate-pin" type="password" inputmode="numeric" autocomplete="current-password" required>
        <p id="gate-error" class="admin-error"></p>
        <button class="btn primary block" type="submit">${setup ? "Создать PIN" : "Войти"}</button>
      </form>
    </section>`;
}

function drinkRow(drink, index) {
  return `<div class="drink-row" data-drink="${index}">
    <label>ID<input name="drink-id" maxlength="40" value="${esc(drink.id)}" required></label>
    <label>Название<input name="drink-name" maxlength="40" value="${esc(drink.name)}" required></label>
    <label class="drink-color">Цвет<input name="drink-color" type="color" value="${/^#[0-9a-f]{6}$/i.test(drink.color) ? drink.color : "#d97706"}"></label>
    <label>Эмодзи<input name="drink-emoji" maxlength="8" value="${esc(drink.emoji)}"></label>
    <label class="drink-active"><input name="drink-active" type="checkbox" ${drink.active ? "checked" : ""}> В продаже</label>
    <button class="btn danger sm drink-remove" type="button" data-remove="${index}" aria-label="Удалить напиток">×</button>
  </div>`;
}

function renderDashboard() {
  const cfg = state.settings;
  drinks = cfg.drinks.map((drink) => ({ ...drink }));
  const status = state.runtime;
  const syncStatus = status.device_id
    ? `Телефон зарегистрирован · операций на сервере: ${status.cursor}`
    : "Телефон ещё не зарегистрирован для синхронизации";
  const backupStatus = status.backup_error
    ? `<div class="status-line warn">Ошибка резервной копии: ${esc(status.backup_error)}</div>`
    : `<div class="status-line">${status.backup_ok === false ? "Последняя резервная копия не прошла проверку" : "Проверено копий: " + status.backup_count}${status.last_backup ? " · последняя: " + esc(status.last_backup) : ""}</div>`;
  root.innerHTML = `<header class="admin-head"><h1>Управление программой лояльности</h1>
    <button class="btn sm" type="button" data-action="logout">Выйти</button></header>
    ${state.settings_error ? `<div class="status-line warn">Ошибка settings.json: ${esc(state.settings_error)}. Проверьте конфигурацию.</div>` : ""}
    ${status.locked ? `<div class="status-line warn">База заблокирована: ${esc(status.locked.reason)}. Для проверки и восстановления копии откройте <a href="/index.html">локальный экран восстановления</a>.</div>` : ""}
    <form id="config-form">
      <div class="admin-grid">
        <section class="admin-card">
          <h2>Название и программа лояльности</h2>
          <label>Название приложения / магазина<input name="shop" maxlength="60" value="${esc(cfg.shop)}" required></label>
          <label>Оплаченных литров до награды<input name="paid-liters" type="number" min="0.5" max="1000" step="0.5" value="${cfg.loyalty.paid_liters}" required></label>
          <label>Бесплатных литров за награду<input name="reward-liters" type="number" min="0.5" max="1000" step="0.5" value="${cfg.loyalty.reward_liters}" required></label>
          <p class="admin-help">Изменение правила лояльности пересчитывает баланс по всей истории. Сначала создайте резервную копию.</p>
        </section>
        <section class="admin-card">
          <h2>Синхронизация и сеть</h2>
          <p class="status-line">${syncStatus}</p>
          <p class="admin-help">Телефон синхронизирует очередь автоматически при доступности сервера. Подключение ограничено одним зарегистрированным телефоном.</p>
          <label>HTTPS-порт<input name="https-port" type="number" min="1" max="65535" step="1" value="${cfg.server.https_port}" required></label>
          <label>Разрешённые Pages origins (по одному на строку)<textarea name="pages-origins" rows="3">${esc(cfg.server.pages_origins.join("\n"))}</textarea></label>
          <p class="admin-help">Доступ разрешён только по локальной сети. Изменение порта и origins применяется после перезапуска сервера. Не открывайте порт в интернет.</p>
        </section>
        <section class="admin-card wide">
          <h2>Список напитков</h2>
          <p class="admin-help">ID существующего напитка лучше не менять: история продаж привязана к нему. Неактивные напитки скрыты из новых продаж, история сохраняется.</p>
          <div id="drinks">${drinks.map(drinkRow).join("")}</div>
          <div class="admin-actions"><button class="btn" type="button" data-action="add-drink">Добавить напиток</button></div>
        </section>
        <section class="admin-card">
          <h2>Резервное копирование</h2>
          <label>Интервал (часы)<input name="backup-interval" type="number" min="1" max="168" step="1" value="${cfg.backups.interval_hours}" required></label>
          <label>Хранить (дней)<input name="backup-retention" type="number" min="1" max="3650" step="1" value="${cfg.backups.retention_days}" required></label>
          ${backupStatus}
          <div class="admin-actions"><button class="btn" type="button" data-action="backup">Создать и проверить копию</button></div>
          <p class="admin-help">Изменение расписания и срока хранения применяется после перезапуска.</p>
        </section>
        <section class="admin-card">
          <h2>PIN доступа</h2>
          <label>Текущий PIN<input name="current-pin" type="password" inputmode="numeric" autocomplete="current-password"></label>
          <label>Новый PIN (4–12 цифр)<input name="new-pin" type="password" inputmode="numeric" autocomplete="new-password"></label>
          <div class="admin-actions"><button class="btn" type="button" data-action="change-pin">Изменить PIN</button></div>
          <p class="admin-help">PIN используется для входа в эту панель и в приложение на телефоне.</p>
        </section>
        <section class="admin-card wide">
          <p class="admin-help">Настройки сохраняются в <b>${esc(state.settings_file)}</b>. Панель доступна только на ноутбуке через localhost.</p>
          <p id="config-error" class="admin-error"></p>
          <button class="btn primary block" type="submit">Сохранить настройки</button>
        </section>
      </div>
    </form>`;
}

async function load() {
  state = await api("admin/status");
  if (state.setup_needed || !state.authenticated) renderGate();
  else renderDashboard();
}

async function handleGate(event) {
  event.preventDefault();
  const pin = document.querySelector("#gate-pin").value;
  try {
    if (state.setup_needed) await api("setup", { pin });
    else await api("login", { pin });
    await load();
  } catch (error) {
    document.querySelector("#gate-error").textContent = error.message;
  }
}

function collectSettings(form) {
  const data = new FormData(form);
  const rows = [...document.querySelectorAll(".drink-row")];
  return {
    shop: data.get("shop"),
    drinks: rows.map((row) => ({
      id: row.querySelector('[name="drink-id"]').value.trim(),
      name: row.querySelector('[name="drink-name"]').value.trim(),
      emoji: row.querySelector('[name="drink-emoji"]').value.trim(),
      color: row.querySelector('[name="drink-color"]').value,
      active: row.querySelector('[name="drink-active"]').checked,
    })),
    loyalty: {
      paid_liters: Number(data.get("paid-liters")),
      reward_liters: Number(data.get("reward-liters")),
    },
    server: {
      https_port: Number(data.get("https-port")),
      pages_origins: data.get("pages-origins").split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
    },
    backups: {
      interval_hours: Number(data.get("backup-interval")),
      retention_days: Number(data.get("backup-retention")),
    },
  };
}

document.addEventListener("submit", async (event) => {
  if (event.target.id === "gate-form") return handleGate(event);
  if (event.target.id !== "config-form") return;
  event.preventDefault();
  const errorEl = document.querySelector("#config-error");
  errorEl.textContent = "";
  try {
    const result = await api("admin/settings", { settings: collectSettings(event.target) });
    await load();
    toast(result.restart_required
      ? "Настройки сохранены. Перезапустите сервер для применения сети и расписания резервирования."
      : "Настройки сохранены.");
  } catch (error) {
    errorEl.textContent = error.message;
  }
});

document.addEventListener("click", async (event) => {
  const remove = event.target.closest("[data-remove]");
  if (remove) {
    drinks.splice(Number(remove.dataset.remove), 1);
    document.querySelector("#drinks").innerHTML = drinks.map(drinkRow).join("");
    return;
  }
  const button = event.target.closest("[data-action]");
  if (!button) return;
  if (button.dataset.action === "reload") {
    location.reload();
    return;
  }
  if (button.dataset.action === "add-drink") {
    drinks.push({ id: "", name: "", emoji: "🍺", color: "#d97706", active: true });
    document.querySelector("#drinks").innerHTML = drinks.map(drinkRow).join("");
    document.querySelector(".drink-row:last-child [name='drink-id']").focus();
    return;
  }
  try {
    if (button.dataset.action === "backup") {
      const result = await api("admin/backup", {});
      await load();
      toast("Копия создана и проверена: " + result.name);
    } else if (button.dataset.action === "change-pin") {
      const currentPin = document.querySelector("[name='current-pin']").value;
      const newPin = document.querySelector("[name='new-pin']").value;
      await api("settings", { current_pin: currentPin, new_pin: newPin });
      await load();
      toast("PIN изменён.");
    } else if (button.dataset.action === "logout") {
      await api("logout", {});
      await load();
    }
  } catch (error) {
    toast(error.message, true);
  }
});

load().catch((error) => {
  root.innerHTML = `<section class="admin-card"><h1>Панель недоступна</h1><p>${esc(error.message)}</p><button class="btn" data-action="reload">Повторить</button></section>`;
});
