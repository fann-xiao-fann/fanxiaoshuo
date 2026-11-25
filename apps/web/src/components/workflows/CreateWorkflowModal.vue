<script setup lang="ts">
import {
  CHAPTER_STATUS_LABELS,
  DEFAULT_WORKFLOW_MAX_COST_USD,
  DEFAULT_WORKFLOW_MAX_REWORK_ROUNDS,
  DEFAULT_WORKFLOW_MIN_PASS_SCORE,
  MAX_AI_INSTRUCTION_LENGTH,
  MAX_WORKFLOW_CHAPTERS_PER_RUN,
  MAX_WORKFLOW_MAX_COST_USD,
  MAX_WORKFLOW_REWORK_ROUNDS,
  MIN_WORKFLOW_MAX_COST_USD,
  WORKFLOW_MODES,
  WORKFLOW_MODE_LABELS,
  type BookDto,
  type BookTreeResponse,
  type ChapterTreeItem,
  type CreateWorkflowRunInputPayload,
  type WorkflowMode,
} from '@fanxiaoshuo/shared';
import {
  NAlert,
  NButton,
  NCheckbox,
  NFormItem,
  NIcon,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  NSwitch,
  NTag,
  useMessage,
} from 'naive-ui';
import { AddOutline, AlertCircleOutline, HardwareChipOutline } from '@vicons/ionicons5';
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { booksApi } from '@/api/books';
import { describeError, isApiClientError } from '@/api/errors';
import { useWorkflowsStore } from '@/stores/workflows';
import { formatWordCount } from '@/utils/format';

const props = defineProps<{ show: boolean }>();

const emit = defineEmits<{
  'update:show': [boolean];
  created: [runId: string];
}>();

const router = useRouter();
const message = useMessage();
const workflowsStore = useWorkflowsStore();

/** 运行模式说明（与 `WORKFLOW_MODE_LABELS` 配套，仅前端展示）。 */
const MODE_DESCRIPTIONS: Record<WorkflowMode, string> = {
  outline_only: '只调用总编策划为每个目标章节拆解结构化细纲，不写正文，Token 消耗最低。',
  write_chapters: '按已有细纲逐章成文，可开启审稿返工与自动摘要，适合细纲已就绪的作品。',
  full_pipeline: '拆细纲 → 写正文 → 审稿返工 → 提炼摘要，全链路无人值守生产。',
};

/** 这些错误码说明角色 / 模型前置条件未满足，需要引导去模型配置中心。 */
const ROLE_GUIDANCE_CODES = new Set(['AGENT_ROLE_UNBOUND', 'PROVIDER_DISABLED', 'MODEL_DISABLED']);

const books = ref<BookDto[]>([]);
const booksLoading = ref(false);
const booksError = ref<string | null>(null);

const tree = ref<BookTreeResponse | null>(null);
const treeLoading = ref(false);
const treeError = ref<string | null>(null);

const bookId = ref<string | null>(null);
const mode = ref<WorkflowMode>('full_pipeline');
const targetSource = ref<'existing' | 'auto'>('existing');
const selectedChapterIds = ref<string[]>([]);

const autoVolumeId = ref<string>('ungrouped');
const autoCount = ref<number | null>(5);
const autoTitlePrefix = ref('第');

const unlimitedBudget = ref(false);
const maxCostUsd = ref<number | null>(DEFAULT_WORKFLOW_MAX_COST_USD);
const enableCritic = ref(true);
const minPassScore = ref<number | null>(DEFAULT_WORKFLOW_MIN_PASS_SCORE);
const maxReworkRounds = ref<number | null>(DEFAULT_WORKFLOW_MAX_REWORK_ROUNDS);
const enableSummary = ref(true);
const targetWords = ref<number | null>(null);
const instruction = ref('');

const submitting = ref(false);
const formError = ref<string | null>(null);

const bookOptions = computed(() =>
  books.value.map((book) => ({ label: book.title, value: book.id })),
);

