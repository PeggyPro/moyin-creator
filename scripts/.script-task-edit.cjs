const fs = require('node:fs');
const ts = require('typescript');
const uiOptions = {importFullScript:2,generateEpisodeShots:2,regenerateAllEpisodeShots:1,calibrateEpisodeTitles:1,calibrateEpisodeShots:2,calibrateSingleShot:2,generateEpisodeSynopses:1,parseScript:1,generateScriptFromIdea:1,generateShotList:1};
for (const [file,ui] of [['src/lib/script/full-script-service.ts',false],['src/components/panels/script/index.tsx',true]]) {
  let text=fs.readFileSync(file,'utf8');
  const ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ui?ts.ScriptKind.TSX:ts.ScriptKind.TS);
  const edits=[];
  function property(arg,code) {
    if(ts.isObjectLiteralExpression(arg)) edits.push({pos:arg.getStart(ast)+1,end:arg.getStart(ast)+1,text:code+', '});
    else edits.push({pos:arg.getStart(ast),end:arg.end,text:`{ ...${arg.getText(ast)}, ${code} }`});
  }
  function visit(node,owner='') {
    if(ts.isFunctionDeclaration(node)&&node.name) owner=node.name.text;
    if(ts.isCallExpression(node)) {
      const name=node.expression.getText(ast);
      if(ui && uiOptions[name]!==undefined && node.arguments[uiOptions[name]]) property(node.arguments[uiOptions[name]],'signal: scriptRun.signal');
      if(!ui && name==='runScriptTask' && !['importSingleEpisodeContent','generateSingleEpisodeTitleAndSynopsis'].includes(owner)) {
        const signal=owner==='importFullScript'?'importSettings?.signal':(['calibrateEpisodeTitles','generateEpisodeSynopses'].includes(owner)?'_options?.signal':'options.signal');
        edits.push({pos:node.arguments[2].end,end:node.arguments[2].end,text:`, ${signal}`});
      }
      if(!ui && name==='analyzeScriptStructureWithAI') edits.push({pos:node.arguments[0].end,end:node.arguments[0].end,text:', scriptRun.signal'});
      if(!ui && name==='analyzeSceneViewpoints') property(node.arguments[2],'signal: scriptRun.signal');
      if(!ui && name==='processBatched') property(node.arguments[0],'apiOptions: { signal: scriptRun.signal }');
      if(!ui && name==='calibrateShotsMultiStage') property(node.arguments[1],'signal: scriptRun.signal');
      if(!ui && name==='callAIForShotCalibration') property(node.arguments[1],'signal: scriptRun.signal');
      if(!ui && name==='callFeatureAPI' && ['generateSingleEpisodeTitleAndSynopsis','callAIForShotCalibration'].includes(owner)) property(node.arguments[3],owner==='callAIForShotCalibration'?'signal: options.signal':'signal: scriptRun.signal');
      if(!ui && name==='generateEpisodeShots') property(node.arguments[2],'signal: scriptRun.signal');
    }
    ts.forEachChild(node,child=>visit(child,owner));
  }
  visit(ast);
  for(const edit of edits.sort((a,b)=>b.pos-a.pos)) text=text.slice(0,edit.pos)+edit.text+text.slice(edit.end);
  if(!ui) {
    text=text.replace('export interface GenerateShotsOptions {','export interface GenerateShotsOptions {\n  signal?: AbortSignal;');
    text=text.replace('export interface CalibrationOptions {','export interface CalibrationOptions {\n  signal?: AbortSignal;');
    text=text.replace('export interface ShotCalibrationOptions {','export interface ShotCalibrationOptions {\n  signal?: AbortSignal;');
    text=text.replace('importSettings?: { styleId?: string; promptLanguage?: PromptLanguage }','importSettings?: { styleId?: string; promptLanguage?: PromptLanguage; signal?: AbortSignal }');
  }
  fs.writeFileSync(file,text);
  console.log(file,edits.length);
}
