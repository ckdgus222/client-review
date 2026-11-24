#!/usr/bin/env python3
"""Build an immutable public site and switch current/previous within one filesystem."""
import argparse
import fcntl
import os
import re
import shutil
import subprocess
import tempfile
from contextlib import contextmanager
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

REPO = Path(__file__).resolve().parents[1]
REVISION = re.compile(r"[0-9a-f]{40}")
PUBLIC_FILE = re.compile(
    r"(?:index\.html|privacy\.html|terms\.html|404\.html|landing\.css|robots\.txt|favicon\.svg|"
    r"shop-[a-z0-9-]+\.webp|app/(?:index\.html|favicon\.svg)|"
    r"(?:app/)?fonts/[\w.-]+(?:\.woff2|-LICENSE\.txt)|app/assets/[\w.-]+\.(?:js|css|webp))",
    re.ASCII,
)


class PageAssets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        key = "href" if tag == "link" else "src" if tag in ("script", "img") else None
        if key and attrs.get(key):
            self.urls.append(attrs[key])


def validate(folder):
    if not folder.is_dir() or folder.is_symlink():
        raise ValueError("release directory is missing or linked")
    for path in folder.rglob("*"):
        name = path.relative_to(folder).as_posix()
        if path.is_symlink():
            raise ValueError("linked build entry")
        if path.is_dir() and name in ("app", "fonts", "app/fonts", "app/assets"):
            continue
        if not PUBLIC_FILE.fullmatch(name) or not path.is_file() or not path.stat().st_size:
            raise ValueError("unexpected or empty build entry")
    for name in ("index.html", "privacy.html", "terms.html", "404.html", "app/index.html"):
        parser = PageAssets()
        parser.feed((folder / name).read_text())
        if not parser.urls:
            raise ValueError("HTML has no public assets")
        for raw in parser.urls:
            url = urlsplit(raw)
            if url.scheme or url.netloc or not url.path.startswith("/") or ".." in url.path.split("/"):
                raise ValueError("unexpected asset URL")
            if not (folder / url.path.lstrip("/")).is_file():
                raise ValueError("HTML references a missing asset")
    if not list((folder / "app/assets").glob("*.js")) or not list((folder / "app/assets").glob("*.css")):
        raise ValueError("missing React build")
    for css in [folder / "landing.css", *(folder / "app/assets").glob("*.css")]:
        content = css.read_text()
        for value in re.findall(r"url\(\s*['\"]?([^()'\"\s]+\.woff2)['\"]?\s*\)", content):
            font = folder / value.lstrip("/") if value.startswith("/") else css.parent / value
            if not font.is_file():
                raise ValueError("stylesheet references a missing font")


def current_revision(root, link):
    path = root / link
    if not path.is_symlink():
        if path.exists():
            raise ValueError(f"{link} must be a managed symlink")
        return None
    target = Path(os.readlink(path))
    if len(target.parts) != 2 or target.parts[0] != "releases" or not REVISION.fullmatch(target.name):
        raise ValueError("unexpected release link")
    return target.name


def allow_web_reads(folder):
    # BuildKit's local exporter may create the release root with mode 0700.
    # This tree contains only files already checked by validate().
    for entry in [folder, *folder.rglob("*")]:
        mode = 0o755 if entry.is_dir() else 0o644
        if entry.stat().st_mode & 0o7777 != mode:
            entry.chmod(mode)


def switch(root, name, revision):
    with tempfile.TemporaryDirectory(dir=root) as tmp:
        link = Path(tmp) / name
        link.symlink_to(Path("releases") / revision)
        os.replace(link, root / name)


@contextmanager
def public_build(root, revision):
    with tempfile.TemporaryDirectory(prefix=".build-", dir=root) as tmp:
        temp = Path(tmp)
        public = temp / "site"
        archive = temp / "context.tar"
        with archive.open("wb") as stream:
            subprocess.run(["git", "archive", revision, "web", "landing", "nginx/Dockerfile"], cwd=REPO,
                           stdout=stream, check=True)
        with archive.open("rb") as stream:
            subprocess.run(["docker", "build", "--file", "nginx/Dockerfile", "--target", "public-site",
                            "--output", f"type=local,dest={public}", "-"], stdin=stream, check=True)
        validate(public)
        yield public


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "activate", "rollback"))
    parser.add_argument("root", type=Path)
    parser.add_argument("--to", metavar="REVISION", help="restore a specific prepared release on rollback")
    args = parser.parse_args()
    if args.to is not None and (args.command != "rollback" or not REVISION.fullmatch(args.to)):
        parser.error("--to requires rollback and a full Git commit hash")
    root = args.root
    if not root.is_absolute() or root.is_symlink() or not root.is_dir() or root == Path("/"):
        parser.error("provide an existing, dedicated absolute release root")
    releases = root / "releases"
    if releases.is_symlink():
        parser.error("releases must be a local directory")
    releases.mkdir(exist_ok=True)
    releases.chmod(0o755)
    with (root / ".release.lock").open("a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        current = current_revision(root, "current")
        prior = current_revision(root, ".prior")
        if prior:
            if current != prior:
                switch(root, "previous", prior)
            (root / ".prior").unlink()
        previous = current_revision(root, "previous")
        revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
        if args.command == "rollback":
            if not args.to and not previous:
                parser.error("no previous release")
            revision = args.to or previous
        if not REVISION.fullmatch(revision):
            parser.error("invalid release identifier")
        target = releases / revision
        if args.command == "prepare" and not target.exists():
            with public_build(root, revision) as site:
                os.replace(site, target)
        validate(target)
        allow_web_reads(target)
        if args.command != "prepare" and current != revision:
            if current:
                switch(root, ".prior", current)
            switch(root, "current", revision)
            if current:
                switch(root, "previous", current)
                (root / ".prior").unlink()
        print(revision)


if __name__ == "__main__":
    main()
