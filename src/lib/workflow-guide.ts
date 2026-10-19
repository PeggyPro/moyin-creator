// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
import type { Character } from '@/stores/character-library-store';
import type { Scene } from '@/stores/scene-store';
import type { ScriptProjectData } from '@/stores/script-store';
import type { DirectorProjectData } from '@/stores/director-store';
import type { Tab } from '@/stores/media-panel-store';

export interface WorkflowFacts {
  imported: boolean;
  hasScriptText: boolean;
  scriptBusy: boolean;
  pendingCharacterCalibration: boolean;
  scriptShots: number;
  characterTotal: number;
  characterReferences: number;
  sceneTotal: number;
  sceneReferences: number;
  sceneViewpoints: number;
  shots: number;
  firstFrames: number;
  optionalTailFrames: number;
  videos: number;
  failedImages: number;
  failedTailFrames: number;
  failedVideos: number;
  timelineClips: number;
}

export interface WorkflowInput {
  projectId: string | null;
  script?: ScriptProjectData | null;
  characters: Character[];
  scenes: Scene[];
  director?: DirectorProjectData | null;
  shareCharacters?: boolean;
  shareScenes?: boolean;
  timelineClips: number;
}

const hasImage = (value?: string | null) => Boolean(value?.trim());
const normalizeName = (value?: string) => value?.trim().toLocaleLowerCase() || '';

export function hasCharacterReference(character: Character): boolean {
  return hasImage(character.thumbnailUrl)
    || Boolean(character.views?.some(view => hasImage(view.imageBase64) || hasImage(view.imageUrl)))
    || Boolean(character.referenceImages?.some(hasImage))
    || Boolean(character.variations?.some(variation => hasImage(variation.referenceImage)));
}

/** Saved child viewpoints count even when their parent has no referenceImage. */
export function hasSceneReference(scene: Scene, scenes: Scene[], visited = new Set<string>()): boolean {
  if (visited.has(scene.id)) return false;
  visited.add(scene.id);
  if (hasImage(scene.referenceImage) || hasImage(scene.referenceImageBase64)) return true;
  return scenes.some(child => child.parentSceneId === scene.id && hasSceneReference(child, scenes, visited));
}

