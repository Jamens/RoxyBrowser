import { useEffect, useState } from "react";
import {
  Input,
  Tag,
  Typography,
  Space,
  Card,
  Alert,
  Spin,
  Button,
} from "antd";
import {
  GlobalOutlined,
  ArrowRightOutlined,
  SafetyOutlined,
} from "@ant-design/icons";
import { useSearchParams } from "react-router-dom";
import {
  osLabel,
  normalizeTarget,
  SEARCH_ENGINES,
  type SearchEngine,
} from "@shared/types";
import type { MessageKey } from "../i18n/messages";
import { useI18n, type TranslateFn } from "../i18n";

interface ProfileInfo {
  id: number;
  name: string;
  seq: number;
  platform: string;
  startUrl: string;
  proxyCountry: string;
  searchEngine: SearchEngine;
  fingerprint: {
    os: string;
    timezone: string;
    languages: string[];
    screenWidth: number;
    screenHeight: number;
    userAgent: string;
  };
}

// 快捷导航：点击直达站点（不是搜索词）。name 为品牌名不做多语言，
// 最后一项为指纹检测页，标题走 i18n。
const QUICK_LINKS: { name: string; url: string; key?: MessageKey }[] = [
  { name: "Amazon", url: "https://www.amazon.com" },
  { name: "Facebook", url: "https://www.facebook.com" },
  { name: "Instagram", url: "https://www.instagram.com" },
  { name: "TikTok", url: "https://www.tiktok.com" },
  { name: "eBay", url: "https://www.ebay.com" },
  { name: "Etsy", url: "https://www.etsy.com" },
  { name: "Google", url: "https://www.google.com" },
  { name: "", url: "https://browserleaks.com/canvas", key: "browser.fpCheck" },
];

/** Chromium 网络错误码 → 人话。绝大多数打开失败其实都是代理不通 */
function navErrorReason(code: string, t: TranslateFn): string {
  if (code.startsWith("ERR_CERT")) return t("browser.err.cert");
  if (code === "ERR_INTERNET_DISCONNECTED" || code === "ERR_NETWORK_CHANGED")
    return t("browser.err.offline");
  if (code === "ERR_NAME_NOT_RESOLVED" || code === "ERR_NAME_RESOLUTION_FAILED")
    return t("browser.err.dns");
  if (code === "ERR_PROXY_AUTH_UNSUPPORTED" || code === "ERR_PROXY_AUTH_REQUESTED")
    return t("browser.err.proxyAuth");
  if (code === "ERR_CONNECTION_TIMED_OUT" || code === "ERR_TIMED_OUT")
    return t("browser.err.timeout");
  if (
    code.startsWith("ERR_PROXY") ||
    code === "ERR_TUNNEL_CONNECTION_FAILED" ||
    code === "ERR_NO_SUPPORTED_PROXIES" ||
    code === "ERR_MANDATORY_PROXY_CONFIGURATION_FAILED"
  ) {
    return t("browser.err.proxy");
  }
  if (
    code === "ERR_CONNECTION_RESET" ||
    code === "ERR_CONNECTION_REFUSED" ||
    code === "ERR_CONNECTION_CLOSED" ||
    code === "ERR_CONNECTION_ABORTED" ||
    code === "ERR_EMPTY_RESPONSE"
  ) {
    return t("browser.err.reset");
  }
  return t("browser.err.unknown", { code });
}

