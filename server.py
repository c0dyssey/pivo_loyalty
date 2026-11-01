#!/usr/bin/env python3
"""Программа лояльности для пивного магазина (локальный сервер, только HTTPS).

Только стандартная библиотека Python 3.8+. Запуск: python server.py
Настройки магазина, лояльности, сети и резервирования: settings.json
Данные: data/data.json (+ data.json.prev), PIN: data/config.json, копии: data/backups/,
повреждённые файлы: data/corrupt/, сертификат: data/cert/, события: data/events.log
"""
import csv
import errno
import hashlib
import hmac
import ipaddress
import io
import json
import math
import os
import re
import secrets
import shutil
import socket
import ssl
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import certgen
import qr

if os.name == "nt":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    try:
        sys.stderr.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("PIVO_DATA", os.path.join(BASE, "data"))
SETTINGS_FILE = os.environ.get("PIVO_SETTINGS", os.path.join(BASE, "settings.json"))
STATIC = os.path.join(BASE, "static")
DATA_FILE = os.path.join(DATA_DIR, "data.json")
PREV_FILE = DATA_FILE + ".prev"
CONF_FILE = os.path.join(DATA_DIR, "config.json")
BACKUP_DIR = os.path.join(DATA_DIR, "backups")
CORRUPT_DIR = os.path.join(DATA_DIR, "corrupt")
CERT_DIR = os.path.join(DATA_DIR, "cert")
EVENT_LOG = os.path.join(DATA_DIR, "events.log")

SESSION_IDLE_SEC = 3 * 3600
REQUEST_TTL_DAYS = 30
CYCLE_H = 12
REWARD_H = 2
BACKUPS_KEEP = 30
BACKUP_INTERVAL_HOURS = 1
ID_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
RID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
ROLE = "staff"
PORT = int(os.environ.get("PIVO_PORT", "8443"))
PORT_OVERRIDE = "PIVO_PORT" in os.environ
ALLOWED_PWA_ORIGINS = {"https://c0dyssey.github.io"}
ORIGINS_OVERRIDE = "PIVO_ALLOWED_ORIGINS" in os.environ
SERVER_STARTED = False

DISK_MSG = ("Не удалось записать данные на диск (возможно, нет места или нет доступа к файлу). "
            "Операция НЕ выполнена и не сохранена. Освободите место и повторите.")
LOCKED_MSG = "База данных недоступна для изменений: требуется восстановление. Данные не потеряны и не перезаписаны."

DEFAULT_SETTINGS = {
    "shop": "Пивной магазин",
    "drinks": [
        {"id": "weissburg-blanche", "name": "Вайсбург Бланш", "emoji": "🍋", "color": "#f59e0b"},
        {"id": "weissburg-lager", "name": "Вайсбург Лагер", "emoji": "🍺", "color": "#d97706"},
        {"id": "knyaz-sangushko", "name": "Князь Сангушко", "emoji": "🏰", "color": "#7c3aed"},
        {"id": "kronenbourg-blanc", "name": "Кроненбург Бланш", "emoji": "👑", "color": "#0ea5e9"},
        {"id": "heisenberg-dark", "name": "Хайзенберг Дарк", "emoji": "🌑", "color": "#57534e"},
        {"id": "bilyi-kelyh", "name": "Білий келих", "emoji": "🥂", "color": "#16a34a"},
    ],
    "loyalty": {"paid_liters": 6, "reward_liters": 1},
    "server": {"https_port": 8443, "pages_origins": ["https://c0dyssey.github.io"]},
    "backups": {"interval_hours": 1, "retention_days": 30},
}
PALETTE = ["#d97706", "#0ea5e9", "#16a34a", "#dc2626", "#7c3aed", "#0d9488", "#db2777", "#65a30d"]

LOCK = threading.RLock()
STATE = {"data": None, "conf": None, "locked": None}
SYNC_CONTEXT = None
STATUS = {"backup": {"ok": None, "name": None, "error": None, "ts": None}}
SETTINGS = {
    "mtime": None, "shop": DEFAULT_SETTINGS["shop"], "drinks": [],
    "loyalty": dict(DEFAULT_SETTINGS["loyalty"]), "backups": dict(DEFAULT_SETTINGS["backups"]),
    "server": dict(DEFAULT_SETTINGS["server"]),
    "error": None,
}
SESSIONS = {}       # token -> {"seen":...}
FAILS = {}          # ip -> {"n":..., "until":...}


# ---------------------------------------------------------------- утилиты
def now_iso():
    return datetime.now().replace(microsecond=0).isoformat()


def log_event(msg):
    try:
        with open(EVENT_LOG, "a", encoding="utf-8") as f:
            f.write(f"{now_iso()} {msg}\n")
    except OSError:
        pass


def hash_pin(pin, salt=None):
    salt = salt or secrets.token_hex(8)
    return {"salt": salt, "hash": hashlib.pbkdf2_hmac("sha256", pin.encode(), salt.encode(), 200_000).hex()}


def check_pin(pin, rec):
    h = hashlib.pbkdf2_hmac("sha256", pin.encode(), rec["salt"].encode(), 200_000).hex()
    return hmac.compare_digest(h, rec["hash"])


def verify_pin(pin):
    conf = STATE["conf"] or {}
    recs = [conf["pin"]] if "pin" in conf else [conf[k] for k in ("seller", "owner") if k in conf]
    ok = False
    for r in recs:                      # без раннего выхода: время не зависит от результата
        ok = check_pin(pin, r) or ok
    return ok


def weak_pin(pin):
    return len(set(pin)) == 1 or pin in ("1234", "12345", "123456", "1234567", "12345678", "4321", "654321")


def norm_phone(raw):
    d = re.sub(r"\D", "", raw or "")
    if len(d) == 10 and d.startswith("0"):
        d = "38" + d
    return d


def fmt_phone(d):
    if len(d) == 12 and d.startswith("380"):
        return f"+{d[:3]} {d[3:5]} {d[5:8]} {d[8:10]} {d[10:]}"
    return "+" + d if d else ""


def half(x):
    """литры -> целые половинки; None если не кратно 0.5"""
    try:
        v = float(x)
        if not math.isfinite(v):
            return None
        h = round(v * 2)
    except (TypeError, ValueError, OverflowError):
        return None
    if abs(v * 2 - h) > 1e-9:
        return None
    return int(h)


def lit(h):
    v = h / 2
    return int(v) if v == int(v) else v


_TR = dict(zip("абвгдеёжзийклмнопрстуфхцчшщъыьэюяіїєґ",
               ["a", "b", "v", "g", "d", "e", "e", "zh", "z", "i", "y", "k", "l", "m", "n", "o", "p", "r", "s", "t",
                "u", "f", "h", "ts", "ch", "sh", "sch", "", "y", "", "e", "yu", "ya", "i", "yi", "ye", "g"]))


def slug(name):
    s = "".join(_TR.get(ch, ch) for ch in name.lower())
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:40]
    return s or "drink-" + hashlib.md5(name.encode()).hexdigest()[:6]


# ---------------------------------------------------------------- надёжная запись файлов
def _fault(stage):
    """Только для тестов: имитация сбоев. Работает лишь если задана PIVO_FAULT_FILE."""
    ff = os.environ.get("PIVO_FAULT_FILE")
    if not ff or not os.path.exists(ff):
        return False
    try:
        with open(ff) as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        return False
    if cfg.get("stage") != stage:
        return False
    if cfg.get("once", True):
        try:
            os.remove(ff)
        except OSError:
            pass
    if stage == "enospc":
        return True
    os._exit(137)           # аварийное завершение процесса в заданной точке