export function deriveWorkflowFacts(input: WorkflowInput): WorkflowFacts {
  const { projectId, script, characters, scenes, director } = input;
  const scriptCharacters = (script?.scriptData?.characters || []).filter(character => !character.stageCharacterIds?.length);
  const scriptScenes = script?.scriptData?.scenes || [];
  const characterGroups = scriptCharacters.length > 0
    ? scriptCharacters.map(character => {
      const libraryId = character.characterLibraryId || script?.characterIdMap?.[character.id];
      const linked = characters.filter(item => item.id === libraryId);
      return linked.length ? linked : characters.filter(item => (input.shareCharacters || item.projectId === projectId)
        && normalizeName(item.name) === normalizeName(character.name));
    })
    : characters.filter(character => character.projectId === projectId).map(character => [character]);
  const sceneGroups = scriptScenes.length > 0
    ? scriptScenes.map(scene => {
      const libraryId = scene.sceneLibraryId || script?.sceneIdMap?.[scene.id];
      const linked = scenes.filter(item => item.id === libraryId);
      const name = normalizeName(scene.name || scene.location);
      const location = normalizeName(scene.location);
      return linked.length ? linked : scenes.filter(item => (input.shareScenes || item.projectId === projectId) && !item.parentSceneId
        && ((name && normalizeName(item.name) === name) || (location && normalizeName(item.location) === location)));
    })
    : scenes.filter(scene => scene.projectId === projectId && !scene.parentSceneId).map(scene => [scene]);
  const shots = director?.splitScenes || [];
  const failed = (status?: string) => status === 'failed' || status === 'error';
  const calibration = script?.calibrationState;
  const busyStatuses = new Set(['parsing', 'generating', 'importing', 'calibrating', 'processing', 'analyzing']);
  const scriptBusy = [script?.parseStatus, script?.shotStatus, calibration?.importStatus,
    calibration?.titleCalibrationStatus, calibration?.characterCalibrationStatus,
    calibration?.sceneCalibrationStatus, calibration?.viewpointAnalysisStatus,
    calibration?.structureCompletionStatus, calibration?.synopsisStatus,
    ...Object.values(calibration?.singleShotCalibrationStatus || {})]
    .some(status => Boolean(status && busyStatuses.has(status)));
  const imported = Boolean(script?.scriptData && (script.scriptData.episodes?.length
    || script.scriptData.characters?.length || script.scriptData.scenes?.length || script.shots?.length))
    || Boolean(script?.episodeRawScripts?.some(episode => episode.rawContent?.trim()));
  return {
    imported,
    hasScriptText: Boolean(script?.rawScript?.trim()),
    scriptBusy,
    pendingCharacterCalibration: Boolean(calibration?.calibrationDialogOpen
      || calibration?.pendingCalibrationCharacters?.length),
    scriptShots: script?.shots?.length || 0,
    characterTotal: scriptCharacters.length || characterGroups.length,
    characterReferences: characterGroups.filter(group => group.some(hasCharacterReference)).length,
    sceneTotal: scriptScenes.length || sceneGroups.length,
    sceneReferences: sceneGroups.filter(group => group.some(scene => hasSceneReference(scene, scenes))).length,
    sceneViewpoints: scenes.filter(scene => scene.projectId === projectId && scene.parentSceneId
      && (hasImage(scene.referenceImage) || hasImage(scene.referenceImageBase64))).length,
    shots: shots.length,
    firstFrames: shots.filter(shot => !failed(shot.imageStatus)
      && (hasImage(shot.imageDataUrl) || hasImage(shot.imageHttpUrl))).length,
    optionalTailFrames: shots.filter(shot => shot.needsEndFrame
      && !failed(shot.endFrameStatus) && (hasImage(shot.endFrameImageUrl) || hasImage(shot.endFrameHttpUrl))).length,
    videos: shots.filter(shot => !failed(shot.videoStatus) && hasImage(shot.videoUrl)).length,
    failedImages: shots.filter(shot => failed(shot.imageStatus)).length,
    failedTailFrames: shots.filter(shot => failed(shot.endFrameStatus)).length,
    failedVideos: shots.filter(shot => failed(shot.videoStatus)).length,
    timelineClips: input.timelineClips,
  };
}

export interface WorkflowStage {
  tab: Tab;
  label: string;
  purpose: string;
  progress: string;
  status: 'done' | 'partial' | 'todo' | 'optional';
}

