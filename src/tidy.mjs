/**
 * 整理流水线的核心逻辑：扫描 → 计划 → 改名 → 清理。
 * 每个阶段都是独立的 async 函数，通过回调报告进度，可被 shouldStop() 中断。
 */
import { extname } from 'node:path'

export const IMG_EXT = new Set(['.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif', '.avif', '.tif', '.tiff'])
export const VID_EXT = new Set(['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.ts', '.m4v', '.rmvb', '.rm', '.webm', '.mpg', '.mpeg', '.3gp', '.iso'])

export const kindOf = (name) => {
  const e = extname(name).toLowerCase()
  return IMG_EXT.has(e) ? 'img' : VID_EXT.has(e) ? 'vid' : 'other'
}

const tokens = (s) => s.match(/(\d+)|(\D+)/g) || []
/** 自然排序：(2) 排在 (10) 之前，否则按中文/英文本地顺序。 */
export function natcmp(a, b) {
  const ax = tokens(a), bx = tokens(b)
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const x = ax[i], y = bx[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d/.test(x), ny = /^\d/.test(y)
    if (nx && ny) { const d = parseInt(x, 10) - parseInt(y, 10); if (d) return d }
    else { const d = x.localeCompare(y, 'zh'); if (d) return d }
  }
  return 0
}

/**
 * 递归扫描目标目录（不限层数）。
 * 读操作，风险极低；CD2 自带目录缓存，所以 forceRefresh 保持 false。
 */
export async function scan(client, root, { conc = 4, onProgress, shouldStop } = {}) {
  const dirs = [], files = [], errors = []
  const queue = [{ path: root, depth: 0 }]
  let inflight = 0, done = 0

  async function handle(job) {
    let items
    try { items = await client.list(job.path) }
    catch (e) { errors.push({ path: job.path, error: e.message }); return }
    const rec = { dir: job.path, depth: job.depth, img: 0, vid: 0, other: 0, subs: 0 }
    const subs = []
    for (const f of items) {
      if (f.fileType === 'Directory') { rec.subs++; subs.push({ path: f.fullPathName, depth: job.depth + 1 }); continue }
      const k = kindOf(f.name)
      rec[k]++
      files.push({
        p: f.fullPathName, n: f.name, s: f.size || 0,
        e: extname(f.name).toLowerCase(), k, t: f.writeTime?.seconds ?? null,
      })
    }
    dirs.push(rec)
    queue.push(...subs)
    done++
    onProgress?.({ dirs: done, files: files.length, current: job.path })
  }

  async function worker() {
    for (;;) {
      if (shouldStop?.()) return
      const job = queue.shift()
      if (!job) {
        if (inflight === 0) return
        await new Promise((r) => setTimeout(r, 20))
        continue
      }
      inflight++
      try { await handle(job) } finally { inflight-- }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, conc) }, worker))
  return { root, dirs, files, errors, scannedAt: new Date().toISOString() }
}

/**
 * 生成改名计划：每个「含图片的目录」各自从 0001 起编号，保留目录结构。
 * 排序用自然序，保证 (2) 不会排到 (10) 后面。
 */
export function buildPlan({ files }, { pad = 4 } = {}) {
  const byDir = new Map()
  for (const f of files) {
    const d = f.p.slice(0, f.p.lastIndexOf('/'))
    if (!byDir.has(d)) byDir.set(d, [])
    byDir.get(d).push(f)
  }
  const units = []
  for (const [dir, items] of [...byDir].sort((a, b) => a[0].localeCompare(b[0]))) {
    const imgs = items.filter((f) => f.k === 'img')
    if (!imgs.length) continue
    imgs.sort((a, b) => natcmp(a.n, b.n))
    const w = Math.max(pad, String(imgs.length).length)
    units.push({
      dir,
      count: imgs.length,
      width: w,
      items: imgs.map((f, i) => ({ src: f.p, from: f.n, to: String(i + 1).padStart(w, '0') + f.e })),
    })
  }
  return units
}

/**
 * 执行改名。
 *
 * 幂等设计：对每个单元先列目录，逐个文件判断它「现在实际叫什么」——
 * 可能是原始名、旧的 3 位名(001.jpg)，或已达标的 4 位名(0001.jpg)。
 * 因此改到一半被中止、或中途改过编号位数，都能正确续跑。
 */
export async function rename(client, units, { onProgress, shouldStop } = {}) {
  const acc = { units: 0, unitsTotal: units.length, renamed: 0, skipped: 0, failed: 0, batchFallback: 0, throttleHits: 0 }
  const errors = []
  const THROTTLE = /频繁|频率|过快|稍后|too many|rate.?limit|frequent|throttl|retry/i

  for (const u of units) {
    if (shouldStop?.()) break
    let cur
    try { cur = await client.list(u.dir) }
    catch (e) { acc.failed++; errors.push({ dir: u.dir, error: e.message }); acc.units++; continue }

    const names = new Set(cur.map((f) => f.name))
    const todo = []
    for (let i = 0; i < u.items.length; i++) {
      const it = u.items[i]
      const m = it.to.match(/^(\d+)(\.[^.]+)$/)
      if (!m) continue
      const n = parseInt(m[1], 10), ext = m[2]
      const to3 = String(n).padStart(3, '0') + ext
      let from = null
      if (names.has(it.from)) from = it.from           // 尚未改名
      else if (names.has(to3)) from = to3              // 已按 3 位方案改过
      if (!from || from === it.to) continue             // 已达标或定位不到
      todo.push({ src: u.dir + '/' + from, from, to: it.to })
    }
    acc.skipped += u.items.length - todo.length

    if (!todo.length) { acc.units++; onProgress?.({ ...acc, unit: u.dir }); continue }

    try {
      const r = await client.renameMany(todo)
      if (!r.success) throw new Error(r.errorMessage || 'success=false')
      acc.renamed += todo.length
    } catch (e) {
      // 批量整体失败时回退逐个，以便定位到底哪个文件出问题
      acc.batchFallback++
      if (THROTTLE.test(e.message)) acc.throttleHits++
      for (const it of todo) {
        try { await client.renameOne(it.src, it.to); acc.renamed++ }
        catch (e2) {
          acc.failed++
          if (THROTTLE.test(e2.message)) acc.throttleHits++
          errors.push({ dir: u.dir, from: it.from, error: e2.message })
        }
      }
    }
    acc.units++
    onProgress?.({ ...acc, unit: u.dir })
  }
  return { ...acc, errors }
}

