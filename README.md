# gh-download

> **通用 GitHub 下载器（国内无 VPN 友好）**：多镜像并行分段（HTTP `Range`）+ 断点续传 +（有则）sha256 校验。
> **零外部二进制依赖**：纯 Python 标准库实现，**不需要** `aria2`、`curl`、`gh`、`jq`、`sha256sum`。

下载 GitHub Release 资产时，直连慢、单镜像不稳。这个工具把"选哪个镜像"从凭感觉变成 **先验 `Range`（HTTP 206）**，再把同一文件的多个镜像**并行分段**拉下来，下完自动校验。

## 快速开始（零依赖）

**方式 A：pip 安装**（推荐，命令即 `gh-download`）

```bash
pip install gh-download-embedai        # 或： uv tool install gh-download-embedai / pipx install gh-download-embedai

gh-download <owner/repo> <tag> [--pattern GLOB]... [-d DIR] [--list]
```

**方式 B：单文件脚本**（只需一个 `python3`，3.8+，标准库自带，不装任何东西）

```bash
curl -fsSL https://raw.githubusercontent.com/zishuowang696/gh-download/main/gh_download.py -o gh_download.py

python3 gh_download.py <owner/repo> <tag> [--pattern GLOB]... [-d DIR] [--list]
```

两种方式逻辑完全相同。例子：

```bash
# 只下某个平台的资产
gh-download BurntSushi/ripgrep latest --pattern '*x86_64-unknown-linux-musl.tar.gz' -d ./dl

# 先看有哪些资产（不下载）
gh-download NationalSecurityAgency/ghidra latest --list

# 也可以直接给一个 GitHub 下载 URL
gh-download https://github.com/<owner>/<repo>/releases/download/<tag>/<file>
```

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `GH_DL_MIRRORS` | `https://ghproxy.net https://ghfast.top` | 空格分隔的镜像前缀，**必须支持 `Range`** |
| `GH_DL_CONN` | `8` | 每个文件的分段/并发数 |
| `GITHUB_TOKEN` | 空 | 可选；提升 API 限额 / 访问私有仓库 |

> `--mirror` 可多次指定覆盖镜像；`--conn` 覆盖分段数；`--pattern` 可重复。

## 原理（三点）

1. **只信支持 `Range`（206）的镜像**——先发一个 `Range: bytes=0-0` 探是否返回 206；
2. **同一文件按分段分给多个镜像并行拉**（`ThreadPoolExecutor` + `os.pwrite` 按偏移写入），单流慢时自动回退；
3. **sha256 自动校验**——优先用 GitHub Release 资产自带的 `digest`；没有则跳过。

## 实测

| 目标 | 大小 | 说明 |
| --- | --- | --- |
| ripgrep (musl) | 2.2 MB | 多镜像并行，sha256 校验通过 |
| **Ghidra 12.1.4 (PUBLIC)** | **543 MB** | 多镜像并行，一次下完（旧版 aria2 脚本实测 **4.7 MiB/s**） |

> 对比直连/单镜像 ~0.19 MiB/s —— 快约 20 倍。

## 其它版本（可选）

- **本地 Web UI**（`gh-download-ui.ts`，需要 [Bun](https://bun.sh)）：粘贴 `owner/repo` + tag → 列资产 → 勾选 → 下载，日志实时滚动。
  ```bash
  bun gh-download-ui.ts        # 打开 http://localhost:8787
  ```
- **旧版 bash 脚本**（`gh-download.sh`，依赖 `curl` + `aria2c`）：接口相同，逻辑等价，作为参考保留。
- **Windows PowerShell 版**（`gh-download.ps1`，依赖 `curl.exe` + `aria2c`）。

## 注意

- 第三方镜像**不可信**：能校验哈希就一定校验；
- **不要**用公共代理下敏感内容；
- 镜像质量会变：工具**先验 `Range`**，不写死。

## 支持这个项目

如果这个工具帮到了你，可以**请我喝杯咖啡**（爱发电）：

<https://afdian.com/a/embedai>

（也欢迎 Star、提 Issue、分享给需要的人。）

## 相关链接

**站点**
- 博客（Agent and Edge AI）：<https://embedai.com.cn>
- 讲解文章：<https://embedai.com.cn/posts/gh-downloader>
- 工具下载页：<https://embedai.com.cn/tools>
- 订阅：<https://embedai.com.cn/feed.xml> · <https://embedai.com.cn/en/feed.xml>

**相关仓库**（GitHub：<https://github.com/zishuowang696>）
- [embedai](https://github.com/zishuowang696/embedai) — Jetson 边缘 AI 发行版（Yocto / KAS）
- [agent-from-scratch](https://github.com/zishuowang696/agent-from-scratch) — 从 0 写一个 AI Agent
- [mcp-demo](https://github.com/zishuowang696/mcp-demo) / [mcp-client](https://github.com/zishuowang696/mcp-client) — MCP 服务端 / 客户端示例
- [agent-on-jetson](https://github.com/zishuowang696/agent-on-jetson) — 把 Agent 部署到 Jetson
- [weekly-topics-agent](https://github.com/zishuowang696/weekly-topics-agent) — 每周选题 Agent（模板）

## 许可

MIT
