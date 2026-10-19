// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, BookOpen, CheckCircle2, Circle, Compass, Loader2, PlugZap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { deriveWorkflowFacts, getWorkflowAdvice, getWorkflowInstructions, getWorkflowStages } from '@/lib/workflow-guide';
import type { WorkflowFacts } from '@/lib/workflow-guide';
import { testProviderConnection } from '@/lib/ai/provider-connection';
import type { ProviderConnectionTestResult } from '@/lib/ai/provider-connection';
import { getComfyUIVideoModelKind, getComfyUIVideoUnsupportedReason, isComfyUIProvider } from '@/lib/provider-config';
import type { IProvider } from '@/lib/api-key-manager';
import { useProjectStore } from '@/stores/project-store';
import { useAppSettingsStore } from '@/stores/app-settings-store';
import { useScriptStore } from '@/stores/script-store';
import { useCharacterLibraryStore } from '@/stores/character-library-store';
import { useSceneStore } from '@/stores/scene-store';
import { useDirectorStore } from '@/stores/director-store';
import { useSimpleTimelineStore } from '@/stores/simple-timeline-store';
import { useMediaPanelStore } from '@/stores/media-panel-store';
import type { Tab } from '@/stores/media-panel-store';
import { useAPIConfigStore } from '@/stores/api-config-store';

interface ServiceInfo {
  label: string;
  optional?: boolean;
  bindings: Array<{ provider: IProvider; model: string }>;
}

function useWorkflowContext() {
  const projectId = useProjectStore(state => state.activeProjectId);
  const script = useScriptStore(state => projectId ? state.projects[projectId] : undefined);
  const director = useDirectorStore(state => projectId ? state.projects[projectId] : undefined);
  const characters = useCharacterLibraryStore(state => state.characters);
  const scenes = useSceneStore(state => state.scenes);
  const sharing = useAppSettingsStore(state => state.resourceSharing);
  const clips = useSimpleTimelineStore(state => state.clips);
  const tab = useMediaPanelStore(state => state.activeTab);
  const navigate = useMediaPanelStore(state => state.setActiveTab);
  const providers = useAPIConfigStore(state => state.providers);
  const bindings = useAPIConfigStore(state => state.featureBindings);
  const getProvidersForFeature = useAPIConfigStore(state => state.getProvidersForFeature);
  const facts = useMemo(() => deriveWorkflowFacts({
    projectId, script, director,
    shareCharacters: sharing.shareCharacters, shareScenes: sharing.shareScenes,
    characters: sharing.shareCharacters ? characters : characters.filter(character => character.projectId === projectId),
    scenes: sharing.shareScenes ? scenes : scenes.filter(scene => scene.projectId === projectId),
    timelineClips: clips.length,
  }), [projectId, script, director, characters, scenes, sharing, clips.length]);
  const imageBindings = getProvidersForFeature('character_generation');
  const videoBindings = getProvidersForFeature('video_generation');
  const freedomImageBindings = tab === 'freedom' ? getProvidersForFeature('freedom_image') : [];
  const freedomVideoBindings = tab === 'freedom' ? getProvidersForFeature('freedom_video') : [];
  const services: ServiceInfo[] = [
    { label: '文字 · 剧本/校准', bindings: getProvidersForFeature('script_analysis') },
    { label: '图片 · 角色/场景/分镜', bindings: imageBindings },
    { label: '视频 · 导演', bindings: videoBindings },
    { label: '图片理解 · 分析参考图', bindings: getProvidersForFeature('image_understanding'), optional: true },
    ...(tab === 'freedom' ? [
      { label: freedomImageBindings.length ? '自由图片 · 独立映射' : '自由图片 · 沿用图片生成', bindings: freedomImageBindings.length ? freedomImageBindings : imageBindings },
      { label: freedomVideoBindings.length ? '自由视频 · 独立映射' : '自由视频 · 沿用视频生成', bindings: freedomVideoBindings.length ? freedomVideoBindings : videoBindings },
    ] : []),
  ];
  return { tab, navigate, facts, services, providers, bindings };
}

