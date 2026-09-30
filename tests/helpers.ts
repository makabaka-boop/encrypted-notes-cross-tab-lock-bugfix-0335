import { NotesDB } from '../src/db';
import { LocalLockBus } from '../src/lockbus';
import { Session } from '../src/session';

/** 测试用低迭代次数，保持 PBKDF2 代码路径不变但跑得动 */
export const TEST_ITERATIONS = 1_000;

let seq = 0;

export async function makeSession(dbName?: string) {
  const db = await NotesDB.open(dbName ?? `test-db-${++seq}`);
  const bus = new LocalLockBus();
  const session = new Session(db, bus, { iterations: TEST_ITERATIONS });
  return { db, bus, session };
}

/** 模拟两个标签页：两条 IndexedDB 连接指向同一个库 */
export async function makeTabPair() {
  const name = `test-db-tabs-${++seq}`;
  const a = await makeSession(name);
  const b = await makeSession(name);
  return { name, a, b };
}

/** 读取 Uint8Array/ArrayBuffer 的便捷断言辅助 */
export function toBytes(buf: ArrayBuffer | Uint8Array): Uint8Array {
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}
