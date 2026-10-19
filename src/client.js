/**
 * dsh-bigmodel-consume 浏览器端（client bundle，无需构建）。
 *
 * 加载协议：window.__ModuleLoader__.load({ id: <包名>, factory })，
 * factory(require) 内可用 require('react') 取外壳基座里的 React；
 * 导出 apply(ctx) 与 inject。数据通过同源 /api RPC 通道
 * （rpc.call('/api', 'bigmodel-usage.<endpoint>', payload)）请求宿主端。
 *
 * UI 贡献两个插槽：
 *  - conversation.input.right：模型选择器左侧的用量药丸（当前模型是
 *    智谱 zai/GLM 时才出现），点击展开用量弹窗（参照 opencode-go 的
 *    UsagePill 模式：session 级 inject + modelDirectories 目录 store）
 *  - settings.section：设置面板中的「GLM 用量」页（Key、组织/项目、刷新间隔）
 */
window.__ModuleLoader__.load({ id: "dsh-bigmodel-consume", factory: (require) => {
	var module = { exports: {} }; var exports = module.exports;

	const React = require("react");
	const { useState, useEffect, useRef, useSyncExternalStore } = React;
	const h = React.createElement;

	const NS = "dsh-bigmodel-consume";
	const PREFIX = "bigmodel-usage.";

	/* ---------------- 本地化 ---------------- */

	const zh = {
		navTitle: "GLM 用量",
		title: "GLM CodingPlan 用量",
		fiveHour: "5小时",
		fiveHourShort: "5h",
		weekly: "本周",
		weeklyShort: "周",
		monthlyMcp: "月度 MCP",
		remaining: "剩",
		resetIn: "后重置",
		resetAt: "重置于",
		creditsUnit: "积分",
		fetchedAt: "更新于",
		cached: "（缓存）",
		refresh: "刷新",
		refreshing: "刷新中…",
		noKeyTitle: "未配置 API Key",
		noKeyHint: "点击填入",
		apiKeyLabel: "API Key",
		apiKeyPlaceholder: "粘贴智谱 API Key",
		apiKeyHelp: "从 bigmodel.cn 控制台获取。留空保存则回退使用 DSH 凭据库的 ZAI_API_KEY。",
		orgLabel: "组织 ID（新版积分套餐需要，可选）",
		orgPlaceholder: "org-xxxxxxxx",
		projectLabel: "项目 ID（新版积分套餐需要，可选）",
		projectPlaceholder: "proj_xxxxxxxx",
		orgHelp: "新版积分套餐（2026-07 后，含团队套餐）需填组织/项目：登录 bigmodel.cn/coding-plan，在浏览器 DevTools 的 Network 里找 api/monitor/usage/quota/limit 请求，请求头 bigmodel-organization / bigmodel-project 与 query 参数 type 即这三项。",
		planLabel: "套餐类型",
		planTeam: "团队（type=2）",
		planPersonal: "个人（type=1）",
		regionLabel: "区域",
		regionCn: "bigmodel.cn（国内）",
		regionIntl: "z.ai（国际站）",
		pollLabel: "自动刷新间隔（分钟）",
		keySourceLabel: "当前 Key 来源",
		keySourceConfig: "插件配置",
		keySourceCredentials: "DSH 凭据 ZAI_API_KEY",
		keySourceEnv: "环境变量",
		keySourceNone: "未设置",
		levelLabel: "套餐档位",
		errorTitle: "获取失败",
		retry: "重试",
		save: "保存并测试",
		saving: "保存中…",
		clear: "清除",
		savedOk: "已保存，Key 验证通过",
		savedNoVerify: "已保存（网络错误，未能验证 Key）",
		dayUnit: "天",
		hourUnit: "时",
		minuteUnit: "分",
		loading: "加载中…",
		moreInSettings: "更多选项见 设置 → GLM 用量",
		noData: "暂无数据",
	};

	const en = {
		navTitle: "GLM Usage",
		title: "GLM CodingPlan Usage",
		fiveHour: "5-hour",
		fiveHourShort: "5h",
		weekly: "Weekly",
		weeklyShort: "Wk",
		monthlyMcp: "Monthly MCP",
		remaining: "left",
		resetIn: "to reset",
		resetAt: "Resets at",
		creditsUnit: "credits",
		fetchedAt: "Updated",
		cached: " (cached)",
		refresh: "Refresh",
		refreshing: "Refreshing…",
		noKeyTitle: "API key not configured",
		noKeyHint: "Click to add",
		apiKeyLabel: "API Key",
		apiKeyPlaceholder: "Paste your Zhipu API key",
		apiKeyHelp: "From the bigmodel.cn console. Leave empty and save to fall back to ZAI_API_KEY in the DSH credential store.",
		orgLabel: "Organization ID (new credit plans, optional)",
		orgPlaceholder: "org-xxxxxxxx",
		projectLabel: "Project ID (new credit plans, optional)",
		projectPlaceholder: "proj_xxxxxxxx",
		orgHelp: "Credit plans (after 2026-07, incl. team) need org/project: open bigmodel.cn/coding-plan, find the api/monitor/usage/quota/limit request in DevTools Network, and copy bigmodel-organization / bigmodel-project headers plus the type query.",
		planLabel: "Plan type",
		planTeam: "Team (type=2)",
		planPersonal: "Personal (type=1)",
		regionLabel: "Region",
		regionCn: "bigmodel.cn (CN)",
		regionIntl: "z.ai (international)",
		pollLabel: "Auto refresh interval (minutes)",
		keySourceLabel: "Active key source",
		keySourceConfig: "Plugin config",
		keySourceCredentials: "DSH credential ZAI_API_KEY",
		keySourceEnv: "Environment",
		keySourceNone: "none",
		levelLabel: "Plan tier",
		errorTitle: "Fetch failed",
		retry: "Retry",
		save: "Save & test",
		saving: "Saving…",
		clear: "Clear",
		savedOk: "Saved; key verified",
		savedNoVerify: "Saved (network error; key not verified)",
		dayUnit: "d",
		hourUnit: "h",
		minuteUnit: "m",
		loading: "Loading…",
		moreInSettings: "More options in Settings → GLM Usage",
		noData: "No data yet",
	};

	/* ---------------- 样式 ---------------- */

	const CSS = [
		/* 所有设计令牌都带系统色兜底（Canvas/CanvasText/GrayText 随深浅色自适应）：
		   DSH 更新若改令牌名，挂件只会变朴素而不会破相。 */
		/* 药丸按钮（composer 工具行内，模型选择器左侧） */
		".bmu-pill{position:relative;display:inline-flex}",
		".bmu-pill-trigger{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border:0.5px solid transparent;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,GrayText);font:var(--dsw-font-xs-13,12px/1.5 system-ui,sans-serif);cursor:pointer;white-space:nowrap}",
		".bmu-pill-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15));color:var(--dsw-alias-label-primary,CanvasText)}",
		".bmu-pill-trigger[data-open=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15));color:var(--dsw-alias-label-primary,CanvasText)}",
		".bmu-dot{flex:none;width:6px;height:6px;border-radius:3px;background:var(--dsw-alias-state-idle-primary,var(--dsw-alias-label-tertiary,GrayText))}",
		".bmu-dot[data-tone=ok]{background:var(--dsw-alias-state-success-primary,#1a7f37)}",
		".bmu-dot[data-tone=warn]{background:var(--dsw-alias-state-warn-primary,#9a6700)}",
		".bmu-dot[data-tone=danger]{background:var(--dsw-alias-state-error-primary,#cf222e)}",
		".bmu-dot[data-spin]{animation:bmu-pulse 1s ease-in-out infinite}",
		"@keyframes bmu-pulse{50%{opacity:.35}}",
		/* 弹窗（右对齐锚在按钮上方） */
		".bmu-panel{position:absolute;right:0;bottom:calc(100% + 8px);z-index:1100;width:304px;max-width:calc(100vw - 24px);box-sizing:border-box;padding:12px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,Canvas);box-shadow:var(--dsw-elevation-prominent,0 8px 28px rgba(0,0,0,.28));color:var(--dsw-alias-label-primary,CanvasText)}",
		".bmu-panel h4{margin:0 0 4px;font:var(--dsw-font-xs-13,12px/1.5 system-ui,sans-serif);color:var(--dsw-alias-label-primary,CanvasText)}",
		".bmu-panel .bmu-sub{color:var(--dsw-alias-label-tertiary,GrayText);font:var(--dsw-font-xs-13,12px/1.5 system-ui,sans-serif);font-size:11px;margin:0 0 4px}",
		/* 窗口行 */
		".bmu-win{padding:8px 0;border-top:0.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35))}",
		".bmu-win-head{display:flex;align-items:center;gap:8px}",
		".bmu-win-name{flex:none;width:58px;color:var(--dsw-alias-label-secondary,GrayText);font:var(--dsw-font-xs-13,12px/1.5 system-ui,sans-serif)}",
		".bmu-bar{flex:1;min-width:0;height:4px;border-radius:2px;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15));overflow:hidden}",
		".bmu-fill{height:100%;border-radius:2px;transition:width .3s ease}",
		".bmu-fill[data-tone=ok]{background:var(--dsw-alias-state-success-primary,#1a7f37)}",
		".bmu-fill[data-tone=warn]{background:var(--dsw-alias-state-warn-primary,#9a6700)}",
		".bmu-fill[data-tone=danger]{background:var(--dsw-alias-state-error-primary,#cf222e)}",
		".bmu-pct{flex:none;width:44px;text-align:right;color:var(--dsw-alias-label-secondary,GrayText);font:var(--dsw-font-xs-13,12px/1.5 system-ui,sans-serif);font-variant-numeric:tabular-nums;white-space:nowrap}",
		".bmu-win-line{display:flex;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-tertiary,GrayText);font:var(--dsw-font-xs-13,12px/1.5 system-ui,sans-serif);font-size:11px;margin-top:3px}",
		".bmu-meta{color:var(--dsw-alias-label-tertiary,GrayText);font:var(--dsw-font-xs-13,12px/1.5 system-ui,sans-serif);font-size:11px;margin-top:6px;line-height:1.5}",
		".bmu-err{margin-top:6px;color:var(--dsw-alias-state-error-primary,#cf222e);font:var(--dsw-font-xs-13,12px/1.5 system-ui,sans-serif);font-size:11px;line-height:1.5;word-break:break-all}",
		".bmu-actions{display:flex;align-items:center;gap:8px;margin-top:8px}",
		/* 表单与按钮 */
		".bmu-btn{padding:4px 10px;border:none;border-radius:6px;background:var(--dsw-alias-button-primary-fill,LinkText);color:var(--dsw-alias-label-primary-foreground,Canvas);font:var(--dsw-font-xs-13,12px/1.5 system-ui,sans-serif);cursor:pointer}",
		".bmu-btn:disabled{opacity:.55;cursor:default}",
		".bmu-btn-ghost{background:transparent;color:var(--dsw-alias-label-secondary,GrayText);border:0.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.4))}",
		".bmu-form{display:flex;flex-direction:column;gap:8px}",
		".bmu-field{display:flex;flex-direction:column;gap:3px}",
		".bmu-field-label{color:var(--dsw-alias-label-secondary,GrayText);font:var(--dsw-font-xs-13,12px/1.5 system-ui,sans-serif)}",
		".bmu-input{box-sizing:border-box;width:100%;padding:5px 8px;border:0.5px solid var(--dsw-alias-border-l4,rgba(128,128,128,.45));border-radius:6px;background:var(--dsw-alias-bg-layer-1,Canvas);color:var(--dsw-alias-label-primary,CanvasText);font:var(--dsw-font-xs-13,12px/1.5 system-ui,sans-serif)}",
		".bmu-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,LinkText)}",
		".bmu-select{appearance:auto}",
		".bmu-msg{color:var(--dsw-alias-state-success-primary,#1a7f37);font:var(--dsw-font-xs-13,12px/1.5 system-ui,sans-serif);font-size:11px}",
		".bmu-msg[data-tone=error]{color:var(--dsw-alias-state-error-primary,#cf222e)}",
		/* 设置页 */
		".bmu-settings{display:flex;flex-direction:column;gap:14px;padding:4px 0}",
		".bmu-settings h3{margin:0;font:var(--dsw-font-xs-13,12px/1.5 system-ui,sans-serif);color:var(--dsw-alias-label-primary,CanvasText)}",
		".bmu-help{color:var(--dsw-alias-label-tertiary,GrayText);font:var(--dsw-font-xs-13,12px/1.5 system-ui,sans-serif);font-size:11px;line-height:1.6}",
	].join("\n");

	/* ---------------- 数据 store ---------------- */

	function createUsageStore(rpc) {
		let state = {
			phase: "idle", // idle | loading | ready | error
			config: undefined,
			usage: undefined,
			error: undefined,
			saving: false,
			lastFetchedAt: undefined,
			lastAttemptAt: 0,
		};
		const listeners = new Set();
		const emit = () => { for (const listener of [...listeners]) listener(); };
		const set = (patch) => { state = { ...state, ...patch }; emit(); };

		function businessError(result) {
			const error = new Error(result && result.error ? result.error.message : "unknown error");
			error.code = result && result.error ? result.error.code : "unknown";
			return error;
		}

		/** 兼容通道：绕过 RPC 信封，普通同源 fetch 打到同一路由（宿主端裸 JSON 兼容）。 */
		async function plainCall(endpoint, body) {
			const response = await fetch(`/api/${PREFIX}${endpoint}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			let json;
			try {
				json = await response.json();
			} catch {
				throw new Error(`HTTP ${response.status}`);
			}
			const result = json !== null && typeof json === "object" && json.type === "server-response" && json.result !== undefined
				? json.result
				: json;
			if (result !== null && typeof result === "object" && result.ok === true) return result.value;
			throw businessError(result);
		}

		async function call(endpoint, payload) {
			const body = payload ?? {};
			if (rpc !== undefined && rpc !== null && typeof rpc.call === "function") {
				try {
					const result = await rpc.call("/api", PREFIX + endpoint, body);
					if (result !== null && typeof result === "object" && result.ok === true) return result.value;
					throw businessError(result);
				} catch (error) {
					// 带业务码的错误直接上抛；通道/信封层异常才走兼容通道
					if (error !== null && typeof error === "object" && typeof error.code === "string") throw error;
				}
			}
			return await plainCall(endpoint, body);
		}

		async function loadConfig() {
			try {
				const config = await call("config");
				set({ config });
			} catch {
				set({ config: undefined });
			}
		}

		async function refresh(options) {
			const background = options && options.background === true;
			if (state.lastAttemptAt && Date.now() - state.lastAttemptAt < 2000) return; // 防抖
			set({ lastAttemptAt: Date.now(), ...(background && state.usage ? {} : { phase: "loading" }) });
			try {
				const usage = await call("usage", { force: options && options.force === true });
				set({ phase: "ready", usage, error: undefined, lastFetchedAt: Date.now() });
			} catch (error) {
				set({ phase: state.usage ? "ready" : "error", error });
			}
		}

		/** 弹窗打开时的按需刷新：超过 60 秒才真正请求。 */
		function refreshIfStale() {
			if (state.lastFetchedAt === undefined || Date.now() - state.lastFetchedAt > 60000) {
				refresh({ force: state.lastFetchedAt !== undefined });
			}
		}

		async function saveConfig(patch) {
			set({ saving: true });
			try {
				const value = await call("setConfig", patch);
				await Promise.all([loadConfig(), refresh({ force: true })]);
				set({ saving: false });
				return { ok: true, value };
			} catch (error) {
				set({ saving: false });
				return { ok: false, error };
			}
		}

		return {
			subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
			getSnapshot: () => state,
			refresh,
			refreshIfStale,
			loadConfig,
			saveConfig,
		};
	}

	/* ---------------- 工具 ---------------- */

	/** 当前会话选中的模型是否智谱（provider 或模型 id 判断）。 */
	function isZhipuModel(selection) {
		if (selection === null || typeof selection !== "object") return false;
		const provider = String(selection.provider ?? "");
		const model = String(selection.model ?? "");
		if (/^(zai|glm|zhipu|bigmodel)([./_-].*)?$/i.test(provider)) return true;
		return /^glm[-_.]/i.test(model);
	}

	function toneFor(usedPercent) {
		if (usedPercent >= 90) return "danger";
		if (usedPercent >= 70) return "warn";
		return "ok";
	}

	function fmtCountdown(resetAt, t, now) {
		let sec = Math.max(0, Math.floor((resetAt - (now ?? Date.now())) / 1000));
		const d = Math.floor(sec / 86400); sec -= d * 86400;
		const hr = Math.floor(sec / 3600); sec -= hr * 3600;
		const min = Math.floor(sec / 60);
		if (d > 0) return `${d}${t("dayUnit")}${hr}${t("hourUnit")}`;
		if (hr > 0) return `${hr}${t("hourUnit")}${min}${t("minuteUnit")}`;
		return `${min}${t("minuteUnit")}`;
	}

	function fmtClock(ms) {
		try {
			return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
		} catch {
			return new Date(ms).toISOString().slice(11, 16);
		}
	}

	function fmtFull(ms) {
		try {
			return new Date(ms).toLocaleString(undefined, { hour12: false });
		} catch {
			return new Date(ms).toISOString();
		}
	}

	function fmtNum(n) {
		if (n === undefined || n === null || !Number.isFinite(n)) return undefined;
		return Math.round(n).toLocaleString("en-US");
	}

	/* ---------------- 组件 ---------------- */

	function Bar({ usedPercent, tone }) {
		return h("div", { className: "bmu-bar" },
			h("div", { className: "bmu-fill", "data-tone": tone, style: { width: `${Math.max(0, Math.min(100, usedPercent))}%` } }));
	}

	/** 弹窗/设置页共用的窗口详情行。 */
	function WindowDetail({ name, win, t }) {
		if (!win) return null;
		const used = fmtNum(win.used);
		const total = fmtNum(win.total);
		const remaining = fmtNum(win.remaining);
		const credits = used !== undefined && total !== undefined
			? `${used} / ${total} ${t("creditsUnit")}`
			: remaining !== undefined ? `${t("remaining")} ${remaining} ${t("creditsUnit")}` : undefined;
		const reset = win.resetAt !== undefined
			? `${fmtFull(win.resetAt)}（${fmtCountdown(win.resetAt, t)}${t("resetIn")}）`
			: undefined;
		return h("div", { className: "bmu-win" },
			h("div", { className: "bmu-win-head" },
				h("span", { className: "bmu-win-name" }, name),
				h(Bar, { usedPercent: win.usedPercent, tone: toneFor(win.usedPercent) }),
				h("span", { className: "bmu-pct" }, `${t("remaining")} ${Math.round(win.remainingPercent)}%`)),
			credits ? h("div", { className: "bmu-win-line" }, h("span", null, credits)) : null,
			reset ? h("div", { className: "bmu-win-line" }, h("span", null, `${t("resetAt")} ${reset}`)) : null);
	}

	/** 全部窗口详情 + 元信息；无 Key 时显示 Key 表单。 */
	function DetailPanel({ state, t, store }) {
		const usage = state.usage;
		const rows = [];
		if (usage) {
			if (usage.fiveHour) rows.push(h(WindowDetail, { key: "5h", name: t("fiveHour"), win: usage.fiveHour, t }));
			if (usage.weekly) rows.push(h(WindowDetail, { key: "w", name: t("weekly"), win: usage.weekly, t }));
			if (usage.monthlyMcp) rows.push(h(WindowDetail, { key: "m", name: t("monthlyMcp"), win: usage.monthlyMcp, t }));
		}
		const meta = [];
		if (usage && usage.level) meta.push(`${t("levelLabel")}: ${usage.level}`);
		if (usage && usage.fetchedAt) meta.push(`${t("fetchedAt")} ${fmtClock(usage.fetchedAt)}${usage.cached ? t("cached") : ""}`);
		if (state.config && state.config.keySource) {
			const sourceMap = { config: "keySourceConfig", credentials: "keySourceCredentials", env: "keySourceEnv" };
			meta.push(`${t("keySourceLabel")}: ${t(sourceMap[state.config.keySource] ?? "keySourceNone")}`);
		}
		const busy = state.phase === "loading";
		return h("div", null,
			rows.length > 0 ? rows : (busy ? h("div", { className: "bmu-meta" }, t("loading")) : h("div", { className: "bmu-meta" }, t("noData"))),
			state.error ? h("div", { className: "bmu-err" }, `${t("errorTitle")}: ${state.error.message}`) : null,
			meta.length > 0 ? h("div", { className: "bmu-meta" }, meta.join(" · ")) : null,
			h("div", { className: "bmu-actions" },
				h("button", {
					className: "bmu-btn", disabled: busy, onClick: (event) => {
						event.stopPropagation();
						store.refresh({ force: true });
					},
				}, busy ? t("refreshing") : state.error ? t("retry") : t("refresh"))));
	}

	/** 无 Key 时的录入表单（弹窗精简版）。 */
	function KeyForm({ store, t, compact }) {
		const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
		const [apiKey, setApiKey] = useState("");
		const [message, setMessage] = useState(undefined);
		const [tone, setTone] = useState("ok");
		const busy = state.saving;
		const submit = async (event) => {
			event.stopPropagation();
			setMessage(undefined);
			const result = await store.saveConfig({ apiKey: apiKey.trim() });
			if (result.ok) {
				setTone("ok");
				setMessage(result.value && result.value.tested === "network" ? t("savedNoVerify") : t("savedOk"));
				setApiKey("");
			} else {
				setTone("error");
				setMessage(result.error.message);
			}
		};
		return h("form", {
			className: "bmu-form",
			onClick: (event) => event.stopPropagation(),
			onSubmit: (event) => { event.preventDefault(); if (!busy && apiKey.trim()) submit(event); },
		},
			h("div", { className: "bmu-field" },
				h("label", { className: "bmu-field-label" }, t("apiKeyLabel")),
				h("input", {
					className: "bmu-input", type: "password", value: apiKey,
					placeholder: t("apiKeyPlaceholder"), autoComplete: "off", spellCheck: false,
					onChange: (event) => setApiKey(event.target.value),
				})),
			!compact ? h("div", { className: "bmu-help" }, t("apiKeyHelp")) : null,
			h("div", { className: "bmu-actions" },
				h("button", { className: "bmu-btn", type: "submit", disabled: busy || !apiKey.trim() }, busy ? t("saving") : t("save")),
				message ? h("span", { className: "bmu-msg", "data-tone": tone }, message) : null),
			compact ? h("div", { className: "bmu-meta" }, t("moreInSettings")) : null);
	}

	/**
	 * 模型选择器左侧的用量药丸（conversation.input.right）。
	 * session 级 inject 提供 { directory, store, t }：directory 是
	 * modelDirectories.directoryFor(sessionId).store，快照的 current 即
	 * 当前模型选择；非智谱模型时整体不渲染（与 opencode-go 一致）。
	 */
	/** 缺省目录：modelDirectories 接口变化时药丸安全地隐藏而非崩溃。 */
	const EMPTY_DIRECTORY = { current: null };

	function UsagePill({ directory, store, t }) {
		const safeDirectory = directory !== null && typeof directory === "object" && typeof directory.subscribe === "function" && typeof directory.getSnapshot === "function"
			? directory
			: EMPTY_DIRECTORY;
		const dirState = useSyncExternalStore(safeDirectory.subscribe, safeDirectory.getSnapshot, safeDirectory.getSnapshot);
		const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
		const [open, setOpen] = useState(false);
		const rootRef = useRef(null);
		const current = dirState !== null && typeof dirState === "object" ? dirState.current : null;

		useEffect(() => {
			if (!open) return;
			const onDown = (event) => {
				const root = rootRef.current;
				if (root && !root.contains(event.target)) setOpen(false);
			};
			const onKey = (event) => { if (event.key === "Escape") setOpen(false); };
			document.addEventListener("mousedown", onDown);
			document.addEventListener("keydown", onKey);
			return () => {
				document.removeEventListener("mousedown", onDown);
				document.removeEventListener("keydown", onKey);
			};
		}, [open]);

		if (!isZhipuModel(current)) return null;

		const usage = state.usage;
		const noKey = state.config !== undefined && state.config.hasKey === false;
		const busy = state.phase === "loading";

		// 状态点颜色：无 Key/出错橙红，否则取两窗口中较差的一档
		let dotTone = "ok";
		if (noKey || (state.error && !usage)) dotTone = "warn";
		if (usage) {
			const worst = Math.max(
				usage.fiveHour !== undefined ? usage.fiveHour.usedPercent : 0,
				usage.weekly !== undefined ? usage.weekly.usedPercent : 0,
			);
			dotTone = toneFor(worst);
		}

		let label;
		if (noKey) {
			label = `GLM ${t("noKeyHint")}`;
		} else if (usage && (usage.fiveHour !== undefined || usage.weekly !== undefined)) {
			const parts = [];
			if (usage.fiveHour !== undefined) parts.push(`${t("fiveHourShort")} ${Math.round(usage.fiveHour.remainingPercent)}%`);
			if (usage.weekly !== undefined) parts.push(`${t("weeklyShort")} ${Math.round(usage.weekly.remainingPercent)}%`);
			label = `GLM ${parts.join(" · ")}`;
		} else if (state.error && !usage) {
			label = "GLM !";
		} else {
			label = "GLM …";
		}
		const ariaLabel = noKey ? `${t("title")} — ${t("noKeyTitle")}` : `${t("title")}: ${label}`;

		const toggleOpen = (event) => {
			event.preventDefault();
			setOpen((value) => {
				if (!value) store.refreshIfStale();
				return !value;
			});
		};

		return h("span", { className: "bmu-pill", ref: rootRef },
			h("button", {
				type: "button",
				className: "bmu-pill-trigger",
				"data-open": open ? "true" : undefined,
				"aria-expanded": open,
				"aria-haspopup": "dialog",
				"aria-label": ariaLabel,
				title: t("title"),
				onClick: toggleOpen,
			},
				h("span", { className: "bmu-dot", "data-tone": dotTone, "data-spin": busy ? "true" : undefined }),
				label),
			open ? h("div", {
				className: "bmu-panel", role: "dialog", "aria-label": t("title"), "aria-busy": busy,
				onClick: (event) => event.stopPropagation(),
			},
				h("h4", null, t("title")),
				usage !== undefined && usage.level ? h("p", { className: "bmu-sub" }, `${t("levelLabel")}: ${usage.level}`) : null,
				noKey ? h(KeyForm, { store, t, compact: true }) : h(DetailPanel, { state, t, store }))
				: null);
	}

	/** 设置页（settings.section）。 */
	function UsageSettings({ store, t }) {
		const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
		const config = state.config;
		const [apiKey, setApiKey] = useState("");
		const [organization, setOrganization] = useState("");
		const [project, setProject] = useState("");
		const [message, setMessage] = useState(undefined);
		const [tone, setTone] = useState("ok");
		const busy = state.saving;
		const dirty = apiKey.trim() !== "" || organization !== (config?.organization ?? "") || project !== (config?.project ?? "");

		useEffect(() => {
			setOrganization(config?.organization ?? "");
			setProject(config?.project ?? "");
		}, [config?.organization, config?.project]);

		const save = async (event) => {
			event.preventDefault();
			setMessage(undefined);
			const patch = {};
			if (apiKey.trim() !== "") patch.apiKey = apiKey.trim();
			if (organization !== (config?.organization ?? "")) patch.organization = organization;
			if (project !== (config?.project ?? "")) patch.project = project;
			const result = await store.saveConfig(patch);
			if (result.ok) {
				setTone("ok");
				setMessage(result.value && result.value.tested === "network" ? t("savedNoVerify") : t("savedOk"));
				setApiKey("");
			} else {
				setTone("error");
				setMessage(result.error.message);
			}
		};

		const setPref = (patch) => {
			store.saveConfig(patch).then((result) => {
				if (!result.ok) { setTone("error"); setMessage(result.error.message); }
				else setMessage(undefined);
			});
		};

		const sourceMap = { config: "keySourceConfig", credentials: "keySourceCredentials", env: "keySourceEnv" };

		return h("div", { className: "bmu-settings" },
			h("h3", null, t("title")),
			h("form", { className: "bmu-form", onSubmit: (event) => event.preventDefault() },
				h("div", { className: "bmu-field" },
					h("label", { className: "bmu-field-label" }, t("apiKeyLabel")),
					h("input", {
						className: "bmu-input", type: "password", value: apiKey,
						placeholder: config?.keyPreview ? config.keyPreview : t("apiKeyPlaceholder"),
						autoComplete: "off", spellCheck: false,
						onChange: (event) => setApiKey(event.target.value),
					}),
					h("div", { className: "bmu-help" }, t("apiKeyHelp")),
					config ? h("div", { className: "bmu-help" }, `${t("keySourceLabel")}: ${config.hasKey && config.keySource ? t(sourceMap[config.keySource] ?? "keySourceNone") : t("keySourceNone")}${config.keyPreview && config.keySource === "config" ? ` (${config.keyPreview})` : ""}`) : null),
				h("div", { className: "bmu-field" },
					h("label", { className: "bmu-field-label" }, t("orgLabel")),
					h("input", { className: "bmu-input", value: organization, placeholder: t("orgPlaceholder"), autoComplete: "off", spellCheck: false, onChange: (event) => setOrganization(event.target.value) })),
				h("div", { className: "bmu-field" },
					h("label", { className: "bmu-field-label" }, t("projectLabel")),
					h("input", { className: "bmu-input", value: project, placeholder: t("projectPlaceholder"), autoComplete: "off", spellCheck: false, onChange: (event) => setProject(event.target.value) })),
				h("div", { className: "bmu-help" }, t("orgHelp")),
				h("div", { className: "bmu-actions" },
					h("button", { className: "bmu-btn", type: "submit", disabled: busy || !dirty, onClick: save }, busy ? t("saving") : t("save")),
					config?.keySource === "config" ? h("button", {
						className: "bmu-btn bmu-btn-ghost", type: "button", disabled: busy,
						onClick: () => { setPref({ apiKey: "" }); setApiKey(""); },
					}, t("clear")) : null,
					message ? h("span", { className: "bmu-msg", "data-tone": tone }, message) : null)),
			h("form", { className: "bmu-form", onSubmit: (event) => event.preventDefault() },
				h("div", { className: "bmu-field" },
					h("label", { className: "bmu-field-label" }, t("planLabel")),
					h("div", { className: "bmu-actions" },
						h("button", { className: `bmu-btn${config?.planType === 2 ? "" : " bmu-btn-ghost"}`, type: "button", disabled: !config || config.planType === 2, onClick: () => setPref({ planType: 2 }) }, t("planTeam")),
						h("button", { className: `bmu-btn${config?.planType === 1 ? "" : " bmu-btn-ghost"}`, type: "button", disabled: !config || config.planType === 1, onClick: () => setPref({ planType: 1 }) }, t("planPersonal")))),
				h("div", { className: "bmu-field" },
					h("label", { className: "bmu-field-label" }, t("regionLabel")),
					h("div", { className: "bmu-actions" },
						h("button", { className: `bmu-btn${config?.region !== "intl" ? "" : " bmu-btn-ghost"}`, type: "button", disabled: !config || config.region !== "intl", onClick: () => setPref({ region: "cn" }) }, t("regionCn")),
						h("button", { className: `bmu-btn${config?.region === "intl" ? "" : " bmu-btn-ghost"}`, type: "button", disabled: !config || config.region === "intl", onClick: () => setPref({ region: "intl" }) }, t("regionIntl")))),
				h("div", { className: "bmu-field" },
					h("label", { className: "bmu-field-label" }, t("pollLabel")),
					h("select", {
						className: "bmu-input bmu-select", value: String(config?.pollMinutes ?? 5), disabled: !config,
						onChange: (event) => setPref({ pollMinutes: Number(event.target.value) }),
					},
						[1, 2, 5, 10, 30, 60].map((minutes) => h("option", { key: minutes, value: String(minutes) }, String(minutes)))))),
			h(DetailPanel, { state, t, store }));
	}

	/* ---------------- 插件入口 ---------------- */

	const inject = ["slots", "locale"];

	/** 药丸首选插槽与降级候选：主插槽被改名/移除时依次尝试。 */
	const PILL_SLOT_CANDIDATES = ["conversation.input.right", "conversation.composer.dock"];

	function apply(ctx) {
		const warn = (message) => { try { console.warn("[dsh-bigmodel-consume]", message); } catch { /* 忽略 */ } };

		// 每个关注点独立失败软着陆：任何一块接口变化都不拖垮其余功能。
		try {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), NS + ": locale dictionaries");
		} catch (error) { warn(`locale 注册失败（界面退回内置词典）: ${error}`); }
		try {
			ctx.effect(() => {
				const style = document.createElement("style");
				style.setAttribute("data-plugin", NS);
				style.textContent = CSS;
				document.head.appendChild(style);
				return () => style.remove();
			}, NS + ": pill styles");
		} catch (error) { warn(`样式注入失败: ${error}`); }

		const tf = (() => {
			try {
				const bound = ctx.locale.bind(NS);
				return (key) => {
					const value = bound(key);
					return value === undefined || value === null || value === "" ? (zh[key] ?? en[key] ?? key) : value;
				};
			} catch {
				return (key) => zh[key] ?? en[key] ?? key;
			}
		})();

		let rpc;
		try {
			const connection = ctx.get("connection");
			rpc = connection !== null && typeof connection === "object" ? connection.rpc : undefined;
		} catch (error) { warn(`connection 服务不可用（退回普通同源 fetch）: ${error}`); }
		const store = createUsageStore(rpc);

		store.loadConfig().then(() => store.refresh({ background: false })).catch(() => {});

		// 轮询：每 30 秒检查一次是否到期（间隔由配置决定），页面不可见时暂停。
		try {
			ctx.effect(() => {
				const timer = setInterval(() => {
					if (document.visibilityState !== "visible") return;
					const snapshot = store.getSnapshot();
					const minutes = snapshot.config && snapshot.config.pollMinutes ? snapshot.config.pollMinutes : 5;
					if (Date.now() - (snapshot.lastFetchedAt ?? 0) >= minutes * 60000) {
						store.refresh({ background: true });
					}
				}, 30000);
				return () => clearInterval(timer);
			}, NS + ": usage polling");
		} catch (error) { warn(`轮询注册失败: ${error}`); }

		try {
			ctx.on("connection/reset", () => {
				store.loadConfig().then(() => store.refresh({ force: true })).catch(() => {});
			});
		} catch { /* 事件名变化时忽略 */ }

		// 模型选择器左侧的用量药丸：等 modelDirectories 服务就绪，
		// session 级 inject 用当前会话的模型目录决定显隐；
		// 主插槽不可用时按候选链降级。
		if (typeof ctx.inject === "function") {
			const registerPill = (scope, candidates) => {
				const slotName = candidates[0];
				if (slotName === undefined) { warn("所有候选插槽均不可用，药丸停用（其余功能不受影响）"); return; }
				const makeOptions = (name) => ({
					name,
					id: "bigmodel-usage",
					order: name === "conversation.input.right" ? 500 : 40,
					locale: NS,
					inject: (sessionId) => {
						let directory;
						try {
							directory = scope.modelDirectories.directoryFor(sessionId).store;
						} catch (error) {
							warn(`模型目录不可用，药丸暂时隐藏: ${error}`);
							directory = undefined;
						}
						return { directory, store, t: tf };
					},
				});
				try {
					scope.slots.inject(slotName, () => {
						try {
							return scope.slots.register(makeOptions(slotName), UsagePill);
						} catch (error) {
							warn(`插槽 ${slotName} 拒绝注册，尝试降级: ${error}`);
							registerPill(scope, candidates.slice(1));
							return () => {};
						}
					});
				} catch (error) {
					warn(`插槽 ${slotName} 不可用，尝试降级: ${error}`);
					registerPill(scope, candidates.slice(1));
				}
			};
			ctx.inject(["modelDirectories"], (scope) => { registerPill(scope, PILL_SLOT_CANDIDATES); });
		} else warn("ctx.inject 不可用，药丸停用");

		// 设置页
		try {
			ctx.slots.inject("settings.section", () => {
				try {
					return ctx.slots.register({
						name: "settings.section",
						id: "bigmodel-usage",
						order: 95,
						label: () => tf("navTitle"),
						inject: () => ({ store, t: tf }),
					}, UsageSettings);
				} catch (error) { warn(`设置页注册失败: ${error}`); return () => {}; }
			});
		} catch (error) { warn(`设置页注册失败: ${error}`); }
	}

	exports.apply = apply;
	exports.inject = inject;
	return module.exports;
} });
