import { App } from 'antd'

/**
 * 统一的 antd 应用上下文钩子。
 * 必须在被 <App> 包裹的组件内调用，返回与当前主题（明暗 / 算法）联动的
 * message / modal / notification 实例——否则静态 message.xxx 会渲染成浅色，
 * 在暗黑模式下「看不见」选中 / 高亮效果。
 */
export function useAppCtx() {
  return App.useApp()
}
