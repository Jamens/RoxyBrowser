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
    }
  }
}
export {}
