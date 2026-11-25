import { describe, expect, it } from 'vitest';
import {
  TOOLBOX_TOOL_DEFINITIONS,
  TOOLBOX_TOOL_IDS,
  getToolboxToolDefinition,
  toolboxOutputSchema,
  type ToolboxInputs,
  type ToolboxToolId,
} from '@fanxiaoshuo/shared';
import {
  buildToolboxPrompts,
  parseToolboxOutput,
  resolveToolboxRecommendedCategory,
  type ToolboxBookContext,
} from '../prompts/toolbox.js';

/** 6 个工具的合法最小输入（必填字段 + 省略可选字段以验证默认值说明）。 */
const VALID_INPUTS: Record<ToolboxToolId, ToolboxInputs> = {
  'book-pitch': {
    genre: '都市异能',
    coreHook: '落魄法医继承亡者记忆，靠破悬案翻盘',
    audience: '男频爽文',
  },
  'character-designer': {
    rolePosition: '主角',
    archetype: '背负血仇的落魄医修',
  },
  'world-faction-builder': {
    cardCategory: 'faction',
    theme: '以音律为修行根基的六大乐坊',
  },
  'golden-finger-designer': {
    powerStyle: '系统面板',
    coreMechanic: '每完成一次委托可获得一次模拟推演',
  },
  'plot-hook-brainstorm': {
    currentSituation: '主角刚击败内门大师兄，宗门开始怀疑他的功法来源',
    conflictType: '危机升级',
  },
  'text-polish-diagnose': {
    excerpt: '他走进大殿，所有人都看着他，空气安静了下来。',
    focus: '综合诊断与节奏',
  },
};

const BOOK_CONTEXT: ToolboxBookContext = {
  title: '断剑问天',
  genre: '东方玄幻',
  synopsis: '少年持断剑北上问道，最终补全剑道。',
  outline: {
    mainPlot: '少年持断剑北上问道，逐层揭开剑道崩坏的真相',
    worldSetting: '九州灵气衰微，剑修以命换锋',
    styleGuide: '冷峻克制，不写市井插科打诨',
    endingPlan: '剑归九州，主角自断长生',
  },
  cards: [
    {
      category: 'character',
      title: '沈青梧',
      summary: '主角，剑修，性格克制',
      content: '出身寒门，凭一柄断剑入道。',
      pinned: false,
    },
    {
      category: 'faction',
      title: '问剑宗',
      summary: '正道第一大派，规矩森严',
      pinned: true,
    },
  ],
};

