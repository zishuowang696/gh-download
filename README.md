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

## 许可

MIT

---

讲解文章：<https://embedai.com.cn/posts/gh-downloader>
