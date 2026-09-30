# 加密便笺工作台（secure-notes-workbench）

纯前端的加密便笺应用：**所有数据只保存在当前浏览器的 IndexedDB 中**，服务器（nginx）仅分发静态文件，不接触任何用户数据。最多管理 **100 条**便笺。

## 安全设计

```
口令（仅内存，绝不落盘）
  └─ PBKDF2-SHA256（随机盐，250 000 次迭代）─▶ KEK（仅内存，不可导出）
        └─ AES-GCM wrap ─▶ 数据密钥 DK（首次创建时随机生成的 AES-GCM-256 密钥）
              └─ 每条便笺：DK + 独立随机 IV(96bit) 的 AES-GCM 加密 ─▶ IndexedDB
```

- **数据密钥封装**：首次创建时生成随机数据密钥，用口令派生的 KEK 经 `wrapKey` 封装后，与 KDF 盐/迭代次数一起存入 IndexedDB 的 `meta` 表。
- **逐条加密**：每条便笺使用全新的随机 IV 做 AES-GCM 加密，GCM 认证标签同时保证机密性与完整性——密文或 IV 被篡改时解密必然失败。
- **明文与口令不持久化**：IndexedDB 里只有密文、IV、修订号、时间戳和封装后的密钥；明文与口令只存在于内存/DOM，锁定即销毁。
- **改口令 = 重新封装**：修改口令时用新盐派生新 KEK，对同一个数据密钥重新封装，单次原子 `put` 写回；**便笺密文一个字节都不动**。写入中途失败（掉电/配额/异常）时事务回滚，旧封装保持原样，旧口令依然有效。
- **失败不改旧数据**：错误口令、存储失败（如配额耗尽）都不会改动任何已存记录——所有「检查 + 写入」都在单个 IndexedDB 事务内完成，失败即整体回滚。
- **跨标签页乐观锁**：每条记录带 `revision` 修订号，保存在事务内比对「读取时的修订号」，不一致即中止提交，后写的一方收到冲突提示并被要求**重新载入**，先写的内容不会被覆盖（IndexedDB 事务在同一 origin 内串行，两个标签页同样成立）。
- **锁定即撤明文**：点「锁定」或任一标签页锁定时，通过 `BroadcastChannel` 广播，所有标签页立即销毁内存中的数据密钥、明文缓存与 DOM 中的明文，回到解锁页。

## 数据布局（IndexedDB：`secure-notes-workbench`）

| Object Store | 内容 |
| --- | --- |
| `meta` | `wrappedDataKey`：PBKDF2 盐与迭代次数、封装 IV、封装后的数据密钥 |
| `notes` | `{ id, iv, ciphertext, revision, updatedAt }`，上限 100 条 |

## 运行

### Docker（推荐）

```bash
docker compose up --build app   # http://localhost:8080
```

### 本地开发

```bash
npm ci
npm run dev                     # Vite 开发服务器
npm run build                   # 产出 dist/
```

## 测试

测试基于 Vitest + fake-indexeddb（Node 内置 WebCrypto），覆盖：

| 场景 | 文件 |
| --- | --- |
| 解锁 / 错误口令不改旧数据 / 明文口令不落盘 / 锁定广播 | `tests/unlock.test.ts` |
| 加密原语（随机 IV、错误口令解封失败、篡改检测） | `tests/crypto.test.ts` |
| 篡改密文 / IV → 完整性校验失败，其它便笺不受影响 | `tests/tamper.test.ts` |
| 改口令：密文逐字节不变；写入中断 → 旧口令仍有效 | `tests/passphrase.test.ts` |
| 100 条容量上限；存储失败回滚、旧数据不变 | `tests/capacity.test.ts` |
| 跨标签页修订号冲突：后写被拦、提示重新载入 | `tests/conflict.test.ts` |

```bash
npm test            # 仅测试
npm run verify      # 类型检查 + 测试 + 生产构建
```

## 验收

```bash
docker compose config --quiet
docker compose build
docker compose run --rm verify
```

`verify` 是一次性服务：依次执行 `tsc --noEmit`、`vitest run`、`vite build`，全部通过则以 0 退出。

## 目录结构

```
src/
  crypto.ts    WebCrypto 原语：PBKDF2 派生、密钥封装/解封、AES-GCM 加解密
  db.ts        IndexedDB 访问层：单事务「检查+写入」，失败整体回滚
  store.ts     业务层：加解密 + 100 条上限 + 修订号乐观锁
  session.ts   会话：解锁/锁定/改口令，锁定广播，内存密钥销毁
  lockbus.ts   BroadcastChannel 锁定广播（含测试用进程内实现）
  ui.ts        纯 DOM 界面：锁定页 / 列表 / 编辑器 / 冲突与篡改提示
  main.ts      入口
tests/         Vitest 测试（fake-indexeddb）
Dockerfile     多阶段：verify（一次性验收）/ app（nginx 静态托管）
docker-compose.yml
```

## 限制与说明

- 口令无法找回：忘记口令即无法解封数据密钥，所有便笺不可恢复。
- 数据绑定当前浏览器与 origin，清站数据即丢失；不提供云同步。
- 上限 100 条便笺，达到后「新建」按钮禁用，服务端（本仓库无服务端）不参与任何数据操作。
