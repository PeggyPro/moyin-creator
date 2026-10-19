const fs = require('node:fs');
const ts = require('typescript');
for (const [file, ui] of [['src/lib/script/full-script-service.ts', false], ['src/components/panels/script/index.tsx', true]]) {
  let text = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ui ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const changes = [];
  function visit(node, owner = '') {
    if (ts.isFunctionDeclaration(node) && node.name) owner = node.name.text;
    if (ui && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text.startsWith('handle')) owner = node.name.text;
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(ast);
      const args = node.arguments.map(arg => arg.getText(ast));
      if (!ui && callee === 'store.setShots' && ['generateEpisodeShots', 'calibrateEpisodeShots', 'calibrateSingleShot'].includes(owner)) {
        changes.push({start:node.getStart(ast), end:node.end, text:`commitGeneratedShots(${args[0]}, project.shots, ${args[1]})`});
      }
      if (!ui && callee === 'store.setScriptData' && owner === 'generateEpisodeShots') {
        changes.push({start:node.getStart(ast), end:node.end, text:`commitGeneratedScriptData(${args[0]}, scriptData, ${args[1]})`});
      }
      if (ui && callee === 'setScriptData' && ['handleImportFullScript', 'handleCalibrateScenes', 'handleCalibrateEpisodeScenes'].includes(owner)) {
        const baseline = owner === 'handleImportFullScript' ? 'result.scriptData' : 'scriptData';
        changes.push({start:node.getStart(ast), end:node.end, text:`commitGeneratedScriptData(${args[0]}, ${baseline}, ${args[1]})`});
      }
      if (ui && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'catch' && ['handleGenerateEpisodeShots', 'handleAIFindCharacter', 'handleAIFindScene'].includes(owner)) {
        const body = node.arguments[0].body;
        const fallback = owner === 'handleGenerateEpisodeShots' ? "return { shots: [], viewpointAnalyzed: false, viewpointSkippedReason: '任务已取消' };" : owner === 'handleAIFindCharacter' ? "return { found: false, name: '', message: '任务已取消' };" : "return { found: false, message: '任务已取消' };";
        changes.push({start:body.end-1,end:body.end-1,text:` ${fallback} `});
      }
    }
    ts.forEachChild(node, child => visit(child, owner));
  }
  visit(ast);
  for (const c of changes.sort((a,b)=>b.start-a.start)) text = text.slice(0,c.start) + c.text + text.slice(c.end);
  text = "import { commitGeneratedScriptData, commitGeneratedShots } from '@/lib/script/script-merge';\n" + text;
  fs.writeFileSync(file,text);
  console.log(file, changes.length);
}
