import { useScriptStore } from '@/stores/script-store';
import type { ScriptData, Shot } from '@/types/script';

const equal = (left: unknown, right: unknown): boolean => left === right || JSON.stringify(left) === JSON.stringify(right);

/** Apply generated fields only where the caller's original value is still current. */
export function mergeGeneratedFields<T extends object>(current: T, baseline: T, generated: T): T {
  const merged = { ...current };
  for (const key of Object.keys(generated) as (keyof T)[]) {
    if (!equal(generated[key], baseline[key]) && equal(current[key], baseline[key])) merged[key] = generated[key];
  }
  return merged;
}

export function mergeGeneratedEntities<T extends { id: string | number }>(current: T[] = [], baseline: T[] = [], generated: T[] = []): T[] {
  const originals = new Map(baseline.map(item => [item.id, item]));
  const results = new Map(generated.map(item => [item.id, item]));
  const merged: T[] = [];
  for (const item of current) {
    const before = originals.get(item.id);
    const after = results.get(item.id);
    // A concurrent deletion/addition/edit always wins over an older AI snapshot.
    if (!before) merged.push(item);
    else if (after) merged.push(mergeGeneratedFields(item, before, after));
    else merged.push(item);
  }
  for (const item of generated) {
    if (!originals.has(item.id) && !current.some(existing => existing.id === item.id)) merged.push(item);
  }
  return merged;
}

export function commitGeneratedScriptData(projectId: string, baseline: ScriptData, generated: ScriptData): void {
  const store = useScriptStore.getState();
  const current = store.projects[projectId]?.scriptData;
  if (!current) throw new Error('剧本已被移除，已忽略旧任务结果');
  const merged = mergeGeneratedFields(current, baseline, generated);
  const scenes = mergeGeneratedEntities(current.scenes, baseline.scenes, generated.scenes).map(scene => {
    const before = baseline.scenes.find(item => item.id === scene.id);
    const after = generated.scenes.find(item => item.id === scene.id);
    const latest = current.scenes.find(item => item.id === scene.id);
    if (!before || !after || !latest || (!before.viewpoints && !after.viewpoints && !latest.viewpoints)) return scene;
    return { ...scene, viewpoints: mergeGeneratedEntities(latest.viewpoints, before.viewpoints, after.viewpoints) };
  });
  store.setScriptData(projectId, {
    ...merged,
    characters: mergeGeneratedEntities(current.characters, baseline.characters, generated.characters),
    scenes,
    episodes: mergeGeneratedEntities(current.episodes, baseline.episodes, generated.episodes),
    storyParagraphs: mergeGeneratedEntities(current.storyParagraphs, baseline.storyParagraphs, generated.storyParagraphs),
  });
}

export function commitGeneratedShots(projectId: string, baseline: Shot[], generated: Shot[]): void {
  const store = useScriptStore.getState();
  const current = store.projects[projectId];
  if (!current) throw new Error('项目已被移除，已忽略旧任务结果');
  store.setShots(projectId, mergeGeneratedEntities(current.shots, baseline, generated));
}
