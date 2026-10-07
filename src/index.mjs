/**
 * 常驻 Web 服务入口。
 * 零额外依赖：用 node:http 做 API + 静态文件，避免为几个路由引入 express。
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname } from 'node:path'
import { createClient } from './cd2.mjs'
import { createRunner, createStore } from './jobs.mjs'

const WEB = join(dirname(fileURLToPath(import.meta.url)), 'web')

const cfg = {
  port: Number(process.env.PORT || 8080),
  cd2Url: process.env.CD2_URL || '127.0.0.1:19798',
  cd2Token: process.env.CD2_TOKEN || '',
  root: process.env.ROOT_PATH || '/115/4',
  pad: Number(process.env.PAD || 4),
  conc: Number(process.env.SCAN_CONC || 4),
  dataDir: process.env.DATA_DIR || '/data',
}

const store = createStore(cfg.dataDir)
let cachedClient = null
async function getClient() {
  if (!cfg.cd2Token) throw new Error('未配置 CD2_TOKEN 环境变量')
  if (!cachedClient) cachedClient = await createClient({ serverUrl: cfg.cd2Url, token: cfg.cd2Token })
  return cachedClient
}

const runner = createRunner({ getClient, store })

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
}

const json = (res, code, obj) => {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

const readBody = (req) => new Promise((resolve) => {
  let s = ''
  req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy() })
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}) } catch { resolve({}) } })
})

/** 只读探测：确认 CD2 可达，并读出 115 的 QPS 上限（这决定整体速度）。 */
async function probe() {
  try {
    const client = await getClient()
    const apis = await client.allCloudApis()
    const out = []
    for (const a of apis.apis || []) {
      let qps = null
      try { qps = (await client.cloudApiConfig(a.name, a.userName)).maxQueriesPerSecond } catch { /* 忽略 */ }
      out.push({ name: a.name, userName: a.userName, path: a.path, qps, supportQpsLimit: a.supportQpsLimit })
    }
    return { ok: true, apis: out }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const path = url.pathname

  try {
    // ---------- API ----------
    if (path.startsWith('/api/')) {
      if (path === '/api/config' && req.method === 'GET') {
        // 绝不回传 token
        return json(res, 200, { cd2Url: cfg.cd2Url, root: cfg.root, pad: cfg.pad, conc: cfg.conc, hasToken: !!cfg.cd2Token })
      }
      if (path === '/api/probe') {
        return json(res, 200, await probe())
      }
      if (path === '/api/job') {
        return json(res, 200, { job: runner.getJob(), busy: runner.busy() })
      }
      if (path === '/api/log') {
        return json(res, 200, { log: runner.logs() })
      }
      if (path === '/api/scan-summary') {
        const s = store.read('scan.json')
        if (!s) return json(res, 200, { exists: false })
        const byDepth = {}
        for (const d of s.dirs) byDepth[d.depth] = (byDepth[d.depth] || 0) + 1
        return json(res, 200, {
          exists: true, root: s.root, scannedAt: s.scannedAt,
          dirs: s.dirs.length, files: s.files.length, errors: s.errors.length,
          photos: s.files.filter((f) => f.k === 'img').length,
          videos: s.files.filter((f) => f.k === 'vid').length,
          others: s.files.filter((f) => f.k === 'other').length,
          byDepth,
          topLevels: topLevels(s),
        })
      }
      if (path === '/api/plan-summary') {
        const p = store.read('plan.json')
        const cp = store.read('cleanplan.json')
        if (!p) return json(res, 200, { exists: false })
        return json(res, 200, {
          exists: true, builtAt: p.builtAt, pad: p.pad,
          units: p.units.length,
          photos: p.units.reduce((a, u) => a + u.count, 0),
          sample: p.units.slice(0, 30).map((u) => ({
            dir: u.dir, count: u.count,
            first: u.items[0] && { from: u.items[0].from, to: u.items[0].to },
            last: u.items.at(-1) && { from: u.items.at(-1).from, to: u.items.at(-1).to },
          })),
          clean: cp && { victims: cp.victims.length, deadDirs: cp.deadDirs.length, bytes: cp.bytes, deadList: cp.deadDirs.slice(0, 30), topVictims: cp.victims.slice(0, 20) },
        })
      }
      if (path === '/api/stop' && req.method === 'POST') {
        runner.stop()
        return json(res, 200, { ok: true })
      }

      if (req.method === 'POST') {
        const body = await readBody(req)
        if (path === '/api/scan') return json(res, 202, runner.runScan(body.root || cfg.root, body.conc || cfg.conc))
        if (path === '/api/plan') return json(res, 202, runner.runPlan(body.pad || cfg.pad))
        if (path === '/api/rename') return json(res, 202, runner.runRename())
        if (path === '/api/clean') return json(res, 202, runner.runClean())
      }
      return json(res, 404, { error: 'no such api' })
    }

    // ---------- 静态文件 ----------
    const file = path === '/' ? 'index.html' : path.replace(/^\/+/, '')
    if (file.includes('..')) { res.writeHead(400); return res.end('bad path') }
    const buf = await readFile(join(WEB, file))
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' })
    res.end(buf)
  } catch (e) {
    if (path.startsWith('/api/')) return json(res, 500, { error: e.message })
    res.writeHead(404)
    res.end('not found')
  }
})

/** 一级子目录汇总 —— 用户靠这张表圈定处理范围。 */
function topLevels(s) {
  const acc = new Map()
  for (const d of s.dirs) {
    const rel = d.dir.slice(s.root.length).replace(/^\/+/, '')
    const key = rel ? rel.split('/')[0] : '(根目录)'
    const o = acc.get(key) || { name: key, dirs: 0, img: 0, vid: 0, other: 0, maxDepth: 0 }
    o.dirs++; o.img += d.img; o.vid += d.vid; o.other += d.other
    o.maxDepth = Math.max(o.maxDepth, d.depth)
    acc.set(key, o)
  }
  return [...acc.values()].sort((a, b) => b.img - a.img || b.vid - a.vid)
}

server.listen(cfg.port, () => {
  console.log(`cd2-115-tidy 已启动`)
  console.log(`  Web UI   http://0.0.0.0:${cfg.port}`)
  console.log(`  CD2      ${cfg.cd2Url}${cfg.cd2Token ? '' : '  ⚠ 未设置 CD2_TOKEN'}`)
  console.log(`  目标目录 ${cfg.root}   编号 ${cfg.pad} 位   数据目录 ${cfg.dataDir}`)
})
