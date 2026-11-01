"""Тесты надёжности: python test_reliability.py
Сбои записи, аварийное завершение, повторы запросов, повреждённая база, восстановление, только HTTPS."""
import http.client
import json
import os
import sys

from tests_common import Env, check, sha, PIN

JSON_OK = lambda p: bool(json.load(open(p, encoding="utf-8")))  # noqa: E731


def seed(env, first=True):
    """клиент + 2 л Лагера; -> (client, cid, lager_id)"""
    c = env.login(first=first)
    st, j = c.call("GET", "/api/state")
    lager = {d["name"]: d["id"] for d in j["drinks"]}["Вайсбург Лагер"]
    st, j = c.call("POST", "/api/customers", {"request_id": "reg-seed-0001", "name": "Иван", "surname": "Петров", "phone": "0501234567"})
    cid = j["id"]
    c.call("POST", f"/api/customers/{cid}/purchase", {"request_id": "buy-seed-0001", "items": [{"drink": lager, "liters": 2}]})
    return c, cid, lager


def info(c, cid):
    st, j = c.call("GET", f"/api/customers/{cid}")
    return j["total_paid"], [h["id"] for h in j["history"]]


def buy(c, cid, lager, rid, liters=1):
    return c.call("POST", f"/api/customers/{cid}/purchase", {"request_id": rid, "items": [{"drink": lager, "liters": liters}]})


def t_disk_full():
    print("\n# Ошибка записи / нехватка места")
    env = Env()
    try:
        env.start()
        c, cid, lager = seed(env)
        before = sha(env.data_file)
        env.set_fault("enospc")
        st, j = buy(c, cid, lager, "buy-full-0001")
        check(st == 503 and "НЕ выполнена" in j.get("error", ""), "нет места: операция отклонена с понятным сообщением")
        check(info(c, cid) == (2, [2]), "в памяти ничего не изменилось (нет «фантомной» покупки)")
        check(sha(env.data_file) == before, "файл базы на диске не тронут")
        check(not os.path.exists(env.data_file + ".tmp"), "недописанный временный файл удалён")
        env.set_fault("enospc")
        st, j = c.call("POST", "/api/customers", {"request_id": "reg-full-0001", "name": "Анна", "surname": "Быстрая", "phone": "0671112233"})
        st2, s = c.call("GET", "/api/search?q=0671112233")
        check(st == 503 and not s["results"], "регистрация при сбое записи откатывается целиком")
        st, j = buy(c, cid, lager, "buy-full-0001")
        check(st == 200 and info(c, cid) == (3, [3, 2]), "после освобождения места тот же запрос проходит, номера операций без дыр")
        st, j = buy(c, cid, lager, "buy-full-0001")
        check(st == 200 and j.get("replay") and info(c, cid)[0] == 3, "повтор того же запроса не создаёт дубль")
    finally:
        env.stop()


def t_crash_during_save():
    print("\n# Аварийное завершение во время сохранения")
    for stage, label in (("after_tmp", "после записи временного файла"), ("after_link", "после создания .prev, до замены")):
        env = Env()
        try:
            env.start()
            c, cid, lager = seed(env)
            before = sha(env.data_file)
            env.set_fault(stage)
            try:
                buy(c, cid, lager, "buy-crash-0001")
                dropped = False
            except Exception:  # noqa
                dropped = True
            check(dropped and env.died(), f"[{label}] процесс аварийно завершён, клиент ответа не получил")
            check(JSON_OK(env.data_file) and sha(env.data_file) == before, f"[{label}] data.json цел и содержит все подтверждённые операции")
            env.start()
            c = env.login()
            check(info(c, cid) == (2, [2]), f"[{label}] после перезапуска неподтверждённая операция не применена, подтверждённые на месте")
            check(not os.path.exists(env.data_file + ".tmp"), f"[{label}] остаток .tmp убран")
            st, j = buy(c, cid, lager, "buy-crash-0001")
            check(st == 200 and info(c, cid)[0] == 3, f"[{label}] повтор запроса с тем же ID выполняется ровно один раз")
            st, j = buy(c, cid, lager, "buy-crash-0001")
            check(j.get("replay") and info(c, cid)[0] == 3, f"[{label}] второй повтор — прежний результат")
        finally:
            env.stop()
    env = Env()
    try:
        env.start()
        c, cid, lager = seed(env)
        env.set_fault("after_replace")
        try:
            buy(c, cid, lager, "buy-crash-0002")
            dropped = False
        except Exception:  # noqa
            dropped = True
        check(dropped and env.died(), "[после замены файла] авария до отправки ответа")
        env.start()
        c = env.login()
        check(info(c, cid)[0] == 3, "[после замены файла] операция сохранилась (подтверждена на диске)")
        st, j = buy(c, cid, lager, "buy-crash-0002")
        check(st == 200 and j.get("replay") and info(c, cid)[0] == 3, "[после замены файла] повтор после перезапуска не дублирует операцию")
        prev_ops = json.load(open(env.data_file + ".prev", encoding="utf-8"))["ops"]
        now_ops = json.load(open(env.data_file, encoding="utf-8"))["ops"]
        check(len(prev_ops) == len(now_ops) - 1, "прошлая версия хранится в .prev без копирования перед операцией")
    finally:
        env.stop()


