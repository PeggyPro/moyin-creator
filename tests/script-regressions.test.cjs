// Run with: node --test tests/script-regressions.test.cjs
// Uses installed TypeScript only. No user files, credentials or remote services are read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const turns = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const never = () => new Promise(() => {});
const limits = { contextWindow: 128000, maxOutput: 32768 };
const registry = { getModelLimits: () => limits, estimateTokens: text => Math.ceil(text.length / 4), parseModelLimitsFromError: () => null, cacheDiscoveredLimits() {} };

// Isolated module graph lets tests exercise actual stores/transports with memory-only I/O.
function loader(mocks = {}) {
  const cache = new Map();
  function filename(specifier, parent = path.join(root, 'index.ts')) {
    let file = specifier.startsWith('@/') ? path.join(root, 'src', specifier.slice(2)) : path.resolve(path.dirname(parent), specifier);
    if (!path.extname(file)) file += fs.existsSync(file + '.ts') ? '.ts' : '.tsx';
    return file;
  }
  const overrides = new Map(Object.entries(mocks).map(([name, value]) => [filename(name), value]));
  function load(specifier, parent) {
    const file = filename(specifier, parent);
    if (overrides.has(file)) return overrides.get(file);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const source = fs.readFileSync(file, 'utf8').replace(/import\.meta\.env/g, '({ DEV: false })');
    const code = ts.transpileModule(source, { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const nativeRequire = createRequire(file);
    const localRequire = name => name.startsWith('@/') || name.startsWith('.') ? load(name, file) : nativeRequire(name);
    try {
      new Function('require', 'module', 'exports', '__filename', '__dirname', code)(localRequire, module, module.exports, file, path.dirname(file));
    } catch (error) { error.message += ` [loading ${file}]`; throw error; }
    return module.exports;
  }
  return name => load(name.startsWith('@/') ? name : path.join(root, name));
}

function bootstrap(seed = {}, extra = {}) {
  const disk = new Map(Object.entries(seed));
  const local = new Map();
  global.localStorage = { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value), removeItem: key => local.delete(key) };
  const bridge = { getItem: async key => disk.get(key) ?? null, setItem: async (key, value) => { disk.set(key, value); return true; }, removeItem: async key => disk.delete(key) };
  global.window = { fileStorage: bridge };
  // An accidental unmocked fetch fails the test without making a network connection.
  global.fetch = async () => { throw new Error('External HTTP is forbidden in regression tests'); };
  const router = { activeProjectId: 'A', projects: [{ id: 'A' }, { id: 'B' }], setActiveProject(id) { router.activeProjectId = id; } };
  const apiConfig = { concurrency: 1, isFeatureConfigured: () => true, getProviderForFeature: () => ({ model: ['test-model'], apiKey: 'mock' }) };
  const mocks = {
    '@/stores/project-store': { useProjectStore: { getState: () => router, persist: { hasHydrated: () => true } } },
    '@/stores/app-settings-store': { useAppSettingsStore: { getState: () => ({ resourceSharing: {} }) } },
    '@/stores/api-config-store': { useAPIConfigStore: { getState: () => apiConfig } },
    '@/stores/character-library-store': { useCharacterLibraryStore: { getState: () => ({ getCharacterById: () => null }) } },
    '@/lib/ai/model-registry': registry,
    '@/lib/provider-config': { getAuthorizationHeaders: () => ({}) },
    '@/lib/utils/rate-limiter': { delay: async () => {}, RATE_LIMITS: {} },
    ...extra,
  };
  const load = loader(mocks);
  const storeModule = load('@/stores/script-store');
  const storage = load('@/lib/indexed-db-storage');
  return { load, disk, bridge, router, storage, ...storeModule, store: storeModule.useScriptStore };
}
async function fixture(seed, extra) {
  const h = bootstrap(seed, extra);
  await h.store.persist.rehydrate(); await turns(); await h.storage.flushFileStorage();
  return h;
}
const sampleData = () => ({ title: '保留剧本', genre: 'test', logline: '测试', characters: [{ id: 'c1', name: '甲', role: '原角色' }], episodes: [{ id: 'ep_1', index: 1, title: '第1集', sceneIds: ['s1'] }], scenes: [{ id: 's1', episodeId: 'ep_1', location: '房间', time: 'day', atmosphere: '安静', viewpoints: [{ id: 'old', name: '原视角', shotIds: ['original'] }] }], storyParagraphs: [] });
const rawEpisode = (index = 1) => ({ episodeIndex: index, title: `第${index}集`, rawContent: `第${index}集原内容`, scenes: [{ content: '甲走进房间', dialogues: [], actions: ['甲走进房间'] }], shotGenerationStatus: 'idle' });
function seedProject(h, id = 'A') {
  const store = h.store.getState(); store.ensureProject(id); store.setScriptData(id, sampleData()); store.setEpisodeRawScripts(id, [rawEpisode()]); store.setShots(id, [{ id: 'original', episodeId: 'ep_1', sceneRefId: 's1', actionSummary: '已有镜头', imageStatus: 'completed' }]);
}
const serviceMocks = extra => ({
  '@/lib/script/episode-parser': {},
  '@/lib/script/script-normalizer': {},
  '@/lib/script/series-meta-sync': { buildSeriesContextSummary: () => '', populateSeriesMetaFromImport: () => ({}) },
  '@/lib/script/character-stage-analyzer': { getVariationForEpisode: () => null },
  '@/lib/script/shot-calibration-stages': {},
  '@/lib/ai/feature-router': { callFeatureAPI: async () => { throw new Error('Unexpected AI call'); } },
  ...extra,
});

test('old per-project busy state reload becomes retryable errors without losing content', async () => {
  const data = sampleData(); const shots = [{ id: 'original', sceneRefId: 's1', actionSummary: '保留镜头' }];
  const projectData = { rawScript: '原剧本', scriptData: data, shots, episodeRawScripts: [{ ...rawEpisode(), shotGenerationStatus: 'generating' }], parseStatus: 'parsing', shotStatus: 'generating', batchProgress: { current: 1, total: 3 }, calibrationState: { importStatus: 'importing', synopsisStatus: 'generating', titleCalibrationStatus: 'calibrating', characterCalibrationStatus: 'calibrating', sceneCalibrationStatus: 'calibrating', viewpointAnalysisStatus: 'analyzing', structureCompletionStatus: 'processing', singleShotCalibrationStatus: { original: 'calibrating' } } };
  const h = await fixture({ '_p/A/script': JSON.stringify({ state: { activeProjectId: 'A', projectData }, version: 0 }) });
  const recovered = h.store.getState().projects.A;
  assert.equal(recovered.parseStatus, 'error'); assert.equal(recovered.shotStatus, 'error');
  for (const [field, status] of Object.entries(recovered.calibrationState)) if (field.endsWith('Status') && typeof status === 'string') assert.equal(status, 'error', field);
  assert.equal(recovered.calibrationState.singleShotCalibrationStatus.original, 'error'); assert.equal(recovered.episodeRawScripts[0].shotGenerationStatus, 'error');
  assert.equal(recovered.batchProgress, null); assert.match(recovered.taskError, /中断/);
  assert.deepEqual(recovered.scriptData, data); assert.deepEqual(recovered.shots, shots); assert.equal(recovered.rawScript, '原剧本');
  await h.storage.flushFileStorage();
});

test('legacy project map is normalized without treating old busy flags as success', async () => {
  const project = { scriptData: sampleData(), calibrationState: { synopsisStatus: 'generating' } };
  const h = await fixture({ 'moyin-script-store': JSON.stringify({ state: { activeProjectId: 'A', projects: { A: project } }, version: 0 }) });
  assert.equal(h.store.getState().projects.A.calibrationState.synopsisStatus, 'error');
  assert.deepEqual(h.store.getState().projects.A.scriptData, project.scriptData);
});

test('an eager empty project placeholder cannot overwrite disk during initial hydration', async () => {
  const saved = { rawScript: '从磁盘加载', scriptData: sampleData() };
  const payload = JSON.stringify({ state: { activeProjectId: 'A', projectData: saved }, version: 0 });
  const h = bootstrap({ '_p/A/script': payload }); h.store.getState().ensureProject('A');
  await h.store.persist.rehydrate(); await h.storage.flushFileStorage();
  assert.equal(h.store.getState().projects.A.rawScript, saved.rawScript); assert.equal(h.disk.get('_p/A/script'), payload);
});

test('live tasks survive panel reconciliation and stale rehydration', async () => {
  const h = await fixture(); seedProject(h);
  const tasks = h.load('@/lib/script/script-tasks'); const pending = deferred();
  const work = tasks.runScriptTask('A', 'titles', async run => { h.store.getState().setCalibrationState('A', { titleCalibrationStatus: 'calibrating' }); await run.wait(pending.promise); h.store.getState().setCalibrationState('A', { titleCalibrationStatus: 'completed' }); });
  h.reconcileScriptTasks('A'); assert.equal(h.store.getState().projects.A.calibrationState.titleCalibrationStatus, 'calibrating');
  await h.storage.flushFileStorage();
  h.disk.set('_p/A/script', JSON.stringify({ state: { activeProjectId: 'A', projectData: { rawScript: 'stale disk' } }, version: 0 }));
  await h.store.persist.rehydrate();
  assert.equal(h.store.getState().projects.A.calibrationState.titleCalibrationStatus, 'calibrating');
  assert.equal(h.store.getState().projects.A.scriptData.title, '保留剧本');
  pending.resolve(); await work; assert.equal(h.store.getState().projects.A.calibrationState.titleCalibrationStatus, 'completed'); await h.storage.flushFileStorage();
});

test('finally settles a task that exits without an explicit terminal status', async () => {
  const h = await fixture(); seedProject(h);
  await h.load('@/lib/script/script-tasks').runScriptTask('A', 'scenes', async () => { h.store.getState().setCalibrationState('A', { sceneCalibrationStatus: 'calibrating' }); });
  assert.equal(h.store.getState().projects.A.calibrationState.sceneCalibrationStatus, 'error'); await h.storage.flushFileStorage();
});

test('superseded runs cannot commit late results or clear the replacement task', async () => {
  const h = await fixture(); const tasks = h.load('@/lib/script/script-tasks'); const first = deferred(), second = deferred(); let result = '';
  const old = tasks.runScriptTask('A', 'titles', async run => { await run.wait(first.promise); result = 'old'; });
  const rejection = assert.rejects(old, { name: 'AbortError' });
  const current = tasks.runScriptTask('A', 'titles', async run => { await run.wait(second.promise); result = 'new'; });
  first.resolve(); await rejection; assert.equal(tasks.hasLiveScriptTask('A', 'titles'), true); assert.equal(result, ''); second.resolve(); await current; assert.equal(result, 'new'); assert.equal(tasks.hasLiveScriptTask('A'), false);
});

test('parent cancellation reaches child tasks and other projects remain live', async () => {
  const h = await fixture(); const tasks = h.load('@/lib/script/script-tasks'); const controller = new AbortController(); let childSignal;
  const otherWait = deferred(); const other = tasks.runScriptTask('B', 'titles', run => run.wait(otherWait.promise));
  const work = tasks.runScriptTask('A', 'titles:service', run => { childSignal = run.signal; return run.wait(never()); }, controller.signal);
  const rejected = assert.rejects(work, { name: 'AbortError' }); controller.abort(); await rejected;
  assert.equal(childSignal.aborted, true); assert.equal(tasks.hasLiveScriptTask('B'), true); otherWait.resolve(); await other;
});

test('inactive project completion is persisted under its explicit project ID', async () => {
  const h = await fixture(); seedProject(h); seedProject(h, 'B'); h.router.activeProjectId = 'B'; h.store.getState().setActiveProjectId('B');
  h.store.getState().setMetadataMarkdown('A', '后台项目 A 完成'); await h.storage.flushFileStorage();
  assert.equal(JSON.parse(h.disk.get('_p/A/script')).state.projectData.metadataMarkdown, '后台项目 A 完成');
  assert.equal(JSON.parse(h.disk.get('_p/B/script')).state.projectData.metadataMarkdown, '');
});

test('file writes are ordered and flush waits for actual disk acknowledgements', async () => {
  const h = await fixture(); const first = deferred(), second = deferred(); const starts = [];
  h.bridge.setItem = async (key, value) => { starts.push(value); await (value === 'one' ? first.promise : second.promise); h.disk.set(key, value); return true; };
  h.storage.fileStorage.setItem('ordered', 'one'); h.storage.fileStorage.setItem('ordered', 'two'); let flushed = false;
  const flush = h.storage.flushFileStorage('ordered').then(() => { flushed = true; }); await turns();
  assert.deepEqual(starts, ['one']); assert.equal(flushed, false); first.resolve(); await turns(); assert.deepEqual(starts, ['one', 'two']); assert.equal(flushed, false); second.resolve(); await flush; assert.equal(h.disk.get('ordered'), 'two');
});

test('failed disk saves block flush and an unchanged snapshot can be retried', async () => {
  const h = await fixture(); const map = h.load('@/lib/project-storage').createProjectMapStorage('script-test'); const payload = JSON.stringify({ state: { activeProjectId: 'A', projects: { A: { rawScript: '保留' } } }, version: 0 });
  h.bridge.setItem = async () => false; await map.setItem('unused', payload); await assert.rejects(h.storage.flushFileStorage('_p/A/script-test'), /项目保存失败/);
  h.bridge.setItem = async (key, value) => { h.disk.set(key, value); return true; }; await map.setItem('unused', payload); await h.storage.flushFileStorage(); assert.equal(JSON.parse(h.disk.get('_p/A/script-test')).state.projectData.rawScript, '保留');
});

test('project switching waits for pending saves rather than a fixed delay', async () => {
  const stub = { getState: () => ({ setActiveProjectId() {}, ensureProject() {} }), persist: { rehydrate: async () => {} } };
  const extra = {}; for (const [file, name] of [['director-store', 'useDirectorStore'], ['media-store', 'useMediaStore'], ['character-library-store', 'useCharacterLibraryStore'], ['scene-store', 'useSceneStore'], ['simple-timeline-store', 'useSimpleTimelineStore'], ['sclass-store', 'useSClassStore']]) extra[`@/stores/${file}`] = { [name]: stub };
  const h = await fixture({}, extra); seedProject(h); await h.storage.flushFileStorage(); const gate = deferred();
  h.bridge.setItem = async (key, value) => { await gate.promise; h.disk.set(key, value); return true; }; h.store.getState().setRawScript('A', '等待真实落盘');
  const change = h.load('@/lib/project-switcher').switchProject('B'); await turns(); assert.equal(h.router.activeProjectId, 'A'); gate.resolve(); await change;
  assert.equal(h.router.activeProjectId, 'B'); assert.equal(JSON.parse(h.disk.get('_p/A/script')).state.projectData.rawScript, '等待真实落盘'); await h.storage.flushFileStorage();
});

test('latest-state merge preserves concurrent edits, additions, deletions and old viewpoints', async () => {
  const h = await fixture(); seedProject(h); const { mergeGeneratedEntities, commitGeneratedScriptData, commitGeneratedShots } = h.load('@/lib/script/script-merge');
  const baseline = h.store.getState().projects.A; const extraShot = { id: 'new', sceneRefId: 's1', actionSummary: '用户新增' };
  h.store.getState().updateShot('A', 'original', { actionSummary: '用户改动' }); h.store.getState().addShot('A', extraShot); h.store.getState().updateCharacter('A', 'c1', { role: '最新角色' });
  commitGeneratedShots('A', baseline.shots, [{ ...baseline.shots[0], actionSummary: '旧 AI', duration: 8 }]);
  commitGeneratedScriptData('A', baseline.scriptData, { ...baseline.scriptData, title: '生成标题', characters: [{ ...baseline.scriptData.characters[0], role: '旧角色', age: '25' }], scenes: [] });
  const result = h.store.getState().projects.A; assert.equal(result.shots[0].actionSummary, '用户改动'); assert.equal(result.shots[0].duration, 8); assert.ok(result.shots.some(s => s.id === 'new')); assert.equal(result.scriptData.characters[0].role, '最新角色'); assert.equal(result.scriptData.scenes[0].viewpoints[0].id, 'old');
  assert.deepEqual(mergeGeneratedEntities([], [{ id: 'deleted' }], [{ id: 'deleted', name: '旧结果' }]), []); await h.storage.flushFileStorage();
});

test('episode viewpoint completion merges into latest data and preserves other episode shots', async () => {
  const gate = deferred(), entered = deferred();
  const h = await fixture({}, serviceMocks({ '@/lib/script/viewpoint-analyzer': { analyzeSceneViewpoints: async () => { entered.resolve(); return gate.promise; } } })); seedProject(h);
  const service = h.load('@/lib/script/full-script-service'); const work = service.generateEpisodeShots(1, 'A', { apiKey: 'mock', provider: 'mock', styleId: '', targetDuration: '60s' });
  await entered.promise; h.store.getState().addShot('A', { id: 'episode-two', episodeId: 'ep_2', sceneRefId: 's2', actionSummary: '后台另一集' }); h.store.getState().updateCharacter('A', 'c1', { role: '并发编辑' }); h.store.getState().updateScene('A', 's1', { location: '编辑后的房间' });
  gate.resolve({ viewpoints: [{ id: 'vp1', name: '新视角', nameEn: 'new', shotIndexes: [1], keyProps: [] }], analysisNote: 'mock' }); const result = await work;
  assert.equal(result.viewpointAnalyzed, true); const project = h.store.getState().projects.A; assert.equal(project.scriptData.characters[0].role, '并发编辑'); assert.equal(project.scriptData.scenes[0].location, '编辑后的房间'); assert.ok(project.scriptData.scenes[0].viewpoints.some(view => view.id === 'vp1')); assert.ok(project.scriptData.scenes[0].viewpoints.some(view => view.id === 'old')); assert.ok(project.shots.some(s => s.id === 'episode-two')); assert.ok(project.shots.some(s => s.id === 'original')); await h.storage.flushFileStorage();
});

test('episode shot results are discarded when raw content changes during analysis', async () => {
  const gate = deferred(), entered = deferred();
  const h = await fixture({}, serviceMocks({ '@/lib/script/viewpoint-analyzer': { analyzeSceneViewpoints: async () => { entered.resolve(); return gate.promise; } } })); seedProject(h);
  const work = h.load('@/lib/script/full-script-service').generateEpisodeShots(1, 'A', { apiKey: 'mock', provider: 'mock', styleId: '', targetDuration: '60s' });
  await entered.promise;
  h.store.getState().updateEpisodeRawScript('A', 1, { rawContent: '用户新编辑内容' });
  gate.resolve({ viewpoints: [{ id: 'vp1', name: '新视角', nameEn: 'new', shotIndexes: [1], keyProps: [] }], analysisNote: 'mock' });
  await assert.rejects(work, /剧本内容已更新/);
  const project = h.store.getState().projects.A;
  assert.equal(project.episodeRawScripts[0].rawContent, '用户新编辑内容');
  assert.deepEqual(project.shots.map(shot => shot.id), ['original']);
  assert.equal(project.episodeRawScripts[0].shotGenerationStatus, 'error');
  await h.storage.flushFileStorage();
});

test('failed viewpoint analysis preserves original views and ends episode with error', async () => {
  const h = await fixture({}, serviceMocks({ '@/lib/script/viewpoint-analyzer': { analyzeSceneViewpoints: async () => { throw new Error('mock failure'); } } })); seedProject(h);
  const result = await h.load('@/lib/script/full-script-service').generateEpisodeShots(1, 'A', { apiKey: 'mock', provider: 'mock', styleId: '', targetDuration: '60s' });
  assert.equal(result.viewpointAnalyzed, false); assert.match(result.viewpointSkippedReason, /失败/); assert.equal(h.store.getState().projects.A.episodeRawScripts[0].shotGenerationStatus, 'error'); assert.equal(h.store.getState().projects.A.scriptData.scenes[0].viewpoints[0].id, 'old'); await h.storage.flushFileStorage();
});

test('partial title generation preserves results and reports incomplete instead of success', async () => {
  const h = await fixture({}, serviceMocks({ '@/lib/ai/batch-processor': { processBatched: async () => ({ results: new Map([['1', '成功标题']]), failedBatches: 1, totalBatches: 2 }) } })); seedProject(h); h.store.getState().setEpisodeRawScripts('A', [rawEpisode(1), rawEpisode(2)]);
  const result = await h.load('@/lib/script/full-script-service').calibrateEpisodeTitles('A'); assert.equal(result.success, false); assert.equal(result.calibratedCount, 1); assert.match(h.store.getState().projects.A.episodeRawScripts[0].title, /成功标题/); assert.equal(h.store.getState().projects.A.episodeRawScripts[1].title, '第2集'); await h.storage.flushFileStorage();
});

test('title results from replaced episode content are discarded', async () => {
  const gate = deferred(); const h = await fixture({}, serviceMocks({ '@/lib/ai/batch-processor': { processBatched: async () => gate.promise } })); seedProject(h);
  const work = h.load('@/lib/script/full-script-service').calibrateEpisodeTitles('A'); h.store.getState().updateEpisodeRawScript('A', 1, { rawContent: '已替换的新内容' }); gate.resolve({ results: new Map([['1', '旧内容标题']]), failedBatches: 0, totalBatches: 1 }); const result = await work; assert.equal(result.success, false); assert.equal(h.store.getState().projects.A.episodeRawScripts[0].title, '第1集'); await h.storage.flushFileStorage();
});

const parseOptions = { apiKey: 'mock', provider: 'mock', baseUrl: 'https://example.invalid', model: 'test-model', timeoutMs: 25, maxRetries: 3 };
test('request timeout covers hung fetch without retrying forever', async () => {
  let calls = 0, signal; const h = await fixture({}, { '@/lib/cors-fetch': { corsFetch: async (_, init) => { calls++; signal = init.signal; return never(); } } });
  await assert.rejects(h.load('@/lib/script/script-parser').callChatAPI('s', 'u', parseOptions), { name: 'TimeoutError' }); assert.equal(calls, 1); assert.equal(signal.aborted, true);
});
test('request timeout also covers successful response bodies that never finish', async () => {
  let calls = 0; const h = await fixture({}, { '@/lib/cors-fetch': { corsFetch: async () => { calls++; return { ok: true, json: never }; } } });
  await assert.rejects(h.load('@/lib/script/script-parser').callChatAPI('s', 'u', parseOptions), { name: 'TimeoutError' }); assert.equal(calls, 1);
});
test('request timeout covers error response bodies', async () => {
  const h = await fixture({}, { '@/lib/cors-fetch': { corsFetch: async () => ({ ok: false, status: 503, text: never }) } }); await assert.rejects(h.load('@/lib/script/script-parser').callChatAPI('s', 'u', parseOptions), { name: 'TimeoutError' });
});
test('caller cancellation aborts the request and avoids retries', async () => {
  let calls = 0, signal; const h = await fixture({}, { '@/lib/cors-fetch': { corsFetch: async (_, init) => { calls++; signal = init.signal; return never(); } } }); const controller = new AbortController();
  const work = h.load('@/lib/script/script-parser').callChatAPI('s', 'u', { ...parseOptions, signal: controller.signal }); const rejected = assert.rejects(work, { name: 'AbortError' }); controller.abort(); await rejected; assert.equal(signal.aborted, true); assert.equal(calls, 1);
  await assert.rejects(h.load('@/lib/script/script-parser').callChatAPI('s', 'u', { ...parseOptions, signal: controller.signal }), { name: 'AbortError' }); assert.equal(calls, 1);
});

test('renderer IPC cancellation rejects even if the main process never replies', async () => {
  const h = await fixture(); const controller = new AbortController(); let aborts = 0; global.window.apiFetch = { request: never, abort: () => { aborts++; } };
  const work = h.load('@/lib/cors-fetch').corsFetch('https://example.invalid', { signal: controller.signal }); const rejected = assert.rejects(work, { name: 'AbortError' }); await turns(); controller.abort(); await rejected; assert.equal(aborts, 1);
});
test('main IPC deadline covers hung response bodies and removes request ownership', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const load = loader(); const handlers = new Map(), listeners = new Map(); let signal;
  load('electron/api-fetch.ts').registerApiFetchHandlers({ handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => listeners.set(name, fn) }, async (_, init) => { signal = init.signal; return { arrayBuffer: never }; });
  const request = { id: 'same', url: 'https://example.invalid', method: 'POST', headers: [] }; const event = { sender: { id: 1 } };
  const work = handlers.get('api-fetch')(event, request); await turns(); t.mock.timers.tick(180001); const result = await work; assert.equal(result.success, false); assert.equal(result.timedOut, true); assert.equal(signal.aborted, true);
  const again = handlers.get('api-fetch')(event, request); listeners.get('api-fetch-abort')(event, 'same'); assert.equal((await again).aborted, true);
});

