"""The automatic updater (repopulse/updater.py) against a fake GitHub: no network."""
from __future__ import annotations

import hashlib
import io
import json
import os
import tarfile
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from repopulse import updater
from repopulse.updater import GitHub, Response, UpdateError

TOKEN = "github_pat_SECRET123"
API = "https://api.github.com/repos/dxcufgb/RepoPulse"
CDN = "https://release-assets.githubusercontent.com"
BASE_FILES = {"repopulse/__init__.py": b'__version__ = "X"\n', "requirements.txt": b"flask\n", "install.sh": b"#!/bin/sh\n"}


def make_tar(version, extra=None, raw_names=False):
    prefix = f"repopulse-{version}"
    files = dict(BASE_FILES, **(extra or {}))
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(name if raw_names and not name.startswith("repopulse/") and name not in BASE_FILES else f"{prefix}/{name}")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


class FakeGitHub:
    """Serves a release like GitHub: API asset URLs answer 302 to a pre-signed CDN URL."""

    def __init__(self, version="1.3.0", draft=False, prerelease=False, archive=None, sums=None, assets=None, reject_token=False):
        self.calls = []
        self.reject_token = reject_token
        tar = make_tar(version) if archive is None else archive
        zdata = b"MZ fake installer " + version.encode()
        name, zname = f"repopulse-{version}-linux.tar.gz", f"repopulse-{version}-setup.exe"
        if sums is None:
            sums = f"{hashlib.sha256(tar).hexdigest()}  {name}\n{hashlib.sha256(zdata).hexdigest()}  {zname}\n".encode()
        self.files = {f"{CDN}/1": tar, f"{CDN}/2": sums, f"{CDN}/3": zdata}
        ids = {name: 1, "SHA256SUMS.txt": 2, zname: 3}
        names = assets if assets is not None else [name, "SHA256SUMS.txt", zname]
        self.release = {"tag_name": f"v{version}", "name": f"RepoPulse {version}", "body": "notes",
                        "html_url": f"https://github.com/dxcufgb/RepoPulse/releases/tag/v{version}",
                        "draft": draft, "prerelease": prerelease,
                        "assets": [{"name": n, "url": f"{API}/releases/assets/{ids[n]}"} for n in names]}

    def __call__(self, url, headers, timeout):
        self.calls.append((url, dict(headers)))
        if self.reject_token and "Authorization" in headers:
            return Response(401, {}, iter([b""]))
        if url == f"{API}/releases/latest":
            return Response(200, {}, iter([json.dumps(self.release).encode()]))
        if url.startswith(f"{API}/releases/assets/"):
            return Response(302, {"location": f"{CDN}/{url.rsplit('/', 1)[1]}"}, iter([b""]))
        if url in self.files:
            return Response(200, {}, iter([self.files[url]]))
        return Response(404, {}, iter([b""]))


class Versions(unittest.TestCase):
    def test_is_newer(self):
        for candidate, installed, newer in [("v1.2.1", "1.2.0", True), ("v1.10.0", "1.9.9", True), ("v2", "1.9", True),
                                            ("v1.2.0", "1.2.0", False), ("v1.2", "1.2.0", False), ("v1.1.0", "1.2.0", False),
                                            ("v1.3.0-rc.1", "1.2.0", False), ("latest", "1.2.0", False), ("v1.3.0", "dev", False)]:
            self.assertIs(updater.is_newer(candidate, installed), newer, (candidate, installed))


