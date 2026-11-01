"""Tests for the public GitHub Pages build allowlist."""
import os
import tempfile
import unittest

import build_pages


class PagesBuildTests(unittest.TestCase):
    def test_build_contains_only_allowlisted_assets(self):
        with tempfile.TemporaryDirectory() as temp:
            source = os.path.join(temp, "static")
            destination = os.path.join(temp, "docs")
            os.makedirs(source)
            for name in build_pages.ALLOWLIST:
                with open(os.path.join(source, name), "wb") as file:
                    file.write(b"public asset")
            build_pages.build(source, destination)
            self.assertEqual(
                set(os.listdir(destination)),
                build_pages.ALLOWLIST | {".nojekyll"},
            )

    def test_build_rejects_sensitive_files_in_output(self):
        with tempfile.TemporaryDirectory() as temp:
            source = os.path.join(temp, "static")
            destination = os.path.join(temp, "docs")
            os.makedirs(source)
            os.makedirs(destination)
            for name in build_pages.ALLOWLIST:
                with open(os.path.join(source, name), "wb") as file:
                    file.write(b"public asset")
            with open(os.path.join(destination, "settings.json"), "w", encoding="utf-8") as file:
                file.write("{}")
            with self.assertRaisesRegex(RuntimeError, "sensitive file"):
                build_pages.build(source, destination)

    def test_build_rejects_unexpected_files_in_output(self):
        with tempfile.TemporaryDirectory() as temp:
            source = os.path.join(temp, "static")
            destination = os.path.join(temp, "docs")
            os.makedirs(source)
            for name in build_pages.ALLOWLIST:
                with open(os.path.join(source, name), "wb") as file:
                    file.write(b"public asset")
            build_pages.build(source, destination)
            with open(os.path.join(destination, "private.txt"), "w", encoding="utf-8") as file:
                file.write("not for Pages")
            with self.assertRaisesRegex(RuntimeError, "Unexpected file"):
                build_pages.validate_output(destination)


if __name__ == "__main__":
    unittest.main()
