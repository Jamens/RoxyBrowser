// AI Agent 对话 UI 状态的模块级单例 store。
//
// 背景：原先 AiAgent 把对话相关的状态（messages / input / sending / uiMode 当前标签页）
// 全放在组件 useState 里，切到别的页面（路由卸载重建）后状态清空——
// 于是「对话进行中切走再切回，对话直接没了、标签页也回到默认的 auto」。
//
// 这里把对话 UI 态提到模块作用域，组件卸载也不丢；组件用 useSyncExternalStore 读取，
// 切回时立即拿到之前的对话内容、输入框残值与所在的标签页。
// 执行态（步骤 / 截图 / runId 等）在 agentStore.ts，二者各管各的、互不影响。
import { useSyncExternalStore } from 'react'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  /** 该条回复实际走的模式（auto 模式下由 Dispatcher 判定） */
  mode?: 'chat' | 'support'
}

export type UiMode = 'auto' | 'chat' | 'support' | 'agent'

export interface ChatSnapshot {
  /** 当前选中的标签页：自动 / 通用对话 / 产品客服 / 执行 */
  uiMode: UiMode
  /** 对话消息（auto / chat / support 三种文本模式共用同一段历史） */
  messages: ChatMessage[]
  /** 输入框当前内容（切走再切回保留残值） */
  input: string
  /** 是否正在请求模型（切走再切回仍显示思考态，避免误以为卡死） */
  sending: boolean
}

const EMPTY: ChatSnapshot = {
  uiMode: 'auto',
  messages: [],
  input: '',
  sending: false
}

let snapshot: ChatSnapshot = EMPTY
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

/** 不可变更新：每次都生成新的 snapshot 引用，配合 useSyncExternalStore 触发重渲染 */
function set(patch: Partial<ChatSnapshot>) {
  snapshot = { ...snapshot, ...patch }
  emit()
}

export const agentChatStore = {
  subscribe(l: () => void) {
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  },
  getSnapshot: () => snapshot,

  setUiMode(v: UiMode) {
    set({ uiMode: v })
  },
  setInput(v: string) {
    set({ input: v })
  },
  setSending(v: boolean) {
    set({ sending: v })
  },
  /** 整体替换消息列表（send 时先塞用户消息、再塞模型回复都用它） */
  setMessages(v: ChatMessage[]) {
    set({ messages: v })
  },
  /** 清空对话与输入框（对应页面上的「清空」按钮） */
  clear() {
    set({ messages: [], input: '' })
  }
}

export function useAgentChatStore(): ChatSnapshot {
  return useSyncExternalStore(agentChatStore.subscribe, agentChatStore.getSnapshot, agentChatStore.getSnapshot)
}
