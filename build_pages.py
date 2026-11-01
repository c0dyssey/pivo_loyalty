#!/usr/bin/env python3
"""Copy the PWA shell into docs/ for GitHub Pages deployment."""
import os
import shutil

BASE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(BASE, "static")
DESTINATION = os.path.join(BASE, "docs")

os.makedirs(DESTINATION, exist_ok=True)
shutil.copytree(SOURCE, DESTINATION, dirs_exist_ok=True)
open(os.path.join(DESTINATION, ".nojekyll"), "a").close()
print("GitHub Pages files updated in docs/.")