describe('buildToolboxPrompts（6 个内置工具）', () => {
  it.each(TOOLBOX_TOOL_IDS)('%s 生成包含任务说明与严格 JSON 纪律的提示词', (toolId) => {
    const definition = getToolboxToolDefinition(toolId);
    expect(definition).toBeDefined();

    const prompts = buildToolboxPrompts({ toolId, inputs: VALID_INPUTS[toolId] });

    expect(prompts.system).toContain(`创作工具盒 · ${definition?.name ?? ''}`);
    expect(prompts.system).toContain('输出纪律');
    expect(prompts.system).toContain('"overview"');
    expect(prompts.system).toContain('"items"');
    expect(prompts.system).toContain('suggestedCardCategory');
    expect(prompts.system).toContain('character|world|faction|item|location|plot');
    expect(prompts.prompt).toContain('【本次输入】');
    expect(prompts.prompt).toContain('请仅输出符合要求的 JSON 对象。');
    expect(prompts.prompt).not.toContain('关联作品上下文');
  });

  it('为每个工具渲染出差异化的原创任务方法论', () => {
    const pitch = buildToolboxPrompts({
      toolId: 'book-pitch',
      inputs: { ...VALID_INPUTS['book-pitch'], count: 5 },
    });
    expect(pitch.system).toContain('书名');
    expect(pitch.system).toContain('简介');
    expect(pitch.system).toContain('5 条结果');
    expect(pitch.prompt).toContain('都市异能');
    expect(pitch.prompt).toContain('男频爽文');

    const character = buildToolboxPrompts({
      toolId: 'character-designer',
      inputs: { ...VALID_INPUTS['character-designer'], backgroundHint: '寒门医修世家' },
    });
    expect(character.system).toContain('人物弧光');
    expect(character.system).toContain('成长弧线');
    expect(character.prompt).toContain('落魄医修');
    expect(character.prompt).toContain('寒门医修世家');

    const world = buildToolboxPrompts({
      toolId: 'world-faction-builder',
      inputs: { ...VALID_INPUTS['world-faction-builder'], constraints: '不得出现越阶战力' },
    });
    expect(world.system).toContain('势力组织');
    expect(world.system).toContain('运行规则');
    expect(world.prompt).toContain('以音律为修行根基的六大乐坊');
    expect(world.prompt).toContain('不得出现越阶战力');

    const goldenFinger = buildToolboxPrompts({
      toolId: 'golden-finger-designer',
      inputs: { ...VALID_INPUTS['golden-finger-designer'], limitation: '每次推演消耗一年寿命' },
    });
    expect(goldenFinger.system).toContain('成长曲线');
    expect(goldenFinger.system).toContain('开局无敌');
    expect(goldenFinger.prompt).toContain('系统面板');
    expect(goldenFinger.prompt).toContain('每次推演消耗一年寿命');

    const plot = buildToolboxPrompts({
      toolId: 'plot-hook-brainstorm',
      inputs: { ...VALID_INPUTS['plot-hook-brainstorm'], count: 4 },
    });
    expect(plot.system).toContain('章尾钩子');
    expect(plot.system).toContain('升级路径');
    expect(plot.prompt).toContain('宗门开始怀疑他的功法来源');

    const polish = buildToolboxPrompts({
      toolId: 'text-polish-diagnose',
      inputs: VALID_INPUTS['text-polish-diagnose'],
    });
    expect(polish.system).toContain('不重写全文');
    expect(polish.system).toContain('改写示范');
    expect(polish.prompt).toContain('"""');
    expect(polish.prompt).toContain('空气安静了下来');
  });

  it('注入 Book Bible 上下文：题材、简介、总大纲与置顶优先的设定卡', () => {
    const prompts = buildToolboxPrompts({
      toolId: 'character-designer',
      inputs: VALID_INPUTS['character-designer'],
      bookContext: BOOK_CONTEXT,
    });

    expect(prompts.prompt).toContain('【关联作品上下文');
    expect(prompts.prompt).toContain('《断剑问天》');
    expect(prompts.prompt).toContain('东方玄幻');
    expect(prompts.prompt).toContain('少年持断剑北上问道');
    expect(prompts.prompt).toContain('九州灵气衰微');
    expect(prompts.prompt).toContain('冷峻克制');
    expect(prompts.prompt).toContain('剑归九州');
    expect(prompts.prompt).toContain('【人物】沈青梧');
    expect(prompts.prompt).toContain('【势力】问剑宗（置顶）');
  });

  it('设定卡最多注入 8 张且置顶卡优先，超出的卡片不进入提示词', () => {
    const cards = Array.from({ length: 10 }, (_value, index) => ({
      category: 'world' as const,
      title: `常规设定${index + 1}`,
      summary: `常规设定摘要 ${index + 1}`,
    }));
    const prompts = buildToolboxPrompts({
      toolId: 'world-faction-builder',
      inputs: VALID_INPUTS['world-faction-builder'],
      bookContext: {
        title: '测试作品',
        cards: [
          ...cards,
          { category: 'character', title: '末位置顶人物', summary: '置顶摘要', pinned: true },
          { category: 'faction', title: '末位置顶势力', summary: '置顶摘要', pinned: true },
        ],
      },
    });

    expect(prompts.prompt).toContain('末位置顶人物（置顶）');
    expect(prompts.prompt).toContain('末位置顶势力（置顶）');
    expect(prompts.prompt).toContain('常规设定1');
    expect(prompts.prompt).not.toContain('常规设定9');
    expect(prompts.prompt).not.toContain('常规设定10');

    const cardLines = prompts.prompt
      .split('\n')
      .filter((line) => line.startsWith('- 【') && line.includes('】'));
    expect(cardLines).toHaveLength(8);
  });

  it('world-faction-builder 以输入 cardCategory 作为推荐分类（location → world / plot → foreshadowing）', () => {
    expect(resolveToolboxRecommendedCategory('world-faction-builder', { cardCategory: 'location' })).toBe(
      'world',
    );
    expect(resolveToolboxRecommendedCategory('world-faction-builder', { cardCategory: 'plot' })).toBe(
      'foreshadowing',
    );
    expect(resolveToolboxRecommendedCategory('world-faction-builder', { cardCategory: 'faction' })).toBe(
      'faction',
    );
    expect(resolveToolboxRecommendedCategory('character-designer')).toBe('character');

    const locationPrompts = buildToolboxPrompts({
      toolId: 'world-faction-builder',
      inputs: { cardCategory: 'location', theme: '浮空城' },
    });
    expect(locationPrompts.system).toContain('地点/场景');
    expect(locationPrompts.system).toContain('"world"');
    expect(locationPrompts.prompt).toContain('浮空城');

    const plotPrompts = buildToolboxPrompts({
      toolId: 'world-faction-builder',
      inputs: { cardCategory: 'plot', theme: '宗门叛变' },
    });
    expect(plotPrompts.system).toContain('"foreshadowing"');
  });

  it('6 个工具的元数据与输入渲染保持契约一致（防止目录漂移）', () => {
    for (const definition of TOOLBOX_TOOL_DEFINITIONS) {
      const inputs = VALID_INPUTS[definition.id];
      for (const field of definition.fields) {
        if (field.required) {
          expect(inputs[field.key]).toBeDefined();
        }
      }
    }
  });
});

