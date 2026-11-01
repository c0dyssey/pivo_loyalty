#!/usr/bin/env python3
"""Copy the allowlisted PWA shell into docs/ for GitHub Pages deployment."""
import os
import shutil

BASE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(BASE, "static")
DESTINATION = os.path.join(BASE, "docs")
ALLOWLIST = {
    "index.html", "app.js", "offline.js", "sw.js", "style.css",
    "manifest.webmanifest", "qrdec.js", "icon.svg", "icon-180.png",
    "icon-192.png", "icon-512.png",
}
FORBIDDEN_NAMES = {
    "data.json", "data.json.prev", "config.json", "settings.json",
    "events.log", "ca-key.json", "key.json", "key.pem", "cert.pem",
}


def validate_output(destination):
    allowed = ALLOWLIST | {".nojekyll"}
    for root, dirs, files in os.walk(destination):
        dirs[:] = [name for name in dirs if name != ".git"]
        for name in files:
            path = os.path.join(root, name)
            relative = os.path.relpath(path, destination)
            if name.lower() in FORBIDDEN_NAMES or name.lower().endswith((".pem", ".key")):
                raise RuntimeError(f"Refusing to publish sensitive file: {relative}")
            if relative not in allowed:
                raise RuntimeError(f"Unexpected file in Pages output: {relative}")


def build(source=SOURCE, destination=DESTINATION):
    os.makedirs(destination, exist_ok=True)
    for name in ALLOWLIST:
        source_file = os.path.join(source, name)
        if not os.path.isfile(source_file):
            raise FileNotFoundError(f"Required Pages asset is missing: static/{name}")
        shutil.copy2(source_file, os.path.join(destination, name))
    open(os.path.join(destination, ".nojekyll"), "a").close()
    validate_output(destination)


if __name__ == "__main__":
    build()
    print("GitHub Pages files updated in docs/.")
