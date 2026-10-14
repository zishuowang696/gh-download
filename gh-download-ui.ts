// gh-download 本地 Web UI（单文件版）
// 运行：bun gh-download-ui.ts   → 浏览器打开 http://localhost:8787
// 需要 Bun（https://bun.sh）与 aria2c。环境变量：EMBEDAI_MIRRORS / EMBEDAI_JOBS / EMBEDAI_CONN / GITHUB_TOKEN / PORT
import { mkdirSync } from 'node:fs'

const PORT = Number(process.env.PORT || 8787)
const MIRRORS = (process.env.EMBEDAI_MIRRORS || 'https://ghproxy.net https://ghfast.top').split(/\s+/).filter(Boolean)
const JOBS = process.env.EMBEDAI_JOBS || '4'
const CONN = process.env.EMBEDAI_CONN || '8'

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
  try {
    const p = Bun.spawnSync([
      'gh', 'api', `repos/${repo}/releases/tags/${tag}`,
      '--jq', '.assets[] | [.name, .browser_download_url, (.size|tostring)] | @tsv',
    ])
    if (p.exitCode === 0) {
      return p.stdout.toString().trim().split('\n').filter(Boolean).map((l) => {
        const [name, url, size] = l.split('\t')
        return { name, url, size: Number(size) || 0 }
      })
    }
  } catch { /* fall back to API */ }
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
        const first = items[0].url
        const good: string[] = []
        for (const m of MIRRORS) {
          if (await rangeOk(`${m.replace(/\/$/, '')}/${first}`)) { good.push(m); send(`镜像可用(Range): ${m}\n`) }
        }
        if (!good.length) { good.push(''); send('无支持 Range 的镜像，改用直连（不并行分段）\n') }
        const lines: string[] = []
        for (const it of items) {
          lines.push(good.map((m) => (m ? `${m.replace(/\/$/, '')}/${it.url}` : it.url)).join('\t'))
          lines.push(`  out=${it.name}`)
        }
        send(`开始下载 ${items.length} 个 → ${dir}\n\n`)
        const proc = Bun.spawn(
          ['aria2c', '-c', '-j', JOBS, '-x', CONN, '-s', CONN, '-k', '1M',
            '--file-allocation=none', '--summary-interval=20', '--console-log-level=warn', '-i', '-'],
          { cwd: dir, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        )
        proc.stdin.write(lines.join('\n') + '\n')
        await proc.stdin.end()
        const pump = async (rs: ReadableStream<Uint8Array>) => {
          const rd = rs.getReader()
          for (;;) { const { done, value } = await rd.read(); if (done) break; controller.enqueue(value) }
        }
        await Promise.all([pump(proc.stdout), pump(proc.stderr)])
        send(`\n完成（exit ${await proc.exited}）\n`)
      } catch (e) {
        send(`\n错误：${String(e)}\n`)
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' } })
}

