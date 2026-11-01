"""Explicitly rotate the local HTTPS CA and server certificate."""
import os
import shutil
import socket
import ssl
import sys
from datetime import datetime

import certgen


BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE, "data")
CERT_DIR = os.path.join(DATA_DIR, "cert")
PORT = 8443


def lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("10.255.255.255", 1))
            return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def server_is_running():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex(("127.0.0.1", PORT)) == 0


def rotate():
    if input("Type ROTATE CERTIFICATE to replace the active CA: ").strip() != "ROTATE CERTIFICATE":
        print("Cancelled; no files were changed.")
        return 1
    if server_is_running():
        print("Stop the Pivo server before rotating its certificate; no files were changed.")
        return 1
    if not os.path.isdir(CERT_DIR):
        print("The active data/cert directory does not exist; no files were changed.")
        return 1

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    staged = os.path.join(DATA_DIR, "cert.rotation-" + stamp)
    previous = os.path.join(DATA_DIR, "cert.previous-" + stamp)
    if os.path.exists(staged) or os.path.exists(previous):
        print("A certificate rotation path already exists; no files were changed.")
        return 1

    moved_old = False
    try:
        cert, key = certgen.ensure(
            staged,
            ["127.0.0.1", lan_ip()],
            ["localhost", socket.gethostname()],
        )
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        os.rename(CERT_DIR, previous)
        moved_old = True
        os.rename(staged, CERT_DIR)
    except (OSError, ValueError, ssl.SSLError) as error:
        if moved_old and not os.path.exists(CERT_DIR):
            try:
                os.rename(previous, CERT_DIR)
            except OSError as restore_error:
                print(f"Could not restore the old certificate directory: {previous}: {restore_error}")
        if os.path.isdir(staged):
            try:
                shutil.rmtree(staged)
            except OSError as cleanup_error:
                print(f"Could not remove temporary certificate files: {staged}: {cleanup_error}")
        print(f"Certificate rotation failed: {error}. Check data/cert and the previous directory before restarting.")
        return 1

    for name in ("ca-key.json", "key.json", "key.pem"):
        old_key = os.path.join(previous, name)
        if os.path.isfile(old_key):
            try:
                os.remove(old_key)
            except OSError as error:
                print(f"Warning: could not remove old private key {name}: {error}")
    print("New CA and server certificate are active. Customer data and PIN were not changed.")
    print(f"Previous public certificate files: {previous}")
    print("Install data/cert/ca.crt on each trusted device, then restart the Pivo server.")
    return 0


if __name__ == "__main__":
    sys.exit(rotate())
