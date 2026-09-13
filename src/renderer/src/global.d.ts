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
      /** AI Agent 执行闭环：启动一次矩阵运行（可驱动 N 个环境并发），返回 { runId } 或 { error } */
      agentStart: (payload: {
        envIds: number[]
        instruction: string
        options?: { needApproval?: boolean; maxSteps?: number }
        actor?: { userId: number; username: string }
      }) => Promise<{ runId?: string; error?: string }>
      /** 中止整次矩阵运行（含所有子会话） */
      agentStop: (runId: string) => void
      /** 审批结果：针对某个具体环境放行（approved=true 继续，false 等同中止该环境） */
      agentApprove: (runId: string, envId: number, approved: boolean) => Promise<{ ok: boolean }>
      /** 订阅单步事件（带 envId，按环境分组），返回取消订阅函数 */
      agentOnStep: (cb: (d: { runId: string; envId: number; step: number; action: import('@shared/types').AgentAction; screenshot?: string; rpaStep?: import('@shared/types').RpaStep | null }) => void) => () => void
      agentOnDone: (cb: (d: { runId: string; envId: number; result: string; rpaSteps?: import('@shared/types').RpaStep[] }) => void) => () => void
      agentOnError: (cb: (d: { runId: string; envId: number; error: string }) => void) => () => void
      agentOnNeedApproval: (cb: (d: { runId: string; envId: number; question: string }) => void) => () => void
      /** 订阅矩阵汇总事件（全部环境执行完毕时触发一次），返回取消订阅函数 */
      agentOnAllDone: (cb: (d: { runId: string; results: { envId: number; status: 'done' | 'failed'; result: string; rpaSteps?: import('@shared/types').RpaStep[] }[] }) => void) => () => void
    }
  }
}
export {}