class Run(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="repopulse-upd-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, True))
        self.token = self.tmp / "token"
        self.token.write_text(TOKEN + "\n")

    def run_main(self, fake, *args, installed="1.2.0", token=True, platform="linux"):
        out, err = io.StringIO(), io.StringIO()
        argv = ["--installed", installed, "--platform", platform] + (["--token-file", str(self.token)] if token else []) + list(args)
        with redirect_stdout(out), redirect_stderr(err):
            code = updater.main(argv, fake)
        self.assertNotIn(TOKEN, out.getvalue() + err.getvalue())
        return code, out.getvalue(), err.getvalue()

    def test_check(self):
        self.assertEqual(self.run_main(FakeGitHub(), "check")[:2], (updater.EXIT_OK, "1.3.0\n"))
        self.assertEqual(self.run_main(FakeGitHub("1.2.0"), "check")[0], updater.EXIT_UP_TO_DATE)
        self.assertEqual(self.run_main(FakeGitHub(draft=True), "check")[0], updater.EXIT_UP_TO_DATE)
        self.assertEqual(self.run_main(FakeGitHub(prerelease=True), "check")[0], updater.EXIT_UP_TO_DATE)
        self.assertEqual(self.run_main(FakeGitHub(), "check", token=False)[0], updater.EXIT_OK)
        # a copy that is not a final release (git, pre-release) is never replaced
        self.assertEqual(self.run_main(FakeGitHub(), "check", installed="1.2.0-rc.1")[0], updater.EXIT_UP_TO_DATE)

    def test_download_verifies_and_extracts(self):
        for platform in ("linux", "windows"):
            fake = FakeGitHub()
            dest = self.tmp / f"dest-{platform}"
            code, out, _ = self.run_main(fake, "download", "--dest", str(dest), platform=platform)
            self.assertEqual(code, updater.EXIT_OK)
            root = Path(out.strip().splitlines()[-1])
            if platform == "windows":  # the verified installer itself
                self.assertEqual(root, dest / "release" / "repopulse-1.3.0-setup.exe")
                self.assertEqual(root.read_bytes(), b"MZ fake installer 1.3.0")
            else:
                self.assertEqual(root, dest / "release" / "repopulse-1.3.0")
                self.assertTrue((root / "repopulse" / "__init__.py").is_file())
            self.assertFalse((dest / "download").exists())
            # the token went to api.github.com only, never to the CDN the download is redirected to
            for url, headers in fake.calls:
                self.assertEqual("Authorization" in headers, url.startswith("https://api.github.com/"), url)

    def test_rejected_token_falls_back_to_no_token(self):
        fake = FakeGitHub(reject_token=True)
        code, _, err = self.run_main(fake, "check")
        self.assertEqual(code, updater.EXIT_OK)
        self.assertIn("continuing without one", err)

    def test_refuses_bad_downloads(self):
        tar = make_tar("1.3.0")
        cases = {
            "checksum": FakeGitHub(sums=b"0" * 64 + b"  repopulse-1.3.0-linux.tar.gz\n"),
            "no sums": FakeGitHub(assets=["repopulse-1.3.0-linux.tar.gz"]),
            "no archive": FakeGitHub(assets=["SHA256SUMS.txt"]),
            "traversal": FakeGitHub(archive=make_tar("1.3.0", {"../evil.txt": b"x"}, raw_names=True)),
            "outside prefix": FakeGitHub(archive=make_tar("1.3.0", {"other/evil.txt": b"x"}, raw_names=True)),
            "not repopulse": FakeGitHub(archive=self._tar_without_package()),
        }
        self.assertTrue(tar)
        for label, fake in cases.items():
            dest = self.tmp / label.replace(" ", "-")
            code, _, err = self.run_main(fake, "download", "--dest", str(dest))
            self.assertEqual(code, updater.EXIT_ERROR, (label, err))
            self.assertFalse((dest / "release" / "repopulse-1.3.0" / "repopulse").exists() and label != "not repopulse", label)

    def test_symlink_in_archive(self):
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tar:
            info = tarfile.TarInfo("repopulse-1.3.0/link")
            info.type = tarfile.SYMTYPE
            info.linkname = "/etc/passwd"
            tar.addfile(info)
        code, _, err = self.run_main(FakeGitHub(archive=buf.getvalue()), "download", "--dest", str(self.tmp / "s"))
        self.assertEqual(code, updater.EXIT_ERROR)
        self.assertIn("Unsupported entry", err)

    def test_http_errors_are_explained(self):
        msg = updater._http_error(403, updater.API_HOST, {"x-ratelimit-remaining": "0", "x-ratelimit-reset": "0"})
        self.assertIn("rate limit", msg)
        self.assertIn("no published release", updater._http_error(404, updater.API_HOST))
        with self.assertRaises(UpdateError):
            GitHub(None, lambda u, h, t: Response(200, {}, iter([b"x"])))._open("http://api.github.com/x", "a")

    @staticmethod
    def _tar_without_package():
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tar:
            info = tarfile.TarInfo("repopulse-1.3.0/README.md")
            info.size = 1
            tar.addfile(info, io.BytesIO(b"x"))
        return buf.getvalue()


class Standalone(unittest.TestCase):
    def test_imports_only_the_standard_library(self):
        # root runs this file with -I: it must not import anything from RepoPulse or a third-party package
        source = (Path(updater.__file__)).read_text(encoding="utf-8")
        for line in source.splitlines():
            if line.startswith(("import ", "from ")) and "__future__" not in line:
                self.assertNotIn("repopulse", line)
                self.assertNotRegex(line, r"\b(flask|waitress|requests)\b")
        self.assertTrue(os.path.basename(updater.__file__) == "updater.py")


if __name__ == "__main__":
    unittest.main()
