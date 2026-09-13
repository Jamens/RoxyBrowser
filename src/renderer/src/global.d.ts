declare global {
  interface Window {
    roxy?: {
      apiBase: string
      platform: string
      /** 由环境窗口注入：让起始页把导航交给主进程执行，失败可回传原因 */
      navigate?: (url: string) => void
      /** 取消起始页正在进行的导航（配合加载遮罩上的「取消」按钮） */
      cancel?: () => void
      /** 设置客户端自身出网代理（system = 跟随系统；custom = 自定义代理） */
      setNetworkProxy?: (cfg: {
        mode: 'system' | 'custom'
        type: 'http' | 'https' | 'socks5'
        host: string
        port: number
        username: string
        password: string
      }) => Promise<{ ok: boolean }>
      /** 任务栏图标显示：icon = 应用图标；name = 窗口（环境）名称 */
      setTrayDisplay?: (mode: 'icon' | 'name') => Promise<{ ok: boolean }>
      /** 内核版本信息（应用 / Electron / Chromium / Node / V8 / 平台） */
      getVersions?: () => Promise<{
        app: string
        electron: string
        chrome: string
        node: string
        v8: string
        platform: string
        arch: string
      }>
      /** AI Agent 执行闭环：启动一次执行，返回 { runId } 或 { error } */
      agentStart: (payload: { envId: number; instruction: string; options?: { needApproval?: boolean; maxSteps?: number } }) => Promise<{ runId?: string; error?: string }>
      /** 中止某次运行 */
      agentStop: (runId: string) => void
      /** 审批结果：approved=true 放行继续，false 等同中止 */
      agentApprove: (runId: string, approved: boolean) => Promise<{ ok: boolean }>
      /** 订阅单步事件，返回取消订阅函数 */
      agentOnStep: (cb: (d: { runId: string; step: number; action: import('@shared/types').AgentAction; screenshot?: string; rpaStep?: import('@shared/types').RpaStep | null }) => void) => () => void
      agentOnDone: (cb: (d: { runId: string; result: string; rpaSteps?: import('@shared/types').RpaStep[] }) => void) => () => void
      agentOnError: (cb: (d: { runId: string; error: string }) => void) => () => void
      agentOnNeedApproval: (cb: (d: { runId: string; question: string }) => void) => () => void
    }
  }
}
export {}
