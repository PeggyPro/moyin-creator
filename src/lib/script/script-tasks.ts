// Runtime-only ownership of script work. Persisted busy flags never prove liveness.
export interface ScriptRun {
  readonly id: number;
  readonly projectId: string;
  readonly key: string;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  assertCurrent(): void;
  wait<T>(promise: Promise<T>): Promise<T>;
}

const runs = new Map<string, Map<string, ScriptRun & { controller: AbortController }>>();
const listeners = new Set<(projectId: string) => void>();
let nextRunId = 0;

export function hasLiveScriptTask(projectId: string, key?: string): boolean {
  const projectRuns = runs.get(projectId);
  return !!projectRuns && [...projectRuns.values()].some(run =>
    !run.signal.aborted && (!key || run.key === key || run.key.startsWith(`${key}:`)));
}

export function onScriptTasksSettled(listener: (projectId: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function cancelScriptTasks(projectId: string): void {
  const projectRuns = runs.get(projectId);
  runs.delete(projectId);
  projectRuns?.forEach(run => run.controller.abort(new DOMException('剧本任务已被替换，请重试', 'AbortError')));
}

export async function runScriptTask<T>(
  projectId: string,
  key: string,
  operation: (run: ScriptRun) => Promise<T>,
): Promise<T> {
  // Reimport replaces the entire workflow, including its outstanding child work.
  if (key === 'import') cancelScriptTasks(projectId);
  let projectRuns = runs.get(projectId);
  if (!projectRuns) runs.set(projectId, projectRuns = new Map());
  projectRuns.get(key)?.controller.abort(new DOMException('剧本任务已被替换，请重试', 'AbortError'));
  const controller = new AbortController();
  const run: ScriptRun & { controller: AbortController } = {
    id: ++nextRunId, projectId, key, signal: controller.signal, controller,
    isCurrent: () => runs.get(projectId)?.get(key) === run && !controller.signal.aborted,
    assertCurrent: () => {
      if (!run.isCurrent()) throw controller.signal.reason || new DOMException('剧本任务已失效，请重试', 'AbortError');
    },
    wait: async <R>(promise: Promise<R>): Promise<R> => {
      run.assertCurrent();
      let abort: () => void = () => {};
      try {
        const result = await Promise.race([promise, new Promise<never>((_, reject) => {
          abort = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', abort, { once: true });
        })]);
        run.assertCurrent();
        return result;
      } finally {
        controller.signal.removeEventListener('abort', abort);
      }
    },
  };
  projectRuns.set(key, run);
  try {
    return await operation(run);
  } finally {
    if (runs.get(projectId)?.get(key) === run) {
      projectRuns.delete(key);
      if (!projectRuns.size) runs.delete(projectId);
      listeners.forEach(listener => listener(projectId));
    }
  }
}
