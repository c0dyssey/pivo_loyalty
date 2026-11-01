"""Автотесты: python test_server.py  (поднимает свой сервер на временной папке)"""
import http.client
import json
import os
import sys
import time
import urllib.parse
import uuid

from tests_common import CTX, Env, Client as _Client, check
import server

ENV = Env()
PORT = ENV.port
TMP = ENV.root
SETTINGS = ENV.settings


def write_settings(drinks, shop="Тест", loyalty=None, server=None, backups=None):
    settings = {"shop": shop, "drinks": drinks}
    if loyalty is not None:
        settings["loyalty"] = loyalty
    if server is not None:
        settings["server"] = server
    if backups is not None:
        settings["backups"] = backups
    with open(SETTINGS, "w", encoding="utf-8") as f:
        json.dump(settings, f, ensure_ascii=False)
    os.utime(SETTINGS, (time.time() + write_settings.n, time.time() + write_settings.n))
    write_settings.n += 2


write_settings.n = 1


def start():
    ENV.start()
    return ENV.proc


def Client():  # noqa: N802
    return _Client(PORT)


DRINKS = [
    {"id": "weissburg-blanche", "name": "Вайсбург Бланш", "emoji": "🍋", "color": "#f59e0b"},
    {"id": "weissburg-lager", "name": "Вайсбург Лагер", "emoji": "🍺"},
    "Князь Сангушко",
    {"id": "kronenbourg-blanc", "name": "Кроненбург Бланш", "emoji": "👑"},
    {"id": "heisenberg-dark", "name": "Хайзенберг Дарк", "emoji": "🌑"},
    {"id": "bilyi-kelyh", "name": "Білий келих", "emoji": "🥂"},
]


