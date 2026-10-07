/**
 * 作业运行器 + 状态存储。
 * 常驻服务里同一时刻只跑一个作业，进度与日志留在内存供 UI 轮询；
 * 扫描结果/计划落盘，容器重启后还能看到上次的计划。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { scan, buildPlan, rename, planClean, clean, stripDirPrefix } from './tidy.mjs'

export function createStore(dir) {
  mkdirSync(dir, { recursive: true })
  const p = (n) => join(dir, n)
  return {
    read: (n, fallback = null) => { try { return JSON.parse(readFileSync(p(n), 'utf8')) } catch { return fallback } },
    write: (n, v) => writeFileSync(p(n), JSON.stringify(v)),
  }
}

export function createRunner({ getClient, store, cfg = {}, logLimit = 300 }) {
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

    /**
     * 自动整理（由定时器驱动）：扫描 → 目录去前缀 → 生成计划 → **自动改名** → 标记待删。
     *
     * 为什么自动改名却不自动删除：改名是幂等的（已达标的目标名会被算成 from === to 而跳过），
     * 重复跑、中断重跑都安全；而删除不可逆，必须留给人点确认。
     */
    autoTidy() {
      if (busy()) { push('已有作业在跑，本次自动整理跳过'); return null }
      return run('自动整理', async () => {
        const client = await getClient()
        const t0 = Date.now()

        let s = await scan(client, cfg.root, {
          conc: cfg.conc,
          shouldStop: () => stop,
          onProgress: (p) => { job.progress = { phase: '自动·扫描', ...p } },
        })
        push(`扫描：${s.dirs.length} 目录 / ${s.files.length} 文件`)

        // 新放进来的文件夹往往也带广告前缀，顺手去掉
        const fixed = await stripDirPrefix(client, s, cfg.prefixStrip)
        if (fixed) {
          push(`目录去前缀：${fixed} 个，重新扫描…`)
          s = await scan(client, cfg.root, {
            conc: cfg.conc,
            shouldStop: () => stop,
            onProgress: (p) => { job.progress = { phase: '自动·重扫', ...p } },
          })
        }
        store.write('scan.json', s)

        const units = buildPlan(s, { pad: cfg.pad })
        const cp = planClean(s)
        store.write('plan.json', { units, pad: cfg.pad, builtAt: new Date().toISOString() })
        store.write('cleanplan.json', cp)

        const need = units.filter((u) => u.items.some((i) => i.from !== i.to)).length
        let renamed = 0, failed = 0
        if (need) {
          push(`发现 ${need} 个单元需改名，自动执行…`)
          const r = await rename(client, units, {
            shouldStop: () => stop,
            onProgress: (x) => { job.progress = { phase: '自动·改名', ...x } },
          })
          renamed = r.renamed
          failed = r.failed
          push(`改名：成功 ${r.renamed} / 跳过 ${r.skipped} / 失败 ${r.failed}`)
          if (r.throttleHits) push(`⛔ 命中疑似风控 ${r.throttleHits} 次，建议调大 WATCH_INTERVAL`)
        } else {
          push('没有需要改名的图片')
        }

        const pending = cp.victims.length + cp.deadDirs.length
        if (pending) {
          push(`⚠ 待确认删除：${cp.victims.length} 个非图片文件（${(cp.bytes / 1073741824).toFixed(2)} GB）+ ${cp.deadDirs.length} 个空目录 —— 到界面点「删除」才会执行`)
        } else {
          push('没有需要清理的东西')
        }

        return {
          prefixFixed: fixed, units: units.length, renamed, failed,
          pendingClean: pending, seconds: Math.round((Date.now() - t0) / 1000),
        }
      })
    },
  }
}
