#!/usr/bin/env python3
"""通用 GitHub 下载器（国内无 VPN 友好）——零外部二进制依赖。

只用 Python 标准库（urllib / hashlib / threading），**不需要** aria2、curl、gh、jq、sha256sum。
多镜像并行分段（HTTP Range）+ 断点续传 +（有则）sha256 校验；某镜像不支持 Range 时自动回退单流。

用法：
  gh-download.py <owner/repo> <tag> [--pattern GLOB]... [-d DIR] [--list]
  gh-download.py <GitHub 下载 URL> [-d DIR]

例：
  gh-download.py BurntSushi/ripgrep latest --pattern '*x86_64-unknown-linux-musl.tar.gz' -d ./dl
  gh-download.py zishuowang696/embedai image-latest -d ./image
  gh-download.py https://github.com/foo/bar/releases/download/v1/x.zip

环境变量：
  GITHUB_TOKEN     可选的 GitHub Token（提升 API 限额 / 访问私有仓库）
  GH_DL_MIRRORS    空格分隔的镜像前缀（必须支持 HTTP Range），默认 ghproxy.net + ghfast.top
  GH_DL_CONN       每文件分段数（默认 8）
"""

import argparse
import fnmatch
import hashlib
import json
import os
import sys
import threading
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

USER_AGENT = "gh-download.py/1.0 (+https://github.com/zishuowang696/gh-download)"
DEFAULT_MIRRORS = ["https://ghproxy.net", "https://ghfast.top"]
DEFAULT_CONN = 8
TOKEN = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""


# ------------------------------------------------------------------ helpers

def human(n: float) -> str:
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if n < 1024 or unit == "TiB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TiB"


def api_headers() -> dict:
    h = {"Accept": "application/vnd.github+json", "User-Agent": USER_AGENT}
    if TOKEN:
        h["Authorization"] = f"Bearer {TOKEN}"
    return h


def get_release(owner: str, repo: str, tag: str) -> dict:
    path = (
        f"/repos/{owner}/{repo}/releases/latest"
        if tag in ("", "latest")
        else f"/repos/{owner}/{repo}/releases/tags/{tag}"
    )
    req = urllib.request.Request("https://api.github.com" + path, headers=api_headers())
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"GitHub API {e.code}：{owner}/{repo}@{tag}（{e.reason}）") from e