def _fsync_dir(path):
    try:
        fd = os.open(os.path.dirname(path) or ".", os.O_RDONLY)
    except OSError:         # Windows не открывает каталоги — там замена файла и так атомарна
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def atomic_write(path, obj, keep_prev=False):
    """Временный файл -> flush+fsync -> (прошлая версия жёсткой ссылкой .prev, без копирования) -> атомарная замена."""
    payload = json.dumps(obj, ensure_ascii=False, indent=1).encode("utf-8")
    tmp = path + ".tmp"
    prev = path + ".prev"
    try:
        with open(tmp, "wb") as f:
            if _fault("enospc"):
                f.write(payload[: len(payload) // 2])
                f.flush()
                raise OSError(errno.ENOSPC, os.strerror(errno.ENOSPC))
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        _fault("after_tmp")
        if keep_prev and os.path.exists(path):
            try:
                os.remove(prev)
            except FileNotFoundError:
                pass
            try:
                os.link(path, prev)
            except OSError:                 # файловая система без жёстких ссылок
                os.replace(path, prev)
            _fault("after_link")
        os.replace(tmp, path)
        _fsync_dir(path)
        _fault("after_replace")
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        if not os.path.exists(path) and os.path.exists(prev):
            try:
                os.replace(prev, path)
            except OSError:
                pass
        raise


class StorageError(Exception):
    pass


# ---------------------------------------------------------------- проверка целостности базы
def _check_items(items):
    if not isinstance(items, list) or not items:
        return False
    return all(isinstance(i, dict) and isinstance(i.get("drink"), str) and half(i.get("liters")) not in (None, 0) for i in items)


def validate_data(d):
    if not isinstance(d, dict):
        raise ValueError("корень файла не является объектом")
    for k, t in (("customers", dict), ("ops", list), ("drinks", list)):
        if not isinstance(d.get(k), t):
            raise ValueError(f"нет раздела «{k}»")
    if not isinstance(d.get("next_op"), int):
        raise ValueError("нет счётчика операций")
    if not isinstance(d.setdefault("requests", {}), dict):
        raise ValueError("раздел «requests» повреждён")
    if d.setdefault("sync_device_id", None) is not None and not isinstance(d["sync_device_id"], str):
        raise ValueError("идентификатор устройства синхронизации повреждён")
    for cid, c in d["customers"].items():
        if not isinstance(c, dict) or c.get("id") != cid or not all(isinstance(c.get(k), str) for k in ("name", "surname", "phone", "created")):
            raise ValueError(f"клиент {cid}: повреждена запись")
    last = 0
    for o in d["ops"]:
        if not isinstance(o, dict) or not isinstance(o.get("id"), int) or o["id"] <= last:
            raise ValueError("нарушен порядок номеров операций")
        last = o["id"]
        if o.get("type") not in ("register", "purchase", "redeem") or not isinstance(o.get("ts"), str):
            raise ValueError(f"операция {last}: неизвестный тип")
        if o.get("customer") not in d["customers"]:
            raise ValueError(f"операция {last}: нет такого клиента")
        if o["type"] == "purchase" and not _check_items(o.get("items")):
            raise ValueError(f"операция {last}: неверные позиции покупки")
        if o["type"] == "redeem" and (not isinstance(o.get("drink"), str) or half(o.get("liters")) in (None, 0)):
            raise ValueError(f"операция {last}: неверное списание")
    if d["next_op"] <= last:
        raise ValueError("счётчик операций меньше номера последней операции")
    return d


def load_json_file(path):
    with open(path, "rb") as f:
        raw = f.read()
    return validate_data(json.loads(raw.decode("utf-8")))


def check_file(path):
    try:
        load_json_file(path)
        return True, ""
    except Exception as e:  # noqa
        return False, str(e)[:200]


def describe_file(path, key, label):
    try:
        st = os.stat(path)
    except OSError:
        return None
    info = {"key": key, "name": label, "size": st.st_size,
            "mtime": datetime.fromtimestamp(st.st_mtime).replace(microsecond=0).isoformat()}
    try:
        d = load_json_file(path)
        info.update(ok=True, ops=len(d["ops"]), customers=len(d["customers"]),
                    last_op_ts=d["ops"][-1]["ts"] if d["ops"] else None)
    except Exception as e:  # noqa
        info.update(ok=False, error=str(e)[:200])
    return info


def skeleton():
    return {"version": 3, "next_op": 1, "drinks": [], "customers": {}, "ops": [], "requests": {},
            "sync_device_id": None}


def backup_names():
    if not os.path.isdir(BACKUP_DIR):
        return []
    return sorted(f for f in os.listdir(BACKUP_DIR) if re.match(r"^data-[0-9_\-]+\.json$", f))


def lock_db(reason, corrupt):
    """База не читается: изменения запрещены, исходный файл не трогаем и сохраняем копию отдельно."""
    saved = None
    if corrupt and os.path.exists(DATA_FILE):
        with open(DATA_FILE, "rb") as f:
            raw = f.read()
        sha = hashlib.sha256(raw).hexdigest()[:8]
        existing = [n for n in os.listdir(CORRUPT_DIR) if n.endswith(f"-{sha}.json")]
        saved = os.path.join(CORRUPT_DIR, existing[0] if existing else datetime.now().strftime(f"data-%Y-%m-%d_%H%M%S-{sha}.json"))
        if not existing:
            with open(saved, "wb") as f:
                f.write(raw)
                f.flush()
                os.fsync(f.fileno())
    STATE["data"] = skeleton()          # только в памяти, на диск не записывается (save() заблокирован)
    STATE["locked"] = {"reason": reason, "saved_copy": saved}
    log_event(f"БЛОКИРОВКА: {reason}; копия повреждённого файла: {saved}")


def load_all():
    for d in (DATA_DIR, BACKUP_DIR, CORRUPT_DIR):
        os.makedirs(d, exist_ok=True)
    STATE["locked"] = None
    STATE["conf"] = None
    if os.path.exists(CONF_FILE):
        with open(CONF_FILE, encoding="utf-8") as f:
            STATE["conf"] = json.load(f)
    tmp = DATA_FILE + ".tmp"
    data = None
    if os.path.exists(DATA_FILE):
        try:
            data = load_json_file(DATA_FILE)
        except Exception as e:  # noqa
            lock_db(f"Файл базы повреждён ({e}).", corrupt=True)
    else:
        if os.path.exists(tmp):             # авария между записью и заменой, когда data.json ещё не было
            try:
                data = load_json_file(tmp)
                os.replace(tmp, DATA_FILE)
                log_event("data.json отсутствовал; принят полностью записанный data.json.tmp")
            except Exception:  # noqa
                data = None
        if data is None:
            if os.path.exists(PREV_FILE) or backup_names():
                lock_db("Файл базы не найден, но остались его копии.", corrupt=False)
            else:
                data = skeleton()
                atomic_write(DATA_FILE, data)
                log_event("создана новая база")
    if STATE["locked"]:
        return
    if os.path.exists(tmp):
        try:
            os.remove(tmp)
        except OSError:
            pass
    STATE["data"] = data
    if prune_requests():
        _save_or_log()
    refresh_settings(force=True)
    names = backup_names()
    if names:
        ok, err = check_file(os.path.join(BACKUP_DIR, names[-1]))
        STATUS["backup"] = {"ok": ok, "name": names[-1], "error": err or None, "ts": now_iso()}
        if not ok:
            log_event(f"Последняя резервная копия {names[-1]} не прошла проверку: {err}")
    do_backup(force=False)


def _save_or_log():
    try:
        save()
    except Exception as e:  # noqa
        log_event(f"Служебная запись не удалась: {e!r}")


def save():
    if STATE["locked"]:
        raise StorageError("база заблокирована")
    atomic_write(DATA_FILE, STATE["data"], keep_prev=True)
    try:
        do_backup(force=False)
    except Exception as e:  # noqa
        log_event(f"Резервная копия не создана: {e!r}")


def commit(rollback):
    """Записать на диск; при ошибке вернуть память в прежнее состояние и сообщить об этом."""
    try:
        save()
    except Exception as e:  # noqa
        rollback()
        log_event(f"Ошибка записи, операция отменена: {e!r}")
        raise ApiError(DISK_MSG, 503)


def do_backup(force=False, refresh=False):
    """Копия за день (+ по требованию). Проверяется сразу после создания; повреждённая копия не сохраняется."""
    if STATE["locked"] or not os.path.exists(DATA_FILE):
        return None
    name = datetime.now().strftime("data-%Y-%m-%d_%H%M%S.json" if force else "data-%Y-%m-%d.json")
    path = os.path.join(BACKUP_DIR, name)
    need = force or not os.path.exists(path)
    if refresh and not need:
        try:
            refresh_after = max(0, BACKUP_INTERVAL_HOURS * 3600 - 300)
            need = os.path.getmtime(DATA_FILE) > os.path.getmtime(path) and time.time() - os.path.getmtime(path) > refresh_after
        except OSError:
            need = True
    if need:
        tmp = path + ".tmp"
        shutil.copyfile(DATA_FILE, tmp)
        with open(tmp, "rb+") as f:
            os.fsync(f.fileno())
        ok, err = check_file(tmp)
        if not ok:
            os.remove(tmp)
            STATUS["backup"] = {"ok": False, "name": name, "error": err, "ts": now_iso()}
            log_event(f"Копия {name} не прошла проверку и не сохранена: {err}")
            return None
        os.replace(tmp, path)
        STATUS["backup"] = {"ok": True, "name": name, "error": None, "ts": now_iso()}
    for old in backup_names()[:-BACKUPS_KEEP]:
        try:
            os.remove(os.path.join(BACKUP_DIR, old))
        except OSError:
            pass
    return name


def backup_loop():
    while True:
        time.sleep(BACKUP_INTERVAL_HOURS * 3600)
        try:
            with LOCK:
                do_backup(refresh=True)
        except Exception as e:  # noqa
            log_event(f"Плановая копия не создана: {e!r}")


def warnings_list():
    w = []
    b = STATUS["backup"]
    if b["ok"] is False:
        w.append(f"Резервная копия {b['name']} не прошла проверку: {b['error']}")
    names = backup_names()
    if names:
        age = time.time() - os.path.getmtime(os.path.join(BACKUP_DIR, names[-1]))
        if age > 2 * 86400:
            w.append("Резервная копия не обновлялась более 2 суток")
    elif not STATE["locked"]:
        w.append("Резервных копий пока нет")
    if SETTINGS["error"]:
        w.append(SETTINGS["error"])
    return w


# ---------------------------------------------------------------- восстановление
def recovery_candidates():
    out = []
    p = describe_file(PREV_FILE, "prev", "Предыдущая версия базы (data.json.prev)")
    if p:
        out.append(p)
    for n in reversed(backup_names()):
        c = describe_file(os.path.join(BACKUP_DIR, n), n, n)
        if c:
            out.append(c)
    return out


def api_restore(key):
    if key == "prev":
        path = PREV_FILE
    elif re.match(r"^data-[0-9_\-]+\.json$", key or "") and key in backup_names():
        path = os.path.join(BACKUP_DIR, key)
    else:
        raise ApiError("Неизвестная копия", 404)
    try:
        data = load_json_file(path)
    except Exception as e:  # noqa
        raise ApiError(f"Эта копия повреждена и не может быть использована: {e}", 400)
    if not STATE["locked"]:
        raise ApiError("База не заблокирована: восстановление не требуется", 409)
    try:
        atomic_write(DATA_FILE, data, keep_prev=False)
    except Exception as e:  # noqa
        raise ApiError(DISK_MSG, 503)
    if key == "prev":
        try:
            os.remove(PREV_FILE)
        except OSError:
            pass
    log_event(f"ВОССТАНОВЛЕНИЕ из {key}: операций {len(data['ops'])}, клиентов {len(data['customers'])}")
    STATE["locked"] = None
    STATE["data"] = data
    prune_requests()
    refresh_settings(force=True)
    do_backup(force=True)
    return {"ok": True, "restored": key, "ops": len(data["ops"]), "customers": len(data["customers"]),
            "last_op_ts": data["ops"][-1]["ts"] if data["ops"] else None}


# ---------------------------------------------------------------- настройки и напитки (settings.json)
def parse_drinks(raw):
    if not isinstance(raw, list) or not raw:
        raise ValueError("в settings.json нужен непустой список \"drinks\"")
    out, seen = [], set()
    for i, it in enumerate(raw):
        if isinstance(it, str):
            it = {"name": it}
        if not isinstance(it, dict) or not str(it.get("name", "")).strip():
            raise ValueError(f"напиток №{i + 1}: нет названия (name)")
        name = str(it["name"]).strip()[:40]
        did = str(it.get("id") or slug(name)).strip().lower()
        if not re.match(r"^[a-z0-9_-]{1,40}$", did):
            raise ValueError(f"напиток «{name}»: id только из латиницы, цифр, - и _")
        if did in seen:
            raise ValueError(f"напиток «{name}»: id «{did}» повторяется")
        seen.add(did)
        color = str(it.get("color") or "")
        if not re.match(r"^#[0-9a-fA-F]{6}$", color):
            color = PALETTE[i % len(PALETTE)]
        emoji = str(it.get("emoji") or "🍺").strip()[:8] or "🍺"
        out.append({"id": did, "name": name, "emoji": emoji, "color": color.lower(), "active": bool(it.get("active", True))})
    return out


def parse_liter_setting(value, label):
    if isinstance(value, bool):
        raise ValueError(f"{label} должен быть числом")
    amount = half(value)
    if amount is None or amount <= 0 or amount > 2000:
        raise ValueError(f"{label} должен быть положительным числом, кратным 0,5 л (не больше 1000 л)")
    return amount / 2


def parse_origin(value):
    if not isinstance(value, str):
        raise ValueError("pages_origins должен содержать HTTPS origins")
    parsed = urlparse(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or
            parsed.path not in ("", "/") or parsed.query or parsed.fragment or value == "*"):
        raise ValueError(f"недопустимый Pages origin: {value!r}")
    try:
        parsed.port
    except ValueError as error:
        raise ValueError(f"недопустимый порт в Pages origin: {value!r}") from error
    return f"https://{parsed.netloc}".rstrip("/")


def parse_app_settings(raw):
    if not isinstance(raw, dict):
        raise ValueError("файл должен быть объектом { ... }")
    drinks = parse_drinks(raw.get("drinks", DEFAULT_SETTINGS["drinks"]))
    loyalty = raw.get("loyalty", DEFAULT_SETTINGS["loyalty"])
    if not isinstance(loyalty, dict):
        raise ValueError("loyalty должен быть JSON-объектом")
    loyalty = {
        "paid_liters": parse_liter_setting(loyalty.get("paid_liters", 6), "loyalty.paid_liters"),
        "reward_liters": parse_liter_setting(loyalty.get("reward_liters", 1), "loyalty.reward_liters"),
    }
    server = raw.get("server", DEFAULT_SETTINGS["server"])
    if not isinstance(server, dict):
        raise ValueError("server должен быть JSON-объектом")
    port = server.get("https_port", 8443)
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise ValueError("server.https_port должен быть целым числом от 1 до 65535")
    origins = server.get("pages_origins", DEFAULT_SETTINGS["server"]["pages_origins"])
    if not isinstance(origins, list):
        raise ValueError("server.pages_origins должен быть списком HTTPS origins")
    origins = sorted({parse_origin(origin) for origin in origins})
    backups = raw.get("backups", DEFAULT_SETTINGS["backups"])
    if not isinstance(backups, dict):
        raise ValueError("backups должен быть JSON-объектом")
    interval = backups.get("interval_hours", 1)
    retention = backups.get("retention_days", 30)
    if isinstance(interval, bool) or not isinstance(interval, int) or not 1 <= interval <= 168:
        raise ValueError("backups.interval_hours должен быть целым числом от 1 до 168")
    if isinstance(retention, bool) or not isinstance(retention, int) or not 1 <= retention <= 3650:
        raise ValueError("backups.retention_days должен быть целым числом от 1 до 3650")
    shop = str(raw.get("shop") or DEFAULT_SETTINGS["shop"]).strip()[:60]
    return shop, drinks, loyalty, {"https_port": port, "pages_origins": origins}, {
        "interval_hours": interval, "retention_days": retention,
    }


def refresh_settings(force=False):
    """перечитывает settings.json, если файл изменился"""
    if not os.path.exists(SETTINGS_FILE):
        os.makedirs(os.path.dirname(SETTINGS_FILE) or ".", exist_ok=True)
        atomic_write(SETTINGS_FILE, DEFAULT_SETTINGS)
    try:
        mt = os.path.getmtime(SETTINGS_FILE)
    except OSError:
        return
    if not force and mt == SETTINGS["mtime"]:
        return
    SETTINGS["mtime"] = mt
    try:
        with open(SETTINGS_FILE, encoding="utf-8-sig") as f:
            raw = json.load(f)
        shop, drinks, loyalty, server, backups = parse_app_settings(raw)
        SETTINGS.update(shop=shop, drinks=drinks, loyalty=loyalty, backups=backups, server=server, error=None)
        global CYCLE_H, REWARD_H, BACKUPS_KEEP, BACKUP_INTERVAL_HOURS, PORT, ALLOWED_PWA_ORIGINS
        CYCLE_H = int(loyalty["paid_liters"] * 2)
        REWARD_H = int(loyalty["reward_liters"] * 2)
        BACKUPS_KEEP = backups["retention_days"]
        BACKUP_INTERVAL_HOURS = backups["interval_hours"]
        if not SERVER_STARTED:
            if not PORT_OVERRIDE:
                PORT = server["https_port"]
            if ORIGINS_OVERRIDE:
                ALLOWED_PWA_ORIGINS = {
                    parse_origin(origin)
                    for origin in os.environ.get("PIVO_ALLOWED_ORIGINS", "").split(",")
                    if origin.strip()
                }
            else:
                ALLOWED_PWA_ORIGINS = set(server["pages_origins"])
    except Exception as e:  # noqa
        SETTINGS["error"] = f"settings.json: {e}"
        if not SETTINGS["drinks"]:
            SETTINGS["drinks"] = parse_drinks(DEFAULT_SETTINGS["drinks"])
            SETTINGS["shop"] = DEFAULT_SETTINGS["shop"]
            SETTINGS["loyalty"] = dict(DEFAULT_SETTINGS["loyalty"])
            SETTINGS["backups"] = dict(DEFAULT_SETTINGS["backups"])
            SETTINGS["server"] = dict(DEFAULT_SETTINGS["server"])
            CYCLE_H, REWARD_H = 12, 2
            BACKUPS_KEEP, BACKUP_INTERVAL_HOURS = 30, 1
    sync_drinks()


def sync_drinks():
    """список напитков в базе = файл настроек + архив (убранные из файла остаются для истории)"""
    data = STATE["data"]
    if data is None or STATE["locked"]:
        return
    new, ids = [], set()
    for d in SETTINGS["drinks"]:
        new.append(dict(d))
        ids.add(d["id"])
    for d in data["drinks"]:
        if d["id"] not in ids:
            d = dict(d)
            d["active"] = False
            d.setdefault("emoji", "🍺")
            d.setdefault("color", "#78716c")
            new.append(d)
    if new != data["drinks"]:
        old = data["drinks"]
        data["drinks"] = new
        try:
            save()
        except Exception as e:  # noqa
            data["drinks"] = old
            SETTINGS["mtime"] = None            # повторить при следующем запросе
            log_event(f"Список напитков не сохранён: {e!r}")


def drink_map():
    return {d["id"]: d for d in STATE["data"]["drinks"]}


def dinfo(did):
    d = drink_map().get(did, {})
    return d.get("name", did), d.get("emoji", "🍺")


# ---------------------------------------------------------------- журнал операций и расчёты
def customer_ops(cid, exclude=None):
    return [o for o in STATE["data"]["ops"]
            if o["customer"] == cid and not o.get("undone") and o["id"] != exclude and o["type"] != "register"]


def group_ops():
    """одним проходом: {клиент: [действующие операции]}"""
    g = {}
    for o in STATE["data"]["ops"]:
        if not o.get("undone") and o["type"] != "register":
            g.setdefault(o["customer"], []).append(o)
    return g


def balances(ops):
    """Общий подарочный счёт по текущим settings.json loyalty rules.
    -> {paid_h, used_h, earned, progress_h, avail_h, per: {напиток: {paid_h, used_h}}}"""
    b = {"paid_h": 0, "used_h": 0, "per": {}}
    for o in ops:
        if o["type"] == "purchase":
            for it in o["items"]:
                h = half(it["liters"])
                b["paid_h"] += h
                b["per"].setdefault(it["drink"], {"paid_h": 0, "used_h": 0})["paid_h"] += h
        elif o["type"] == "redeem":
            h = half(o["liters"])
            b["used_h"] += h
            b["per"].setdefault(o["drink"], {"paid_h": 0, "used_h": 0})["used_h"] += h
    b["earned"] = b["paid_h"] // CYCLE_H
    b["progress_h"] = b["paid_h"] % CYCLE_H
    b["avail_h"] = b["earned"] * REWARD_H - b["used_h"]
    return b


def op_items(o):
    if o["type"] == "purchase":
        return [{"name": dinfo(i["drink"])[0], "emoji": dinfo(i["drink"])[1], "liters": i["liters"]} for i in o["items"]]
    n, e = dinfo(o["drink"])
    return [{"name": n, "emoji": e, "liters": o["liters"]}]


def customer_view(c, with_history=False, limit=60, ops=None):
    ops = customer_ops(c["id"]) if ops is None else ops
    bal = balances(ops)
    per = []
    for did, b in bal["per"].items():
        n, e = dinfo(did)
        per.append({"drink": did, "name": n, "emoji": e, "paid": lit(b["paid_h"]), "gift_used": lit(b["used_h"])})
    per.sort(key=lambda x: x["name"])
    visits = [o for o in ops if o["type"] == "purchase"]
    v = {
        "id": c["id"], "name": c["name"], "surname": c["surname"],
        "phone": c["phone"], "phone_fmt": fmt_phone(c["phone"]), "created": c["created"],
        "total_paid": lit(bal["paid_h"]), "progress": lit(bal["progress_h"]),
        "gifts_earned": lit(bal["earned"] * REWARD_H), "gifts_used": lit(bal["used_h"]), "gifts_avail": lit(bal["avail_h"]),
        "visits": len(visits), "last_visit": visits[-1]["ts"] if visits else None,
        "per_drink": per,
    }
    if with_history:
        hist = [o for o in STATE["data"]["ops"] if o["customer"] == c["id"] and o["type"] != "register"][-limit:][::-1]
        v["history"] = [{"id": o["id"], "operation_id": o.get("operation_id"), "ts": o["ts"], "type": o["type"], "undone": bool(o.get("undone")),
                         "items": op_items(o)} for o in hist]
    return v


def short_view(c):
    bal = balances(customer_ops(c["id"]))
    return {"id": c["id"], "name": c["name"], "surname": c["surname"], "phone_fmt": fmt_phone(c["phone"]),
            "gifts_avail": lit(bal["avail_h"])}


def new_customer_id():
    while True:
        cid = "".join(secrets.choice(ID_ALPHABET) for _ in range(8))
        if cid not in STATE["data"]["customers"]:
            return cid


def add_op(op):
    d = STATE["data"]
    if SYNC_CONTEXT:
        op.update({k: SYNC_CONTEXT[k] for k in ("operation_id", "device_id", "client_sequence")})
    op["id"] = d["next_op"]
    d["next_op"] += 1
    op["ts"] = now_iso()
    d["ops"].append(op)
    return op


def drop_last_op():
    d = STATE["data"]
    d["ops"].pop()
    d["next_op"] -= 1


class ApiError(Exception):
    def __init__(self, msg, code=400, extra=None):
        super().__init__(msg)
        self.msg, self.code, self.extra = msg, code, extra


# ---------------------------------------------------------------- идемпотентность (хранится в базе вместе с операцией)
def prune_requests():
    d = STATE["data"]
    cutoff = (datetime.now() - timedelta(days=REQUEST_TTL_DAYS)).replace(microsecond=0).isoformat()
    old = [k for k, v in d["requests"].items() if not v.get("sync_fp") and v.get("ts", "") < cutoff]
    for k in old:
        del d["requests"][k]
    return len(old)


def remember(rid, fp, kind, cid, extra=None):
    rec = {"fp": fp, "ts": now_iso(), "kind": kind, "cid": cid}
    if SYNC_CONTEXT:
        rec.update(SYNC_CONTEXT)
    rec.update(extra or {})
    if SYNC_CONTEXT:
        rec["result"] = {
            "operation_id": SYNC_CONTEXT["operation_id"],
            "customer_id": cid,
            "server_operation_ids": [op["id"] for op in STATE["data"]["ops"]
                                     if op.get("operation_id") == SYNC_CONTEXT["operation_id"]],
        }
    STATE["data"]["requests"][rid] = rec


def replay(r):
    if r.get("sync_fp") and "result" in r:
        result = json.loads(json.dumps(r["result"], ensure_ascii=False))
        if isinstance(result, dict):
            result["replay"] = True
        return result
    c = STATE["data"]["customers"].get(r["cid"])
    if not c:
        raise ApiError("Клиент не найден", 404)
    v = customer_view(c, True)
    if r["kind"] == "register":
        return dict(v, replay=True)
    res = {"customer": v, "replay": True}
    if r["kind"] == "purchase":
        res["offers"] = r.get("offers", [])
    return res


def idem(kind, key, body, run):
    rid = str(body.get("request_id") or "")
    if not RID_RE.match(rid):
        raise ApiError("Нет идентификатора операции (request_id). Обновите страницу и повторите.", 400)
    fp = hashlib.sha256(json.dumps([kind, key, {k: v for k, v in body.items() if k != "request_id"}],
                                   sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    old = STATE["data"]["requests"].get(rid)
    if old:
        if old["fp"] != fp:
            raise ApiError("Этот идентификатор операции уже использован для другого запроса.", 409)
        return replay(old)
    return run(rid, fp)


def validate_sync_operation(op):
    if not isinstance(op, dict):
        raise ApiError("Операция должна быть объектом")
    opid = op.get("operation_id")
    try:
        if not isinstance(opid, str) or str(uuid.UUID(opid)) != opid.lower():
            raise ValueError()
    except (ValueError, AttributeError):
        raise ApiError("Некорректный operation_id")
    device_id = op.get("device_id")
    try:
        if not isinstance(device_id, str) or str(uuid.UUID(device_id)) != device_id.lower():
            raise ValueError()
    except (ValueError, AttributeError):
        raise ApiError("Некорректный device_id")
    if not isinstance(op.get("customer_id"), str) or not re.match(r"^[A-Z2-9]{8}$", op["customer_id"]):
        raise ApiError("Некорректный customer_id")
    if type(op.get("client_sequence")) is not int or op["client_sequence"] < 1:
        raise ApiError("Некорректный client_sequence")
    if type(op.get("base_version")) is not int or op["base_version"] < 0:
        raise ApiError("Некорректный base_version")
    if not isinstance(op.get("created_at"), str) or not isinstance(op.get("payload"), dict):
        raise ApiError("Некорректная структура операции")
    if op.get("operation_type") not in ("register", "purchase", "redemption"):
        raise ApiError("Неизвестный тип операции")
    payload = op["payload"]
    if op["operation_type"] == "register":
        if not isinstance(payload.get("name"), str) or not payload["name"].strip():
            raise ApiError("Для регистрации требуется имя")
        if not isinstance(payload.get("phone"), str):
            raise ApiError("Для регистрации требуется телефон")
    elif op["operation_type"] == "purchase":
        if not _check_items(payload.get("items")):
            raise ApiError("Неверные позиции покупки")
    elif not _check_items(payload.get("items")):
        raise ApiError("Неверные позиции списания")
    return op


def sync_register_device(device_id):
    try:
        if not isinstance(device_id, str) or str(uuid.UUID(device_id)) != device_id.lower():
            raise ValueError()
    except (ValueError, AttributeError):
        raise ApiError("Некорректный device_id")
    d = STATE["data"]
    registered = d.get("sync_device_id")
    if registered and registered != device_id:
        raise ApiError("Для этого магазина уже зарегистрировано другое устройство синхронизации.", 409,
                       {"code": "device_conflict"})
    if not registered:
        d["sync_device_id"] = device_id
        commit(lambda: d.__setitem__("sync_device_id", None))
    return {"ok": True, "device_id": device_id}


def sync_process_operation(op):
    global SYNC_CONTEXT
    op = validate_sync_operation(op)
    if op["device_id"] != STATE["data"].get("sync_device_id"):
        raise ApiError("Устройство не зарегистрировано для синхронизации.", 409,
                       {"code": "device_conflict"})
    opid = op["operation_id"]
    sync_fp = hashlib.sha256(json.dumps(op, sort_keys=True, ensure_ascii=False,
                                        separators=(",", ":")).encode("utf-8")).hexdigest()
    prior = STATE["data"]["requests"].get(opid)
    if prior:
        if prior.get("sync_fp") != sync_fp:
            raise ApiError("Этот operation_id уже использован для другой операции.", 409,
                           {"code": "idempotency_conflict"})
        return replay(prior)

    SYNC_CONTEXT = {
        "sync_fp": sync_fp,
        "device_id": op["device_id"],
        "client_sequence": op["client_sequence"],
        "operation_id": opid,
    }
    body = dict(op["payload"], request_id=opid)
    try:
        try:
            if op["operation_type"] == "register":
                body["customer_id"] = op["customer_id"]
                idem("register", "", body, lambda rid, fp: api_register(body, rid, fp))
            elif op["operation_type"] == "purchase":
                idem("purchase", op["customer_id"], body,
                     lambda rid, fp: api_purchase(op["customer_id"], body, rid, fp))
            else:
                idem("redeem", op["customer_id"], body,
                     lambda rid, fp: api_redeem(op["customer_id"], body, rid, fp))
        except ApiError as e:
            e.extra = dict(e.extra or {}, code="business_conflict")
            raise
        return STATE["data"]["requests"][opid]["result"]
    finally:
        SYNC_CONTEXT = None


def sync_push(operations):
    if not isinstance(operations, list) or not operations or len(operations) > 50:
        raise ApiError("Передайте от 1 до 50 операций")
    results = []
    for op in operations:
        try:
            result = sync_process_operation(op)
            opid = op.get("operation_id") if isinstance(op, dict) else None
            server_ids = [item["id"] for item in STATE["data"]["ops"] if item.get("operation_id") == opid]
            results.append({"operation_id": opid, "acknowledged": True,
                            "server_operation_ids": server_ids, "result": result})
        except ApiError as e:
            results.append({
                "operation_id": op.get("operation_id") if isinstance(op, dict) else None,
                "acknowledged": False,
                "error": e.msg,
                "status": e.code,
                "conflict": e.code == 409 or (e.extra or {}).get("code") == "business_conflict",
                "code": (e.extra or {}).get("code", "operation_rejected"),
            })
    return {"results": results}


def sync_pull(since):
    if not since.isdigit():
        raise ApiError("Некорректный курсор синхронизации")
    cursor = int(since)
    current = STATE["data"]["next_op"] - 1
    if cursor > current:
        raise ApiError("Курсор синхронизации находится в будущем")
    page = [o for o in STATE["data"]["ops"] if o["id"] > cursor][:500]
    new_cursor = page[-1]["id"] if page else cursor
    changed = set(STATE["data"]["customers"])
    products = {
        "shop": SETTINGS["shop"],
        "drinks": [dict(d) for d in STATE["data"]["drinks"]],
        "loyalty": dict(SETTINGS["loyalty"]),
    }
    products["version"] = hashlib.sha256(json.dumps(products, sort_keys=True, ensure_ascii=False,
                                                     separators=(",", ":")).encode("utf-8")).hexdigest()
    return {
        "changes": {
            "customers": [customer_view(STATE["data"]["customers"][cid], True) for cid in sorted(changed)],
            "operations": [dict(o) for o in page],
            "processed_operation_ids": [rid for rid, record in STATE["data"]["requests"].items()
                                        if record.get("sync_fp")],
            "products": products,
        },
        "cursor": new_cursor,
        "has_more": new_cursor < current,
    }


# ---------------------------------------------------------------- операции
def api_register(body, rid, fp):
    name = (body.get("name") or "").strip()[:60]
    surname = (body.get("surname") or "").strip()[:60]
    phone = norm_phone(body.get("phone"))
    if not name:
        raise ApiError("Укажите имя")
    if len(phone) < 10 or len(phone) > 15:
        raise ApiError("Проверьте номер телефона")
    d = STATE["data"]
    for c in d["customers"].values():
        if c["phone"] == phone:
            raise ApiError(f"Этот номер уже есть: {c['name']} {c['surname']}".strip(), 409)
    cid = str(body.get("customer_id") or new_customer_id()).upper()
    if not re.match(r"^[A-Z2-9]{8}$", cid):
        raise ApiError("Некорректный код клиента")
    if cid in d["customers"]:
        raise ApiError("Код клиента уже занят", 409)
    c = {"id": cid, "name": name, "surname": surname, "phone": phone, "created": now_iso()}
    d["customers"][cid] = c
    add_op({"type": "register", "customer": cid, "by": ROLE})
    result = customer_view(c, True)
    remember(rid, fp, "register", cid, {"result": result} if SYNC_CONTEXT else None)

    def rb():
        d["customers"].pop(cid, None)
        drop_last_op()
        d["requests"].pop(rid, None)
    commit(rb)
    return result


def api_purchase(cid, body, rid, fp):
    d = STATE["data"]
    c = d["customers"].get(cid)
    if not c:
        raise ApiError("Клиент не найден", 404)
    dm = drink_map()
    merged = {}
    for it in body.get("items") or []:
        did = it.get("drink")
        h = half(it.get("liters"))
        if did not in dm or not dm[did].get("active"):
            raise ApiError("Этого напитка нет в списке продаж")
        if h is None or h <= 0 or h > 100:
            raise ApiError("Объём должен быть кратен 0,5 л")
        merged[did] = merged.get(did, 0) + h
    if not merged:
        raise ApiError("Добавьте объём")
    if sum(merged.values()) > 200:
        raise ApiError("Слишком большой объём за раз")
    before = balances(customer_ops(cid))
    add_op({"type": "purchase", "customer": cid, "by": ROLE, "items": [{"drink": k, "liters": lit(v)} for k, v in merged.items()]})
    after = balances(customer_ops(cid))
    offers = []
    if after["avail_h"] > 0:
        offers.append({"avail": lit(after["avail_h"]), "new": after["earned"] > before["earned"]})
    result = {"customer": customer_view(c, True), "offers": offers}
    extra = {"offers": offers}
    if SYNC_CONTEXT:
        extra["result"] = result
    remember(rid, fp, "purchase", cid, extra)

    def rb():
        drop_last_op()
        d["requests"].pop(rid, None)
    commit(rb)
    return result


def api_redeem(cid, body, rid, fp):
    """Списание подарка списком: несколько напитков за одну операцию с подтверждением.
    Формат: {"items":[{"drink":..,"liters":..}]}; старый вид {"drink":..,"liters":..|"all":true} тоже понимается."""
    d = STATE["data"]
    c = d["customers"].get(cid)
    if not c:
        raise ApiError("Клиент не найден", 404)
    dm = drink_map()
    avail = balances(customer_ops(cid))["avail_h"]
    items = body.get("items")
    if items is None:
        one = {"drink": body.get("drink")}
        if body.get("all"):
            one["all"] = True
        else:
            one["liters"] = body.get("liters")
        items = [one]
    if not isinstance(items, list) or not items or len(items) > 50:
        raise ApiError("Добавьте напиток и объём")
    merged = {}
    for it in items:
        if not isinstance(it, dict):
            raise ApiError("Неверный запрос")
        did = it.get("drink")
        if did not in dm or not dm[did].get("active"):
            raise ApiError("Выберите напиток, который отдаётся в подарок")
        if it.get("all"):
            h = avail - sum(merged.values())
        else:
            h = half(it.get("liters"))
            if h is None:
                raise ApiError("Количество должно быть кратно 0,5 л")
        if h <= 0:
            raise ApiError("Нет подарочных литров для списания" if avail <= 0 else "Введите количество литров")
        merged[did] = merged.get(did, 0) + h
    total = sum(merged.values())
    if total > avail:
        raise ApiError(f"Можно списать не больше {str(lit(avail)).replace('.', ',')} л")
    for did, h in merged.items():
        add_op({"type": "redeem", "customer": cid, "drink": did, "liters": lit(h), "by": ROLE})
    result = {"customer": customer_view(c, True)}
    remember(rid, fp, "redeem", cid, {"result": result} if SYNC_CONTEXT else None)
    n = len(merged)

    def rb():
        for _ in range(n):
            drop_last_op()
        d["requests"].pop(rid, None)
    commit(rb)
    return result


def undo_plan(opid):
    """-> (операция, [каскад списаний, которые перестанут быть покрытыми])"""
    op = next((o for o in STATE["data"]["ops"] if o["id"] == opid), None)
    if not op or op["type"] == "register":
        raise ApiError("Операция не найдена", 404)
    if op.get("undone"):
        raise ApiError("Эта операция уже отменена")
    cascade = []
    if op["type"] == "purchase":
        rest = customer_ops(op["customer"], exclude=opid)
        need = -balances(rest)["avail_h"]
        for r in [r for r in reversed(rest) if r["type"] == "redeem"]:
            if need <= 0:
                break
            cascade.append(r)
            need -= half(r["liters"])
    return op, cascade


def _summary(o):
    return {"id": o["id"], "ts": o["ts"], "type": o["type"], "items": op_items(o)}


def api_undo_preview(opid):
    op, cascade = undo_plan(opid)
    return {"preview": {"op": _summary(op), "cascade": [_summary(r) for r in cascade]}}


def api_undo_apply(opid, rid, fp):
    op, cascade = undo_plan(opid)
    stamp = now_iso()
    flagged = [op] + cascade
    for o in flagged:
        o["undone"], o["undone_ts"] = True, stamp
    cid = op["customer"]
    result = {"customer": customer_view(STATE["data"]["customers"][cid], True)}
    remember(rid, fp, "undo", cid, {"result": result} if SYNC_CONTEXT else None)

    def rb():
        for o in flagged:
            o.pop("undone", None)
            o.pop("undone_ts", None)
        STATE["data"]["requests"].pop(rid, None)
    commit(rb)
    return result


def api_edit(cid, b):
    c = STATE["data"]["customers"].get(cid)
    if not c:
        raise ApiError("Клиент не найден", 404)
    name, sur = (b.get("name") or "").strip()[:60], (b.get("surname") or "").strip()[:60]
    ph = norm_phone(b.get("phone"))
    if not name or len(ph) < 10:
        raise ApiError("Проверьте данные")
    if any(o["id"] != cid and o["phone"] == ph for o in STATE["data"]["customers"].values()):
        raise ApiError("Этот номер уже у другого клиента", 409)
    old = dict(c)
    c.update(name=name, surname=sur, phone=ph)
    commit(lambda: (c.clear(), c.update(old)))
    return customer_view(c, True)


def api_search(q):
    q = (q or "").strip().lower()
    if not q:
        seen, out = set(), []
        for o in STATE["data"]["ops"][::-1]:
            cid = o["customer"]
            if cid not in seen and cid in STATE["data"]["customers"]:
                seen.add(cid)
                out.append(short_view(STATE["data"]["customers"][cid]))
            if len(out) >= 8:
                break
        return {"results": out, "recent": True}
    digits = re.sub(r"\D", "", q)
    numeric = q.replace("+", "").replace(" ", "").replace("-", "").isdigit()
    res = []
    for c in STATE["data"]["customers"].values():
        if numeric:
            hit = len(digits) >= 3 and digits in c["phone"]
        else:
            text = f"{c['name']} {c['surname']}".strip().lower()
            hit = all(part in text for part in q.split())
        if hit:
            res.append(c)
    res.sort(key=lambda c: ((c["surname"] or c["name"]).lower(), c["name"].lower()))
    return {"results": [short_view(c) for c in res[:20]], "recent": False}


def api_stats(period):
    d = STATE["data"]
    now = datetime.now()
    days_back = {"today": 0, "week": 6, "month": 29}.get(period)
    start = datetime.min if days_back is None else (now - timedelta(days=days_back)).replace(hour=0, minute=0, second=0, microsecond=0)
    paid, gifts_used, per_cust, by_day = {}, {}, {}, {}
    new_c, visits, active = 0, 0, set()
    for o in d["ops"]:
        if o.get("undone") or datetime.fromisoformat(o["ts"]) < start:
            continue
        if o["type"] == "register":
            new_c += 1
        elif o["type"] == "purchase":
            visits += 1
            active.add(o["customer"])
            for it in o["items"]:
                h = half(it["liters"])
                paid[it["drink"]] = paid.get(it["drink"], 0) + h
                per_cust[o["customer"]] = per_cust.get(o["customer"], 0) + h
                by_day[o["ts"][:10]] = by_day.get(o["ts"][:10], 0) + h
        elif o["type"] == "redeem":
            gifts_used[o["drink"]] = gifts_used.get(o["drink"], 0) + half(o["liters"])
    g = group_ops()
    pending_h = sum(balances(ops)["avail_h"] for ops in g.values())
    top_out = []
    for cid, h in sorted(per_cust.items(), key=lambda kv: -kv[1])[:10]:
        c = d["customers"].get(cid)
        if c:
            top_out.append({"id": cid, "name": f"{c['surname']} {c['name']}".strip(), "liters": lit(h)})
    drinks = []
    for i in sorted(set(paid) | set(gifts_used)):
        n, e = dinfo(i)
        drinks.append({"name": n, "emoji": e, "paid": lit(paid.get(i, 0)), "gifts_used": lit(gifts_used.get(i, 0))})
    drinks.sort(key=lambda x: -x["paid"])
    span = 7 if period in ("today", "week") else 30
    days = [{"day": (now - timedelta(days=i)).strftime("%Y-%m-%d"),
             "liters": lit(by_day.get((now - timedelta(days=i)).strftime("%Y-%m-%d"), 0))} for i in range(span - 1, -1, -1)]
    return {"period": period, "liters_paid": lit(sum(paid.values())), "gifts_used": lit(sum(gifts_used.values())),
            "gifts_pending": lit(pending_h), "new_customers": new_c, "active_customers": len(active),
            "purchases": visits, "customers_total": len(d["customers"]),
            "drinks": drinks, "top": top_out, "days": days}


def api_customers_stats():
    """полная статистика по всем покупателям (отдельная страница)"""
    g = group_ops()
    rows = []
    for c in STATE["data"]["customers"].values():
        v = customer_view(c, ops=g.get(c["id"], []))
        v["per_drink"] = [{"name": p["name"], "emoji": p["emoji"], "paid": p["paid"], "gift_used": p["gift_used"]}
                          for p in v["per_drink"] if p["paid"] or p["gift_used"]]
        for k in ("phone", "history"):
            v.pop(k, None)
        rows.append(v)
    tot = {"customers": len(rows),
           "paid": lit(sum(half(r["total_paid"]) for r in rows)),
           "gifts_earned": sum(r["gifts_earned"] for r in rows),
           "gifts_used": lit(sum(half(r["gifts_used"]) for r in rows)),
           "gifts_avail": lit(sum(half(r["gifts_avail"]) for r in rows)),
           "visits": sum(r["visits"] for r in rows)}
    return {"totals": tot, "customers": rows}


def csv_cell(v):
    s = str(v)
    return "'" + s if s[:1] in ("=", "+", "-", "@", "\t", "\r") else s   # защита от формул Excel


def api_export_csv():
    ds = STATE["data"]["drinks"]
    g = group_ops()
    out = io.StringIO()
    w = csv.writer(out, delimiter=";")
    w.writerow(["Телефон", "Фамилия", "Имя", "Оплачено, л", "Подарков заработано", "Подарок списано, л",
                "Подарок доступен, л", "Визитов", "Последняя покупка", "Регистрация"] + [f"{d['name']}, л" for d in ds])
    for c in sorted(STATE["data"]["customers"].values(), key=lambda c: ((c["surname"] or c["name"]).lower(), c["name"].lower())):
        v = customer_view(c, ops=g.get(c["id"], []))
        per = {p["drink"]: p["paid"] for p in v["per_drink"]}
        w.writerow([fmt_phone(c["phone"]), csv_cell(c["surname"]), csv_cell(c["name"]), v["total_paid"], v["gifts_earned"],
                    v["gifts_used"], v["gifts_avail"], v["visits"], v["last_visit"] or "", c["created"]]
                   + [per.get(d["id"], 0) for d in ds])
    return ("﻿" + out.getvalue()).encode("utf-8")


# ---------------------------------------------------------------- HTTP (только HTTPS)
MIME = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
        ".json": "application/json", ".webmanifest": "application/manifest+json; charset=utf-8"}


def is_local(ip):
    return ip in ("127.0.0.1", "::1", "::ffff:127.0.0.1")


def is_private_client(ip):
    try:
        addr = ipaddress.ip_address(ip)
        if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
            addr = addr.ipv4_mapped
        return addr.is_loopback or addr.is_private or addr.is_link_local
    except ValueError:
        return False


def write_conf(conf):
    try:
        atomic_write(CONF_FILE, conf)
    except Exception as e:  # noqa
        log_event(f"config.json не записан: {e!r}")
        raise ApiError(DISK_MSG, 503)


class Handler(BaseHTTPRequestHandler):
    server_version = "Pivo/3.0"
    timeout = 30

    def setup(self):
        self.request.settimeout(15)             # TLS-рукопожатие в потоке клиента: «зависший» сокет не блокирует сервер
        self.request = self.server.tls_ctx.wrap_socket(self.request, server_side=True)
        super().setup()

    def log_message(self, fmt, *args):
        pass

    def ip(self):
        return self.client_address[0]

    def send(self, code, body, ctype="application/json", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; connect-src 'self' https:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; media-src 'self' blob:")
        for k, v in getattr(self, "_cors", {}).items():
            self.send_header(k, v)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def session(self):
        authorization = self.headers.get("Authorization", "")
        bearer = re.fullmatch(r"Bearer ([A-Za-z0-9_-]+)", authorization)
        if authorization:
            sid = bearer.group(1) if bearer else None
        else:
            cookie = re.search(r"(?:^|;\s*)sid=([A-Za-z0-9_\-]+)", self.headers.get("Cookie", ""))
            sid = cookie.group(1) if cookie else None
        s = SESSIONS.get(sid) if sid else None
        if not s:
            return None
        if time.time() - s["seen"] > SESSION_IDLE_SEC:
            SESSIONS.pop(sid, None)
            return None
        s["seen"] = time.time()
        return s

    def read_body(self):
        try:
            b = json.loads(getattr(self, "_raw", b"") or b"{}")
        except ValueError:
            raise ApiError("Неверный формат запроса")
        if not isinstance(b, dict):
            raise ApiError("Неверный формат запроса")
        return b

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_OPTIONS(self):
        self.route("OPTIONS")

    def route(self, method):
        try:
            self._cors = {}
            origin = self.headers.get("Origin", "").rstrip("/")
            if origin in ALLOWED_PWA_ORIGINS:
                self._cors = {
                    "Access-Control-Allow-Origin": origin,
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Requested-With",
                    "Access-Control-Max-Age": "600",
                    "Vary": "Origin",
                }
            if not is_private_client(self.ip()):
                raise ApiError("Доступ разрешён только из локальной сети.", 403)
            u = urlparse(self.path)
            if method == "OPTIONS":
                if not u.path.startswith("/api/") or origin not in ALLOWED_PWA_ORIGINS:
                    raise ApiError("Источник не разрешён для PWA.", 403)
                requested_method = self.headers.get("Access-Control-Request-Method", "").upper()
                requested_headers = {
                    item.strip().lower()
                    for item in self.headers.get("Access-Control-Request-Headers", "").split(",")
                    if item.strip()
                }
                allowed_headers = {"authorization", "content-type", "x-requested-with"}
                if requested_method not in ("GET", "POST") or not requested_headers.issubset(allowed_headers):
                    raise ApiError("Параметры запроса из PWA не разрешены.", 403)
                extra = {}
                if self.headers.get("Access-Control-Request-Private-Network", "").lower() == "true":
                    extra["Access-Control-Allow-Private-Network"] = "true"
                return self.send(204, "", extra=extra)
            self._raw = b""
            if method == "POST":                    # тело всегда вычитывается: иначе закрытие сокета сбросит уже отправленный ответ
                n = int(self.headers.get("Content-Length") or 0)
                if n > 100_000:
                    raise ApiError("Слишком большой запрос", 413)
                self._raw = self.rfile.read(n) if n else b""
            if u.path.startswith("/api/"):
                if method == "POST" and self.headers.get("X-Requested-With") != "pivo":
                    raise ApiError("Запрещено", 403)
                self.api(method, u.path[5:], parse_qs(u.query))
            else:
                self.static(u.path)
        except ApiError as e:
            self.send(e.code, dict({"error": e.msg}, **(e.extra or {})))
        except (ConnectionError, ssl.SSLError, socket.timeout):
            pass
        except Exception as e:  # noqa
            sys.stderr.write(f"ERR {e!r}\n")
            log_event(f"Внутренняя ошибка: {e!r}")
            self.send(500, {"error": "Внутренняя ошибка сервера"})

    def static(self, path):
        if path in ("", "/"):
            path = "/admin.html" if is_local(self.ip()) else "/index.html"
        if path == "/admin.html" and not is_local(self.ip()):
            return self.send(404, "Не найдено", "text/plain; charset=utf-8")
        if path == "/ca.crt":                       # открытый сертификат центра (не секретный): для установки на устройства
            try:
                with open(os.path.join(CERT_DIR, "ca.crt"), "rb") as f:
                    return self.send(200, f.read(), "application/x-x509-ca-cert")
            except OSError:
                return self.send(404, "Не найдено", "text/plain; charset=utf-8")
        fp = os.path.normpath(os.path.join(STATIC, path.lstrip("/")))
        if not fp.startswith(STATIC + os.sep) or not os.path.isfile(fp):
            return self.send(404, "Не найдено", "text/plain; charset=utf-8")
        with open(fp, "rb") as f:
            body = f.read()
        self.send(200, body, MIME.get(os.path.splitext(fp)[1], "application/octet-stream"))

    def throttle(self):
        f = FAILS.get(self.ip(), {"n": 0, "until": 0})
        if time.time() < f["until"]:
            raise ApiError(f"Слишком много попыток. Подождите {int(f['until'] - time.time()) + 1} с", 429)
        return f

    def fail_pin(self, f):
        f["n"] += 1
        if f["n"] >= 5:
            f["until"] = time.time() + min(900, 30 * 2 ** (f["n"] - 5))
        FAILS[self.ip()] = f
        time.sleep(0.4)

    def api(self, method, ep, query):
        with LOCK:
            refresh_settings()
        conf = STATE["conf"]
        if ep == "state":
            s = self.session()
            with LOCK:
                return self.send(200, {
                    "setup_needed": conf is None, "local": is_local(self.ip()), "role": ROLE if s else None,
                    "shop": SETTINGS["shop"], "tls_port": PORT, "locked": STATE["locked"],
                    "loyalty": dict(SETTINGS["loyalty"]),
                    "warnings": warnings_list() if s else [],
                    "drinks": [d for d in STATE["data"]["drinks"] if d["active"]] if s else [],
                    "all_drinks": [dict(d) for d in STATE["data"]["drinks"]] if s else [],
                })
        if ep == "setup" and method == "POST":
            if conf is not None:
                raise ApiError("Уже настроено", 403)
            if not is_local(self.ip()):
                raise ApiError("Первую настройку делайте на самом компьютере (localhost)", 403)
            pin = str(self.read_body().get("pin", ""))
            if not (pin.isdigit() and 4 <= len(pin) <= 12):
                raise ApiError("PIN: от 4 до 12 цифр")
            if weak_pin(pin):
                raise ApiError("Слишком простой PIN, придумайте другой")
            with LOCK:
                new = {"pin": hash_pin(pin)}
                write_conf(new)
                STATE["conf"] = new
            return self.send(200, {"ok": True})
        if ep == "login" and method == "POST":
            if conf is None:
                raise ApiError("Сначала выполните настройку", 403)
            f = self.throttle()
            if not verify_pin(str(self.read_body().get("pin", ""))):
                self.fail_pin(f)
                raise ApiError("Неверный PIN", 401)
            FAILS.pop(self.ip(), None)
            sid = secrets.token_urlsafe(24)
            SESSIONS[sid] = {"seen": time.time()}
            return self.send(200, {"role": ROLE, "token": sid}, extra={
                "Set-Cookie": f"sid={sid}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400"})
        if ep == "logout" and method == "POST":
            authorization = self.headers.get("Authorization", "")
            bearer = re.fullmatch(r"Bearer ([A-Za-z0-9_-]+)", authorization)
            cookie = re.search(r"sid=([A-Za-z0-9_\-]+)", self.headers.get("Cookie", ""))
            sid = bearer.group(1) if bearer else (cookie.group(1) if cookie else None)
            if sid:
                SESSIONS.pop(sid, None)
            return self.send(200, {"ok": True}, extra={"Set-Cookie": "sid=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"})

        # восстановление: только на самом компьютере (localhost), перепроверка PIN
        if ep == "recovery" and method == "GET":
            if not is_local(self.ip()):
                raise ApiError("Восстановление выполняется только на компьютере магазина (https://localhost)", 403)
            with LOCK:
                return self.send(200, {"locked": STATE["locked"], "candidates": recovery_candidates()})
        if ep == "recovery/restore" and method == "POST":
            if not is_local(self.ip()):
                raise ApiError("Восстановление выполняется только на компьютере магазина (https://localhost)", 403)
            f = self.throttle()
            b = self.read_body()
            if conf is not None and not verify_pin(str(b.get("pin", ""))):
                self.fail_pin(f)
                raise ApiError("Неверный PIN", 403)
            FAILS.pop(self.ip(), None)
            with LOCK:
                return self.send(200, api_restore(str(b.get("name", ""))))

        if ep.startswith("admin/"):
            if not is_local(self.ip()):
                raise ApiError("Панель доступна только на ноутбуке (localhost).", 403)
            if ep == "admin/status" and method == "GET":
                with LOCK:
                    authenticated = self.session() is not None
                    files = backup_names() if authenticated else []
                    return self.send(200, {
                        "setup_needed": conf is None,
                        "authenticated": authenticated,
                        "shop": SETTINGS["shop"] if authenticated else "",
                        "settings_file": SETTINGS_FILE if authenticated else "",
                        "settings_error": SETTINGS["error"] if authenticated else None,
                        "settings": {
                            "shop": SETTINGS["shop"],
                            "drinks": [dict(d) for d in SETTINGS["drinks"]],
                            "loyalty": dict(SETTINGS["loyalty"]),
                            "server": dict(SETTINGS["server"]),
                            "backups": dict(SETTINGS["backups"]),
                        } if authenticated else None,
                        "runtime": {
                            "https_port": PORT,
                            "port_overridden": PORT_OVERRIDE,
                            "device_id": STATE["data"].get("sync_device_id"),
                            "cursor": STATE["data"]["next_op"] - 1,
                            "backup_count": len(files),
                            "last_backup": files[-1] if files else None,
                            "backup_ok": STATUS["backup"]["ok"],
                            "backup_error": STATUS["backup"]["error"],
                            "locked": STATE["locked"],
                        } if authenticated else None,
                    })
            if not self.session():
                raise ApiError("Нужен вход", 401)
            with LOCK:
                if STATE["locked"]:
                    raise ApiError(LOCKED_MSG + " " + STATE["locked"]["reason"], 503, {"locked": STATE["locked"]})
                if ep == "admin/settings" and method == "POST":
                    raw = self.read_body().get("settings")
                    try:
                        shop, drinks, loyalty, server, backups = parse_app_settings(raw)
                    except (TypeError, ValueError) as e:
                        raise ApiError(str(e))
                    restart_required = SERVER_STARTED and (
                        server["https_port"] != PORT or server["pages_origins"] != sorted(ALLOWED_PWA_ORIGINS) or
                        backups != SETTINGS["backups"])
                    document = {
                        "shop": shop,
                        "drinks": [{"id": d["id"], "name": d["name"], "emoji": d["emoji"],
                                    "color": d["color"], "active": d["active"]} for d in drinks],
                        "loyalty": loyalty,
                        "server": server,
                        "backups": backups,
                    }
                    try:
                        atomic_write(SETTINGS_FILE, document)
                    except Exception as e:  # noqa
                        log_event(f"settings.json не записан: {e!r}")
                        raise ApiError(DISK_MSG, 503)
                    SETTINGS["mtime"] = None
                    refresh_settings(force=True)
                    return self.send(200, {"ok": True, "restart_required": restart_required})
                if ep == "admin/backup" and method == "POST":
                    try:
                        name = do_backup(force=True)
                    except Exception as e:  # noqa
                        log_event(f"Ручная копия не создана: {e!r}")
                        raise ApiError(DISK_MSG, 503)
                    if not name:
                        raise ApiError("Копия не прошла проверку и не сохранена: " + (STATUS["backup"]["error"] or ""), 500)
                    return self.send(200, {"ok": True, "name": name})

        if not self.session():
            raise ApiError("Нужен вход", 401)
        parts = ep.split("/")
        with LOCK:
            if STATE["locked"]:
                raise ApiError(LOCKED_MSG + " " + STATE["locked"]["reason"], 503, {"locked": STATE["locked"]})
            if ep == "sync/status" and method == "GET":
                return self.send(200, {
                    "cursor": STATE["data"]["next_op"] - 1,
                    "device_id": STATE["data"].get("sync_device_id"),
                    "products": {"shop": SETTINGS["shop"],
                                 "drinks": [dict(d) for d in STATE["data"]["drinks"]],
                                 "loyalty": dict(SETTINGS["loyalty"])},
                })
            if ep == "sync/register" and method == "POST":
                return self.send(200, sync_register_device(self.read_body().get("device_id")))
            if ep == "sync/push" and method == "POST":
                return self.send(200, sync_push(self.read_body().get("operations")))
            if ep == "sync/pull" and method == "GET":
                return self.send(200, sync_pull(query.get("since", ["0"])[0]))
            if ep == "search":
                return self.send(200, api_search(query.get("q", [""])[0]))
            if ep == "customers" and method == "POST":
                b = self.read_body()
                return self.send(200, idem("register", "", b, lambda rid, fp: api_register(b, rid, fp)))
            if parts[0] == "customers" and len(parts) == 2 and method == "GET":
                c = STATE["data"]["customers"].get(parts[1].upper())
                if not c:
                    raise ApiError("Клиент не найден", 404)
                return self.send(200, customer_view(c, True))
            if parts[0] == "customers" and len(parts) == 3 and method == "POST":
                cid, act, b = parts[1].upper(), parts[2], self.read_body()
                if act == "purchase":
                    return self.send(200, idem("purchase", cid, b, lambda rid, fp: api_purchase(cid, b, rid, fp)))
                if act == "redeem":
                    return self.send(200, idem("redeem", cid, b, lambda rid, fp: api_redeem(cid, b, rid, fp)))
                if act == "edit":
                    return self.send(200, api_edit(cid, b))
            if parts[0] == "ops" and len(parts) == 3 and parts[2] == "undo" and method == "POST":
                if not parts[1].isdigit():
                    raise ApiError("Операция не найдена", 404)
                opid, b = int(parts[1]), self.read_body()
                if not b.get("confirm"):
                    return self.send(200, api_undo_preview(opid))
                return self.send(200, idem("undo", str(opid), b, lambda rid, fp: api_undo_apply(opid, rid, fp)))
            if parts[0] == "qr" and len(parts) == 2:
                cid, _, ext = parts[1].partition(".")
                cid = cid.upper()
                if cid not in STATE["data"]["customers"]:
                    raise ApiError("Клиент не найден", 404)
                # В QR только идентификатор клиента: ни адреса, ни имени, ни телефона
                if ext == "svg":
                    return self.send(200, qr.to_svg(cid), "image/svg+xml")
                return self.send(200, qr.to_png(cid), "image/png")
            if ep == "stats":
                return self.send(200, api_stats(query.get("period", ["week"])[0]))
            if ep == "customers-stats":
                return self.send(200, api_customers_stats())
            if ep == "export.csv":
                return self.send(200, api_export_csv(), "text/csv; charset=utf-8",
                                 {"Content-Disposition": "attachment; filename=klienty.csv"})
            if ep == "backup" and method == "POST":
                try:
                    name = do_backup(force=True)
                except Exception as e:  # noqa
                    log_event(f"Ручная копия не создана: {e!r}")
                    raise ApiError(DISK_MSG, 503)
                if not name:
                    raise ApiError("Копия не прошла проверку и не сохранена: " + (STATUS["backup"]["error"] or ""), 500)
                return self.send(200, {"ok": True, "name": name})
            if ep == "settings" and method == "GET":
                files = backup_names()
                return self.send(200, {"shop": SETTINGS["shop"], "settings_file": SETTINGS_FILE, "settings_error": SETTINGS["error"],
                                       "loyalty": dict(SETTINGS["loyalty"]),
                                       "server": {"https_port": PORT, "pages_origins": sorted(ALLOWED_PWA_ORIGINS)},
                                       "backup_policy": dict(SETTINGS["backups"]),
                                       "drinks": [d for d in STATE["data"]["drinks"]], "backups": len(files),
                                       "last_backup": files[-1] if files else None, "backup_ok": STATUS["backup"]["ok"],
                                       "backup_error": STATUS["backup"]["error"], "data_dir": DATA_DIR})
            if ep == "settings" and method == "POST":
                b = self.read_body()
                if not verify_pin(str(b.get("current_pin", ""))):
                    raise ApiError("Текущий PIN указан неверно", 403)
                pin = str(b.get("new_pin", ""))
                if not (pin.isdigit() and 4 <= len(pin) <= 12):
                    raise ApiError("Новый PIN: от 4 до 12 цифр")
                if weak_pin(pin):
                    raise ApiError("Слишком простой PIN")
                new = {"pin": hash_pin(pin)}
                write_conf(new)
                STATE["conf"] = new
                return self.send(200, {"ok": True})
        raise ApiError("Не найдено", 404)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    tls_ctx = None

    def handle_error(self, request, client_address):
        pass            # обрывы соединений телефона не засоряют консоль


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    load_all()
    global SERVER_STARTED
    SERVER_STARTED = True
    ip = lan_ip()
    try:
        cert, key = certgen.ensure(CERT_DIR, ["127.0.0.1", ip], ["localhost", socket.gethostname()])
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    except Exception as e:  # noqa
        print(f" ОШИБКА: не удалось подготовить сертификат HTTPS: {e}")
        print(" Без HTTPS сайт не запускается (HTTP отключён). Удалите папку data/cert и запустите снова.")
        sys.exit(1)
    srv = Server(("0.0.0.0", PORT), Handler)
    srv.tls_ctx = ctx
    threading.Thread(target=backup_loop, daemon=True).start()
    print("=" * 62)
    print(" Программа лояльности запущена (только HTTPS)")
    print(f" На этом компьютере:   https://localhost:{PORT}")
    print(f" С ТЕЛЕФОНА (Wi-Fi):   https://{ip}:{PORT}")
    print("   Чтобы не было предупреждений о сертификате: один раз установите ca.crt")
    print(f"   (на ПК: install-cert.bat; на телефоне: https://{ip}:{PORT}/ca.crt, подробности в README).")
    if STATE["conf"] is None:
        print(f" ПЕРВЫЙ ЗАПУСК: откройте https://localhost:{PORT} на ПК и задайте PIN")
    if STATE["locked"]:
        print(" ! БАЗА ДАННЫХ НЕ ПРОЧИТАНА. Изменения заблокированы, ничего не удалено.")
        print(f"   {STATE['locked']['reason']}")
        print(f"   Откройте https://localhost:{PORT} на ПК и выберите копию для восстановления.")
    if SETTINGS["error"]:
        print(f" ! {SETTINGS['error']}")
    print(" Остановить: Ctrl+C")
    print("=" * 62)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановлено.")


if __name__ == "__main__":
    main()
