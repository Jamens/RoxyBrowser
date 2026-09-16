import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * 深链定位：当 URL 带 ?focus=<id> 时，滚动到对应表格行并高亮。
 * 配合各列表页 antd Table 的 onRow={(r) => ({ 'data-dl-id': r.id })} 使用。
 */
export function useDeepLinkFocus(): void {
  const [params] = useSearchParams()
  const focus = params.get('focus')
  useEffect(() => {
    if (!focus) return
    const id = window.setTimeout(() => {
      const el = document.querySelector(`[data-dl-id="${CSS.escape(String(focus))}"]`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el.classList.add('dl-focus')
        window.setTimeout(() => el.classList.remove('dl-focus'), 3200)
      }
    }, 320)
    return () => window.clearTimeout(id)
  }, [focus])
}
