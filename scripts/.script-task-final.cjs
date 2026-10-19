const fs=require('node:fs');const ts=require('typescript');
function transform(file,changes){let text=fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n');for(const[a,b]of changes){if(!text.includes(a))throw new Error(`${file}: missing ${a.slice(0,90)}`);text=text.replace(a,b)}fs.writeFileSync(file,text)}
transform('src/stores/script-store.ts',[
 ['const pendingCharacterRecoveryProjectIds = new Set<string>();','const pendingCharacterRecoveryProjectIds = new Set<string>();\n// An eager ensureProject during hydration must not persist an empty placeholder.\nconst untouchedProjectPlaceholders = new WeakSet<ScriptProjectData>();'],
 ['        set({\n          projects: { ...projects, [projectId]: defaultProjectData() },\n        });','        const project = defaultProjectData();\n        untouchedProjectPlaceholders.add(project);\n        set({ projects: { ...projects, [projectId]: project } });'],
 ['partialize: (state) => ({ activeProjectId: state.activeProjectId, projects: state.projects }),','partialize: (state) => ({ activeProjectId: state.activeProjectId,\n        projects: Object.fromEntries(Object.entries(state.projects).filter(([, project]) => !untouchedProjectPlaceholders.has(project))),\n      }),'],
 ['projects: { ...normalizedProjects, ...current.projects },','projects: { ...normalizedProjects, ...Object.fromEntries(\n              Object.entries(current.projects).filter(([, project]) => !untouchedProjectPlaceholders.has(project as ScriptProjectData)),\n            ) },'],
 ['normalizeScriptProjectData(pid, current.projects[pid] || projectData)','normalizeScriptProjectData(pid, current.projects[pid] && !untouchedProjectPlaceholders.has(current.projects[pid]) ? current.projects[pid] : projectData)'],
]);
transform('src/lib/project-switcher.ts',[
 ['export async function switchProject(newProjectId: string): Promise<void> {','let pendingSwitch: Promise<void> = Promise.resolve();\n\nexport function switchProject(newProjectId: string): Promise<void> {\n  const next = pendingSwitch.then(() => switchProjectNow(newProjectId));\n  pendingSwitch = next.catch(() => {});\n  return next;\n}\n\nasync function switchProjectNow(newProjectId: string): Promise<void> {'],
]);
transform('src/lib/script/full-script-service.ts',[
 ['    // 构建场景内容用于分镜生成','    if (episodeScenes.length === 0) throw new Error("该集没有可生成分镜的场景");\n\n    // 构建场景内容用于分镜生成'],
 ["const result = await scriptRun.wait(analyzeSceneViewpoints(scene, sceneShots, { ...viewpointOptions, signal: scriptRun.signal }));", "const result = await scriptRun.wait(analyzeSceneViewpoints(scene, sceneShots, { ...viewpointOptions, signal: scriptRun.signal }));\n          if (!result.viewpoints?.length) throw new Error('AI 未返回有效场景视角，请重试');"],
 ["      shotGenerationStatus: 'completed',\n      lastGeneratedAt:", "      shotGenerationStatus: viewpointAnalyzed ? 'completed' : 'error',\n      lastGeneratedAt:"],
]);
transform('src/components/panels/script/index.tsx',[
 ["import { commitGeneratedScriptData, commitGeneratedShots }", "import { commitGeneratedScriptData, commitGeneratedShots, mergeGeneratedEntities }"],
 ['        pendingCalibrationCharacters: newCharacters,',"        pendingCalibrationCharacters: mergeGeneratedEntities(\n          useScriptStore.getState().projects[projectId]?.scriptData?.characters || [],\n          scriptData.characters, newCharacters,\n        ),"],
]);
// Pass task cancellation into character/scene requests as well as the task wait race.
const file='src/components/panels/script/index.tsx';let text=fs.readFileSync(file,'utf8');const sf=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);const edits=[];
function visit(n){if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&['calibrateCharacters','calibrateScenes','calibrateEpisodeScenes'].includes(n.expression.text)){const i=n.expression.text==='calibrateEpisodeScenes'?4:3;const arg=n.arguments[i];if(arg&&ts.isObjectLiteralExpression(arg))edits.push({at:arg.getStart(sf)+1,value:' signal: scriptRun.signal, '});}ts.forEachChild(n,visit)}visit(sf);for(const e of edits.sort((a,b)=>b.at-a.at))text=text.slice(0,e.at)+e.value+text.slice(e.at);fs.writeFileSync(file,text);