test('batch retries do not multiply transport retries and timeouts are terminal', async () => {
  let calls = 0; const h = await fixture({}, { '@/lib/ai/feature-router': { callFeatureAPI: async (_, _s, _u, options) => { calls++; assert.equal(options.maxRetries, 0); throw new DOMException('mock timeout', 'TimeoutError'); } } });
  const result = await h.load('@/lib/ai/batch-processor').processBatched({ items: ['one'], feature: 'script_analysis', buildPrompts: () => ({ system: 's', user: 'u' }), parseResult: () => new Map() }); assert.equal(calls, 1); assert.equal(result.failedBatches, 1);
});
test('batch cancellation is propagated rather than counted as a successful empty batch', async () => {
  const h = await fixture({}, { '@/lib/ai/feature-router': { callFeatureAPI: async () => { throw new DOMException('mock cancel', 'AbortError'); } } });
  await assert.rejects(h.load('@/lib/ai/batch-processor').processBatched({ items: ['one'], feature: 'script_analysis', buildPrompts: () => ({ system: 's', user: 'u' }), parseResult: () => new Map() }), { name: 'AbortError' });
});
test('partial scene shot generation keeps usable progress but rejects complete success', async () => {
  let calls = 0; const h = await fixture({}, { '@/lib/cors-fetch': { corsFetch: async () => { calls++; if (calls === 2) return { ok: false, status: 400, text: async () => 'bad mock response' }; return { ok: true, json: async () => ({ choices: [{ message: { content: '[{"id":"generated","actionSummary":"成功镜头"}]' } }] }) }; } } });
  const data = sampleData(); data.scenes.push({ ...data.scenes[0], id: 's2', location: '第二场景' }); const progress = [];
  await assert.rejects(h.load('@/lib/script/script-parser').generateShotList(data, { ...parseOptions, maxRetries: 0, concurrency: -1 }, undefined, shots => progress.push(...shots)), /已保留成功结果/); assert.equal(progress.length, 1); assert.equal(calls, 2);
});
test('a timed out script task releases busy status through final reconciliation', async () => {
  const h = await fixture({}, { '@/lib/cors-fetch': { corsFetch: never } }); seedProject(h);
  await assert.rejects(h.load('@/lib/script/script-tasks').runScriptTask('A', 'parse', async run => { h.store.getState().setParseStatus('A', 'parsing'); await run.wait(h.load('@/lib/script/script-parser').callChatAPI('s', 'u', { ...parseOptions, signal: run.signal })); }), { name: 'TimeoutError' });
  assert.equal(h.store.getState().projects.A.parseStatus, 'error'); assert.ok(h.store.getState().projects.A.shots.length); await h.storage.flushFileStorage();
});