export function getWorkflowStages(facts: WorkflowFacts): WorkflowStage[] {
  return [
    {
      tab: 'script', label: '1 · 剧本与分镜文字',
      purpose: '导入全文，检查风格、角色、场景和自动生成的分镜；有误再校准。',
      progress: facts.pendingCharacterCalibration ? '角色校准结果待确认'
        : facts.scriptBusy ? '剧本任务处理中，完成后检查结果'
          : facts.imported ? `已导入 · ${facts.scriptShots} 个文字分镜` : '待导入或手动编写',
      status: facts.imported && facts.scriptShots > 0 && !facts.scriptBusy && !facts.pendingCharacterCalibration ? 'done'
        : facts.imported || facts.hasScriptText || facts.scriptBusy ? 'partial' : 'todo',
    },
    {
      tab: 'characters', label: '2 · 角色参考图',
      purpose: '为需要固定外观的角色准备设定图并保存，在导演里核对关联。',
      progress: facts.characterTotal ? `${facts.characterReferences}/${facts.characterTotal} 个角色找到参考图` : '按需准备，无人物镜头可跳过',
      status: facts.characterTotal === 0 ? 'optional'
        : facts.characterReferences >= facts.characterTotal ? 'done'
          : facts.characterReferences ? 'partial' : 'todo',
    },
    {
      tab: 'scenes', label: '3 · 场景参考图',
      purpose: '先准备地点参考图；同一地点需要不同机位时再补联合图或四视图。',
      progress: facts.sceneTotal ? `${facts.sceneReferences}/${facts.sceneTotal} 个场景找到参考图` : '按镜头需要准备',
      status: facts.sceneTotal === 0 ? 'optional'
        : facts.sceneReferences >= facts.sceneTotal ? 'done'
          : facts.sceneReferences ? 'partial' : 'todo',
    },
    {
      tab: 'director', label: '4 · 分镜图 → 视频',
      purpose: '为镜头关联角色与场景，先生成首帧，确认后再生成视频。',
      progress: `${facts.shots} 镜 · ${facts.firstFrames} 首帧 · ${facts.videos} 视频`,
      status: facts.shots > 0 && facts.videos >= facts.shots ? 'done'
        : facts.firstFrames || facts.videos ? 'partial' : 'todo',
    },
    {
      tab: 'export', label: '5 · 剪辑与导出',
      purpose: '把需要的素材放入时间线，检查顺序与时长，再选择导出格式。',
      progress: facts.timelineClips ? `时间线已有 ${facts.timelineClips} 个片段` : '等待添加片段',
      // A populated timeline does not prove that a file has been exported.
      status: facts.timelineClips ? 'partial' : 'todo',
    },
  ];
}

export interface WorkflowAdvice {
  title: string;
  description: string;
  action: { tab: Tab; label: string };
}