def main():
    write_settings(DRINKS)
    p = start()
    try:
        a = Client()
        st, root_html = a.call("GET", "/", raw=True)
        check(st == 200 and b"admin.js" in root_html and b"admin.css" in root_html,
              "localhost открывает отдельную панель управления")
        st, admin_status = a.call("GET", "/api/admin/status")
        check(st == 200 and admin_status["setup_needed"] and not admin_status["authenticated"] and
              admin_status["settings"] is None and admin_status["runtime"] is None,
              "до входа панель не раскрывает серверные настройки")
        st, j = a.call("GET", "/api/state")
        check(j["setup_needed"] and j["shop"] == "Тест", "первый запуск: нужна настройка, название из settings.json")
        st, j = a.call("POST", "/api/setup", {"pin": "1111"})
        check(st == 400, "слишком простой PIN отклонён")
        st, j = a.call("POST", "/api/setup", {"pin": "48291"})
        check(st == 200, "настройка единственного PIN")
        st, j = a.call("POST", "/api/setup", {"pin": "99999"})
        check(st == 403, "повторная настройка запрещена")

        s, other = Client(), Client()
        st, _ = other.call("POST", "/api/customers", {})
        check(st == 401, "без входа API закрыт")
        st, j = s.call("POST", "/api/login", {"pin": "48291"})
        check(st == 200 and j.get("role") == "staff", "вход по PIN (один аккаунт)")
        st, admin_status = s.call("GET", "/api/admin/status")
        check(st == 200 and admin_status["authenticated"] and admin_status["settings"]["shop"] == "Тест",
              "панель показывает настройки после входа")
        dashboard_config = {
            "shop": "Панель тест",
            "drinks": DRINKS,
            "loyalty": {"paid_liters": 4, "reward_liters": 0.5},
            "server": {"https_port": 8443, "pages_origins": ["https://c0dyssey.github.io"]},
            "backups": {"interval_hours": 2, "retention_days": 14},
        }
        st, saved = s.call("POST", "/api/admin/settings", {"settings": dashboard_config})
        check(st == 200 and saved["ok"] and saved["restart_required"],
              "панель сохраняет JSON и отмечает параметры, требующие перезапуска")
        with open(SETTINGS, encoding="utf-8") as file:
            persisted_config = json.load(file)
        check(persisted_config["shop"] == "Панель тест" and persisted_config["loyalty"]["paid_liters"] == 4,
              "настройки панели надёжно сохранены в settings.json")
        st, _ = s.call("POST", "/api/admin/settings", {"settings": {"shop": "", "drinks": []}})
        check(st == 400, "панель отклоняет неверную конфигурацию")
        write_settings(DRINKS)
        token = j.get("token", "")
        st, cross_origin_state = s.call("GET", "/api/state", headers={
            "Authorization": "Bearer " + token, "Cookie": "", "Origin": "https://c0dyssey.github.io",
        })
        check(st == 200 and cross_origin_state["role"] == "staff" and
              s.last_headers.get("access-control-allow-origin") == "https://c0dyssey.github.io",
              "GitHub Pages авторизуется bearer-токеном и получает CORS-доступ")
        st, _ = s.call("OPTIONS", "/api/sync/push", headers={
            "Origin": "https://c0dyssey.github.io", "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type,x-requested-with",
            "Access-Control-Request-Private-Network": "true",
        })
        check(st == 204 and s.last_headers.get("access-control-allow-private-network") == "true",
              "разрешён CORS preflight GitHub Pages к локальному HTTPS API")
        st, _ = s.call("OPTIONS", "/api/state", headers={
            "Origin": "https://evil.example", "Access-Control-Request-Method": "GET",
        })
        check(st == 403, "CORS preflight неизвестного сайта отклонён")
        st, _ = s.call("POST", "/api/customers", {"name": "A"}, headers={"X-Requested-With": ""})
        check(st == 403, "CSRF: POST без заголовка отклонён")

        # --- напитки из settings.json
        st, j = s.call("GET", "/api/state")
        names = [d["name"] for d in j["drinks"]]
        check(len(names) == 6 and "Князь Сангушко" in names and "Білий келих" in names, "6 напитков из файла, строка-название тоже работает")
        check(j["loyalty"] == {"paid_liters": 6, "reward_liters": 1},
              "state возвращает правило лояльности из JSON")
        write_settings(
            DRINKS,
            loyalty={"paid_liters": 4, "reward_liters": 0.5},
            server={"https_port": 8443, "pages_origins": ["https://c0dyssey.github.io"]},
            backups={"interval_hours": 2, "retention_days": 14},
        )
        st, j = s.call("GET", "/api/settings")
        check(st == 200 and j["loyalty"] == {"paid_liters": 4, "reward_liters": 0.5} and
              j["backup_policy"] == {"interval_hours": 2, "retention_days": 14},
              "settings API показывает правило награды и параметры резервирования из JSON")
        write_settings(DRINKS)
        d = {x["name"]: x for x in j["drinks"]}
        check(d["Вайсбург Лагер"]["color"].startswith("#") and d["Князь Сангушко"]["emoji"] == "🍺" and d["Князь Сангушко"]["id"] == "knyaz-sangushko",
              "авто-id (транслит), эмодзи по умолчанию, цвет из палитры")
        write_settings(DRINKS + [{"name": "Новинка IPA", "emoji": "🌿", "color": "#16a34a"}])
        st, j = s.call("GET", "/api/state")
        check(any(x["name"] == "Новинка IPA" for x in j["drinks"]), "новый напиток из файла появляется без перезапуска")
        write_settings(DRINKS)  # IPA убираем -> уйдёт в архив
        st, j = s.call("GET", "/api/state")
        check(not any(x["name"] == "Новинка IPA" for x in j["drinks"]), "убранный из файла напиток скрыт из продаж")
        with open(SETTINGS, "w", encoding="utf-8") as f:
            f.write("{ это не json")
        os.utime(SETTINGS, (time.time() + 100, time.time() + 100))
        st, j = s.call("GET", "/api/state")
        check(len(j["drinks"]) == 6, "битый settings.json не ломает сайт (остаётся прежний список)")
        st, j = s.call("GET", "/api/settings")
        check(bool(j["settings_error"]), "ошибка файла показывается в настройках")
        write_settings(DRINKS)
        st, j = s.call("GET", "/api/state")
        D = {x["name"]: x["id"] for x in j["drinks"]}
        lager, blanche, dark = D["Вайсбург Лагер"], D["Вайсбург Бланш"], D["Хайзенберг Дарк"]

        # --- сертификат: устройство, которое доверяет ca.crt, подключается без предупреждений
        import ssl
        ctx = ssl.create_default_context(cafile=os.path.join(ENV.data, "cert", "ca.crt"))
        for host in ("127.0.0.1", "localhost"):
            cc = http.client.HTTPSConnection(host, ENV.port, context=ctx, timeout=5)
            cc.request("GET", "/api/state")
            check(cc.getresponse().status == 200, f"сертификат проверяется по ca.crt ({host})")
        cc = http.client.HTTPSConnection("127.0.0.1", ENV.port, context=ctx, timeout=5)
        cc.request("GET", "/ca.crt")
        r = cc.getresponse()
        check(r.status == 200 and r.read().startswith(b"-----BEGIN CERTIFICATE"), "ca.crt отдаётся для установки на телефон")

        # --- клиенты
        st, j = s.call("POST", "/api/customers", {"name": "Иван", "surname": "Петров", "phone": "050 123-45-67"})
        check(st == 200 and j["phone"] == "380501234567", "регистрация, номер нормализован")
        cid = j["id"]
        st, _ = s.call("POST", "/api/customers", {"name": "Дубль", "surname": "Х", "phone": "+38 (050) 123 45 67"})
        check(st == 409, "дубль номера отклонён")

        def buy(c, items, rid=None):
            return s.call("POST", f"/api/customers/{c}/purchase", dict({"request_id": rid} if rid else {}, items=[{"drink": k, "liters": v} for k, v in items]))

        st, j = buy(cid, [(lager, 3), (lager, 2.5)])
        check(j["customer"]["progress"] == 5.5 and j["customer"]["gifts_avail"] == 0 and not j["offers"], "5,5 л: подарка ещё нет")
        st, j = buy(cid, [(lager, 0.5)])
        check(j["customer"]["gifts_avail"] == 1 and j["offers"] and j["offers"][0]["new"] and j["offers"][0]["avail"] == 1, "6 л: подарочный литр доступен, предложение клиенту")
        check(j["customer"]["total_paid"] == 6 and j["customer"]["progress"] == 0, "общий и подарочный счётчики")
        st, j = buy(cid, [(dark, 2)])
        check(j["customer"]["gifts_avail"] == 1 and j["customer"]["progress"] == 2 and j["offers"] and not j["offers"][0]["new"], "подарок общий: считается по всем напиткам вместе")
        st, j = buy(cid, [(blanche, 1)])
        check(j["customer"]["progress"] == 3 and j["customer"]["total_paid"] == 9, "литры разных напитков копятся в общий счёт")

        # --- списание: 1 л / всё / ввод
        R = lambda body: s.call("POST", f"/api/customers/{cid}/redeem", body)  # noqa: E731
        st, _ = R({"drink": "нет-такого", "liters": 1})
        check(st == 400, "неизвестный напиток для подарка отклонён")
        st, _ = R({"liters": 1})
        check(st == 400, "напиток для подарка обязателен")
        st, j = R({"drink": lager, "liters": 2})
        check(st == 400 and "не больше 1" in j["error"], "больше доступного нельзя, понятное сообщение")
        st, _ = R({"drink": lager, "liters": 0.3})
        check(st == 400, "не кратно 0,5 — отказ")
        st, _ = R({"drink": lager, "liters": 0})
        check(st == 400, "ноль — отказ")
        st, j = R({"drink": dark, "liters": 0.5})
        check(st == 200 and j["customer"]["gifts_avail"] == 0.5, "подарок можно взять ДРУГИМ напитком (вводом 0,5 л)")
        st, j = R({"drink": blanche, "all": True})
        check(j["customer"]["gifts_avail"] == 0 and j["customer"]["gifts_used"] == 1, "«списать всё» забирает остаток любым напитком")
        used = {x["drink"]: x["gift_used"] for x in j["customer"]["per_drink"]}
        check(used.get(dark) == 0.5 and used.get(blanche) == 0.5, "в истории видно, каким напитком отдан подарок")
        st, _ = R({"drink": lager, "all": True})
        check(st == 400, "после списания подарка нет")

        # --- списание списком из нескольких напитков
        st, j = s.call("POST", "/api/customers", {"name": "Список", "phone": "0991234500"})
        check(st == 200 and j["surname"] == "", "фамилия необязательна")
        c3 = j["id"]
        st, j = buy(c3, [(lager, 6), (dark, 6)])
        check(j["customer"]["gifts_avail"] == 2, "12 л разных напитков = 2 л подарка")
        R3 = lambda body: s.call("POST", f"/api/customers/{c3}/redeem", body)  # noqa: E731
        st, _ = R3({"items": [{"drink": lager, "liters": 1.5}, {"drink": dark, "liters": 1}]})
        check(st == 400, "список больше доступного отклонён целиком")
        st, j = s.call("GET", f"/api/customers/{c3}")
        check(j["gifts_avail"] == 2 and j["gifts_used"] == 0, "при отказе ничего не списано")
        st, j = R3({"items": [{"drink": lager, "liters": 0.5}, {"drink": dark, "liters": 1}, {"drink": blanche, "liters": 0.5}]})
        check(st == 200 and j["customer"]["gifts_avail"] == 0 and j["customer"]["gifts_used"] == 2, "списано несколько разных напитков одной операцией")
        used = {x["drink"]: x["gift_used"] for x in j["customer"]["per_drink"]}
        check(used == {lager: 0.5, dark: 1, blanche: 0.5} or (used.get(lager) == 0.5 and used.get(dark) == 1 and used.get(blanche) == 0.5), "по каждому пиву учтён свой подарок")
        st, j = R3({"items": [{"drink": lager, "liters": 0.5}]})
        check(st == 400, "после списания подарка нет")

        # --- идемпотентность
        buy(cid, [(dark, 1)], "r-0000001")
        buy(cid, [(dark, 1)], "r-0000001")
        st, cc = s.call("GET", f"/api/customers/{cid}")
        check({x["drink"]: x for x in cc["per_drink"]}[dark]["paid"] == 3 and cc["total_paid"] == 10, "двойное нажатие не дублирует покупку")

        # --- 8 л за раз
        st, j = s.call("POST", "/api/customers", {"name": "Анна", "surname": "Быстрая", "phone": "0671112233"})
        c2 = j["id"]
        st, j = buy(c2, [(lager, 8)])
        check(j["customer"]["gifts_avail"] == 1 and j["customer"]["progress"] == 2, "8 л за раз: 1 подарок, остаток 2 л")
        st, j = buy(c2, [(dark, 4), (blanche, 1)])
        check(j["customer"]["gifts_avail"] == 2 and j["customer"]["progress"] == 1, "смешанная покупка из разных напитков даёт общий подарок")
        st, j = s.call("POST", f"/api/ops/{j['customer']['history'][0]['id']}/undo", {"confirm": True})
        check(j["customer"]["gifts_avail"] == 1 and j["customer"]["progress"] == 2, "отмена смешанной покупки возвращает счёт")
        st, _ = buy(c2, [(lager, 0.3)])
        check(st == 400, "объём не кратный 0,5 отклонён")

        # --- отмена любой операции (с подтверждением)
        hist = cc["history"]
        redeems = [h for h in hist if h["type"] == "redeem"]
        purchases = [h for h in hist if h["type"] == "purchase"]
        oldest = purchases[-1]  # первая покупка (3 + 2,5 л) — не последняя операция
        st, j = s.call("POST", f"/api/ops/{oldest['id']}/undo", {})
        check(st == 200 and "preview" in j and j["preview"]["op"]["id"] == oldest["id"], "отмена: сначала предпросмотр, ничего не меняется")
        st, cc2 = s.call("GET", f"/api/customers/{cid}")
        check(cc2["total_paid"] == cc["total_paid"], "предпросмотр данные не меняет")
        # первая покупка (5,5 л) нужна для подарка: отмена каскадом отменит и списания
        check(len(j["preview"]["cascade"]) >= 1, "отмена покупки, давшей подарок: в предпросмотре каскад списаний")
        st, j2 = s.call("POST", f"/api/ops/{oldest['id']}/undo", {"confirm": True})
        check(st == 200 and j2["customer"]["gifts_used"] == 0, "после подтверждения покупка и зависящие списания отменены")
        st, _ = s.call("POST", f"/api/ops/{oldest['id']}/undo", {"confirm": True})
        check(st == 400, "повторная отмена невозможна")
        # отмена списания
        st, cc = s.call("GET", f"/api/customers/{c2}")
        st, j = s.call("POST", f"/api/customers/{c2}/redeem", {"drink": lager, "liters": 1})
        rid = j["customer"]["history"][0]["id"]
        st, j = s.call("POST", f"/api/ops/{rid}/undo", {"confirm": True})
        check(j["customer"]["gifts_avail"] == 1, "отмена списания возвращает подарок")
        st, _ = s.call("POST", "/api/ops/999999/undo", {})
        check(st == 404, "неизвестная операция -> 404")

        # --- поиск
        st, j = s.call("GET", "/api/search?q=4567")
        check(len(j["results"]) == 1 and j["results"][0]["id"] == cid, "поиск по последним цифрам телефона")
        st, j = s.call("GET", "/api/search?q=" + urllib.parse.quote("быстр"))
        check(len(j["results"]) == 1 and j["results"][0]["id"] == c2, "поиск по фамилии")

        # --- статистика
        st, j = s.call("GET", "/api/stats?period=all")
        check(st == 200 and j["customers_total"] == 3 and j["liters_paid"] > 0 and j["drinks"][0]["emoji"], "статистика магазина")
        st, j = s.call("GET", "/api/customers-stats")
        rows = {r["id"]: r for r in j["customers"]}
        check(st == 200 and j["totals"]["customers"] == 3 and set(rows) == {cid, c2, c3}, "полная статистика: все покупатели")
        check(rows[c2]["gifts_avail"] == 1 and rows[c2]["total_paid"] == 8 and rows[c2]["per_drink"][0]["emoji"], "строка покупателя: литры, подарки, по напиткам")
        check(j["totals"]["paid"] == sum(r["total_paid"] for r in j["customers"]) and "phone" not in rows[c2], "итоги сходятся, лишних данных нет")
        # безопасность CSV
        s.call("POST", "/api/customers", {"name": "=HYPERLINK(1)", "surname": "Хакер", "phone": "0931112233"})
        st, raw = s.call("GET", "/api/export.csv", raw=True)
        txt = raw.decode("utf-8-sig")
        check(st == 200 and "Вайсбург Лагер, л" in txt and "'=HYPERLINK" in txt and ";=HYPERLINK" not in txt, "CSV: колонки по напиткам, формулы обезврежены")

        # --- QR: только ID
        st, png = s.call("GET", f"/api/qr/{cid}.png", raw=True)
        check(st == 200 and png[:4] == b"\x89PNG", "QR отдаётся как PNG")
        try:
            import cv2
            import numpy as np
            img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_GRAYSCALE)
            val, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
            check(val == cid, f"в QR только ID клиента, без адреса ({val})")
        except ImportError:
            print("SKIP чтение QR (нет cv2)")

        # --- смена PIN
        st, _ = s.call("POST", "/api/settings", {"current_pin": "0000", "new_pin": "73920"})
        check(st == 403, "смена PIN требует верный текущий PIN")
        st, _ = s.call("POST", "/api/settings", {"current_pin": "48291", "new_pin": "73920"})
        check(st == 200, "смена PIN")
        t = Client()
        st, _ = t.call("POST", "/api/login", {"pin": "48291"})
        check(st == 401, "старый PIN не работает")
        st, _ = t.call("POST", "/api/login", {"pin": "73920"})
        check(st == 200, "новый PIN работает")

        # --- статика/безопасность
        for path in ("/../server.py", "/data/config.json", "/../data/config.json", "/settings.json"):
            st, _ = s.call("GET", path, raw=True)
            check(st == 404, f"{path} по HTTP не отдаётся")
        st, body = s.call("GET", "/qrdec.js", raw=True)
        check(st == 200 and b"QRDec" in body, "декодер QR отдаётся")
        st, body = s.call("GET", "/manifest.webmanifest", raw=True)
        manifest = json.loads(body.decode("utf-8")) if st == 200 else {}
        check(st == 200 and "standalone" == manifest.get("display") and
              any(icon.get("sizes") == "192x192" for icon in manifest.get("icons", [])) and
              any(icon.get("sizes") == "512x512" for icon in manifest.get("icons", [])) and
              "application/manifest+json" in s.last_headers.get("content-type", ""), "PWA manifest отдаётся с корректным MIME-типом и иконками")
        st, body = s.call("GET", "/sw.js", raw=True)
        check(st == 200 and b"APP_SHELL" in body and b"/api/" in body, "service worker кэширует оболочку, но пропускает API")
        check(b"LOCAL_ADMIN_HOST" in body and b'url.pathname === "/admin.html"' in body,
              "service worker не подменяет локальную панель кэшированным приложением")
        st, body = s.call("GET", "/offline.js", raw=True)
        check(st == 200 and b"indexedDB.open" in body and b"sync_metadata" in body, "клиентский модуль IndexedDB доступен")
        check(server.is_private_client("192.168.1.15") and server.is_private_client("::1") and
              not server.is_private_client("8.8.8.8"), "сервер разрешает только loopback/private/link-local сети")

        # --- HTTPS
        try:
            c = http.client.HTTPSConnection("127.0.0.1", PORT, timeout=10, context=CTX)
            c.request("GET", "/api/state")
            r = c.getresponse()
            j = json.loads(r.read())
            check(r.status == 200 and j["tls_port"] == PORT, "https-порт отвечает (камера доступна)")
        except Exception as e:  # noqa
            check(False, f"https: {e}")

        # --- сохранность и перебор PIN
        st, before = s.call("GET", f"/api/customers/{c2}")
        p.terminate(); p.wait()
        p = start()
        s2 = Client()
        s2.call("POST", "/api/login", {"pin": "73920"})
        st, after = s2.call("GET", f"/api/customers/{c2}")
        check(st == 200 and after["history"] == before["history"] and after["gifts_avail"] == before["gifts_avail"], "данные сохранились после перезапуска")
        st, j = s2.call("GET", "/api/state")
        check(any(x["name"] == "Вайсбург Лагер" for x in j["drinks"]), "напитки на месте после перезапуска")
        check(any(f.startswith("data-") for f in os.listdir(os.path.join(TMP, "data", "backups"))), "создана резервная копия")
        check(not os.path.exists(os.path.join(TMP, "data", "data.json.tmp")), "нет недописанных временных файлов")

        # --- офлайн-синхронизация: постоянное устройство, идемпотентный push и cursor pull
        device_id = str(uuid.uuid4())
        st, sync_state = s2.call("GET", "/api/sync/status")
        check(st == 200 and sync_state["device_id"] is None, "sync/status сообщает курсор и незарегистрированное устройство")
        st, j = s2.call("POST", "/api/sync/register", {"device_id": device_id})
        check(st == 200 and j["device_id"] == device_id, "первое устройство регистрации синхронизации принимается")
        other_device = str(uuid.uuid4())
        st, j = s2.call("POST", "/api/sync/register", {"device_id": other_device})
        check(st == 409 and j.get("code") == "device_conflict", "другое устройство отклонено")
        cid_sync = "ABCD2345"
        registration = {
            "operation_id": str(uuid.uuid4()), "device_id": device_id, "operation_type": "register",
            "customer_id": cid_sync, "payload": {"name": "Offline", "surname": "", "phone": "0501112233"},
            "created_at": "2026-01-01T00:00:00", "client_sequence": 1, "base_version": sync_state["cursor"],
        }
        st, pushed = s2.call("POST", "/api/sync/push", {"operations": [registration]})
        ack = pushed["results"][0]
        check(st == 200 and ack["acknowledged"] and ack["result"]["customer_id"] == cid_sync,
              "offline-регистрация применена с клиентским ID")
        st, repeated = s2.call("POST", "/api/sync/push", {"operations": [registration]})
        check(st == 200 and repeated["results"][0]["acknowledged"] and repeated["results"][0]["result"]["replay"],
              "повтор push не дублирует регистрацию")
        changed = dict(registration, payload=dict(registration["payload"], name="Changed"))
        st, conflict = s2.call("POST", "/api/sync/push", {"operations": [changed]})
        check(st == 200 and not conflict["results"][0]["acknowledged"] and conflict["results"][0]["code"] == "idempotency_conflict",
              "изменённый payload с тем же operation_id конфликтует")
        purchase = {
            "operation_id": str(uuid.uuid4()), "device_id": device_id, "operation_type": "purchase",
            "customer_id": cid_sync, "payload": {"items": [{"drink": lager, "liters": 2}]},
            "created_at": "2026-01-01T00:00:01", "client_sequence": 2, "base_version": sync_state["cursor"],
        }
        invalid_redemption = {
            "operation_id": str(uuid.uuid4()), "device_id": device_id, "operation_type": "redemption",
            "customer_id": cid_sync, "payload": {"items": [{"drink": lager, "liters": 1}]},
            "created_at": "2026-01-01T00:00:02", "client_sequence": 3, "base_version": sync_state["cursor"],
        }
        st, pushed = s2.call("POST", "/api/sync/push", {"operations": [purchase, invalid_redemption]})
        check(st == 200 and pushed["results"][0]["acknowledged"] and not pushed["results"][1]["acknowledged"] and
              pushed["results"][1]["conflict"], "частичный push сохраняет успехи рядом с конфликтными операциями")
        later_purchase = dict(purchase, operation_id=str(uuid.uuid4()), client_sequence=4,
                              payload={"items": [{"drink": lager, "liters": 1}]})
        st, later = s2.call("POST", "/api/sync/push", {"operations": [later_purchase]})
        st, replayed = s2.call("POST", "/api/sync/push", {"operations": [purchase]})
        previous_result = pushed["results"][0]["result"]
        replay_result = replayed["results"][0]["result"]
        check(st == 200 and later["results"][0]["acknowledged"] and replay_result.get("replay") and
              {k: v for k, v in replay_result.items() if k != "replay"} == previous_result and
              replayed["results"][0]["server_operation_ids"] == pushed["results"][0]["server_operation_ids"],
              "повтор push возвращает сохранённое подтверждение без повторного применения")
        invalid_purchase = dict(later_purchase, operation_id=str(uuid.uuid4()), client_sequence=5,
                                payload={"items": [{"drink": lager, "liters": float("nan")}]})
        st, invalid = s2.call("POST", "/api/sync/push", {"operations": [invalid_purchase]})
        check(st == 200 and not invalid["results"][0]["acknowledged"] and invalid["results"][0]["code"] == "operation_rejected",
              "нечисловой объём отклоняется отдельно, не прерывая sync API")
        st, pulled = s2.call("GET", f"/api/sync/pull?since={sync_state['cursor']}")
        local_customer = next((c for c in pulled.get("changes", {}).get("customers", []) if c["id"] == cid_sync), None)
        check(st == 200 and pulled["cursor"] > sync_state["cursor"] and local_customer and local_customer["total_paid"] == 3,
              "pull возвращает обновлённого клиента и новый курсор")
        st, _ = s2.call("POST", "/api/sync/register", {"device_id": device_id})
        check(st == 200, "идентификатор устройства сохраняется после перезапуска")
        write_settings(
            DRINKS,
            loyalty={"paid_liters": 4, "reward_liters": 0.5},
            server={"https_port": 8443, "pages_origins": ["https://c0dyssey.github.io"]},
            backups={"interval_hours": 1, "retention_days": 30},
        )
        st, customer = s2.call("POST", "/api/customers",
                               {"name": "Rule", "surname": "Test", "phone": "0501112234"})
        check(st == 200, "тестовый клиент зарегистрирован для проверки JSON-правила")
        if st == 200:
            st, earned = s2.call("POST", f"/api/customers/{customer['id']}/purchase",
                                 {"items": [{"drink": lager, "liters": 4}]})
            check(st == 200 and earned["customer"]["gifts_avail"] == 0.5,
                  "сервер рассчитывает количество награды по JSON-настройке")
        bad = Client()
        for _ in range(5):
            st, _ = bad.call("POST", "/api/login", {"pin": "0000"})
        check(st == 401, "неверный PIN отклонён")
        st, _ = bad.call("POST", "/api/login", {"pin": "73920"})
        check(st == 429, "блокировка после 5 неверных попыток (даже с верным PIN)")
    finally:
        p.terminate()
    print("\nПровалов:", check.failed)
    sys.exit(1 if check.failed else 0)


main()