interface ChapterGroup {
  key: string;
  title: string;
  chapters: ChapterTreeItem[];
}

/** 卷章分组：按分卷顺序排列，最后追加「未分卷章节」。 */
const chapterGroups = computed<ChapterGroup[]>(() => {
  const current = tree.value;
  if (current === null) {
    return [];
  }
  const groups: ChapterGroup[] = current.volumes.map((volume) => ({
    key: volume.id,
    title: volume.title,
    chapters: volume.chapters,
  }));
  if (current.ungroupedChapters.length > 0) {
    groups.push({
      key: 'ungrouped',
      title: '未分卷章节',
      chapters: current.ungroupedChapters,
    });
  }
  return groups;
});

/** 按阅读顺序展开的全部章节（提交 `chapterIds` 时严格依此排序）。 */
const orderedChapters = computed<ChapterTreeItem[]>(() =>
  chapterGroups.value.flatMap((group) => group.chapters),
);

/** 阅读顺序下被勾选的章节 ID。 */
const orderedChapterIds = computed<string[]>(() =>
  orderedChapters.value
    .filter((chapter) => selectedChapterIds.value.includes(chapter.id))
    .map((chapter) => chapter.id),
);

/** 「未完成章」= 尚未定稿（细纲 / 草稿 / 待审）。 */
const unfinishedChapterIds = computed<string[]>(() =>
  orderedChapters.value.filter((chapter) => chapter.status !== 'final').map((chapter) => chapter.id),
);

const volumeOptions = computed(() => {
  const current = tree.value;
  const options = [
    { label: '未分卷区（创建为未分卷章节）', value: 'ungrouped' },
    ...(current?.volumes ?? []).map((volume) => ({ label: volume.title, value: volume.id })),
  ];
  return options;
});

const selectedCount = computed(() => orderedChapterIds.value.length);

const roleGuidanceCode = computed(() =>
  workflowsStore.createErrorCode !== null && ROLE_GUIDANCE_CODES.has(workflowsStore.createErrorCode)
    ? workflowsStore.createErrorCode
    : null,
);

const budgetHint = computed(() => {
  if (unlimitedBudget.value) {
    return '不限制预算：批次不会因费用熔断，请自行关注累计消耗。';
  }
  return `累计费用达到 $${(maxCostUsd.value ?? 0).toFixed(2)} 时自动暂停并保留已完成章节，可上调预算后续跑。`;
});

function resetForm(): void {
  bookId.value = null;
  mode.value = 'full_pipeline';
  targetSource.value = 'existing';
  selectedChapterIds.value = [];
  autoVolumeId.value = 'ungrouped';
  autoCount.value = 5;
  autoTitlePrefix.value = '第';
  unlimitedBudget.value = false;
  maxCostUsd.value = DEFAULT_WORKFLOW_MAX_COST_USD;
  enableCritic.value = true;
  minPassScore.value = DEFAULT_WORKFLOW_MIN_PASS_SCORE;
  maxReworkRounds.value = DEFAULT_WORKFLOW_MAX_REWORK_ROUNDS;
  enableSummary.value = true;
  targetWords.value = null;
  instruction.value = '';
  formError.value = null;
  tree.value = null;
  treeError.value = null;
  workflowsStore.createError = null;
  workflowsStore.createErrorCode = null;
}

async function loadBooks(): Promise<void> {
  booksLoading.value = true;
  booksError.value = null;
  try {
    const response = await booksApi.list({ includeDeleted: 'exclude' });
    books.value = response.items;
  } catch (error) {
    booksError.value = describeError(error);
  } finally {
    booksLoading.value = false;
  }
}

async function loadTree(nextBookId: string): Promise<void> {
  treeLoading.value = true;
  treeError.value = null;
  tree.value = null;
  selectedChapterIds.value = [];
  try {
    const response = await booksApi.tree(nextBookId);
    if (bookId.value !== nextBookId) {
      return;
    }
    tree.value = response;
    if (response.volumes.length === 0) {
      autoVolumeId.value = 'ungrouped';
    }
  } catch (error) {
    treeError.value = describeError(error);
  } finally {
    treeLoading.value = false;
  }
}