export function getWorkflowAdvice(tab: Tab, facts: WorkflowFacts): WorkflowAdvice {
  if (tab === 'settings') return {
    title: '把文字、生图、视频分别绑定到对应服务',
    description: 'OpenAI 文本模型用于剧本与理解，图片模型用于角色/场景/分镜，ComfyUI 工作流用于本地视频。',
    action: { tab: 'settings', label: '查看配置步骤' },
  };
  if (tab === 'characters') return facts.characterTotal > 0 && facts.characterReferences >= facts.characterTotal ? {
    title: '已有角色参考，接下来准备场景或核对导演关联',
    description: '外观、服装或年龄变化时再补设定图；库里有图片还需要在相应分镜选对角色。',
    action: { tab: 'scenes', label: '去场景库' },
  } : {
    title: '先把角色设定图生成并保存',
    description: '左侧控制台每次生成都会新建角色；预览后保存，再到导演选择对应版本。已有角色可在中间选中查看资料。',
    action: { tab: 'characters', label: '查看角色操作' },
  };
  if (tab === 'scenes') return facts.sceneTotal > 0 && facts.sceneReferences >= facts.sceneTotal ? {
    title: '已有场景参考，可以到导演核对镜头关联',
    description: '四视图是可选的机位补充；已有合适参考图就可以开始，不必每个场景都做四视图。',
    action: { tab: 'director', label: '去导演工作台' },
  } : {
    title: '先为需要的地点准备场景参考图',
    description: '先用单图跑通；需要多个区域用联合图，需要前后左右机位时再做四视图。生成后记得保存。',
    action: { tab: 'scenes', label: '查看场景操作' },
  };
  if (tab === 'assets') return {
    title: '按需要浏览视觉风格和维护道具参考',
    description: '这里管理内置风格、自定义风格和道具；角色形象、地点参考仍到角色页和场景页准备。',
    action: { tab: 'assets', label: '查看资产操作' },
  };
  if (tab === 'freedom') return {
    title: '自由板块适合先试一个图片或视频效果',
    description: '这是独立创作入口，不是主流程的必经步骤；模型与服务使用自由板块自己的映射。',
    action: { tab: 'freedom', label: '查看自由板块步骤' },
  };
  if (tab === 'sclass') return {
    title: 'S级是另一种镜头制作入口，可与导演按需选用',
    description: '先检查镜头提示词与参考图，再逐镜生成；无需为了主流程重复跑两个工作台。',
    action: { tab: 'sclass', label: '查看镜头操作' },
  };
  if (tab === 'media' || tab === 'export') return {
    title: facts.timelineClips ? '检查时间线后选择导出方式' : '先把需要的视频加入时间线',
    description: '生成出视频还不等于已经剪辑成片。先检查顺序、时长和声音，再在导出页生成交付文件。',
    action: facts.timelineClips
      ? { tab: 'export', label: '去导出' }
      : { tab: 'media', label: '去素材与时间线' },
  };
  if (tab === 'director') {
    if (!facts.shots) return {
      title: facts.scriptShots ? '把需要的文字分镜加入导演编辑' : '先准备分镜文字，再加入导演编辑',
      description: facts.scriptShots
        ? '在右侧“属性 / 剧本结构”展开场景，点击场景或分镜旁的 +。这一步只添加编辑条目，不会生成图片。'
        : '先在剧本页导入并检查分镜；已有分镜后，在右侧剧本结构点击 + 加入编辑。',
      action: facts.scriptShots
        ? { tab: 'director', label: '查看添加方法' }
        : { tab: 'script', label: '去剧本页' },
    };
    if (facts.failedImages || facts.failedVideos) return {
      title: `先处理 ${facts.failedImages + facts.failedVideos} 项失败的图片或视频`,
      description: '先看分镜卡片的具体报错。失效图片需要重新生成或上传；服务检查通过后再单镜重试。',
      action: { tab: 'director', label: '查看排错顺序' },
    };
    if (!facts.firstFrames) return {
      title: '先生成一个分镜首帧，确认画面后再批量生成',
      description: '角色和场景参考用于做好这一张画面；图生视频随后使用首帧，尾帧按模型和镜头需要补充。',
      action: { tab: 'director', label: '查看分镜成图步骤' },
    };
    if (!facts.videos) return {
      title: '已有首帧，先测试一个分镜的视频',
      description: facts.failedTailFrames
        ? '尾帧失败可重试，也可关闭尾帧选项先做视频。Wan 只用首帧；H3 的尾帧同样可选。'
        : '本地 ComfyUI Wan 工作流只用首帧；H3 可用首帧和可选尾帧。先确认单镜效果再批量。',
      action: { tab: 'director', label: '查看视频操作' },
    };
    return {
      title: '已有视频，继续剩余镜头或开始剪辑',
      description: `${facts.videos}/${facts.shots} 个分镜已有视频；把选好的素材加入时间线后再导出。`,
      action: { tab: 'media', label: '去素材与时间线' },
    };
  }
  if (facts.scriptBusy) return {
    title: '剧本任务正在处理，完成后先检查结果',
    description: '导入可能连续执行标题、大纲、视角分析和首集分镜。请看当前进度，避免重复提交同一任务。',
    action: { tab: 'script', label: '查看剧本进度' },
  };
  if (facts.pendingCharacterCalibration) return {
    title: '先确认待保存的角色校准结果',
    description: 'AI 已提出文字资料，仍需在剧本页确认；确认后再为实际需要的角色准备设定图。',
    action: { tab: 'script', label: '去确认角色资料' },
  };
  if (!facts.imported) return {
    title: facts.hasScriptText ? '检查剧本内容并完成导入' : '从导入完整剧本开始',
    description: '导入可能自动生成角色、场景和首集分镜；先检查结果，不需要重复点击所有校准按钮。',
    action: { tab: 'script', label: '去剧本页' },
  };
  if (facts.timelineClips > 0) return {
    title: '检查时间线，然后导出成片',
    description: `时间线已有 ${facts.timelineClips} 个片段；先检查顺序、时长和声音，再到导出页生成最终文件。`,
    action: { tab: 'export', label: '去检查导出' },
  };
  if (facts.videos > 0) return {
    title: facts.videos >= facts.shots ? '分镜视频已准备好，接下来整理时间线' : '继续剩余镜头，或先剪辑已有视频',
    description: `已有 ${facts.videos}/${facts.shots} 个分镜视频；保留满意的结果，无需从角色或首帧重新做起。`,
    action: facts.videos >= facts.shots
      ? { tab: 'media', label: '去素材与时间线' }
      : { tab: 'director', label: '去完成剩余镜头' },
  };
  if (facts.characterReferences < facts.characterTotal) return {
    title: '文字资料已有，下一步准备角色参考图',
    description: '先确认视觉风格与人物描述，再生成并保存设定图。AI 校准只整理文字，不会代替生图。',
    action: { tab: 'characters', label: '去角色库' },
  };
  if (facts.sceneReferences < facts.sceneTotal) return {
    title: '接下来准备场景参考图',
    description: '角色图与场景图可以并行准备；场景四视图只在需要更多机位时生成。',
    action: { tab: 'scenes', label: '去场景库' },
  };
  return {
    title: '检查文字分镜，然后进入导演工作台',
    description: '选好角色、场景和画面风格后，按“分镜首帧 → 视频 → 时间线”的顺序制作。',
    action: { tab: 'director', label: '去导演工作台' },
  };
}