describe('parseToolboxOutput（结构化解析与归一化）', () => {
  it('剥离 Markdown ```json 代码块并解析 overview 与 items', () => {
    const raw = [
      '好的，结果如下：',
      '```json',
      JSON.stringify({
        overview: '人物卡整体围绕「克制的剑修」展开。',
        items: [
          {
            title: '沈青梧',
            summary: '克制到近乎冷酷的剑修',
            content: '基础档案：二十四岁，寒门出身。',
            aliases: ['青梧'],
            tags: ['主角', '剑修'],
            suggestedCardCategory: 'character',
          },
          {
            title: '柳如是',
            summary: '宗门里唯一愿意为他担保的人',
            content: '基础档案：问剑宗执法堂首座。',
            suggestedCardCategory: 'character',
          },
        ],
      }),
      '```',
    ].join('\n');

    const output = parseToolboxOutput(raw, 'character-designer');

    expect(output.overview).toContain('克制的剑修');
    expect(output.items).toHaveLength(2);
    expect(output.items[0]?.title).toBe('沈青梧');
    expect(output.items[0]?.aliases).toEqual(['青梧']);
    expect(output.items[1]?.tags).toEqual([]);
    expect(toolboxOutputSchema.safeParse(output).success).toBe(true);
  });

  it('兼容 JSON 数组、单条对象条目与字符串条目', () => {
    const arrayOutput = parseToolboxOutput(
      JSON.stringify([{ title: '方案一', content: '正文一' }]),
      'book-pitch',
    );
    expect(arrayOutput.overview).toBe('');
    expect(arrayOutput.items).toHaveLength(1);
    expect(arrayOutput.items[0]?.title).toBe('方案一');

    const singleObjectOutput = parseToolboxOutput(
      JSON.stringify({
        overview: '总览',
        items: { title: '单条方案', summary: '摘要', content: '正文' },
      }),
      'plot-hook-brainstorm',
    );
    expect(singleObjectOutput.items).toHaveLength(1);
    expect(singleObjectOutput.items[0]?.title).toBe('单条方案');

    const stringItemOutput = parseToolboxOutput(
      JSON.stringify({ overview: '总览', items: ['第一条纯文本结果', '第二条纯文本结果'] }),
      'text-polish-diagnose',
    );
    expect(stringItemOutput.items).toHaveLength(2);
    expect(stringItemOutput.items[0]?.content).toBe('第一条纯文本结果');
    expect(stringItemOutput.items[0]?.suggestedCardCategory).toBe('world');
  });

  it('抽取夹杂说明文本中的首个 JSON 对象', () => {
    const raw = '下面是结果：{"overview":"总览","items":[{"title":"危机升级","content":"触发点：宗门大比"}]} 希望对你有帮助。';
    const output = parseToolboxOutput(raw, 'plot-hook-brainstorm');
    expect(output.overview).toBe('总览');
    expect(output.items[0]?.title).toBe('危机升级');
    expect(output.items[0]?.suggestedCardCategory).toBe('foreshadowing');
  });

  it('缺字段时补齐空摘要 / 空正文 / 空别名 / 空标签，并回退默认分类', () => {
    const output = parseToolboxOutput(
      JSON.stringify({ overview: '总览', items: [{ title: '仅标题条目' }] }),
      'golden-finger-designer',
    );

    const item = output.items[0];
    expect(item?.title).toBe('仅标题条目');
    expect(item?.summary).toBe('');
    expect(item?.content).toBe('');
    expect(item?.aliases).toEqual([]);
    expect(item?.tags).toEqual([]);
    expect(item?.suggestedCardCategory).toBe('item');
    expect(toolboxOutputSchema.safeParse(output).success).toBe(true);
  });

  it('超长文本按共享契约上限安全截断，别名与标签去重限量', () => {
    const output = parseToolboxOutput(
      JSON.stringify({
        overview: '概'.repeat(3_000),
        items: [
          {
            title: '标'.repeat(300),
            summary: '摘'.repeat(900),
            content: '文'.repeat(9_000),
            aliases: Array.from({ length: 15 }, (_value, index) => `别名${index}${'长'.repeat(100)}`),
            tags: Array.from({ length: 15 }, (_value, index) => `标签${index}${'长'.repeat(60)}`),
            suggestedCardCategory: 'character',
          },
        ],
      }),
      'character-designer',
    );

    const item = output.items[0];
    expect(output.overview).toHaveLength(2_000);
    expect(item?.title).toHaveLength(120);
    expect(item?.summary).toHaveLength(500);
    expect(item?.content).toHaveLength(8_000);
    expect(item?.aliases).toHaveLength(10);
    expect(item?.aliases.every((alias) => alias.length <= 60)).toBe(true);
    expect(item?.tags).toHaveLength(10);
    expect(item?.tags.every((tag) => tag.length <= 30)).toBe(true);
    expect(toolboxOutputSchema.safeParse(output).success).toBe(true);
  });

  it('items 超过 10 条时截断，非法分类回退到 preferredCategory', () => {
    const items = Array.from({ length: 14 }, (_value, index) => ({
      title: `结果${index + 1}`,
      content: `正文${index + 1}`,
      suggestedCardCategory: '不存在的分类',
    }));

    const output = parseToolboxOutput(
      JSON.stringify({ overview: '总览', items }),
      'book-pitch',
      'foreshadowing',
    );

    expect(output.items).toHaveLength(10);
    expect(output.items.every((item) => item.suggestedCardCategory === 'foreshadowing')).toBe(true);
  });

  it('location / plot 语义分类确定性映射为契约分类', () => {
    const output = parseToolboxOutput(
      JSON.stringify({
        overview: '总览',
        items: [
          { title: '浮空城', content: '地点', suggestedCardCategory: 'location' },
          { title: '宗门叛变', content: '剧情', suggestedCardCategory: 'plot' },
          { title: '沈青梧', content: '人物', suggestedCardCategory: 'character' },
        ],
      }),
      'world-faction-builder',
    );

    expect(output.items[0]?.suggestedCardCategory).toBe('world');
    expect(output.items[1]?.suggestedCardCategory).toBe('foreshadowing');
    expect(output.items[2]?.suggestedCardCategory).toBe('character');
  });

  it('纯文本输出降级为 1 条结构化结果并保留原文', () => {
    const raw = '【核心目标】守住山门\n【章尾钩子】山门外传来第二声钟响。';
    const output = parseToolboxOutput(raw, 'plot-hook-brainstorm');

    expect(output.items).toHaveLength(1);
    expect(output.items[0]?.title).toBe('剧情冲突与章尾钩子脑暴结果');
    expect(output.items[0]?.content).toBe(raw);
    expect(output.items[0]?.summary).toBe('【核心目标】守住山门');
    expect(output.items[0]?.suggestedCardCategory).toBe('foreshadowing');
    expect(toolboxOutputSchema.safeParse(output).success).toBe(true);
  });

  it('空文本与损坏 JSON 都不抛异常，始终返回合法结构', () => {
    expect(() => parseToolboxOutput('', 'book-pitch')).not.toThrow();
    expect(() => parseToolboxOutput('{{{ broken json', 'book-pitch')).not.toThrow();
    expect(() => parseToolboxOutput('{"overview":"总览","items":[]}', 'book-pitch')).not.toThrow();

    for (const raw of ['', '{{{ broken json', '{"overview":"总览","items":[]}']) {
      const output = parseToolboxOutput(raw, 'book-pitch');
      expect(output.items).toHaveLength(1);
      expect(toolboxOutputSchema.safeParse(output).success).toBe(true);
    }
  });
});
