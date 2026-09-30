import { NotesDB } from '../src/db';
import { LocalLockBus, type LocalLockHub } from '../src/lockbus';
import { Session } from '../src/session';

/** 测试用低迭代次数，保持 PBKDF2 代码路径不变但跑得动 */
export const TEST_ITERATIONS = 1_000;

let seq = 0;

export async function makeSession(dbName?: string, bus?: LocalLockBus) {
  const db = await NotesDB.open(dbName ?? `test-db-${++seq}`);
  const localBus = bus ?? new LocalLockBus();
  const session = new Session(db, localBus, { iterations: TEST_ITERATIONS });
  return { db, bus: localBus, session };
}

/** 模拟两个标签页：两条 IndexedDB 连接与两个总线端点共享同一个进程内 hub */
export async function makeTabPair() {
  const name = `test-db-tabs-${++seq}`;
  const hub: LocalLockHub = new Set();
  const a = await makeSession(name, new LocalLockBus(hub));
  const b = await makeSession(name, new LocalLockBus(hub));
  return { name, hub, a, b };
}

/** 读取 Uint8Array/ArrayBuffer 的便捷断言辅助 */
export function toBytes(buf: ArrayBuffer | Uint8Array): Uint8Array {
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}
