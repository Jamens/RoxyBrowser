declare global {
  interface Window {
    roxy?: {
      apiBase: string
      platform: string
      /** 由环境窗口注入：让起始页把导航交给主进程执行，失败可回传原因 */
      navigate?: (url: string) => void
    }
  }
}
export {}
