/**
 * AI 채팅 상태.
 *
 * 비용 원칙 (CLAUDE.md 1장 #3): AI API 는 send() 에서만 호출된다. 편집·자동 저장·서버 상태 확인 등
 * 다른 어떤 경로에서도 호출하지 않는다. 설정·사용량 조회는 로컬 서버만 읽으며 비용이 없다.
 */
import { create } from 'zustand';
import { getAiSettings, getAiUsage, sendChat, type AiSettings, type ChatResponse, type UsageTotals } from '../../api/ai';
import type { CadCommand } from '../../cad/commandTypes';
import { describeCommand } from '../../cad/describeCommand';
import { useSceneStore } from '../../cad/sceneStore';

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  kind?: ChatResponse['kind'] | 'welcome' | 'info';
  options?: string[];
  /** 적용한 변경 (사람이 읽는 요약) */
  changes?: string[];
  costUsd?: number;
}

const WELCOME: ChatMessage = {
  id: 0,
  role: 'assistant',
  kind: 'welcome',
  text: '만들고 싶은 물건을 설명해 주세요.\n예: "가로 80mm, 세로 50mm, 높이 30mm 수납함 만들어줘", "선택한 박스 높이를 50mm로 바꿔줘"',
};

interface AiState {
  messages: ChatMessage[];
  pending: AbortController | null;
  settings: AiSettings | null;
  month: UsageTotals | null;
  settingsOpen: boolean;
  /** 실제 AI API 요청 횟수 (테스트·표시용) */
  sentCount: number;

  loadSettings: () => Promise<void>;
  setSettings: (s: AiSettings) => void;
  setSettingsOpen: (open: boolean) => void;
  send: (text: string) => Promise<void>;
  cancel: () => void;
  clear: () => void;
}

let nextId = 1;

export const STALE_RESPONSE = '요청을 보낸 뒤 모델이 바뀌어 AI 변경을 적용하지 않았습니다. 다시 요청해 주세요.';

/** API 로 보낼 이전 대화: 사용자 문장 + AI 답변(적용한 변경 요약 포함) */
export function historyForApi(messages: ChatMessage[]): { role: 'user' | 'assistant'; text: string }[] {
  return messages
    .filter((m) => m.kind !== 'welcome' && m.kind !== 'info')
    .map((m) => {
      if (m.role === 'user') return { role: 'user' as const, text: m.text };
      const parts = [m.text];
      if (m.changes?.length) parts.push('[적용한 변경]\n' + m.changes.map((c) => `- ${c}`).join('\n'));
      if (m.options?.length) parts.push('[선택지] ' + m.options.join(' / '));
      return { role: 'assistant' as const, text: parts.join('\n') };
    });
}

export const useAiStore = create<AiState>((set, get) => ({
  messages: [WELCOME],
  pending: null,
  settings: null,
  month: null,
  settingsOpen: false,
  sentCount: 0,

  loadSettings: async () => {
    try {
      const [settings, usage] = await Promise.all([getAiSettings(), getAiUsage()]);
      set({ settings, month: usage.month });
    } catch {
      set({ settings: null });
    }
  },
  setSettings: (settings) => set({ settings }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

  send: async (raw) => {
    const text = raw.trim();
    if (!text || get().pending) return;
    const scene = useSceneStore.getState();
    // AI 가 본 설계 원본. 응답이 왔을 때 원본이 바뀌었으면(직접 편집·실행 취소·다른 프로젝트 열기) 적용하지 않는다.
    const sentModel = scene.history.present.model;
    const history = historyForApi(get().messages);
    const controller = new AbortController();
    set((s) => ({
      pending: controller,
      sentCount: s.sentCount + 1,
      messages: [...s.messages, { id: nextId++, role: 'user', text }],
    }));
    const push = (m: Omit<ChatMessage, 'id' | 'role'>) =>
      set((s) => ({ messages: [...s.messages, { id: nextId++, role: 'assistant', ...m }] }));

    try {
      const r = await sendChat(
        { model: sentModel, selectedId: scene.selectedId, history, message: text },
        controller.signal,
      );
      if (r.month) set({ month: r.month });
      const costUsd = r.usage?.costUsd;

      if (r.kind === 'commands' && useSceneStore.getState().history.present.model !== sentModel) {
        push({ kind: 'error', text: STALE_RESPONSE, costUsd });
      } else if (r.kind === 'commands') {
        const result = useSceneStore.getState().dispatchBatch(r.commands, 'ai');
        if (result.ok) {
          push({ kind: 'commands', text: r.message, costUsd, changes: result.commands.map((c: CadCommand) => describeCommand(c, result.model)) });
        } else {
          push({ kind: 'error', text: `AI 가 만든 변경을 적용하지 못했습니다. ${result.error}`, costUsd });
        }
      } else if (r.kind === 'question') {
        push({ kind: 'question', text: r.message, options: r.options, costUsd });
      } else {
        push({ kind: r.kind, text: r.message, costUsd });
      }
    } catch (e) {
      if (controller.signal.aborted) push({ kind: 'info', text: '요청을 취소했습니다.' });
      else push({ kind: 'error', text: `AI 요청에 실패했습니다: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      set({ pending: null });
    }
  },

  cancel: () => get().pending?.abort(),
  clear: () => set({ messages: [WELCOME] }),
}));
