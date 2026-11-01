"use strict";

(() => {
  const DB_NAME = "pivo-offline";
  const DB_VERSION = 1;
  const CORE_STORES = ["customers", "products", "operations", "outbox", "sync_metadata"];
  const READY_MARKER = "pivo-idb-ready";
  const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let dbPromise;
  let syncPromise = null;
  let storageError = null;

  const marker = () => {
    try { return localStorage.getItem(READY_MARKER); }
    catch (error) {
      storageError = new Error("Не удалось проверить сохранность локальной базы. Разрешите хранилище сайта и перезапустите приложение.");
      throw storageError;
    }
  };
  const failStorage = (message) => {
    storageError = new Error(message);
    window.dispatchEvent(new CustomEvent("pivo-storage-error", { detail: storageError.message }));
    return storageError;
  };

  const uuid = () => {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const half = (x) => {
    const value = Number(x);
    if (!Number.isFinite(value) || Math.abs(value * 2 - Math.round(value * 2)) > 1e-9) return null;
    return Math.round(value * 2);
  };
  const open = () => {
    if (storageError) return Promise.reject(storageError);
    if (!("indexedDB" in window)) return Promise.reject(new Error("Это браузер не поддерживает локальное хранилище IndexedDB."));
    if (!dbPromise) {
      const hadReadyMarker = !!marker();
      dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      let blocked = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        if (hadReadyMarker && request.oldVersion === 0) {
          failStorage("Локальная база клиентов и ожидающих операций отсутствует, хотя ранее приложение уже сохраняло данные. Не продолжайте работу с пустой базой. Проверьте другой браузер/адрес сайта или восстановите данные с ноутбука.");
          request.transaction.abort();
          return;
        }
        if (hadReadyMarker && CORE_STORES.some((name) => !db.objectStoreNames.contains(name))) {
          failStorage("Структура локальной базы несовместима с этой версией приложения. Данные не изменены; не очищайте данные сайта.");
          request.transaction.abort();
          return;
        }
        if (!db.objectStoreNames.contains("customers")) db.createObjectStore("customers", { keyPath: "id" });
        if (!db.objectStoreNames.contains("products")) db.createObjectStore("products", { keyPath: "key" });
        if (!db.objectStoreNames.contains("operations")) db.createObjectStore("operations", { keyPath: "operation_id" });
        if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "operation_id" });
        if (!db.objectStoreNames.contains("sync_metadata")) db.createObjectStore("sync_metadata", { keyPath: "key" });
      };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked || CORE_STORES.some((name) => !db.objectStoreNames.contains(name))) {
          db.close();
          dbPromise = null;
          reject(failStorage("Не удалось безопасно открыть локальную базу. Закройте другие вкладки и не продолжайте операции."));
          return;
        }
        db.onversionchange = () => {
          db.close();
          failStorage("Локальная база обновляется в другой вкладке. Закройте все вкладки приложения и перезапустите его.");
        };
        resolve(db);
      };
      request.onerror = () => {
        dbPromise = null;
        reject(storageError || failStorage("Не удалось открыть локальную базу. Сохранённые данные не сброшены."));
      };
      request.onblocked = () => {
        blocked = true;
        dbPromise = null;
        reject(failStorage("Локальная база занята другой вкладкой. Закройте остальные вкладки приложения и перезапустите."));
      };
      });
    }
    return dbPromise;
  };
  const markReady = () => {
    try { localStorage.setItem(READY_MARKER, String(DB_VERSION)); }
    catch (error) { throw failStorage("Не удалось установить защитную отметку локального хранилища. Освободите место и перезапустите приложение."); }
  };
  const quotaMessage = (error) => {
    if (error && (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED")) {
      return new Error("На телефоне закончилось место. Операцию не сохранено; освободите место и повторите. Ожидающие операции не удалялись.");
    }
    return error instanceof Error ? error : new Error("Ошибка локального хранилища.");
  };
  const readAll = (store) => open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const request = tx.objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.onabort = () => reject(tx.error || new Error("Не удалось прочитать локальную базу."));
  }));
  const getMeta = async (key, fallback) => {
    const rows = await open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction("sync_metadata", "readonly");
      const req = tx.objectStore("sync_metadata").get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error);
    }));
    return rows ? rows.value : fallback;
  };
  const setMeta = async (key, value) => {
    const db = await open();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("sync_metadata", "readwrite");
      tx.objectStore("sync_metadata").put({ key, value });
      tx.oncomplete = () => {
        try { markReady(); resolve(); }
        catch (error) { reject(error); }
      };
      tx.onabort = tx.onerror = () => reject(quotaMessage(tx.error));
    });
  };
  const requestIdForKey = async (key) => {
    const metaKey = "request:" + key;
    let value = await getMeta(metaKey, null);
    if (!value) {
      value = uuid();
      await setMeta(metaKey, value);
    }
    return value;
  };
  const clearRequestIdForKey = (key) => setMeta("request:" + key, null);
  const stores = (names, mode, prepare) => open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode);
    let value, callbackError;
    tx.oncomplete = () => {
      try {
        if (mode === "readwrite") markReady();
        resolve(value);
      } catch (error) { reject(error); }
    };
    tx.onabort = tx.onerror = () => reject(quotaMessage(callbackError || tx.error));
    try {
      prepare(tx, (result) => { value = result; }, (error) => {
        callbackError = error;
        try { tx.abort(); } catch (_) {}
      });
    } catch (e) {
      try { tx.abort(); } catch (_) {}
      reject(quotaMessage(e));
    }
  }));

  const productConfig = async () => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("products", "readonly");
      const req = tx.objectStore("products").get("config");
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  const customerRecord = async (id) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("customers", "readonly");
      const req = tx.objectStore("customers").get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  const productConfiguration = async () => {
    const config = await productConfig();
    return config || null;
  };
  const newCustomerId = async () => {
    let id;
    do {
      const bytes = crypto.getRandomValues(new Uint8Array(8));
      id = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
    } while (await customerRecord(id));
    return id;
  };
  const emptyCustomer = (id, payload) => {
    const phone = String(payload.phone || "").replace(/\D/g, "");
    const normalized = phone.length === 10 && phone.startsWith("0") ? "38" + phone : phone;
    const formatted = normalized.length === 12 && normalized.startsWith("380")
      ? `+${normalized.slice(0, 3)} ${normalized.slice(3, 5)} ${normalized.slice(5, 8)} ${normalized.slice(8, 10)} ${normalized.slice(10)}`
      : (normalized ? "+" + normalized : "");
    const created = new Date().toISOString().slice(0, 19);
    return {
      id, name: String(payload.name || "").trim(), surname: String(payload.surname || "").trim(),
      phone: normalized, phone_fmt: formatted, created, total_paid: 0, progress: 0,
      gifts_earned: 0, gifts_used: 0, gifts_avail: 0, visits: 0, last_visit: null,
      per_drink: [], history: [],
    };
  };
  const reduceOperation = (customer, operation, config) => {
    const current = clone(customer);
    const op = operation.operation;
    if (op.operation_type === "register") {
      current.pending = true;
      return current;
    }
    const drinks = config.drinks;
    const cycleHalf = half(config.loyalty.paid_liters);
    const rewardHalf = half(config.loyalty.reward_liters);
    const items = op.payload.items || [];
    const normalized = [];
    for (const item of items) {
      const amount = half(item.liters);
      const drink = drinks.find((d) => d.id === item.drink);
      if (!drink || drink.active === false || amount === null || amount <= 0) {
        throw new Error("Операция использует неизвестный напиток или неверный объём.");
      }
      normalized.push({ drink: drink.id, name: drink.name, emoji: drink.emoji || "🍺", liters: amount / 2 });
    }
    const per = Object.fromEntries((current.per_drink || []).map((p) => [p.drink, clone(p)]));
    const paidHalfBefore = half(current.total_paid || 0) || 0;
    const usedHalfBefore = half(current.gifts_used || 0) || 0;
    if (op.operation_type === "purchase") {
      for (let i = 0; i < items.length; i++) {
        const item = normalized[i];
        const row = per[item.drink] || { drink: item.drink, name: item.name, emoji: item.emoji, paid: 0, gift_used: 0 };
        row.paid = (half(row.paid) || 0) / 2 + item.liters;
        per[item.drink] = row;
      }
      const paidHalf = paidHalfBefore + normalized.reduce((n, item) => n + (half(item.liters) || 0), 0);
      current.total_paid = paidHalf / 2;
      current.gifts_earned = Math.floor(paidHalf / cycleHalf) * rewardHalf / 2;
      current.progress = (paidHalf % cycleHalf) / 2;
      current.visits = (current.visits || 0) + 1;
      current.last_visit = op.created_at;
    } else {
      const usedHalf = normalized.reduce((n, item) => n + (half(item.liters) || 0), 0);
      const availHalf = Math.floor(paidHalfBefore / cycleHalf) * rewardHalf - usedHalfBefore;
      if (usedHalf > availHalf) throw new Error(`Можно списать не больше ${(Math.max(0, availHalf) / 2).toString().replace(".", ",")} л`);
      for (let i = 0; i < items.length; i++) {
        const item = normalized[i];
        const row = per[item.drink] || { drink: item.drink, name: item.name, emoji: item.emoji, paid: 0, gift_used: 0 };
        row.gift_used = (half(row.gift_used) || 0) / 2 + item.liters;
        per[item.drink] = row;
      }
      current.gifts_used = (usedHalfBefore + usedHalf) / 2;
    }
    current.gifts_avail = current.gifts_earned - current.gifts_used;
    current.per_drink = Object.values(per).sort((a, b) => a.name.localeCompare(b.name, "ru"));
    current.history = [{
      id: op.operation_id, operation_id: op.operation_id,
      ts: op.created_at, type: op.operation_type === "purchase" ? "purchase" : "redeem",
      undone: false, pending: true, items: normalized.map(({ name, emoji, liters }) => ({ name, emoji, liters })),
    }, ...(current.history || [])];
    current.pending = true;
    return current;
  };
  const recordFailedAttempts = async (entries, error) => stores(["outbox"], "readwrite", (tx) => {
    const store = tx.objectStore("outbox");
    const message = error && error.message ? error.message : "Связь с сервером прервана; результат запроса неизвестен.";
    for (const entry of entries) {
      const req = store.get(entry.operation_id);
      req.onsuccess = () => {
        if (!req.result) return;
        const updated = req.result;
        updated.attempts = (updated.attempts || 0) + 1;
        updated.next_retry_at = Date.now() + Math.min(300000, 1000 * (2 ** Math.min(updated.attempts, 8)));
        updated.last_error = { message, conflict: false };
        store.put(updated);
      };
    }
  });
  const acquireLease = async () => {
    const owner = uuid(), db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sync_metadata", "readwrite");
      const store = tx.objectStore("sync_metadata");
      const req = store.get("sync_lease");
      let acquired = false;
      req.onsuccess = () => {
        const lease = req.result && req.result.value;
        if (lease && lease.expires_at > Date.now()) return;
        acquired = true;
        store.put({ key: "sync_lease", value: { owner, expires_at: Date.now() + 120000 } });
      };
      req.onerror = () => { try { tx.abort(); } catch (_) {} };
      tx.oncomplete = () => {
        try {
          if (acquired) markReady();
          resolve(acquired ? owner : null);
        } catch (error) { reject(error); }
      };
      tx.onabort = tx.onerror = () => reject(tx.error || new Error("Не удалось получить блокировку синхронизации."));
    });
  };
  const releaseLease = async (owner) => stores(["sync_metadata"], "readwrite", (tx) => {
    const store = tx.objectStore("sync_metadata");
    const req = store.get("sync_lease");
    req.onsuccess = () => {
      if (req.result && req.result.value.owner === owner) store.delete("sync_lease");
    };
  });

  const ensureDeviceId = async () => {
    let id = await getMeta("device_id", null);
    if (!id) {
      id = uuid();
      await setMeta("device_id", id);
    }
    return id;
  };
  const serverUrl = () => getMeta("server_url", "");
  const setServerUrl = (value) => stores(
    ["customers", "products", "operations", "outbox", "sync_metadata"], "readwrite", (tx, setResult, fail) => {
      const meta = tx.objectStore("sync_metadata");
      const req = meta.get("server_url");
      req.onsuccess = () => {
        if (req.result && req.result.value === value) {
          setResult(value);
          return;
        }
        const outbox = tx.objectStore("outbox").getAll();
        const lease = meta.get("sync_lease");
        let outboxRows, syncLease, remaining = 2;
        const checkReady = () => {
          if (--remaining) return;
          if (outboxRows.length) {
            fail(new Error("Сначала синхронизируйте или экспортируйте все ожидающие операции. Адрес сервера не изменён."));
            return;
          }
          if (syncLease && syncLease.value.expires_at > Date.now()) {
            fail(new Error("Синхронизация уже выполняется в другой вкладке. Повторите позже."));
            return;
          }
          tx.objectStore("customers").clear();
          tx.objectStore("products").clear();
          tx.objectStore("operations").clear();
          tx.objectStore("outbox").clear();
          meta.clear();
          meta.put({ key: "server_url", value });
          setResult(value);
        };
        outbox.onsuccess = () => { outboxRows = outbox.result; checkReady(); };
        outbox.onerror = () => fail(outbox.error);
        lease.onsuccess = () => { syncLease = lease.result; checkReady(); };
        lease.onerror = () => fail(lease.error);
      };
      req.onerror = () => fail(req.error);
    });
  const getAuthToken = () => getMeta("auth_token", "");
  const setAuthToken = (value) => setMeta("auth_token", value || "");
  const clearAuthToken = () => setAuthToken("");
  const bootstrap = async () => {
    await open();
    const config = await productConfig();
    const authenticated = await getMeta("local_session", await getMeta("authenticated", false));
    const record = await getMeta("device_id", null);
    const customers = await readAll("customers");
    const outbox = await readAll("outbox");
    if (authenticated && (config || customers.length || outbox.length)) markReady();
    return {
      authenticated: !!authenticated,
      device_id: record,
      server_url: await serverUrl(),
      cursor: await getMeta("cursor", 0),
      config,
      pending: outbox.length,
      customers: customers.length,
    };
  };
  const cacheProducts = (state) => stores(["products"], "readwrite", (tx) => {
    tx.objectStore("products").put({
      key: "config",
      value: {
        shop: state.shop,
        drinks: clone(state.all_drinks || state.drinks || []),
        loyalty: clone(state.loyalty || { paid_liters: 6, reward_liters: 1 }),
        version: state.products_version || "",
      },
    });
  });
  const cacheCustomer = async (customer) => {
    const config = await productConfiguration();
    const operationConfig = config || { drinks: [], loyalty: { paid_liters: 6, reward_liters: 1 } };
    const drinks = operationConfig.drinks.filter((drink) => drink.active !== false);
    return stores(["customers", "operations"], "readwrite", (tx, setResult, fail) => {
      const getOps = tx.objectStore("operations").getAll();
      getOps.onsuccess = () => {
        const ops = getOps.result.filter((entry) => entry.operation.customer_id === customer.id && entry.status === "pending");
        let current = clone(customer);
        try {
          for (const entry of ops) current = reduceOperation(current, entry, {
            drinks, loyalty: operationConfig.loyalty || { paid_liters: 6, reward_liters: 1 },
          });
          tx.objectStore("customers").put({ id: customer.id, base: clone(customer), current });
          setResult(current);
        } catch (e) { fail(e); }
      };
    });
  };

  const enqueue = async (type, customerId, payload, operationId) => {
    const db = await open();
    const deviceId = await ensureDeviceId();
    const productConfig = await productConfiguration();
    const drinks = productConfig ? productConfig.drinks.filter((drink) => drink.active !== false) : [];
    if (type !== "register" && !productConfig) {
      throw new Error("Локальная конфигурация товаров отсутствует; операция не сохранена.");
    }
    const operationConfig = productConfig || { drinks: [], loyalty: { paid_liters: 6, reward_liters: 1 } };
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["customers", "operations", "outbox", "sync_metadata"], "readwrite");
      const customerStore = tx.objectStore("customers");
      const opsStore = tx.objectStore("operations");
      const outboxStore = tx.objectStore("outbox");
      const metaStore = tx.objectStore("sync_metadata");
      const customerReq = customerStore.getAll();
      const opsReq = opsStore.getAll();
      const seqReq = metaStore.get("sequence");
      const cursorReq = metaStore.get("cursor");
      let remaining = 4;
      let customer, ops, seq = 0, cursor = 0;
      let result;
      const fail = (error) => { try { tx.abort(); } catch (_) {} reject(quotaMessage(error)); };
      const ready = () => {
        if (--remaining) return;
        try {
          const prior = ops.find((row) => row.operation_id === operationId);
          if (prior) {
            const existing = (customerReq.result || []).find((row) => row.id === prior.operation.customer_id);
            result = { operation: prior.operation, customer: existing ? existing.current : null, existing: true };
            return;
          }
          if (type !== "register" && !customer) throw new Error("Клиент не сохранён на этом телефоне. Подключитесь к серверу и повторите.");
          if (type === "register") {
            const phone = String(payload.phone || "").replace(/\D/g, "");
            const normalized = phone.length === 10 && phone.startsWith("0") ? "38" + phone : phone;
            if (!String(payload.name || "").trim()) throw new Error("Укажите имя клиента.");
            if (normalized.length < 10 || normalized.length > 15) throw new Error("Проверьте номер телефона.");
            const allCustomers = customerReq.result || [];
            if (ops.some((entry) => entry.operation.operation_type === "register" &&
                entry.operation.customer_id !== customerId &&
                String(entry.operation.payload.phone || "").replace(/\D/g, "").endsWith(normalized.slice(-10)))) {
              throw new Error("Этот номер телефона уже есть в локальной базе.");
            }
            if (allCustomers.some((row) => row.id !== customerId && row.current.phone === normalized)) throw new Error("Этот номер телефона уже есть в локальной базе.");
            customer = { id: customerId, base: emptyCustomer(customerId, payload), current: emptyCustomer(customerId, payload) };
          } else if (!Array.isArray(payload.items) || !payload.items.length || payload.items.length > 50) {
            throw new Error("Добавьте напиток и объём.");
          }
          const operation = {
            operation_id: operationId || uuid(),
            device_id: deviceId,
            operation_type: type,
            customer_id: customerId,
            payload: clone(payload),
            created_at: new Date().toISOString(),
            client_sequence: seq + 1,
            base_version: cursor,
          };
          const entry = { operation_id: operation.operation_id, operation, status: "pending", server_operation_ids: [] };
          const beforeEarned = customer.current.gifts_earned || 0;
          if (type === "purchase") {
            const total = payload.items.reduce((sum, item) => {
              const amount = half(item.liters);
              if (amount === null || amount <= 0 || amount > 100) throw new Error("Объём должен быть кратен 0,5 л.");
              return sum + amount;
            }, 0);
            if (total > 200) throw new Error("Слишком большой объём за раз.");
          }
          const current = reduceOperation(customer.current, entry, operationConfig);
          customer.current = current;
          customerStore.put(customer);
          opsStore.put(entry);
          outboxStore.put({ operation_id: operation.operation_id, operation, attempts: 0, last_error: null });
          metaStore.put({ key: "sequence", value: operation.client_sequence });
          result = { operation, customer: current, offers: type === "purchase" && current.gifts_avail > 0
            ? [{ avail: current.gifts_avail, new: current.gifts_earned > beforeEarned }] : [] };
        } catch (e) { fail(e); }
      };
      customerReq.onsuccess = () => { customer = (customerReq.result || []).find((row) => row.id === customerId) || null; ready(); };
      customerReq.onerror = () => fail(customerReq.error);
      opsReq.onsuccess = () => { ops = opsReq.result || []; ready(); };
      opsReq.onerror = () => fail(opsReq.error);
      seqReq.onsuccess = () => { seq = seqReq.result ? seqReq.result.value : 0; ready(); };
      seqReq.onerror = () => fail(seqReq.error);
      cursorReq.onsuccess = () => { cursor = cursorReq.result ? cursorReq.result.value : 0; ready(); };
      cursorReq.onerror = () => fail(cursorReq.error);
      tx.oncomplete = () => {
        try { markReady(); resolve(result); }
        catch (error) { reject(error); }
      };
      tx.onabort = tx.onerror = () => reject(quotaMessage(tx.error));
    });
  };
  const getCustomer = async (id) => {
    const row = await customerRecord(id);
    return row ? row.current : null;
  };
  const search = async (query) => {
    const rows = await readAll("customers");
    const q = String(query || "").trim().toLowerCase();
    const digits = q.replace(/\D/g, "");
    const numeric = /^[+()\d\s-]+$/.test(q);
    const matches = rows.map((row) => row.current).filter((customer) => {
      if (!q) return true;
      if (numeric) return digits.length >= 3 && customer.phone.includes(digits);
      const name = `${customer.name} ${customer.surname}`.trim().toLowerCase();
      return q.split(/\s+/).every((part) => name.includes(part));
    }).sort((a, b) => (b.last_visit || b.created || "").localeCompare(a.last_visit || a.created || ""));
    return { results: matches.slice(0, 20).map((c) => ({
      id: c.id, name: c.name, surname: c.surname, phone_fmt: c.phone_fmt, gifts_avail: c.gifts_avail,
    })), recent: !q };
  };
  const pending = () => readAll("outbox");
  const exportPending = async () => {
    const entries = await pending();
    const blob = new Blob([JSON.stringify(entries.map((entry) => entry.operation), null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `pivo-pending-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };

  const acknowledge = async (results) => stores(["outbox", "operations", "sync_metadata"], "readwrite", (tx) => {
    const outbox = tx.objectStore("outbox");
    const operations = tx.objectStore("operations");
    const metadata = tx.objectStore("sync_metadata");
    for (const result of results) {
      if (!result.operation_id) continue;
      if (result.acknowledged) {
        outbox.delete(result.operation_id);
        const requestMeta = metadata.getAll();
        requestMeta.onsuccess = () => {
          for (const item of requestMeta.result) {
            if (item.key.startsWith("request:") && item.value === result.operation_id) metadata.delete(item.key);
          }
        };
        const req = operations.get(result.operation_id);
        req.onsuccess = () => {
          const entry = req.result;
          if (!entry) return;
          entry.status = "acknowledged";
          entry.server_operation_ids = result.server_operation_ids || [];
          operations.put(entry);
        };
      } else {
        const req = outbox.get(result.operation_id);
        req.onsuccess = () => {
          const entry = req.result;
          if (!entry) return;
          entry.attempts = (entry.attempts || 0) + 1;
          entry.next_retry_at = Date.now() + Math.min(300000, 1000 * (2 ** Math.min(entry.attempts, 8)));
          entry.last_error = { message: result.error, code: result.code, conflict: !!result.conflict };
          outbox.put(entry);
          const opReq = operations.get(result.operation_id);
          opReq.onsuccess = () => {
            if (!opReq.result) return;
            opReq.result.last_error = entry.last_error;
            operations.put(opReq.result);
          };
        };
      }
    }
  });
  const applyPull = async (response) => {
    const changes = response.changes || {};
    return stores(["customers", "products", "operations", "outbox", "sync_metadata"], "readwrite", (tx, _, fail) => {
      const customerStore = tx.objectStore("customers");
      const operationsStore = tx.objectStore("operations");
      const outboxStore = tx.objectStore("outbox");
      const rowsRequest = customerStore.getAll();
      const opsRequest = operationsStore.getAll();
      const configRequest = tx.objectStore("products").get("config");
      const customers = changes.customers || [];
      const processed = new Set(changes.processed_operation_ids || []);
      let config = changes.products;
      let remaining = 3;
      let rows, localOps, cachedConfig;
      const finish = () => {
        if (--remaining) return;
        if (!config) config = cachedConfig;
        if (!config && (localOps || []).some((entry) => !processed.has(entry.operation_id))) {
          fail(new Error("Локальная конфигурация товаров отсутствует; ожидающие операции сохранены и не применены."));
          return;
        }
        if (config) config = {
          ...config,
          loyalty: config.loyalty || { paid_liters: 6, reward_liters: 1 },
          drinks: config.drinks || [],
        };
        const localById = new Map((rows || []).map((row) => [row.id, row]));
        const serverCustomerIds = new Set(customers.map((customer) => customer.id));
        for (const customer of customers) {
          localById.set(customer.id, { id: customer.id, base: clone(customer), current: clone(customer) });
        }
        for (const row of localById.values()) {
          if (!serverCustomerIds.has(row.id)) row.current = clone(row.base);
        }
        for (const entry of localOps || []) {
          const row = localById.get(entry.operation.customer_id);
          const isProcessed = processed.has(entry.operation_id);
          if (isProcessed) {
            operationsStore.delete(entry.operation_id);
            outboxStore.delete(entry.operation_id);
          } else if (row && entry.status !== "acknowledged") {
            try {
              row.current = reduceOperation(row.current, entry, config);
            } catch (e) {
              const outboxRequest = outboxStore.get(entry.operation_id);
              outboxRequest.onsuccess = () => {
                if (!outboxRequest.result) return;
                outboxRequest.result.last_error = { message: e.message, conflict: true, code: "local_projection_conflict" };
                outboxStore.put(outboxRequest.result);
                entry.last_error = outboxRequest.result.last_error;
                operationsStore.put(entry);
              };
            }
          }
        }
        for (const row of localById.values()) customerStore.put(row);
        if (config) tx.objectStore("products").put({ key: "config", value: config });
        tx.objectStore("sync_metadata").put({ key: "cursor", value: response.cursor });
      };
      rowsRequest.onsuccess = () => { rows = rowsRequest.result; finish(); };
      rowsRequest.onerror = () => { try { tx.abort(); } catch (_) {} };
      opsRequest.onsuccess = () => { localOps = opsRequest.result; finish(); };
      opsRequest.onerror = () => { try { tx.abort(); } catch (_) {} };
      configRequest.onsuccess = () => { cachedConfig = configRequest.result && configRequest.result.value; finish(); };
      configRequest.onerror = () => { try { tx.abort(); } catch (_) {} };
    });
  };
  const synchronize = async (send) => {
    if (syncPromise) return syncPromise;
    syncPromise = (async () => {
      const owner = await acquireLease();
      if (!owner) return { synchronized: false, reason: "busy" };
      try {
        const deviceId = await ensureDeviceId();
        await send("sync/register", { device_id: deviceId });
        const entries = await pending();
        entries.sort((a, b) => a.operation.client_sequence - b.operation.client_sequence);
        const due = entries.filter((entry) => !entry.next_retry_at || entry.next_retry_at <= Date.now());
        for (let i = 0; i < due.length; i += 50) {
          const batch = due.slice(i, i + 50);
          try {
            const response = await send("sync/push", { operations: batch.map((entry) => entry.operation) });
            await acknowledge(response.results || []);
          } catch (error) {
            await recordFailedAttempts(batch, error);
            throw error;
          }
        }
        let cursor = await getMeta("cursor", 0);
        let more = true;
        while (more) {
          const response = await send("sync/pull?since=" + encodeURIComponent(cursor));
          await applyPull(response);
          cursor = response.cursor;
          more = !!response.has_more;
        }
        return { synchronized: true, cursor };
      } finally {
        await releaseLease(owner);
      }
    })().finally(() => { syncPromise = null; });
    return syncPromise;
  };
  const persistentStorage = async () => {
    if (navigator.storage && navigator.storage.persist) {
      try { await navigator.storage.persist(); } catch (_) { /* browser can deny persistent storage */ }
    }
  };
  window.Offline = {
    open,
    bootstrap,
    cacheProducts,
    cacheCustomer,
    enqueue,
    newCustomerId,
    getCustomer,
    search,
    pending,
    exportPending,
    synchronize,
    rememberAuthentication: async (value, token) => {
      await setMeta("local_session", !!value);
      await setAuthToken(value ? token : "");
    },
    clearAuthToken,
    serverUrl,
    setServerUrl,
    getAuthToken,
    requestIdForKey,
    clearRequestIdForKey,
    persistentStorage,
    get storageError() { return storageError; },
  };
})();