const html = `<!doctype html>
<html lang="zh"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>gh-download · 本地下载器</title>
<style>
  :root{--bg:#0f1115;--fg:#e6e6e6;--muted:#9aa0a6;--line:#262a33;--accent:#2dd4bf;--card:#161a21}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  .wrap{max-width:900px;margin:0 auto;padding:28px 20px 60px}
  h1{font-size:1.35rem;margin:0 0 4px} h1 span{color:var(--accent)}
  .sub{color:var(--muted);margin:0 0 22px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:16px}
  label{display:block;font-size:.82rem;color:var(--muted);margin:6px 0 4px}
  input[type=text]{width:100%;padding:9px 11px;background:#0c0e12;border:1px solid var(--line);border-radius:8px;color:var(--fg);font:inherit}
  .row{display:flex;gap:12px;flex-wrap:wrap} .row>div{flex:1 1 180px}
  button{background:var(--accent);color:#04201c;border:0;border-radius:8px;padding:9px 16px;font:600 .92rem/1 inherit;cursor:pointer}
  button.ghost{background:transparent;color:var(--accent);border:1px solid var(--accent)}
  button:disabled{opacity:.5;cursor:not-allowed}
  .actions{display:flex;gap:10px;margin-top:14px;align-items:center}
  ul.assets{list-style:none;margin:8px 0 0;padding:0}
  ul.assets li{display:flex;align-items:center;gap:10px;padding:7px 4px;border-bottom:1px solid var(--line)}
  ul.assets li:last-child{border-bottom:0}
  .nm{flex:1;word-break:break-all} .sz{color:var(--muted);font-size:.8rem;white-space:nowrap}
  pre#log{background:#0a0c10;border:1px solid var(--line);border-radius:10px;padding:12px;height:280px;overflow:auto;white-space:pre-wrap;font:12px/1.45 ui-monospace,Menlo,Consolas,monospace}
  a{color:var(--accent)} .hint{color:var(--muted);font-size:.82rem}
</style></head>
<body><div class="wrap">
  <h1>gh-download <span>· 本地下载器</span></h1>
  <p class="sub">多镜像测速 + Range 校验 → aria2 多源并行 → 断点续传 →（有则）sha256。本地运行，仅下载你指定的 GitHub 资产。</p>
  <div class="card">
    <div class="row">
      <div><label>仓库（owner/repo）</label><input type="text" id="repo" placeholder="NationalSecurityAgency/ghidra"></div>
      <div><label>标签（tag）</label><input type="text" id="tag" placeholder="Ghidra_12.1.4_build"></div>
    </div>
    <label>或者：直接粘贴一个 GitHub 下载链接</label>
    <input type="text" id="url" placeholder="https://github.com/owner/repo/releases/download/tag/file.zip">
    <div class="row" style="margin-top:8px"><div><label>下载目录</label><input type="text" id="dir" value="./downloads"></div></div>
    <div class="actions"><button id="list">列出资产</button><button id="dl" class="ghost" disabled>下载选中</button><span class="hint" id="status"></span></div>
  </div>
  <div class="card"><div id="listbox">填入仓库/标签后点「列出资产」；或直接填 URL 后点「下载选中」。</div></div>
  <div class="card"><label>日志</label><pre id="log"></pre></div>
  <p class="hint">镜像/并发可用环境变量调：EMBEDAI_MIRRORS / EMBEDAI_JOBS / EMBEDAI_CONN。第三方镜像不可信，凡有 SHA256SUMS 会自动校验。</p>
</div>
<script>
var $=function(id){return document.getElementById(id)};
var assets=[];
function human(n){if(!n)return '';var u=['B','KB','MB','GB'],i=0;while(n>=1024&&i<u.length-1){n/=1024;i++}return n.toFixed(i?1:0)+u[i]}
$('list').onclick=async function(){
  var repo=$('repo').value.trim(),tag=$('tag').value.trim();
  if(!repo||!tag){$('status').textContent='请填仓库和标签（或直接填 URL）';return}
  $('status').textContent='查询中…';$('listbox').textContent='';
  try{
    var r=await fetch('/api/assets?repo='+encodeURIComponent(repo)+'&tag='+encodeURIComponent(tag));
    var j=await r.json();
    if(j.error){$('status').textContent='错误：'+j.error;return}
    assets=j;if(!assets.length){$('status').textContent='没有资产';return}
    var ul=document.createElement('ul');ul.className='assets';
    assets.forEach(function(a,i){
      var li=document.createElement('li');
      li.innerHTML='<input type="checkbox" checked data-i="'+i+'"><span class="nm"></span><span class="sz">'+human(a.size)+'</span>';
      li.querySelector('.nm').textContent=a.name;ul.appendChild(li);
    });
    $('listbox').innerHTML='';$('listbox').appendChild(ul);$('dl').disabled=false;$('status').textContent=assets.length+' 个资产';
  }catch(e){$('status').textContent='错误：'+e}
};
$('dl').onclick=async function(){
  var url=$('url').value.trim(),items=[];
  if(url){items=[{name:url.split('/').pop(),url}]}
  else{items=[].slice.call(document.querySelectorAll('#listbox input[type=checkbox]:checked')).map(function(c){return assets[+c.dataset.i]})}
  if(!items.length){$('status').textContent='没有选中项';return}
  $('log').textContent='';$('dl').disabled=true;$('status').textContent='下载中…';
  try{
    var r=await fetch('/api/download',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({items:items,dir:$('dir').value.trim()||'./downloads'})});
    var reader=r.body.getReader(),dec=new TextDecoder();
    for(;;){var x=await reader.read();if(x.done)break;$('log').textContent+=dec.decode(x.value,{stream:true});$('log').scrollTop=$('log').scrollHeight}
    $('status').textContent='完成';
  }catch(e){$('status').textContent='错误：'+e}
  $('dl').disabled=false;
};
</script>
</body></html>`

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
      try { return Response.json(await listAssets(repo, tag)) } catch (e) { return Response.json({ error: String(e) }, { status: 400 }) }
    }
    if (u.pathname === '/api/download' && req.method === 'POST') {
      const body = (await req.json().catch(() => null)) as { items?: Item[]; dir?: string } | null
      if (!body || !Array.isArray(body.items) || body.items.length === 0) return new Response('bad request', { status: 400 })
      return streamDownload(body.items, body.dir || './downloads')
    }
    return new Response('not found', { status: 404 })
  },
})

console.log(`gh-download UI → http://localhost:${PORT}`)
