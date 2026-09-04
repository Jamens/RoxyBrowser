declare global {
  interface Window {
    roxy?: {
      apiBase: string
      platform: string
      /** 由环境窗口注入：让起始页把导航交给主进程执行，失败可回传原因 */
      navigate?: (url: string) => void
      /** 取消起始页正在进行的导航（配合加载遮罩上的「取消」按钮） */
      cancel?: () => void
    }
  }
}
export {}