watch(
  () => props.show,
  (show) => {
    if (!show) {
      return;
    }
    resetForm();
    void loadBooks();
  },
);

watch(bookId, (value) => {
  if (value === null) {
    tree.value = null;
    selectedChapterIds.value = [];
    return;
  }
  void loadTree(value);
});

function isSelected(chapterId: string): boolean {
  return selectedChapterIds.value.includes(chapterId);
}

function toggleChapter(chapterId: string, checked: boolean): void {
  if (checked) {
    if (selectedChapterIds.value.includes(chapterId)) {
      return;
    }
    if (selectedChapterIds.value.length >= MAX_WORKFLOW_CHAPTERS_PER_RUN) {
      formError.value = `单个批次最多纳管 ${MAX_WORKFLOW_CHAPTERS_PER_RUN} 章`;
      return;
    }
    selectedChapterIds.value = [...selectedChapterIds.value, chapterId];
    return;
  }
  selectedChapterIds.value = selectedChapterIds.value.filter((id) => id !== chapterId);
}

function selectUnfinished(): void {
  selectedChapterIds.value = unfinishedChapterIds.value.slice(0, MAX_WORKFLOW_CHAPTERS_PER_RUN);
}

function clearSelection(): void {
  selectedChapterIds.value = [];
}

function close(): void {
  emit('update:show', false);
}

function goToModels(): void {
  close();
  void router.push('/models');
}

function buildPayload(): CreateWorkflowRunInputPayload | null {
  const currentBookId = bookId.value;
  if (currentBookId === null) {
    formError.value = '请先选择目标书籍';
    return null;
  }
  const chapterIds = orderedChapterIds.value;
  const autoChapterCount = autoCount.value ?? 0;
  if (targetSource.value === 'existing') {
    if (chapterIds.length === 0) {
      formError.value = '请至少勾选一个目标章节，或切换为「自动新建章节」';
      return null;
    }
  } else if (
    !Number.isInteger(autoChapterCount) ||
    autoChapterCount < 1 ||
    autoChapterCount > MAX_WORKFLOW_CHAPTERS_PER_RUN
  ) {
    formError.value = `新建章数须为 1–${MAX_WORKFLOW_CHAPTERS_PER_RUN} 的整数`;
    return null;
  }

  const budget = unlimitedBudget.value ? null : (maxCostUsd.value ?? DEFAULT_WORKFLOW_MAX_COST_USD);
  if (budget !== null && (budget < MIN_WORKFLOW_MAX_COST_USD || budget > MAX_WORKFLOW_MAX_COST_USD)) {
    formError.value = `预算上限须在 $${MIN_WORKFLOW_MAX_COST_USD} – $${MAX_WORKFLOW_MAX_COST_USD} 之间`;
    return null;
  }

  const payload: CreateWorkflowRunInputPayload = {
    bookId: currentBookId,
    mode: mode.value,
    maxCostUsd: budget,
    enableCritic: enableCritic.value,
    minPassScore: minPassScore.value ?? DEFAULT_WORKFLOW_MIN_PASS_SCORE,
    maxReworkRounds: maxReworkRounds.value ?? DEFAULT_WORKFLOW_MAX_REWORK_ROUNDS,
    enableSummary: enableSummary.value,
    instruction: instruction.value.trim(),
    ...(targetWords.value !== null ? { targetWords: targetWords.value } : {}),
    ...(targetSource.value === 'existing'
      ? { chapterIds }
      : {
          autoCreateChapters: {
            volumeId: autoVolumeId.value === 'ungrouped' ? null : autoVolumeId.value,
            count: autoChapterCount,
            titlePrefix: autoTitlePrefix.value.trim().length > 0 ? autoTitlePrefix.value.trim() : '第',
          },
        }),
  };
  return payload;
}