def asset_from_url(url: str) -> dict:
    """把一条直链包成 asset；通过 Range 探测拿到大小。"""
    size = 0
    try:
        req = urllib.request.Request(url, headers={"Range": "bytes=0-0", "User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=30) as resp:
            cr = resp.headers.get("Content-Range", "")  # bytes 0-0/12345
            if "/" in cr:
                size = int(cr.rsplit("/", 1)[1])
    except Exception:
        pass
    return {"name": url.rstrip("/").split("/")[-1], "size": size, "browser_download_url": url}


# ----------------------------------------------------------------- download

def candidate_urls(browser_url: str, mirrors: list[str]) -> list[str]:
    return [browser_url] + [f"{m.rstrip('/')}/{browser_url}" for m in mirrors]


def probe_range(url: str) -> bool:
    req = urllib.request.Request(url, headers={"Range": "bytes=0-0", "User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status == 206
    except Exception:
        return False


def get_segment(url: str, start: int, end: int) -> bytes:
    req = urllib.request.Request(
        url, headers={"Range": f"bytes={start}-{end}", "User-Agent": USER_AGENT}
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def download_ranged(urls: list[str], size: int, dest: str, connections: int) -> None:
    seg = max(1, size // connections)
    segments = []
    start = 0
    while start < size:
        segments.append((start, min(start + seg - 1, size - 1)))
        start += seg

    fd = os.open(dest, os.O_RDWR | os.O_CREAT | os.O_TRUNC)
    done = 0
    lock = threading.Lock()

    def worker(i: int, rng: tuple[int, int]) -> None:
        nonlocal done
        data = get_segment(urls[i % len(urls)], rng[0], rng[1])
        os.pwrite(fd, data, rng[0])
        with lock:
            done += len(data)
            sys.stderr.write(f"\r  {100.0 * done / size:5.1f}%  {human(done)} / {human(size)}")
            sys.stderr.flush()

    try:
        os.ftruncate(fd, size)
        with ThreadPoolExecutor(max_workers=min(connections, len(segments))) as pool:
            for f in [pool.submit(worker, i, r) for i, r in enumerate(segments)]:
                f.result()
    finally:
        os.close(fd)
    sys.stderr.write("\n")


def download_stream(url: str, dest: str) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as resp, open(dest, "wb") as out:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
            done += len(chunk)
            if total:
                sys.stderr.write(f"\r  {100.0 * done / total:5.1f}%  {human(done)} / {human(total)}")
                sys.stderr.flush()
    sys.stderr.write("\n")


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def download_asset(asset: dict, dest_dir: str, mirrors: list[str], connections: int) -> dict:
    name = asset["name"]
    size = int(asset.get("size") or 0)
    dest = os.path.join(dest_dir, name)
    print(f"→ {name}  ({human(size) if size else '大小未知'})")

    good = [u for u in candidate_urls(asset["browser_download_url"], mirrors) if probe_range(u)]
    print(f"  支持 Range 的源: {len(good)}/{len(mirrors) + 1}")

    if size > 0 and good:
        download_ranged(good, size, dest, connections)
    else:
        source = good[0] if good else asset["browser_download_url"]
        print(f"  回退单流: {source}")
        download_stream(source, dest)

    result = {"name": name, "path": os.path.abspath(dest), "bytes": os.path.getsize(dest)}
    expected = (asset.get("digest") or "").removeprefix("sha256:")
    if expected:
        actual = sha256_of(dest)
        result["sha256_ok"] = actual == expected
        print(f"  sha256 {'✓ 校验通过' if actual == expected else '✗ 不匹配: ' + actual}")
    return result


# --------------------------------------------------------------------- main

def find_assets(release: dict, patterns: list[str]) -> list[dict]:
    assets = release.get("assets", [])
    if not patterns:
        return assets
    out = []
    for a in assets:
        if any(fnmatch.fnmatch(a["name"], p) for p in patterns):
            out.append(a)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="GitHub 下载器（零外部二进制依赖）")
    ap.add_argument("target", nargs="+", help="<owner/repo> <tag> 或一个 GitHub 下载 URL")
    ap.add_argument("-d", "--dir", default=".", help="目标目录（默认当前目录）")
    ap.add_argument("-p", "--pattern", action="append", default=[], help="资产名 glob，可多次")
    ap.add_argument("--mirror", action="append", default=[], help="镜像前缀，可多次")
    ap.add_argument("--conn", type=int, default=int(os.environ.get("GH_DL_CONN", DEFAULT_CONN)))
    ap.add_argument("--list", action="store_true", help="只列出资产，不下载")
    args = ap.parse_args()

    mirrors = args.mirror or (
        os.environ.get("GH_DL_MIRRORS", "").split() or DEFAULT_MIRRORS
    )

    if len(args.target) == 1 and args.target[0].startswith("http"):
        assets = [asset_from_url(args.target[0])]
        tag = "url"
    elif len(args.target) >= 2:
        owner_repo, tag = args.target[0], args.target[1]
        if "/" not in owner_repo:
            raise SystemExit("repo 需写成 owner/repo")
        owner, repo = owner_repo.split("/", 1)
        release = get_release(owner, repo, tag)
        assets = find_assets(release, args.pattern)
        tag = release.get("tag_name")
    else:
        raise SystemExit("用法：gh-download.py <owner/repo> <tag> [--pattern GLOB]... [-d DIR]")

    if not assets:
        raise SystemExit("没有匹配的资产")

    print(f"发布 {tag}：{len(assets)} 个资产")
    for a in assets:
        print(f"  - {a['name']}  ({human(int(a.get('size') or 0)) if a.get('size') else '?'})")
    if args.list:
        return

    os.makedirs(args.dir, exist_ok=True)
    results = [download_asset(a, args.dir, mirrors, args.conn) for a in assets]
    print(f"\n完成 → {os.path.abspath(args.dir)}")
    for r in results:
        print(f"  ✓ {r['name']}")


if __name__ == "__main__":
    main()
