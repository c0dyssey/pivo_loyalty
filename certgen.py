"""Локальный центр сертификации + сертификат сервера, без внешних программ (чистый Python).

Нужен, чтобы камера в браузере телефона работала (getUserMedia требует https).
ca.crt устанавливается на телефон/ПК один раз и доверяется: после этого предупреждений нет.
Сертификат сервера выпускается этим центром (срок < 398 дней: требование iOS), при смене IP
или приближении срока перевыпускается автоматически, повторная установка не нужна.
"""
import base64
import hashlib
import json
import math
import os
import secrets
import time
from datetime import datetime, timedelta, timezone

_SMALL = [p for p in range(3, 2000, 2) if all(p % q for q in range(3, int(p ** 0.5) + 1, 2))]


def _mr(n, rounds=24):
    d, s = n - 1, 0
    while d % 2 == 0:
        d //= 2
        s += 1
    for _ in range(rounds):
        a = secrets.randbelow(n - 3) + 2
        x = pow(a, d, n)
        if x in (1, n - 1):
            continue
        for _ in range(s - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def _prime(bits):
    while True:
        c = secrets.randbits(bits) | (1 << (bits - 1)) | (1 << (bits - 2)) | 1
        if any(c % p == 0 for p in _SMALL):
            continue
        if _mr(c):
            return c


def gen_rsa(bits=2048):
    e = 65537
    while True:
        p, q = _prime(bits // 2), _prime(bits // 2)
        if p == q:
            continue
        phi = (p - 1) * (q - 1)
        if math.gcd(e, phi) != 1:
            continue
        n = p * q
        if n.bit_length() != bits:
            continue
        return {"n": n, "e": e, "d": pow(e, -1, phi), "p": p, "q": q}


# ---------- DER
def _len(n):
    if n < 128:
        return bytes([n])
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(b)]) + b


def _tlv(tag, content):
    return bytes([tag]) + _len(len(content)) + content


