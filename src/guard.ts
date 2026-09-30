/**
 * 会话内一次业务操作的栅栏。
 *
 * 锁定、口令被其它标签页更换、新的解锁尝试都会使当前会话代次失效，
 * 并 abort 尚未完成的操作；异步操作在每个 await 边界后都必须重新检查。
 */
export interface SessionOperation {
  readonly signal: AbortSignal;
  assertActive(): void;
  end(): void;
}

export type SessionOperationFactory = () => SessionOperation;