function WorkflowRoadmap({ facts, tab, onNavigate }: {
  facts: WorkflowFacts;
  tab: Tab;
  onNavigate: (tab: Tab) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5" data-testid="workflow-roadmap">
      {getWorkflowStages(facts).map(stage => {
        const Icon = stage.status === 'done' ? CheckCircle2 : Circle;
        return (
          <button
            key={stage.tab}
            type="button"
            aria-current={tab === stage.tab ? 'step' : undefined}
            onClick={() => onNavigate(stage.tab)}
            className={cn('rounded-lg border bg-background/60 p-3 text-left transition-colors hover:border-primary/50 hover:bg-primary/5',
              tab === stage.tab && 'border-primary/60 bg-primary/5')}
          >
            <span className="flex items-center gap-1.5 text-xs font-semibold">
              <Icon className={cn('h-3.5 w-3.5 shrink-0', stage.status === 'done' ? 'text-emerald-500' : 'text-muted-foreground')} />
              {stage.label}
            </span>
            <span className="mt-2 block text-xs leading-5 text-foreground/80">{stage.purpose}</span>
            <span className="mt-2 block text-[11px] leading-4 text-muted-foreground">{stage.progress}</span>
          </button>
        );
      })}
    </div>
  );
}

function WorkflowServices({ services, providers, bindings, onNavigate }: {
  services: ServiceInfo[];
  providers: IProvider[];
  bindings: Record<string, unknown>;
  onNavigate: (tab: Tab) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [results, setResults] = useState<Record<string, ProviderConnectionTestResult>>({});
  const checkEpoch = useRef(0);
  useEffect(() => {
    checkEpoch.current += 1;
    setResults({});
    setChecking(false);
    return () => { checkEpoch.current += 1; };
  }, [providers, bindings]);

  const checkServices = async () => {
    const epoch = ++checkEpoch.current;
    setChecking(true);
    setResults({});
    const unique = new Map(services.flatMap(service => service.bindings).map(binding => [binding.provider.id, binding.provider]));
    const checked = await Promise.all([...unique.values()].map(async provider => {
      try {
        return [provider.id, await testProviderConnection(provider)] as const;
      } catch {
        return [provider.id, { success: false, message: '连接检查未完成，请到设置查看服务地址。' }] as const;
      }
    }));
    if (checkEpoch.current !== epoch) return;
    setResults(Object.fromEntries(checked));
    setChecking(false);
  };

  return (
    <section className="rounded-lg border bg-muted/20 p-3" data-testid="workflow-services">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="flex items-center gap-1.5 text-sm font-medium"><PlugZap className="h-4 w-4" />当前绑定的服务</h4>
          <p className="mt-1 text-xs text-muted-foreground">检查连接不会提交图片或视频任务；实际生成以任务结果为准。</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={checking || services.every(service => !service.bindings.length)} onClick={checkServices}>
            {checking && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            {checking ? '正在检查…' : '检查当前服务'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onNavigate('settings')}>去设置</Button>
        </div>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {services.map(service => (
          <div key={service.label} className="min-w-0 rounded border bg-background/50 p-2.5">
            <p className="text-xs font-medium">{service.label}</p>
            {!service.bindings.length ? (
              <p className="mt-1 text-xs text-amber-500">{service.optional ? '可按需配置参考图理解服务' : '尚未绑定，先到设置关联模型'}</p>
            ) : service.bindings.map(({ provider, model }) => {
              const result = results[provider.id];
              const native = isComfyUIProvider(provider);
              const reason = native ? getComfyUIVideoUnsupportedReason(provider, model) : undefined;
              const kind = native ? getComfyUIVideoModelKind(model) : undefined;
              return (
                <div key={`${provider.id}:${model}`} className="mt-1.5 text-[11px] leading-4">
                  <p className="font-medium text-foreground/80">{provider.name}</p>
                  <p className="break-all text-muted-foreground">{model}</p>
                  {kind && <p className="mt-1 text-muted-foreground">{kind === 'wan' ? '本地 Wan · 首帧，不使用尾帧' : '本地 H3 · 可用首帧/尾帧'}</p>}
                  {reason && <p className="mt-1 text-amber-500">{reason}</p>}
                  {result && (
                    <p role="status" className={cn('mt-1', result.success ? 'text-emerald-500' : 'text-red-500')}>
                      {result.success ? '服务连接正常' : result.message}
                      {result.warning && <span className="block text-amber-500">{result.warning}</span>}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}

function WorkflowExplanations() {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <section className="rounded-lg border border-primary/20 bg-primary/5 p-3">
        <h4 className="text-sm font-medium">什么时候做场景四视图？</h4>
        <p className="mt-1.5 text-xs leading-5 text-foreground/80">先有一张地点参考图就能开始。需要同一地点的不同区域时用联合图；需要前、后、左、右的正交机位时再补四视图。生成后切割并保存为视角子场景，再到导演选择。</p>
        <p className="mt-1 text-xs leading-5 text-primary">四视图可选，不需要为每个场景、每个角色都做。</p>
      </section>
      <section className="rounded-lg border bg-muted/20 p-3">
        <h4 className="text-sm font-medium">这几类资料各自做什么？</h4>
        <ul className="mt-1.5 space-y-1 text-xs leading-5 text-foreground/80">
          <li>AI 校准：整理文字与提示词，不会自动生图。</li>
          <li>角色设定图：固定脸、服装和外观，生成后保存。</li>
          <li>场景参考图：固定地点和空间，按需补不同机位。</li>
          <li>分镜首帧：最终镜头的画面，用于接下来的图生视频。</li>
        </ul>
      </section>
    </div>
  );
}

export function WorkflowGuide() {
  const context = useWorkflowContext();
  const { tab, facts, navigate } = context;
  const [open, setOpen] = useState(false);
  const advice = getWorkflowAdvice(tab, facts);
  const instructions = getWorkflowInstructions(tab);
  useEffect(() => {
    const showHelp = () => setOpen(true);
    window.addEventListener('moyin:workflow-help', showHelp);
    return () => window.removeEventListener('moyin:workflow-help', showHelp);
  }, []);
  const go = (next: Tab) => {
    setOpen(false);
    navigate(next);
  };
  const followAdvice = () => {
    if (advice.action.tab === tab) setOpen(true);
    else go(advice.action.tab);
  };
  return (
    <section id="workflow-guide" className="shrink-0 border-b border-primary/15 bg-primary/[0.035] px-4 py-2" data-testid="workflow-guide">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Compass className="hidden h-5 w-5 shrink-0 text-primary sm:block" />
        <div className="min-w-0 flex-1 basis-64">
          <p className="text-xs font-semibold text-foreground">{advice.title}</p>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{advice.description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}><BookOpen className="mr-1 h-3.5 w-3.5" />步骤与服务</Button>
          <Button size="sm" onClick={followAdvice}>
            {advice.action.tab === tab ? '查看本页步骤' : advice.action.label}
            <ArrowRight className="ml-1 h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[88vh] max-w-5xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{instructions.title}</DialogTitle>
            <DialogDescription>按当前页面说明操作；路线供参考，不会强制锁住其他页面。</DialogDescription>
          </DialogHeader>
          <ol className="space-y-2.5">
            {instructions.steps.map((step, index) => (
              <li key={step} className="flex gap-3 text-sm leading-6">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{index + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
          <p className="rounded-md bg-muted/50 p-3 text-xs leading-5 text-muted-foreground">{instructions.note}</p>
          <div>
            <h4 className="mb-2 text-sm font-medium">本项目已保存的资料</h4>
            <WorkflowRoadmap facts={facts} tab={tab} onNavigate={go} />
            <p className="mt-2 text-[11px] text-muted-foreground">角色/场景按已有链接或当前可见素材库名称查找参考；有素材后仍需在导演核对镜头关联。远程图片是否可用以实际请求为准。</p>
          </div>
          <WorkflowExplanations />
          <WorkflowServices services={context.services} providers={context.providers} bindings={context.bindings} onNavigate={go} />
        </DialogContent>
      </Dialog>
    </section>
  );
}

export function WorkflowOverview() {
  const context = useWorkflowContext();
  const { facts, tab, navigate } = context;
  const advice = getWorkflowAdvice('overview', facts);
  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 p-5" data-testid="workflow-overview">
      <div>
        <p className="text-xs font-medium text-primary">制作导航 · 根据本项目资料更新</p>
        <h3 className="mt-1 text-xl font-semibold">知道现在做什么，也知道下一步去哪</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">先用一个镜头跑通“参考图 → 分镜首帧 → 视频”。角色与场景可以并行准备，四视图和额外工作台按需要使用。</p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/5 p-4">
        <div className="min-w-0 flex-1 basis-64">
          <p className="text-sm font-medium">当前建议：{advice.title}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{advice.description}</p>
        </div>
        <Button onClick={() => navigate(advice.action.tab)}>{advice.action.label}<ArrowRight className="ml-1.5 h-4 w-4" /></Button>
      </div>
      <WorkflowRoadmap facts={facts} tab={tab} onNavigate={navigate} />
      <p className="text-xs leading-5 text-muted-foreground">进度按本项目已保存的数据统计；已有参考不代表每个镜头已经关联，进入导演后请再检查。素材库预览成功但未保存时，不计入已保存参考。</p>
      <WorkflowExplanations />
      <WorkflowServices services={context.services} providers={context.providers} bindings={context.bindings} onNavigate={navigate} />
    </div>
  );
}