/**
 * 去掉目录名里的广告前缀（如 www.98T.la@）。
 *
 * 只列每个目标目录的**直接父目录**，不递归 —— 目录改名影响整棵子树，
 * 目标名被占用时直接跳过而不是覆盖。返回成功改名的数量。
 */
export async function stripDirPrefix(client, { dirs }, pattern) {
  if (!pattern) return 0
  const rx = new RegExp(pattern, 'i')
  const byParent = new Map()
  for (const d of dirs) {
    const i = d.dir.lastIndexOf('/')
    const parent = d.dir.slice(0, i), name = d.dir.slice(i + 1)
    if (!rx.test(name)) continue
    const newName = name.replace(rx, '').trim()
    if (!newName || newName === name) continue
    if (!byParent.has(parent)) byParent.set(parent, [])
    byParent.get(parent).push({ parent, name, newName, full: d.dir })
  }

  let done = 0
  for (const [parent, items] of byParent) {
    let kids
    try { kids = await client.list(parent) } catch { continue }
    const existing = new Set(kids.map((k) => k.name))
    const todo = []
    for (const it of items) {
      if (!existing.has(it.name)) continue        // 源已不在
      if (existing.has(it.newName)) continue      // 目标名被占用，跳过
      todo.push(it)
      existing.delete(it.name)
      existing.add(it.newName)
    }
    if (!todo.length) continue
    try {
      const r = await client.renameMany(todo.map((it) => ({ src: it.full, to: it.newName })))
      if (!r.success) throw new Error(r.errorMessage || 'success=false')
      done += todo.length
    } catch {
      for (const it of todo) {
        try { await client.renameOne(it.full, it.newName); done++ } catch { /* 单个失败忽略 */ }
      }
    }
  }
  return done
}

/** 计算待删的非图片文件，以及删完后会变空的目录（自底向上传播）。 */
export function planClean({ dirs, files }) {
  const victims = files.filter((f) => f.k !== 'img')
  const children = new Map()
  for (const d of dirs) {
    const p = d.dir.slice(0, d.dir.lastIndexOf('/'))
    if (!children.has(p)) children.set(p, [])
    children.get(p).push(d.dir)
  }
  const dead = new Set()
  for (const d of [...dirs].sort((a, b) => b.depth - a.depth)) {
    const alive = (children.get(d.dir) || []).filter((k) => !dead.has(k)).length
    if (d.img === 0 && alive === 0) dead.add(d.dir)
  }
  return {
    victims,
    deadDirs: [...dead].sort((a, b) => b.split('/').length - a.split('/').length),
    bytes: victims.reduce((a, v) => a + v.s, 0),
  }
}

/**
 * 执行清理：先删非图片文件，再删变空的目录。
 * 115 不支持永久删除（DeleteFilesPermanently 仅阿里云盘可用），所以文件进回收站，30 天内可捞。
 */
export async function clean(client, { victims, deadDirs }, { batch = 20, onProgress, shouldStop } = {}) {
  const acc = { filesDeleted: 0, filesFailed: 0, dirsDeleted: 0, dirsFailed: 0, bytes: 0 }
  const THROTTLE = /频繁|频率|过快|稍后|too many|rate.?limit|frequent|throttl|retry/i
  const errors = []

  for (let i = 0; i < victims.length; i += batch) {
    if (shouldStop?.()) return { ...acc, errors }
    const chunk = victims.slice(i, i + batch)
    try {
      const r = await client.deleteMany(chunk.map((v) => v.p))
      if (!r.success) throw new Error(r.errorMessage || 'success=false')
      acc.filesDeleted += chunk.length
      acc.bytes += chunk.reduce((a, v) => a + v.s, 0)
    } catch (e) {
      for (const v of chunk) {
        try { await client.deleteOne(v.p); acc.filesDeleted++; acc.bytes += v.s }
        catch (e2) {
          acc.filesFailed++
          errors.push({ path: v.p, error: e2.message, throttle: THROTTLE.test(e2.message) })
        }
      }
    }
    onProgress?.({ ...acc })
  }

  for (const d of deadDirs) {
    if (shouldStop?.()) return { ...acc, errors }
    try {
      const kids = await client.list(d)
      if (kids.length) continue                    // 已经有内容了，别删
      await client.deleteOne(d)
      acc.dirsDeleted++
    } catch (e) {
      acc.dirsFailed++
      errors.push({ path: d, error: e.message, throttle: THROTTLE.test(e.message) })
    }
    onProgress?.({ ...acc })
  }
  return { ...acc, errors }
}