async function submit(): Promise<void> {
  formError.value = null;
  const payload = buildPayload();
  if (payload === null) {
    return;
  }
  submitting.value = true;
  try {
    const detail = await workflowsStore.createRun(payload);
    message.success(`批量任务已创建：${WORKFLOW_MODE_LABELS[detail.mode]} · ${detail.totalSteps} 章`);
    emit('created', detail.id);
    close();
  } catch (error) {
    formError.value = describeError(error);
    if (isApiClientError(error)) {
      workflowsStore.createErrorCode = error.code;
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="新建批量流水线任务"
    style="width: 880px; max-width: 96vw"
    :bordered="false"
    :mask-closable="!submitting"
    @update:show="emit('update:show', $event)"
  >
    <div class="fx-wf-modal">
      <n-alert v-if="formError !== null" type="error" :bordered="false">
        {{ formError }}
      </n-alert>

      <n-alert v-if="roleGuidanceCode !== null" type="warning" :bordered="false">
        <div class="fx-wf-guidance">
          <div class="fx-wf-guidance__text">
            <strong>写书角色尚未就绪（{{ roleGuidanceCode }}）</strong>
            <div>
              批量任务需要「总编策划 / 设定档案员 / 执笔写手 / 审稿质检」四个角色都绑定可用模型。
              请前往模型配置中心补齐绑定或启用对应供应商与模型后重试。
            </div>
          </div>
          <n-button type="primary" secondary size="small" @click="goToModels">
            <template #icon>
              <n-icon><hardware-chip-outline /></n-icon>
            </template>
            前往模型配置
          </n-button>
        </div>
      </n-alert>

      <!-- 1. 目标书籍 -->
      <section class="fx-wf-section">
        <header class="fx-wf-section__head">
          <span class="fx-wf-section__index">1</span>
          <div>
            <div class="fx-wf-section__title">目标书籍</div>
            <div class="fx-wf-section__hint">批量任务只能作用于一本作品，卷章树与章节状态会随选书刷新。</div>
          </div>
        </header>
        <n-alert v-if="booksError !== null" type="error" :bordered="false">{{ booksError }}</n-alert>
        <n-select
          v-model:value="bookId"
          :options="bookOptions"
          :loading="booksLoading"
          filterable
          clearable
          placeholder="选择要批量生产的作品"
        />
        <n-alert v-if="treeError !== null" type="warning" :bordered="false">{{ treeError }}</n-alert>
      </section>

      <!-- 2. 运行模式 -->
      <section class="fx-wf-section">
        <header class="fx-wf-section__head">
          <span class="fx-wf-section__index">2</span>
          <div>
            <div class="fx-wf-section__title">运行模式</div>
            <div class="fx-wf-section__hint">按现有进度选择：只要细纲、只写正文，或一次跑完全链路。</div>
          </div>
        </header>
        <div class="fx-wf-mode-grid">
          <button
            v-for="item in WORKFLOW_MODES"
            :key="item"
            type="button"
            :class="['fx-wf-mode-card', { 'is-active': mode === item }]"
            @click="mode = item"
          >
            <div class="fx-wf-mode-card__title">{{ WORKFLOW_MODE_LABELS[item] }}</div>
            <div class="fx-wf-mode-card__desc">{{ MODE_DESCRIPTIONS[item] }}</div>
          </button>
        </div>
      </section>

      <!-- 3. 目标章节 -->
      <section class="fx-wf-section">
        <header class="fx-wf-section__head">
          <span class="fx-wf-section__index">3</span>
          <div>
            <div class="fx-wf-section__title">目标章节</div>
            <div class="fx-wf-section__hint">选择已有章节，或按目标分卷自动新建空白章节后立即开写。</div>
          </div>
        </header>

        <div class="fx-wf-toggle">
          <button
            type="button"
            :class="['fx-wf-toggle__item', { 'is-active': targetSource === 'existing' }]"
            @click="targetSource = 'existing'"
          >
            选择已有章节
          </button>
          <button
            type="button"
            :class="['fx-wf-toggle__item', { 'is-active': targetSource === 'auto' }]"
            @click="targetSource = 'auto'"
          >
            自动新建章节
          </button>
        </div>

        <template v-if="targetSource === 'existing'">
          <div class="fx-wf-inline">
            <n-button size="tiny" secondary :disabled="tree === null" @click="selectUnfinished">
              全选未完成章
            </n-button>
            <n-button size="tiny" quaternary :disabled="selectedCount === 0" @click="clearSelection">
              清空
            </n-button>
            <n-tag size="small" round :bordered="false" type="info">
              已选 {{ selectedCount }} 章 / 上限 {{ MAX_WORKFLOW_CHAPTERS_PER_RUN }}
            </n-tag>
          </div>

          <div v-if="bookId === null" class="fx-wf-empty">先选择目标书籍，再勾选要生成的章节。</div>
          <div v-else-if="treeLoading" class="fx-wf-empty">正在加载卷章树…</div>
          <div v-else-if="chapterGroups.length === 0" class="fx-wf-empty">
            该作品还没有章节，请切换为「自动新建章节」。
          </div>
          <div v-else class="fx-wf-chapter-groups">
            <div v-for="group in chapterGroups" :key="group.key" class="fx-wf-chapter-group">
              <div class="fx-wf-chapter-group__title">
                {{ group.title }}
                <span class="fx-tertiary">{{ group.chapters.length }} 章</span>
              </div>
              <div class="fx-wf-chapter-list">
                <label
                  v-for="chapter in group.chapters"
                  :key="chapter.id"
                  :class="['fx-wf-chapter', { 'is-active': isSelected(chapter.id) }]"
                >
                  <n-checkbox
                    :checked="isSelected(chapter.id)"
                    @update:checked="toggleChapter(chapter.id, $event)"
                  />
                  <span class="fx-wf-chapter__title">{{ chapter.title }}</span>
                  <span class="fx-wf-chapter__meta">
                    {{ CHAPTER_STATUS_LABELS[chapter.status] }} ·
                    {{ formatWordCount(chapter.wordCount) }}
                  </span>
                </label>
              </div>
            </div>
          </div>
        </template>

        <template v-else>
          <div class="fx-wf-auto-grid">
            <n-form-item label="目标分卷" :show-feedback="false">
              <n-select v-model:value="autoVolumeId" :options="volumeOptions" />
            </n-form-item>
            <n-form-item label="新建章数" :show-feedback="false">
              <n-input-number
                v-model:value="autoCount"
                :min="1"
                :max="MAX_WORKFLOW_CHAPTERS_PER_RUN"
                style="width: 100%"
              />
            </n-form-item>
            <n-form-item label="标题前缀" :show-feedback="false">
              <n-input v-model:value="autoTitlePrefix" :maxlength="60" placeholder="默认：第" />
            </n-form-item>
          </div>
          <div class="fx-form-hint">
            服务端会在目标分卷末尾按序创建 {{ autoCount ?? 0 }} 个空白章节（标题形如
            {{ (autoTitlePrefix || '第') }}1章），随后直接进入流水线执行。
          </div>
        </template>
      </section>

      <!-- 4. 流水线参数 -->
      <section class="fx-wf-section">
        <header class="fx-wf-section__head">
          <span class="fx-wf-section__index">4</span>
          <div>
            <div class="fx-wf-section__title">流水线参数</div>
            <div class="fx-wf-section__hint">预算上限是硬熔断保护；审稿及格分与返工轮数决定返工闭环强度。</div>
          </div>
        </header>

        <div class="fx-wf-param-grid">
          <div class="fx-wf-param">
            <div class="fx-wf-param__label">
              预算上限（USD）
              <span class="fx-wf-param__inline">
                <n-switch v-model:value="unlimitedBudget" size="small" />
                <span class="fx-tertiary">不限</span>
              </span>
            </div>
            <n-input-number
              v-model:value="maxCostUsd"
              :disabled="unlimitedBudget"
              :min="MIN_WORKFLOW_MAX_COST_USD"
              :max="MAX_WORKFLOW_MAX_COST_USD"
              :step="0.5"
              :precision="4"
              style="width: 100%"
            />
            <div class="fx-form-hint">{{ budgetHint }}</div>
          </div>

          <div class="fx-wf-param">
            <div class="fx-wf-param__label">
              审稿质检
              <span class="fx-wf-param__inline">
                <n-switch v-model:value="enableCritic" size="small" />
                <span class="fx-tertiary">{{ enableCritic ? '开启' : '关闭' }}</span>
              </span>
            </div>
            <div class="fx-wf-param-row">
              <n-input-number
                v-model:value="minPassScore"
                :disabled="!enableCritic"
                :min="1"
                :max="100"
                style="width: 100%"
              >
                <template #prefix>及格分</template>
              </n-input-number>
              <n-input-number
                v-model:value="maxReworkRounds"
                :disabled="!enableCritic"
                :min="0"
                :max="MAX_WORKFLOW_REWORK_ROUNDS"
                style="width: 100%"
              >
                <template #prefix>返工轮数</template>
              </n-input-number>
            </div>
            <div class="fx-form-hint">
              低于及格分时由审稿官输出问题清单，执笔写手按意见返工，最多返工
              {{ MAX_WORKFLOW_REWORK_ROUNDS }} 轮。
            </div>
          </div>

          <div class="fx-wf-param">
            <div class="fx-wf-param__label">
              自动摘要
              <span class="fx-wf-param__inline">
                <n-switch v-model:value="enableSummary" size="small" />
                <span class="fx-tertiary">{{ enableSummary ? '开启' : '关闭' }}</span>
              </span>
            </div>
            <n-input-number
              v-model:value="targetWords"
              :min="100"
              :max="10000"
              :step="200"
              clearable
              placeholder="单章目标字数（可选）"
              style="width: 100%"
            />
            <div class="fx-form-hint">
              开启后每章完成后由设定档案员提炼摘要，供后续章节召回上下文；留空则沿用角色默认字数。
            </div>
          </div>
        </div>

        <n-form-item label="全局补充指令（可选）" :show-feedback="false">
          <n-input
            v-model:value="instruction"
            type="textarea"
            :maxlength="MAX_AI_INSTRUCTION_LENGTH"
            :autosize="{ minRows: 2, maxRows: 5 }"
            show-count
            placeholder="例如：保持冷峻克制的叙述语调，尽量少用感叹句，每章结尾留悬念。"
          />
        </n-form-item>
      </section>

      <div v-if="!enableCritic" class="fx-wf-notice">
        <n-icon size="14"><alert-circle-outline /></n-icon>
        当前已关闭审稿，批次只会执行成文与摘要阶段，不会产生审稿得分与返工。
      </div>
    </div>

    <template #footer>
      <div class="fx-modal-footer">
        <span v-if="bookId !== null" class="fx-tertiary" style="font-size: 11.5px">
          {{ targetSource === 'existing' ? `将执行 ${selectedCount} 个章节` : `将新建并执行 ${autoCount ?? 0} 个章节` }}
          · 预算 {{ unlimitedBudget ? '不限' : `$${(maxCostUsd ?? 0).toFixed(2)}` }}
        </span>
        <div class="fx-inline" style="gap: 8px">
          <n-button :disabled="submitting" @click="close">取消</n-button>
          <n-button type="primary" :loading="submitting || workflowsStore.creating" @click="submit">
            <template #icon>
              <n-icon><add-outline /></n-icon>
            </template>
            创建并开始生产
          </n-button>
        </div>
      </div>
    </template>
  </n-modal>
</template>