def _int(n):
    b = n.to_bytes(max(1, (n.bit_length() + 8) // 8), "big")
    return _tlv(0x02, b)


def _seq(*items):
    return _tlv(0x30, b"".join(items))


def _oid(s):
    a = [int(x) for x in s.split(".")]
    out = bytes([a[0] * 40 + a[1]])
    for v in a[2:]:
        chunk = [v & 0x7F]
        v >>= 7
        while v:
            chunk.append(0x80 | (v & 0x7F))
            v >>= 7
        out += bytes(reversed(chunk))
    return _tlv(0x06, out)


def _utc(dt):
    return _tlv(0x17, dt.strftime("%y%m%d%H%M%SZ").encode())


def _pem(label, der):
    b = base64.b64encode(der).decode()
    lines = [b[i:i + 64] for i in range(0, len(b), 64)]
    return f"-----BEGIN {label}-----\n" + "\n".join(lines) + f"\n-----END {label}-----\n"


_SHA256_RSA = _seq(_oid("1.2.840.113549.1.1.11"), _tlv(0x05, b""))
_DIGEST_PREFIX = bytes.fromhex("3031300d060960864801650304020105000420")


def _private_pem(k):
    dp, dq = k["d"] % (k["p"] - 1), k["d"] % (k["q"] - 1)
    qinv = pow(k["q"], -1, k["p"])
    der = _seq(_int(0), _int(k["n"]), _int(k["e"]), _int(k["d"]), _int(k["p"]),
               _int(k["q"]), _int(dp), _int(dq), _int(qinv))
    return _pem("RSA PRIVATE KEY", der)


def _name(cn):
    return _seq(_tlv(0x31, _seq(_oid("2.5.4.3"), _tlv(0x0C, cn.encode()))))


def _ext(oid, value, critical=False):
    parts = [_oid(oid)]
    if critical:
        parts.append(_tlv(0x01, b"\xff"))
    parts.append(_tlv(0x04, value))
    return _seq(*parts)


def _spki(k):
    return _seq(_seq(_oid("1.2.840.113549.1.1.1"), _tlv(0x05, b"")),
                _tlv(0x03, b"\x00" + _seq(_int(k["n"]), _int(k["e"]))))


def _key_id(k):
    return hashlib.sha1(_seq(_int(k["n"]), _int(k["e"]))).digest()


def _issue(subj_key, subj_cn, issuer_key, issuer_cn, exts, days):
    now = datetime.now(timezone.utc).replace(microsecond=0)
    tbs = _seq(
        _tlv(0xA0, _int(2)),
        _int(secrets.randbits(63) + 1),
        _SHA256_RSA,
        _name(issuer_cn),
        _seq(_utc(now - timedelta(days=1)), _utc(now + timedelta(days=days))),
        _name(subj_cn),
        _spki(subj_key),
        _tlv(0xA3, _seq(*exts)),
    )
    klen = (issuer_key["n"].bit_length() + 7) // 8
    h = hashlib.sha256(tbs).digest()
    em = b"\x00\x01" + b"\xff" * (klen - len(_DIGEST_PREFIX) - len(h) - 3) + b"\x00" + _DIGEST_PREFIX + h
    sig = pow(int.from_bytes(em, "big"), issuer_key["d"], issuer_key["n"]).to_bytes(klen, "big")
    return _seq(tbs, _SHA256_RSA, _tlv(0x03, b"\x00" + sig))


CA_CN = "Pivo Loyalty Local CA"
LEAF_DAYS = 397
CA_DAYS = 3650


def _ca_cert(ca):
    ski = _key_id(ca)
    return _issue(ca, CA_CN, ca, CA_CN, [
        _ext("2.5.29.19", _seq(_tlv(0x01, b"\xff")), True),     # CA:TRUE
        _ext("2.5.29.15", b"\x03\x02\x01\x06", True),          # keyCertSign, cRLSign
        _ext("2.5.29.14", _tlv(0x04, ski)),
    ], CA_DAYS)


def _leaf_cert(k, ca, names, ips):
    san = b"".join(_tlv(0x82, n.encode()) for n in names)
    san += b"".join(_tlv(0x87, bytes(int(x) for x in ip.split("."))) for ip in ips)
    return _issue(k, "Pivo Loyalty Server", ca, CA_CN, [
        _ext("2.5.29.19", _seq(), True),
        _ext("2.5.29.15", b"\x03\x02\x05\xa0", True),
        _ext("2.5.29.37", _seq(_oid("1.3.6.1.5.5.7.3.1"))),
        _ext("2.5.29.17", _tlv(0x30, san)),
        _ext("2.5.29.35", _seq(_tlv(0x80, _key_id(ca)))),         # authorityKeyIdentifier
    ], LEAF_DAYS)


def _chmod(p):
    try:
        os.chmod(p, 0o600)
    except OSError:
        pass


def _load_or_make(path):
    if os.path.exists(path):
        with open(path) as f:
            return {a: int(b, 16) for a, b in json.load(f).items()}
    k = gen_rsa()
    with open(path, "w") as f:
        json.dump({a: format(b, "x") for a, b in k.items()}, f)
    _chmod(path)
    return k


def ensure(folder, ips, names):
    """-> (cert_path, key_path). ca.crt (для установки на устройства) лежит в той же папке."""
    os.makedirs(folder, exist_ok=True)
    p = lambda n: os.path.join(folder, n)  # noqa: E731
    ca = _load_or_make(p("ca-key.json"))
    if not os.path.exists(p("ca.crt")):
        with open(p("ca.crt"), "w") as f:
            f.write(_pem("CERTIFICATE", _ca_cert(ca)))
        for old in ("cert.pem", "meta.json"):          # сертификат прежней версии (самоподписанный) заменяется
            if os.path.exists(p(old)):
                os.remove(p(old))
    k = _load_or_make(p("key.json"))
    sans = sorted(set(ips)) + sorted(set(names))
    ok = False
    if os.path.exists(p("cert.pem")) and os.path.exists(p("meta.json")) and os.path.exists(p("key.pem")):
        try:
            with open(p("meta.json")) as f:
                m = json.load(f)
            ok = m.get("sans") == sans and m.get("until", 0) > time.time() + 30 * 86400 and m.get("v") == 2
        except (OSError, ValueError):
            ok = False
    if not ok:
        with open(p("key.pem"), "w") as f:
            f.write(_private_pem(k))
        _chmod(p("key.pem"))
        with open(p("ca.crt")) as f:
            ca_pem = f.read()
        with open(p("cert.pem"), "w") as f:
            f.write(_pem("CERTIFICATE", _leaf_cert(k, ca, sorted(set(names)), sorted(set(ips)))) + ca_pem)
        with open(p("meta.json"), "w") as f:
            json.dump({"sans": sans, "until": time.time() + LEAF_DAYS * 86400, "v": 2}, f)
    return p("cert.pem"), p("key.pem")
