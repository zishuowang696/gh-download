#!/usr/bin/env bash
# 通用 GitHub 下载器（国内无 VPN 友好）：
#   镜像测速 + Range 校验 → aria2 多源并行 → 断点续传 →（有则）sha256 校验。
#
# 用法：
#   scripts/gh-download.sh <owner/repo> <tag> [--pattern GLOB]... [-d DIR]
#   scripts/gh-download.sh <GitHub 下载 URL> [-d DIR]
#
# 例：
#   scripts/gh-download.sh zishuowang696/embedai image-latest -d ./image
#   scripts/gh-download.sh zishuowang696/embedai sstate-jetson --pattern 'sstate-*.part-*' -d ./sst
#   scripts/gh-download.sh https://github.com/zishuowang696/embedai/releases/download/image-latest/x.zst
#
# 环境变量：
#   EMBEDAI_MIRRORS  空格分隔的镜像前缀（**必须支持 HTTP Range/206**）；默认 ghproxy.net + ghfast.top
#   EMBEDAI_JOBS     并发文件数（默认 4）
#   EMBEDAI_CONN     每文件分段数（默认 8）
#   EMBEDAI_STAGE    暂存目录（默认目标目录本身）
#
# 依赖：curl；aria2c（推荐，缺失回退 curl）；gh（按 owner/repo 列举资产时需要）
set -euo pipefail

MIRRORS="${EMBEDAI_MIRRORS:-https://ghproxy.net https://ghfast.top}"
JOBS="${EMBEDAI_JOBS:-4}"
CONN="${EMBEDAI_CONN:-8}"

DEST="."
PATTERNS=()
POS=()
while [ $# -gt 0 ]; do
  case "$1" in
    -d|--dir) DEST="$2"; shift 2;;
    -p|--pattern) PATTERNS+=("$2"); shift 2;;
    *) POS+=("$1"); shift;;
  esac
done
mkdir -p "$DEST"; cd "$DEST"

probe_range() { # 返回 206 视为支持 Range
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -r 0-0 --max-time 20 "$1" 2>/dev/null || echo 000)
  [ "$code" = "206" ]
}

# 列资产（无需登录）：优先已授权 gh，否则用公开 API（curl）+ jq/python3 解析
list_assets() { # repo tag -> "name<TAB>url"
  local repo="$1" tag="$2" json hdr=()
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    gh api "repos/$repo/releases/tags/$tag" --jq '.assets[] | [.name, .browser_download_url] | @tsv'
    return $?
  fi
  hdr=(-H 'Accept: application/vnd.github+json')
  [ -n "${GH_TOKEN:-}" ] && hdr+=(-H "Authorization: Bearer $GH_TOKEN")
  json=$(curl -fsSL "${hdr[@]}" "https://api.github.com/repos/$repo/releases/tags/$tag") || return 1
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$json" | jq -r '.assets[] | "\(.name)\t\(.browser_download_url)"'
  else
    printf '%s' "$json" | python3 -c 'import sys,json
for a in json.load(sys.stdin)["assets"]: print(a["name"]+"\t"+a["browser_download_url"])'
  fi
}

# 1) 组装资产清单：name \t url
: > assets.tsv
if [ "${#POS[@]}" -eq 1 ] && [[ "${POS[0]}" == http* ]]; then
  name="${POS[0]##*/}"
  printf '%s\t%s\n' "$name" "${POS[0]}" > assets.tsv
elif [ "${#POS[@]}" -ge 2 ]; then
  repo="${POS[0]}"; tag="${POS[1]}"
  list_assets "$repo" "$tag" > assets.tsv
else
  echo "用法: $0 <owner/repo> <tag> [--pattern GLOB]... [-d DIR]"; exit 1
fi
[ -s assets.tsv ] || { echo "没有资产"; exit 1; }

# 按 --pattern 过滤（无 pattern 则全要）
if [ "${#PATTERNS[@]}" -gt 0 ]; then
  : > assets.filtered
  while IFS=$'\t' read -r n u; do
    for pat in "${PATTERNS[@]}"; do
      case "$n" in $pat) printf '%s\t%s\n' "$n" "$u" >> assets.filtered; break;; esac
    done
  done < assets.tsv
  mv assets.filtered assets.tsv
fi
echo "资产数: $(wc -l < assets.tsv)"

# 2) 测速/验 Range：对第一个资产的每个镜像探测
firsturl=$(awk -F'\t' 'NR==1{print $2}' assets.tsv)
for m in $MIRRORS; do
  if probe_range "${m%/}/${firsturl}"; then GOOD_MIRRORS+=("$m"); echo "镜像可用(Range): $m"; fi
done
[ "${#GOOD_MIRRORS[@]}" -gt 0 ] || { echo "无支持 Range 的镜像，改用直连（不并行分段）"; GOOD_MIRRORS=(""); }

# 3) 组装 aria2 输入（**同一文件的多个镜像放同一行、TAB 分隔** → 才被当作镜像并行，而非下两遍）
: > dl.aria2
while IFS=$'\t' read -r n u; do
  first=1
  for m in "${GOOD_MIRRORS[@]}"; do
    full="$u"; [ -n "$m" ] && full="${m%/}/$u"
    if [ "$first" = 1 ]; then printf '%s' "$full"; first=0; else printf '\t%s' "$full"; fi
  done
  printf '\n  out=%s\n' "$n"
done < assets.tsv > dl.aria2

# 4) 下载
echo "开始下载 → $DEST"
if command -v aria2c >/dev/null 2>&1; then
  aria2c -c -j "$JOBS" -x "$CONN" -s "$CONN" -k 1M --file-allocation=none \
    --summary-interval=30 --console-log-level=warn -i dl.aria2
else
  echo "！未找到 aria2c —— 单连接会非常慢；建议先安装："
  echo "    Debian/Ubuntu: sudo apt install -y aria2"
  echo "    Fedora:        sudo dnf install -y aria2"
  echo "    Arch:          sudo pacman -S aria2"
  echo "    macOS:         brew install aria2"
  echo "    Windows:       winget install aria2.aria2"
  echo "  临时回退：curl 单接连下（可续传，慢）"
  while IFS=$'\t' read -r n u; do curl -L -C - --retry 5 -o "$n" "$u"; done < assets.tsv
fi

# 5) 校验（若同批里有 SHA256SUMS）
sums=$(awk -F'\t' '$1 ~ /SHA256SUMS$/{print $1}' assets.tsv | head -1)
if [ -n "$sums" ] && [ -f "$sums" ]; then
  echo "校验：sha256sum -c $sums"; sha256sum -c "$sums" || true
else
  echo "（无 SHA256SUMS，跳过校验）"
fi

rm -f assets.tsv dl.aria2
echo "完成 → $DEST"
