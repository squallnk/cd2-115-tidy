/**
 * 作业运行器 + 状态存储。
 * 常驻服务里同一时刻只跑一个作业，进度与日志留在内存供 UI 轮询；
 * 扫描结果/计划落盘，容器重启后还能看到上次的计划。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { scan, buildPlan, rename, planClean, clean } from './tidy.mjs'

export function createStore(dir) {
  mkdirSync(dir, { recursive: true })
  const p = (n) => join(dir, n)
  return {
    read: (n, fallback = null) => { try { return JSON.parse(readFileSync(p(n), 'utf8')) } catch { return fallback } },
    write: (n, v) => writeFileSync(p(n), JSON.stringify(v)),
  }
}

export function createRunner({ getClient, store, logLimit = 300 }) {
  let job = { type: null, status: 'idle', startedAt: null, finishedAt: null, progress: null, error: null, result: null }
  let stop = false
  const logs = []
  const push = (msg) => {
    logs.push({ t: Date.now(), msg: String(msg) })
    if (logs.length > logLimit) logs.shift()
  }

  const busy = () => job.status === 'running'

  function run(type, fn) {
    if (busy()) throw new Error(`已有作业在运行：${job.type}`)
    stop = false
    job = { type, status: 'running', startedAt: Date.now(), finishedAt: null, progress: null, error: null, result: null }
    push(`▶ 开始 ${type}`)
    // 故意不 await：作业在后台跑，UI 通过 GET /api/job 轮询进度
    fn()
      .then((result) => { job.status = 'done'; job.finishedAt = Date.now(); job.result = result; push(`✅ ${type} 完成`) })
      .catch((e) => { job.status = 'error'; job.finishedAt = Date.now(); job.error = e.message; push(`❌ ${type} 失败：${e.message}`) })
    return { type, status: job.status }
  }

  return {
    getJob: () => ({ ...job, log: logs.slice(-60) }),
    logs: () => logs,
    busy,
    stop() { stop = true; push('⏹ 已请求中止，将在当前文件处理完后停下') },

    runScan(root, conc = 4) {
      return run('scan', async () => {
        const client = await getClient()
        const t0 = Date.now()
        const res = await scan(client, root, {
          conc,
          shouldStop: () => stop,
          onProgress: (p) => { job.progress = { phase: '扫描目录', ...p } },
        })
        store.write('scan.json', res)
        push(`扫描：${res.dirs.length} 目录 / ${res.files.length} 文件，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`)
        return {
          dirs: res.dirs.length, files: res.files.length, errors: res.errors.length,
          photos: res.files.filter((f) => f.k === 'img').length,
          videos: res.files.filter((f) => f.k === 'vid').length,
          others: res.files.filter((f) => f.k === 'other').length,
        }
      })
    },

    runPlan(pad = 4) {
      return run('plan', async () => {
        const s = store.read('scan.json')
        if (!s) throw new Error('还没有扫描结果，请先执行扫描')
        const units = buildPlan(s, { pad })
        const cp = planClean(s)
        store.write('plan.json', { units, pad, builtAt: new Date().toISOString() })
        store.write('cleanplan.json', cp)
        const photos = units.reduce((a, u) => a + u.count, 0)
        push(`计划：${units.length} 个单元 / ${photos} 张图，编号 ${pad} 位`)
        push(`清理：${cp.victims.length} 个非图片文件（${(cp.bytes / 1073741824).toFixed(2)} GB）/ ${cp.deadDirs.length} 个空目录`)
        return { units: units.length, photos, victims: cp.victims.length, deadDirs: cp.deadDirs.length, bytes: cp.bytes }
      })
    },

    runRename() {
      return run('rename', async () => {
        const p = store.read('plan.json')
        if (!p) throw new Error('还没有改名计划，请先扫描并生成计划')
        const client = await getClient()
        const res = await rename(client, p.units, {
          shouldStop: () => stop,
          onProgress: (x) => { job.progress = { phase: '改名', ...x } },
        })
        push(`改名：成功 ${res.renamed} / 跳过 ${res.skipped} / 失败 ${res.failed}`)
        if (res.throttleHits) push(`⛔ 命中疑似风控关键词 ${res.throttleHits} 次，建议降低并发后再试`)
        return res
      })
    },

    runClean() {
      return run('clean', async () => {
        const cp = store.read('cleanplan.json')
        if (!cp) throw new Error('还没有清理计划，请先扫描并生成计划')
        const client = await getClient()
        const res = await clean(client, cp, {
          shouldStop: () => stop,
          onProgress: (x) => { job.progress = { phase: '清理', ...x } },
        })
        push(`清理：删除文件 ${res.filesDeleted} / 空目录 ${res.dirsDeleted}`)
        return res
      })
    },
  }
}
