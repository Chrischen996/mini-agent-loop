import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

type Locale = "zh-CN" | "en-US";

const translations: Record<Locale, Record<string, string>> = {
  "zh-CN": {
    settings: "设置",
    general: "通用",
    models: "模型",
    skills: "技能",
    about: "关于",
    appearance: "外观",
    theme: "主题",
    system: "跟随系统",
    light: "浅色",
    dark: "深色",
    currentSession: "当前会话",
    permissionMode: "权限模式",
    plan: "计划",
    bypass: "直接执行",
    currentSessionModel: "当前会话模型",
    sessionSkills: "会话技能",
    createSessionFirst: "先创建一个会话，才能管理技能。",
    loading: "加载中…",
    miniAgentLoop: "Mini Agent Loop",
    webWorkbench: "Web 工作台",
    closeSettings: "关闭设置",
    settingsSections: "设置分区",
    customModelInterface: "自定义模型接口",
    connectCompatible: "连接兼容 OpenAI 或 Anthropic 的接口。",
    addProvider: "添加提供商",
    loadingProviders: "正在加载提供商…",
    noProviders: "还没有配置自定义提供商。",
    editProvider: "编辑提供商",
    providerId: "提供商 ID",
    displayName: "显示名称",
    baseUrl: "接口地址",
    protocol: "接口协议",
    apiKey: "API 密钥",
    keepCurrentKey: "留空则保留当前密钥",
    advancedSettings: "高级接口设置",
    modelsCount: "个模型",
    keyConfigured: "已设置密钥",
    keyNotConfigured: "未设置密钥",
    canPullOrManual: "可以拉取模型列表，也可以手动填写 ID。",
    pulling: "拉取中…",
    pullModels: "拉取模型",
    modelId: "模型 ID",
    name: "名称",
    context: "上下文",
    maxOutput: "最大输出",
    input: "输入",
    text: "文本",
    textImage: "文本 + 图片",
    tools: "工具",
    enableThinking: "启用思考",
    defaultThinkingLevel: "默认思考强度",
    canUseDirectly: "可以直接使用，也可以在对话里改强度。",
    usingCustomSettings: "正在使用你保存的自定义设置。",
    advancedThinkingSettings: "高级思考设置",
    onlyForCustom: "只有自定义接口才需要。已有映射会保留。",
    useAutoSettings: "使用自动设置",
    addModel: "添加模型",
    removeModel: "移除模型",
    delete: "删除",
    cancel: "取消",
    saving: "保存中…",
    saveProvider: "保存提供商",
    back: "返回",
    selectModel: "选择模型",
    loadingModels: "正在加载模型",
    loadingModelsDots: "正在加载模型…",
    noModels: "没有可用模型",
    noMatchingModels: "没有匹配的模型",
    searchModels: "搜索模型",
    clearSearch: "清除搜索",
    thinkingIntensity: "思考强度",
    default: "默认",
    language: "语言",
    chinese: "中文",
    english: "English",
  },
  "en-US": {
    settings: "Settings",
    general: "General",
    models: "Models",
    skills: "Skills",
    about: "About",
    appearance: "Appearance",
    theme: "Theme",
    system: "System",
    light: "Light",
    dark: "Dark",
    currentSession: "Current session",
    permissionMode: "Permission mode",
    plan: "Plan",
    bypass: "Bypass",
    currentSessionModel: "Current session model",
    sessionSkills: "Session skills",
    createSessionFirst: "Create a session to manage skills.",
    loading: "Loading…",
    miniAgentLoop: "Mini Agent Loop",
    webWorkbench: "Web workspace",
    closeSettings: "Close settings",
    settingsSections: "Settings sections",
    customModelInterface: "Custom model providers",
    connectCompatible: "Connect an OpenAI- or Anthropic-compatible endpoint.",
    addProvider: "Add provider",
    loadingProviders: "Loading providers…",
    noProviders: "No custom providers configured yet.",
    editProvider: "Edit provider",
    providerId: "Provider ID",
    displayName: "Display name",
    baseUrl: "Base URL",
    protocol: "Protocol",
    apiKey: "API key",
    keepCurrentKey: "Leave blank to keep the current key",
    advancedSettings: "Advanced endpoint settings",
    modelsCount: "models",
    keyConfigured: "Key set",
    keyNotConfigured: "No key",
    canPullOrManual: "Pull the model list, or enter IDs manually.",
    pulling: "Pulling…",
    pullModels: "Pull models",
    modelId: "Model ID",
    name: "Name",
    context: "Context",
    maxOutput: "Max output",
    input: "Input",
    text: "Text",
    textImage: "Text + image",
    tools: "Tools",
    enableThinking: "Enable thinking",
    defaultThinkingLevel: "Default thinking level",
    canUseDirectly: "Ready to use. You can also change the level in chat.",
    usingCustomSettings: "Using your saved custom settings.",
    advancedThinkingSettings: "Advanced thinking settings",
    onlyForCustom: "Only needed for custom endpoints. Existing mappings are kept.",
    useAutoSettings: "Use automatic settings",
    addModel: "Add model",
    removeModel: "Remove model",
    delete: "Delete",
    cancel: "Cancel",
    saving: "Saving…",
    saveProvider: "Save provider",
    back: "Back",
    selectModel: "Select model",
    loadingModels: "Loading models",
    loadingModelsDots: "Loading models…",
    noModels: "No models available",
    noMatchingModels: "No matching models",
    searchModels: "Search models",
    clearSearch: "Clear search",
    thinkingIntensity: "Thinking intensity",
    default: "Default",
    language: "Language",
    chinese: "中文",
    english: "English",
  },
};

const STORAGE_KEY = "mini-agent-locale";

function readStoredLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "zh-CN" || stored === "en-US") return stored;
  } catch {
    // localStorage may be unavailable.
  }
  return "zh-CN";
}

type I18nContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readStoredLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
    document.documentElement.lang = next;
  }, []);

  const t = useCallback((key: string): string => {
    return translations[locale][key] ?? translations["en-US"][key] ?? key;
  }, [locale]);

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}
