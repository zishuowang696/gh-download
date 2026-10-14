# gh-download

> **通用 GitHub 下载器（国内无 VPN 友好）**：多镜像测速 + `Range` 校验 → **aria2 多源并行** → 断点续传 →（有则）sha256 校验。

下载 GitHub Release 资产时，直连慢、单镜像不稳。这个脚本把"选哪个镜像"从凭感觉变成**先验 `Range`（HTTP 206）**，再让 **aria2 把同一个文件的多个镜像当"镜像源"并行拉**。

## 快速开始

```bash
curl -fsSL https://embedai.com.cn/dl/gh-download.sh -o gh-download.sh
chmod +x gh-download.sh

# 按 owner/repo + tag（自动列资产，--pattern 过滤）
./gh-download.sh <owner/repo> <tag> [--pattern 'GLOB']... [-d DIR]

# 例：只下某个分卷
./gh-download.sh zishuowang696/embedai sstate-jetson --pattern 'sstate-*.part-*' -d ./sst

# 也可以直接给一个 GitHub 下载 URL
./gh-download.sh https://github.com/<owner>/<repo>/releases/download/<tag>/<file>
```

## 本地 Web UI（可选）

不想敲命令？用本地网页版（需要 [Bun](https://bun.sh)）：

单文件，一个链接就能拿到：

```bash
curl -fsSL https://embedai.com.cn/dl/gh-download-ui.ts -o gh-download-ui.ts
bun gh-download-ui.ts        # 打开 http://localhost:8787
# 或： git clone 后 bun run ui
```

- 粘贴 **`owner/repo` + `tag`**（或直接一个 GitHub 下载链接）→ **列出资产** → **勾选** → **下载**；
- 后端仍走同一套逻辑（**多镜像 Range 校验 + aria2 多源并行 + 续传**），**日志实时滚动**；
- 参数照旧：`EMBEDAI_MIRRORS` / `EMBEDAI_JOBS` / `EMBEDAI_CONN`；`GITHUB_TOKEN`（可选，匿名 API 有限流）。

## 更多例子

```bash
# 1) 下某个 release 的「全部资产」（自动列出来，全下）
./gh-download.sh owner/repo v1.2.3 -d ./dl

# 2) 只要 Linux 的
./gh-download.sh owner/repo v1.2.3 --pattern '*linux*' -d ./dl

# 3) 只要 Windows 的
./gh-download.sh owner/repo v1.2.3 --pattern '*windows*' -d ./dl

# 4) 压缩包 + 校验文件一起下
./gh-download.sh owner/repo v1.2.3 --pattern '*.zip' --pattern 'SHA256SUMS' -d ./dl

# 5) 只下某个分卷（如 Yocto sstate 缓存）
./gh-download.sh zishuowang696/embedai sstate-jetson --pattern 'sstate-*.part-*' -d ./sst

# 6) 直接给一个 GitHub 下载链接（不用 repo/tag）
./gh-download.sh https://github.com/owner/repo/releases/download/v1.2.3/file.zip

# 7) 换镜像 / 提高并发分段
EMBEDAI_MIRRORS="https://ghproxy.net https://ghfast.top" EMBEDAI_CONN=16 ./gh-download.sh owner/repo v1.2.3

# 8) 下断了？直接重跑同一条命令 —— 自动续传
./gh-download.sh owner/repo v1.2.3 -d ./dl
```

> 提示：`--pattern` 可重复多次；`-d` 指定目录；不确定有哪些资产时**先不带 pattern 跑一次**，它会打印"资产数"并全下。

## Windows / PowerShell 版

`gh-download.ps1`（Windows 10+ 自带 `curl.exe`）：

```powershell
# 按 owner/repo + tag，过滤后下载
./gh-download.ps1 <owner/repo> <tag> -Pattern '*x86_64-pc-windows-msvc.zip' -Dir .\dl

# 或直接给 URL
./gh-download.ps1 https://github.com/<owner>/<repo>/releases/download/<tag>/<file>
```

依赖：`curl.exe`（自带）；**`aria2c`**（推荐，`winget install aria2.aria2`）；`gh`（可选，按仓库列资产时用）。
> 逻辑与 bash 版一致；已在 Linux 上用 **PowerShell 7.6** 实测通过（同一脚本也适用于 Windows PowerShell）。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `EMBEDAI_MIRRORS` | `https://ghproxy.net https://ghfast.top` | 空格分隔的镜像前缀，**必须支持 `Range`** |
| `EMBEDAI_JOBS` | `4` | 并发文件数 |
| `EMBEDAI_CONN` | `8` | 每个文件的分段/连接数 |
| `EMBEDAI_STAGE` | 目标目录 | 暂存目录 |

## 依赖

- `curl`（必需）
- `aria2c`（**强烈推荐**；缺失会回退 curl 并打印各平台安装命令）
- `gh`（按 `owner/repo` 自动列资产时需要；否则走公开 API + `jq`/`python3`）

## 原理（三点）

1. **只信支持 `Range`（206）的镜像** —— 探一下 `curl -r 0-0` 是否返回 206；
2. **同一文件的多个镜像放在 aria2 输入的"同一行"（TAB 分隔）** —— 否则它会**把文件下两遍**；
3. **`aria2c -c` 续传**，同批有 `SHA256SUMS` 则自动校验。

## 实测

| 目标 | 大小 | 平均速度 |
| --- | --- | --- |
| ripgrep 14.1.0 (musl) | 2.4 MB | 191 KiB/s（单镜像） |
| **Ghidra 12.1.4 (PUBLIC)** | **543 MB** | **4.7 MiB/s**（多镜像并行，一次下完） |

> 对比直连/单镜像 ~0.19 MiB/s —— **快约 20 倍**。

## 注意

- 第三方镜像**不可信**：能校验哈希就一定校验；
- **不要**用公共代理下敏感内容；
- 镜像质量会变：所以脚本**先测速/验 Range**，不要写死。

## 相关链接

- 博客（Agent and Edge AI）：<https://embedai.com.cn>
- 讲解文章：<https://embedai.com.cn/posts/gh-downloader>
- 工具下载页：<https://embedai.com.cn/tools>
- GitHub：<https://github.com/zishuowang696>

## 许可

MIT