export interface WorkflowPageInstructions {
  title: string;
  steps: string[];
  note: string;
}

export function getWorkflowInstructions(tab: Tab): WorkflowPageInstructions {
  switch (tab) {
    case 'script': return {
      title: '剧本页：得到可检查的角色、场景和分镜文字',
      steps: [
        '在输入区导入完整剧本或编写内容，先确认视觉风格与画面比例。',
        '检查自动提取的标题、角色、场景和分镜；导入后可能已自动处理首集，等待正在执行的任务完成。',
        '有错漏时再用对应的 AI 角色校准、场景校准或分镜生成，不需要无差别重复全部按钮。',
        '从角色或场景条目进入相应素材库准备图片；检查当前集分镜后再进入导演。',
      ],
      note: '校准 = 完善文字和提示词；生图 = 得到图片。角色参考和场景参考可以并行准备。',
    };
    case 'characters': return {
      title: '角色页：固定脸、服装和外观',
      steps: [
        '已有角色先在中间角色库选中查看资料；需要新形象时，在左侧控制台准备名称、描述和参考图。每次生成会新建角色，请避免重复创建。',
        '检查描述、视觉风格和上传参考。新角色的“生成设定图”默认包含三视图与表情设定。',
        '检查预览，点击“保存设定图”。只看见生成预览，还不算存好可引用的角色素材。',
        '回到导演，在分镜卡片关联相应角色；服装或年龄变化时再补对应造型参考。',
      ],
      note: '角色设定图可以是一张完整排版图，不必拆成四张。这里的角色设定图与场景页“四视图”用途不同。',
    };
    case 'scenes': return {
      title: '场景页：先有地点参考，再按需补机位',
      steps: [
        '先选已有场景或填写地点、时间和风格。刚开始可用单图模式，生成后点击“保存概念图”。',
        '需要同一地点的不同区域时用联合图。“生成联合图（自动切割并保存）”会生成并保存视角子场景。',
        '需要前、后、左、右的正交机位时再用“四视图”：生成或上传 → 切割 → 保存视角图片到场景。',
        '在导演的场景选择器里，选择父场景参考或具体视角。已有合适参考图就能开始成图。',
      ],
      note: '四视图是可选的场景机位参考，不是最终分镜图，也不是生成视频前每个场景都必须完成的任务。',
    };
    case 'director': return {
      title: '导演页：先画面，再运动，再剪辑',
      steps: [
        '右侧“属性 / 剧本结构”展开场景，点击场景或分镜旁的 + 加入编辑。不要重复添加同一批分镜。',
        '核对分镜内容、角色和场景关联；没有人物的环境镜头可以不选角色。单图逐镜出图，合并生成批量出网格并切回各镜，都不是视频拼接。',
        '先为一个分镜生成首帧或上传图片，确认构图、人物和场景正确，再批量生成其他首帧。',
        '镜头需要结束构图且模型支持时再补尾帧。本地 ComfyUI Wan 工作流忽略尾帧；H3 可使用首尾帧。',
        '点击该分镜的生成视频，先测试短镜头。图片失败先修图片；视频失败查看卡片报错并检查当前服务。',
        '挑选视频加入时间线，检查镜头衔接后到导出页。',
      ],
      note: '导演的图生视频使用分镜首帧和可选尾帧；角色/场景参考应先用于生成正确的分镜画面。',
    };
    case 'settings': return {
      title: '设置页：分别配置文字、图片和视频服务',
      steps: [
        '在 API 管理中添加服务地址与模型。自定义本地服务允许不填 Key；远程服务按供应商要求填写。',
        '在服务映射中，剧本分析/对话选文字模型，图片生成选图片模型，图片理解选支持视觉的模型。',
        '视频生成绑定对应视频模型；原生 ComfyUI 当前支持这两个火宝工作流：Wan 2.2 5B 与 MiniMax H3 Reference Turbo。',
        '自由图片/视频使用各自的自由板块映射，未单独配置时检查界面提示的回退模型。',
        '检查服务连接后先单张、单镜生成，确认效果再批量。不要把连接在线当成已经生成完成。',
      ],
      note: '原生 ComfyUI 地址填 http://127.0.0.1:8188，服务需要保持运行。文字模型、生图模型与视频工作流不能相互替代。',
    };
    case 'assets': return {
      title: '资产页：管理视觉风格与道具参考',
      steps: [
        '在左侧选择内置风格、自定义风格或道具库，浏览和维护需要的资料。',
        '准备生成时，在剧本或对应生成控制台确认视觉风格；不需要先新建自定义风格才能开始。',
        '角色形象到角色页生成并保存，地点参考到场景页准备，再到导演制作镜头画面。',
      ],
      note: '资产页提供风格与道具资料，不会自动生成分镜图片或视频。',
    };
    case 'freedom': return {
      title: '自由板块：独立测试单个效果',
      steps: [
        '先选择图片或视频模式，再核对界面显示的服务和模型。',
        '生图输入提示词并按需加入参考；图生视频先放入首帧，再按模型支持补充尾帧。',
        '先生成一个结果，保存或加入素材库；需要进入正片时再加入时间线。',
      ],
      note: '自由板块可以独立使用，不会自动替代剧本、角色库、场景库的准备工作。',
    };
    case 'sclass': return {
      title: 'S级：另一种分镜制作入口',
      steps: [
        '先准备镜头文字、角色和场景参考，检查每镜的图片与视频提示词。',
        '先生成一个镜头画面，再生成该镜的视频；有报错时先处理单镜。',
        '把选中的结果加入时间线或继续剪辑；可以与导演工作台按需选用。',
      ],
      note: 'S级与导演不是前后必经的两个步骤，不需要为同一镜头强制重复生成。',
    };
    case 'media':
    case 'export': return {
      title: '剪辑与导出：把生成结果变成可交付文件',
      steps: [
        '在素材库挑选要使用的视频、图片和音频，添加到时间线。',
        '检查片段顺序、时长、转场和声音，预览实际使用的结果。',
        '到导出页选择所需格式并导出。时间线已有片段不代表已经导出成文件。',
      ],
      note: '本页引导读取当前时间线的片段数，不会自动移动或替换你的素材。',
    };
    default: return {
      title: '从文字到成片的建议路线',
      steps: [
        '导入剧本并检查文字资料与分镜。已有文字内容也可以手动编辑。',
        '准备需要的角色参考和场景参考；两者可并行，场景四视图按需补。',
        '在导演逐镜生成首帧，确认画面后生成视频。先跑通一个镜头，再批量。',
        '把选中的结果加入时间线，检查后导出。自由板块与S级是可选入口。',
      ],
      note: '进度按本项目已保存的数据更新；图片有地址不代表远程图片仍可访问，失败时以卡片实际报错为准。',
    };
  }
}
