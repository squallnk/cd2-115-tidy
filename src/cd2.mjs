/**
 * CloudDrive2 gRPC 客户端。
 * 只负责协议层：连接、鉴权 metadata、错误规范化 —— 业务逻辑在 tidy.mjs。
 */
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PROTO_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'protos', 'clouddrive.proto')

// 单个 RPC 的上限。RenameFiles 在 CD2 内部是逐个下发给云端的（实测约 1 文件/秒），
// 大目录可能跑十几分钟，所以留足余量。
const DEFAULT_DEADLINE_MS = 30 * 60 * 1000

const wrap = (name, e) => {
  const err = new Error(`${name}: ${e?.details || e?.message || String(e)}`)
  err.code = e?.code
  return err
}

export async function createClient({ serverUrl, token, deadlineMs = DEFAULT_DEADLINE_MS }) {
  const def = await protoLoader.load(PROTO_PATH, {
    keepCase: false, longs: Number, enums: String, defaults: true, oneofs: true,
  })
  const pkg = grpc.loadPackageDefinition(def)
  const srv = new pkg.clouddrive.CloudDriveFileSrv(serverUrl, grpc.credentials.createInsecure())
  const meta = new grpc.Metadata()
  meta.set('authorization', 'Bearer ' + token)

  const unary = (name, msg) => new Promise((resolve, reject) => {
    srv[name].call(srv, msg, meta, { deadline: Date.now() + deadlineMs },
      (e, r) => (e ? reject(wrap(name, e)) : resolve(r)))
  })

  // GetSubFiles 是服务端流，这里聚合全部 chunk
  const list = (path) => new Promise((resolve, reject) => {
    const out = []
    const call = srv.GetSubFiles({ path, forceRefresh: false }, meta)
    call.on('data', (d) => out.push(...(d.subFiles ?? [])))
    call.on('error', (e) => reject(wrap('GetSubFiles', e)))
    call.on('end', () => resolve(out))
  })

  return {
    list,
    renameMany: (items) => unary('RenameFiles', {
      renameFiles: items.map((i) => ({ theFilePath: i.src, newName: i.to })),
    }),
    renameOne: (src, newName) => unary('RenameFile', { theFilePath: src, newName }),
    deleteMany: (paths) => unary('DeleteFiles', { path: paths }),
    deleteOne: (path) => unary('DeleteFile', { path }),
    allCloudApis: () => unary('GetAllCloudApis', {}),
    cloudApiConfig: (cloudName, userName) =>
      unary('GetCloudAPIConfig', { cloudName, userName: userName || '' }),
    close: () => srv.close(),
  }
}