export default function BrowserTab() {
  const [params] = useSearchParams();
  const profileId = params.get("profileId");
  const { t } = useI18n();
  const [info, setInfo] = useState<ProfileInfo | null>(null);
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState("");
  const [hint, setHint] = useState("");
  // active：正在打开的快捷卡片（显示 loading）；pressed：按下态（点击特效）
  const [active, setActive] = useState("");
  const [pressed, setPressed] = useState("");

  // 主进程在导航失败后回到起始页时带上的错误码与目标地址
  const navError = params.get("navError") || "";
  const navUrl = params.get("navUrl") || "";

  // window.roxy 由 browser-preload 仅在应用自身页面（file:// 或 localhost）上注入，
  // 端口递增时也是真实值；取不到时回落默认端口
  const apiBase = window.roxy?.apiBase || "http://127.0.0.1:39100";

  useEffect(() => {
    if (!profileId) return;
    let cancelled = false;
    fetch(`${apiBase}/api/browser/profile-info/${profileId}`)
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then((d: ProfileInfo) => {
        if (cancelled) return;
        setInfo(d);
        // 只在用户还没输入时回填起始页，否则会覆盖用户已经敲进去的内容
        setUrl((prev) => (prev ? prev : d.startUrl || ""));
      })
      .catch(() => {
        /* 起始页仍可用：搜索走默认引擎，仅无指纹摘要 */
      });
    return () => {
      cancelled = true;
    };
  }, [profileId, apiBase]);

  const engine: SearchEngine = info?.searchEngine || "bing";
  const engineLabel =
    SEARCH_ENGINES.find((e) => e.value === engine)?.label || "Bing";

  const go = (target?: string) => {
    const raw = (target ?? url).trim();
    if (!raw) {
      // 空输入时给出提示，而不是静默什么都不做（这是「点了没反应」的来源之一）
      setHint(t("browser.emptyInput"));
      return;
    }
    const u = normalizeTarget(raw, engine);
    if (!u) {
      // 输入只有协议没有主体（如 "http://"）时 normalizeTarget 返回空串
      setHint(t("browser.emptyInput"));
      return;
    }
    setHint("");
    // 回填输入框：点快捷卡片时让用户看到即将去哪个地址
    setUrl(raw);
    // 先渲染出加载态再发起导航：环境窗口没有进度条，
    // 少了这一步，打不开的站点看起来就像点击没生效。
    // 同时清掉按下态：卡片进入加载后会禁用指针事件，onMouseLeave 不会再触发，
    // 不清的话按下位移会一直卡着。
    setPressed("");
    setActive(target || "");
    setPending(u);
    const navigate = window.roxy?.navigate;
    if (typeof navigate === "function") navigate(u);
    else window.location.href = u;
  };

  const cancelNav = () => {
    window.roxy?.cancel?.();
    setPending("");
    setActive("");
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        // 固定的品牌深色渐变背景，不随明暗主题变化：
        // 页内文字因此全部用显式白色系配色，卡片交给 antd 主题（明暗各自成立），
        // 不再出现「浅色底 + 主题文字」的混搭——那会在暗色主题下变成白底白字。
        background: "linear-gradient(180deg, #101a3a 0%, #1d2b64 100%)",
        padding: "60px 40px 40px",
        boxSizing: "border-box",
      }}
    >
      <div style={{ maxWidth: 860, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 8 }}>
          <GlobalOutlined style={{ fontSize: 40, color: "#6a8dff" }} />
        </div>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <Typography.Title level={3} style={{ color: "#fff", margin: 0 }}>
            {info ? `#${info.seq} ${info.name}` : "RoxyBrowser Clone"}
          </Typography.Title>
          <Space style={{ marginTop: 8 }}>
            <Tag icon={<SafetyOutlined />} color="success">
              {t("browser.envActive")}
            </Tag>
            {info?.proxyCountry && (
              <Tag color="blue">
                {t("browser.proxyRegion", { country: info.proxyCountry })}
              </Tag>
            )}
            {info?.platform && <Tag color="purple">{info.platform}</Tag>}
          </Space>
        </div>

        <Input.Search
          size="large"
          placeholder={t("browser.searchPlaceholder")}
          enterButton={<ArrowRightOutlined />}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onSearch={() => go()}
          style={{ marginBottom: 8 }}
        />
        {hint ? (
          <Typography.Text
            style={{
              display: "block",
              textAlign: "center",
              marginBottom: 24,
              fontSize: 12,
              color: "#ffc53d",
            }}
          >
            {hint}
          </Typography.Text>
        ) : (
          <Typography.Text
            style={{
              display: "block",
              textAlign: "center",
              marginBottom: 24,
              fontSize: 12,
              color: "rgba(255,255,255,0.58)",
            }}
          >
            {t("browser.engineHint", { engine: engineLabel })}
          </Typography.Text>
        )}

        {navError && !pending && (
          <Alert
            type="error"
            showIcon
            closable
            style={{ marginBottom: 24, textAlign: "left" }}
            message={t("browser.navFailed")}
            description={
              <>
                <div style={{ fontSize: 12, wordBreak: "break-all" }}>
                  {t("browser.navFailedDesc", {
                    url: navUrl,
                    reason: navErrorReason(navError, t),
                  })}
                </div>
                <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
                  {navError}
                </div>
              </>
            }
          />
        )}

        <div style={{ textAlign: "center", marginBottom: 12 }}>
          <Typography.Text
            style={{ color: "rgba(255,255,255,0.68)", fontSize: 13 }}
          >
            {t("browser.quickNav")} · {t("browser.quickNavExtra")}
          </Typography.Text>
        </div>
        <Space size={12} wrap style={{ justifyContent: "center", width: "100%" }}>
          {QUICK_LINKS.map((l) => {
            let domain = "";
            try {
              domain = new URL(l.url).hostname.replace(/^www\./, "");
            } catch {
              domain = l.url;
            }
            const isActive = active === l.url;
            const dimmed = !!pending && !isActive;
            return (
              <Card
                key={l.url}
                size="small"
                hoverable={!pending}
                onClick={() => go(l.url)}
                // 按下/抬起做位移与描边，给点击一个即时反馈
                onMouseDown={() => setPressed(l.url)}
                onMouseUp={() => setPressed("")}
                onMouseLeave={() => setPressed("")}
                style={{
                  minWidth: 130,
                  textAlign: "center",
                  borderRadius: 8,
                  cursor: pending ? "default" : "pointer",
                  transition:
                    "transform .12s ease, box-shadow .18s ease, opacity .18s ease",
                  transform:
                    pressed === l.url ? "translateY(1px) scale(0.97)" : undefined,
                  boxShadow: isActive
                    ? "0 0 0 2px rgba(64,150,255,0.7)"
                    : undefined,
                  opacity: dimmed ? 0.45 : 1,
                  pointerEvents: dimmed ? "none" : "auto",
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 13 }}>
                  {l.key ? t(l.key) : l.name}
                </div>
                {/* 打开中：域名位置换成 loading；其余时候域名随卡片主题色半透明 */}
                <div
                  style={{
                    fontSize: 11,
                    opacity: isActive ? 0.85 : 0.55,
                    marginTop: 2,
                    minHeight: 22,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                  }}
                >
                  {isActive ? (
                    <>
                      <Spin size="small" />
                      <span>{t("browser.openingShort")}</span>
                    </>
                  ) : (
                    domain
                  )}
                </div>
              </Card>
            );
          })}
        </Space>

        {info && (
          <Card size="small" style={{ marginTop: 40, borderRadius: 8 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t("browser.fpSummary")}
            </Typography.Text>
            <div style={{ marginTop: 8 }}>
              <Tag>{osLabel(info.fingerprint.os)}</Tag>
              <Tag color="geekblue">{info.fingerprint.timezone}</Tag>
              <Tag color="purple">{info.fingerprint.languages.join(", ")}</Tag>
              <Tag color="cyan">
                {info.fingerprint.screenWidth}×{info.fingerprint.screenHeight}
              </Tag>
            </div>
            <Typography.Paragraph
              style={{ fontSize: 11, marginTop: 10, marginBottom: 0 }}
              type="secondary"
              ellipsis
            >
              {info.fingerprint.userAgent}
            </Typography.Paragraph>
          </Card>
        )}
      </div>

      {/* 打开中的提示条：环境窗口没有地址栏与进度条，导航期间必须有个明确的
          「正在打开」，否则打不开的站点与「点击没生效」在用户看来一模一样。
          这里刻意不做全屏遮罩——那会把快捷卡片上的 loading 一起盖住，
          用户反而看不到自己点的是哪一张。固定在底部、不挡卡片。 */}
      {pending && (
        <div
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            bottom: 24,
            display: "flex",
            justifyContent: "center",
            // 容器不吃事件，只有提示条本体可点，避免挡住页面其它操作
            pointerEvents: "none",
            zIndex: 99,
          }}
        >
          <Card
            size="small"
            style={{
              pointerEvents: "auto",
              maxWidth: 480,
              borderRadius: 10,
              boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
            styles={{ body: { display: "flex", alignItems: "center", gap: 12 } }}
          >
            <Spin size="small" />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, wordBreak: "break-all" }}>
                {t("browser.opening", { url: pending })}
              </div>
              <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>
                {t("browser.openingTip")}
              </div>
            </div>
            <Button size="small" danger onClick={cancelNav}>
              {t("browser.cancel")}
            </Button>
          </Card>
        </div>
      )}
    </div>
  );
}