def t_idempotency():
    print("\n# Идемпотентность")
    env = Env()
    try:
        env.start()
        c, cid, lager = seed(env)
        c.send_and_drop("POST", f"/api/customers/{cid}/purchase", {"request_id": "buy-lost-0001", "items": [{"drink": lager, "liters": 1}]})
        import time
        time.sleep(0.4)
        st, j = buy(c, cid, lager, "buy-lost-0001")
        check(st == 200 and j.get("replay") and info(c, cid)[0] == 3, "потеря ответа: повтор возвращает прежний результат, дубля нет")
        st, j = buy(c, cid, lager, "buy-lost-0001", liters=2)
        check(st == 409, "тот же ID с другим содержимым отклоняется (409)")
        st, j = c.call("POST", "/api/customers", {"request_id": "buy-lost-0001", "name": "А", "surname": "Б", "phone": "0509998877"})
        check(st == 409, "тот же ID на другой операции отклоняется (409)")
        st, j = c.call("POST", f"/api/customers/{cid}/purchase", {"request_id": "", "items": [{"drink": lager, "liters": 1}]})
        check(st == 400, "запрос без request_id отклоняется")
        st, j = c.call("POST", f"/api/customers/{cid}/purchase", {"request_id": "bad id!", "items": [{"drink": lager, "liters": 1}]})
        check(st == 400, "некорректный request_id отклоняется")
        # списание и отмена тоже идемпотентны
        buy(c, cid, lager, "buy-lost-0002", liters=3)
        r1 = c.call("POST", f"/api/customers/{cid}/redeem", {"request_id": "red-0000001", "drink": lager, "liters": 1})
        r2 = c.call("POST", f"/api/customers/{cid}/redeem", {"request_id": "red-0000001", "drink": lager, "liters": 1})
        st, h = c.call("GET", f"/api/customers/{cid}")
        check(r1[0] == 200 and r2[1].get("replay") and h["gifts_used"] == 1, "списание подарка: повтор не списывает второй раз")
        op = [x for x in h["history"] if x["type"] == "redeem"][0]["id"]
        u1 = c.call("POST", f"/api/ops/{op}/undo", {"request_id": "und-0000001", "confirm": True})
        u2 = c.call("POST", f"/api/ops/{op}/undo", {"request_id": "und-0000001", "confirm": True})
        check(u1[0] == 200 and u2[0] == 200 and u2[1].get("replay"), "отмена: повтор не вызывает ошибку «уже отменено»")
        stored = json.load(open(env.data_file, encoding="utf-8"))["requests"]
        check("buy-lost-0001" in stored and stored["buy-lost-0001"]["fp"], "ID и отпечаток запроса хранятся в файле базы")
        env.stop()
        env.start()
        c = env.login()
        st, j = buy(c, cid, lager, "buy-lost-0001")
        check(st == 200 and j.get("replay"), "после перезапуска повтор возвращает прежний результат")
        st, j = buy(c, cid, lager, "buy-lost-0001", liters=2)
        check(st == 409, "после перезапуска конфликт ID по-прежнему обнаруживается")
        total_before = info(c, cid)[0]
        st, j = buy(c, cid, lager, "buy-lost-0001")
        check(info(c, cid)[0] == total_before, "после перезапуска операция не выполняется повторно")
    finally:
        env.stop()


