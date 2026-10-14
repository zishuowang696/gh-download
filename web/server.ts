// gh-download 本地 Web UI
// 运行：bun web/server.ts   → 打开 http://localhost:8787
// 功能：粘贴 repo/tag 或 GitHub 下载链接 → 列出资产 → 勾选 → 后台 aria2（多镜像并行）下载 + 实时进度。
//
// 环境变量：EMBEDAI_MIRRORS / EMBEDAI_JOBS / EMBEDAI_CONN / GITHUB_TOKEN(可选) / PORT
import { mkdirSync } from 'node:fs'

const PORT = Number(process.env.PORT || 8787)
const MIRRORS = (process.env.EMBEDAI_MIRRORS || 'https://ghproxy.net https://ghfast.top').split(/\s+/).filter(Boolean)
const JOBS = process.env.EMBEDAI_JOBS || '4'
const CONN = process.env.EMBEDAI_CONN || '8'

const html = await Bun.file(new URL('./index.html', import.meta.url)).text()

interface Item { name: string; url: string; size?: number }

async function rangeOk(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-0' } })
    return r.status === 206
  } catch {
    return false
  }
}

async function listAssets(repo: string, tag: string): Promise<Item[]> {
  // 优先用已登录的 gh（避免匿名 API 限流）；否则公开 API
  try {
    const p = Bun.spawnSync([
      'gh', 'api', `repos/${repo}/releases/tags/${tag}`,
      '--jq', '.assets[] | [.name, .browser_download_url, (.size|tostring)] | @tsv',
    ])
    if (p.exitCode === 0) {
      return p.stdout
        .toString()
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [name, url, size] = l.split('\t')
          return { name, url, size: Number(size) || 0 }
        })
    }
  } catch {
    /* ignore, fall back to API */
  }
  const headers: Record<string, string> = { 'User-Agent': 'gh-download-ui' }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const r = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { headers })
  if (!r.ok) throw new Error(`GitHub API ${r.status}`)
  const j = (await r.json()) as { assets?: { name: string; browser_download_url: string; size: number }[] }
  return (j.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }))
}

function streamDownload(items: Item[], dir: string): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => controller.enqueue(enc.encode(s))
      try {
        mkdirSync(dir, { recursive: true })

        // 1) 镜像 Range 校验（用第一个资产探测）
        const first = items[0].url
        const good: string[] = []
        for (const m of MIRRORS) {
          if (await rangeOk(`${m.replace(/\/$/, '')}/${first}`)) {
            good.push(m)
            send(`镜像可用(Range): ${m}\n`)
          }
        }
        if (!good.length) {
          good.push('')
          send('无支持 Range 的镜像，改用直连（不并行分段）\n')
        }

        // 2) 组装 aria2 输入（同文件多镜像放同一行、TAB 分隔）
        const lines: string[] = []
        for (const it of items) {
          const uris = good.map((m) => (m ? `${m.replace(/\/$/, '')}/${it.url}` : it.url))
          lines.push(uris.join('\t'))
          lines.push(`  out=${it.name}`)
        }
        send(`开始下载 ${items.length} 个 → ${dir}\n\n`)

        // 3) aria2c 下载，流式回传日志
        const proc = Bun.spawn(
          ['aria2c', '-c', '-j', JOBS, '-x', CONN, '-s', CONN, '-k', '1M',
            '--file-allocation=none', '--summary-interval=20', '--console-log-level=warn', '-i', '-'],
          { cwd: dir, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        )
        proc.stdin.write(lines.join('\n') + '\n')
        await proc.stdin.end()

        const pump = async (rs: ReadableStream<Uint8Array>) => {
          const rd = rs.getReader()
          for (;;) {
            const { done, value } = await rd.read()
            if (done) break
            controller.enqueue(value)
          }
        }
        await Promise.all([pump(proc.stdout), pump(proc.stderr)])
        const code = await proc.exited
        send(`\n完成（exit ${code}）\n`)
      } catch (e) {
        send(`\n错误：${String(e)}\n`)
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' } })
}

Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    const u = new URL(req.url)
    if (u.pathname === '/') return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    if (u.pathname === '/api/assets') {
      const repo = u.searchParams.get('repo') || ''
      const tag = u.searchParams.get('tag') || ''
      if (!repo || !tag) return Response.json({ error: 'need repo & tag' }, { status: 400 })
      try {
        return Response.json(await listAssets(repo, tag))
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 400 })
      }
    }
    if (u.pathname === '/api/download' && req.method === 'POST') {
      const body = (await req.json().catch(() => null)) as { items?: Item[]; dir?: string } | null
      if (!body || !Array.isArray(body.items) || body.items.length === 0) {
        return new Response('bad request', { status: 400 })
      }
      return streamDownload(body.items, body.dir || './downloads')
    }
    return new Response('not found', { status: 404 })
  },
})

console.log(`gh-download UI → http://localhost:${PORT}`)