def t_ttl():
    print("\n# Срок хранения идентификаторов")
    env = Env()
    try:
        env.start()
        c, cid, lager = seed(env)
        env.stop()
        d = json.load(open(env.data_file, encoding="utf-8"))
        d["requests"]["old-request-0001"] = {"fp": "x", "ts": "2020-01-01T00:00:00", "kind": "purchase", "cid": cid}
        d["requests"]["sync-old-operation"] = {"fp": "x", "sync_fp": "y", "ts": "2020-01-01T00:00:00", "kind": "purchase", "cid": cid}
        json.dump(d, open(env.data_file, "w", encoding="utf-8"), ensure_ascii=False)
        env.start()
        d = json.load(open(env.data_file, encoding="utf-8"))
        check("old-request-0001" not in d["requests"] and "buy-seed-0001" in d["requests"], "ID старше 30 дней удаляются, свежие остаются")
        check("sync-old-operation" in d["requests"], "идентификатор синхронизации не удаляется по TTL")
    finally:
        env.stop()


def corrupt(path):
    raw = open(path, "rb").read()
    open(path, "wb").write(raw[: len(raw) // 2])
    return raw[: len(raw) // 2]


def t_corrupt_and_restore():
    print("\n# Повреждённая база при запуске и восстановление")
    env = Env()
    try:
        env.start()
        c, cid, lager = seed(env)
        st, j = c.call("POST", "/api/backup", {})
        check(st == 200, "ручная резервная копия создана и проверена")
        buy(c, cid, lager, "buy-corr-0001")
        buy(c, cid, lager, "buy-corr-0002")           # 4 операции в базе, в копии: 2
        env.stop()
        broken = corrupt(env.data_file)
        env.start()
        c = env.login()
        st, s = c.call("GET", "/api/state")
        check(s.get("locked") and "повреждён" in s["locked"]["reason"], "при запуске обнаружено повреждение, сайт заблокирован")
        st, j = buy(c, cid, lager, "buy-corr-0003")
        check(st == 503 and j.get("locked") and "восстановление" in j["error"], "изменения заблокированы с понятной ошибкой")
        st, j = c.call("GET", f"/api/customers/{cid}")
        check(st == 503, "чтение тоже закрыто (нет пустых «фантомных» данных)")
        check(open(env.data_file, "rb").read() == broken, "повреждённый файл НЕ перезаписан пустой базой")
        saved = os.listdir(os.path.join(env.data, "corrupt"))
        check(len(saved) == 1 and open(os.path.join(env.data, "corrupt", saved[0]), "rb").read() == broken, "исходный файл сохранён отдельно")
        env.stop()
        env.start()
        check(len(os.listdir(os.path.join(env.data, "corrupt"))) == 1, "повторный запуск не плодит копии")
        c = env.login()
        st, rec = c.call("GET", "/api/recovery")
        keys = {x["key"]: x for x in rec["candidates"]}
        check(st == 200 and keys["prev"]["ok"] and any(k.startswith("data-") and v["ok"] for k, v in keys.items()), "в списке восстановления: .prev и копии с проверкой целостности")
        check(keys["prev"]["ops"] == 3 and keys["prev"]["customers"] == 1 and keys["prev"]["last_op_ts"], "для каждой копии видно число операций и дату последней")
        st, j = c.call("POST", "/api/recovery/restore", {"name": "prev", "pin": "00000"})
        check(st == 403, "неверный PIN: восстановление не выполняется")
        st, s = c.call("GET", "/api/state")
        check(s.get("locked"), "после неверного PIN база осталась заблокированной")
        st, j = c.call("POST", "/api/recovery/restore", {"name": "../../etc/passwd", "pin": PIN})
        check(st in (403, 404), "путь вне папки копий не принимается")
        st, j = c.call("POST", "/api/recovery/restore", {"name": "prev", "pin": PIN})
        check(st == 200 and j["ops"] == 3, "восстановление из .prev с PIN выполнено (потеряна только последняя операция, это видно заранее)")
        st, s = c.call("GET", "/api/state")
        check(not s.get("locked"), "блокировка снята")
        total, ids = info(c, cid)
        check(total == 3, "все операции, вошедшие в выбранную копию, на месте")
        st, j = buy(c, cid, lager, "buy-corr-0004")
        check(st == 200, "после восстановления операции снова проходят")
        check("ВОССТАНОВЛЕНИЕ" in open(os.path.join(env.data, "events.log"), encoding="utf-8").read(), "восстановление записано в журнал событий")
    finally:
        env.stop()
    # восстановление из ежедневной копии
    env = Env()
    try:
        env.start()
        c, cid, lager = seed(env)
        c.call("POST", "/api/backup", {})
        buy(c, cid, lager, "buy-bk-0000001")
        env.stop()
        for f in (env.data_file + ".prev",):
            os.remove(f)
        corrupt(env.data_file)
        env.start()
        c = env.login()
        st, rec = c.call("GET", "/api/recovery")
        name = [x for x in rec["candidates"] if x["key"].startswith("data-")][0]
        st, j = c.call("POST", "/api/recovery/restore", {"name": name["key"], "pin": PIN})
        check(st == 200 and j["ops"] == name["ops"], "восстановление из резервной копии: ровно то, что показано в списке")
        total, _ = info(c, cid)
        check(total == 2, "все операции, подтверждённые до копии, сохранены")
    finally:
        env.stop()


def t_missing_and_backup_checks():
    print("\n# Файл базы пропал / повреждена копия / мусор")
    env = Env()
    try:
        env.start()
        seed(env)
        env.stop()
        os.remove(env.data_file)
        env.start()
        c = env.login()
        st, s = c.call("GET", "/api/state")
        check(s.get("locked") and not os.path.exists(env.data_file), "нет data.json, но есть копии: блокировка, пустая база НЕ создаётся")
        st, rec = c.call("GET", "/api/recovery")
        st, j = c.call("POST", "/api/recovery/restore", {"name": rec["candidates"][0]["key"], "pin": PIN})
        check(st == 200 and not (c.call("GET", "/api/state")[1].get("locked")), "восстановление после пропажи файла")
    finally:
        env.stop()
    env = Env()
    try:
        env.start()
        seed(env)
        env.stop()
        bdir = os.path.join(env.data, "backups")
        newest = sorted(os.listdir(bdir))[-1]
        corrupt(os.path.join(bdir, newest))
        open(env.data_file + ".tmp", "wb").write(b"\x00garbage")
        env.start()
        c = env.login()
        st, s = c.call("GET", "/api/state")
        check(not s.get("locked") and any("не прошла проверку" in w for w in s["warnings"]), "повреждённая резервная копия обнаружена и показана предупреждением")
        check(not os.path.exists(env.data_file + ".tmp"), "мусорный .tmp при исправной базе игнорируется и удаляется")
        st, rec = c.call("GET", "/api/recovery")
        check(any(not x["ok"] for x in rec["candidates"]), "негодная копия помечена в списке восстановления")
    finally:
        env.stop()
    env = Env()
    try:
        env.start()
        c = env.login(first=True)
        st, j = c.call("GET", "/api/recovery")
        check(st == 200 and not j["locked"] and os.path.exists(env.data_file), "чистая установка создаёт новую базу (блокировки нет)")
    finally:
        env.stop()


def t_https_only():
    print("\n# Только HTTPS")
    env = Env()
    try:
        env.start()
        c = env.login(first=True)
        check("Secure" in (c.last_headers.get("set-cookie") or ""), "cookie сессии помечена Secure")
        try:
            h = http.client.HTTPConnection("127.0.0.1", env.port, timeout=5)
            h.request("GET", "/api/state")
            r = h.getresponse()
            ok_plain = r.status == 200 and b"setup_needed" in r.read()
        except Exception:  # noqa
            ok_plain = False
        check(not ok_plain, "обычный HTTP на этом порту не обслуживается")
        st, j = c.call("GET", "/api/state")
        check(st == 200 and j["tls_port"] == env.port, "сайт и API отвечают по HTTPS")
        import socket
        s = socket.socket()
        s.settimeout(1)
        closed = s.connect_ex(("127.0.0.1", 8080)) != 0
        s.close()
        check(closed, "порт 8080 никто не слушает")
        st, png = c.call("GET", "/api/qr/NOSUCHID.png", raw=True)
        check(st == 404, "QR-адрес отдаётся тем же HTTPS-сервером")
    finally:
        env.stop()


if __name__ == "__main__":
    for t in (t_disk_full, t_crash_during_save, t_idempotency, t_ttl, t_corrupt_and_restore, t_missing_and_backup_checks, t_https_only):
        try:
            t()
        except Exception as e:  # noqa
            import traceback
            traceback.print_exc()
            check(False, f"{t.__name__}: исключение {e!r}")
    print("\nПровалов:", check.failed)
    sys.exit(1 if check.failed else 0)
