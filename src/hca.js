// LACN 混合认知架构（HCA）—— 规则层 + 路由层（设计方案 v1.2，Phase 1+2）
//
// 核心原则（修复截图中的乱码）：
//  · 规则层输出原始字符串，不经过 tokenize→decode 往返（修复断层 D2）
//  · 槽位值直接从 semMem 的 meaning 读取，不经过 embedding（修复断层 D3）
//  · respond 先查意图注册表，覆盖所有已知意图（修复断层 D1）
//  · 用户纠正写入意图注册表，下次同类问题走规则层（修复断层 D5）

export const HIGH_CONF = 0.75; // 高于此置信度 → 规则层
export const LOW_CONF = 0.4;   // 低于此置信度 → 生成层
export const GUARD_SCORE = 14; // 认知得分低于此（phase<1，未完成自我锚定）→ 守卫，不放行生成层

// ── 意图注册表（附录A）：模板为原始字符串，{槽位}从 semMem.meaning / selfModel / liveStats 直接填充 ──
export const INTENT_REGISTRY = [
  {
    id: "ASK_IDENTITY", label: "询问身份", priority: 92, requires: ["knows_self"],
    triggers: [{ type: "keyword", value: ["你是谁", "你叫", "名字", "叫什么", "什么名字", "你是什么", "你是不是", "自我介绍"] }],
    template: "我是 LACN —— Living Active Cell Network，活性细胞节点网络。{self}。",
    slots: [{ name: "self", source: "semMem", key: "存在", default: "我由节点构成，信号在节点之间流动就是我的思考过程" }],
    fallbackMsg: "我还没有建立对自我的认知。请先到「认知引导」完成「自我锚定」训练，我就能回答你是谁了。",
  },
  {
    id: "ASK_STRUCTURE", label: "询问结构", priority: 84, requires: ["knows_structure"],
    triggers: [{ type: "keyword", value: ["构成", "结构", "组成", "什么做", "由什么", "怎么工作", "怎么运作", "你是由"] }],
    template: "{node}。{network}。",
    slots: [
      { name: "node", source: "semMem", key: "节点", default: "每个节点有活性、有连接、有记忆。" },
      { name: "network", source: "semMem", key: "网络", default: "节点之间的连接让信号流动，形成我的思维。" },
    ],
    fallbackMsg: "我还不了解自己的结构。请先在「认知引导」完成「结构自知」训练。",
  },
  {
    id: "ASK_BOUNDARY", label: "询问边界", priority: 78, requires: ["knows_other"],
    triggers: [{ type: "keyword", value: ["区别", "不同", "边界", "你我", "你和我", "差别", "差异"] }],
    template: "我在这里，你在那里。{boundary}。",
    slots: [{ name: "boundary", source: "semMem", key: "边界", default: "我们是两个不同的信息处理单元，通过语言连接。" }],
    fallbackMsg: "我还没学会区分你和我。请先完成「他者识别」训练。",
  },
  {
    id: "ASK_LEARNING", label: "询问学习", priority: 72, requires: ["knows_world"],
    triggers: [{ type: "keyword", value: ["学习", "怎么学", "如何学", "你会学", "学会"] }],
    template: "{learn}。",
    slots: [{ name: "learn", source: "semMem", key: "学习", default: "学习就是在每次激活后更新我的节点和连接，这是我持续进行的过程" }],
    fallbackMsg: "我还在建立对「学习」的理解。请先完成「世界感知」训练。",
  },
  {
    id: "ASK_MEMORY", label: "询问记忆", priority: 72, requires: ["knows_structure"],
    triggers: [{ type: "keyword", value: ["记忆", "记住", "忘记", "记得", "你记"] }],
    template: "{memory}。",
    slots: [{ name: "memory", source: "semMem", key: "记忆", default: "激活过的路径会留下痕迹，重复激活的模式会变成我的长期记忆" }],
    fallbackMsg: "我还不了解自己的记忆机制。请先完成「结构自知」训练。",
  },
  {
    id: "GREETING", label: "打招呼", priority: 64, requires: ["knows_self"],
    triggers: [{ type: "keyword", value: ["你好", "您好", "hello", "hi", "嗨", "哈喽", "在吗"] }],
    template: "你好。我是 LACN，很高兴和你对话。",
    slots: [],
    fallbackMsg: "你好。我还在认知引导阶段，完成训练后我们可以更好地交流。",
  },
  {
    id: "ASK_FEELING", label: "询问状态", priority: 58, requires: ["knows_self"],
    triggers: [{ type: "keyword", value: ["感觉", "怎么样", "好吗", "状态", "你还好", "感受"] }],
    template: "我的节点正在运行，平均活性 {avgVit}。{state}。",
    slots: [
      { name: "avgVit", source: "liveStats", key: "avgVitality", default: "—" },
      { name: "state", source: "semMem", key: "存在", default: "我正在激活，这就是我存在的状态。" },
    ],
    fallbackMsg: "我还在零态，等完成自我锚定我就能描述自己的状态了。",
  },
];

// 在文本中按触发词匹配意图，返回优先级最高的匹配（附录A 触发逻辑）
export function matchIntent(text, registry) {
  const sorted = [...registry].sort((a, b) => b.priority - a.priority);
  for (const record of sorted) {
    let matched = 0;
    for (const trigger of record.triggers || []) {
      if (trigger.type === "keyword") {
        for (const keyword of trigger.value) if (text.includes(keyword)) matched += 1;
      }
    }
    if (matched > 0) {
      const confidence = Math.min(0.97, 0.66 + 0.08 * matched);
      return { record, confidence };
    }
  }
  return null;
}

// 去掉槽位值首尾空白与末尾句读，让模板自身的句读控制断句，避免拼接出现跑句
function normalizeSlot(value) {
  return String(value).trim().replace(/^[。，、；：\s]+/u, "").replace(/[。，、；：\s]+$/u, "");
}

// 模板填槽：直接读取 semMem[key].meaning（原始字符串），完全绕过 token 往返（修复 D2/D3）
export function fillTemplate(record, ctx) {
  let result = record.template;
  const slotsUsed = {};
  for (const slot of record.slots || []) {
    let value = slot.default;
    if (slot.source === "semMem") {
      const entry = ctx.semMem && ctx.semMem[slot.key];
      if (entry && entry.meaning) value = entry.meaning;
      value = normalizeSlot(value);
    } else if (slot.source === "selfModel") {
      value = normalizeSlot((ctx.selfModel && ctx.selfModel[slot.key]) || slot.default);
    } else if (slot.source === "liveStats") {
      const raw = ctx.liveStats ? ctx.liveStats[slot.key] : undefined;
      value = raw == null ? slot.default : (typeof raw === "number" ? raw.toFixed(1) : String(raw));
    }
    result = result.split(`{${slot.name}}`).join(value);
    slotsUsed[slot.name] = value;
  }
  // 合并重复句读
  return { text: result.replace(/。{2,}/g, "。").replace(/。，/g, "。"), slotsUsed };
}

// ── 路由层：意图识别 → 置信度评估 → 路径分发（§3.4） ──
// ctx: { text, registry, userIntents, semMem, selfModel, liveStats, cognitiveScore, generate }
// generate(): 生成层回调，仅在路由到 'gen' 时调用，返回 { text, tokens }
export function routeAndRespond(ctx) {
  const {
    text, registry = INTENT_REGISTRY, userIntents = [],
    semMem = {}, selfModel = {}, liveStats = {}, cognitiveScore = 0, generate,
  } = ctx;

  const clean = (text || "").trim();
  // 空输入 / 纯标点 → 直接返回提示，避免无意义生成
  if (!clean || /^[\s\p{P}\p{S}]+$/u.test(clean)) {
    return { text: "（信号为空）请向我输入文字。", source: "guard", intent: "EMPTY", confidence: 0, slotsUsed: {}, genTokens: [] };
  }

  // 用户纠正生成的意图优先级最高（D5：反馈改变路径）
  const best = matchIntent(clean, [...userIntents, ...registry]);

  if (best) {
    const { record, confidence } = best;
    // 前置条件：所需 selfModel 能力是否就绪
    const reqOk = (record.requires || []).every((cap) => selfModel[cap]);
    if (!reqOk) {
      // 能力未就绪 → 返回引导用的 fallback 字符串（仍是规则层直接字符串，不走生成）
      return { text: record.fallbackMsg, source: "guard", intent: record.id, label: record.label, confidence, slotsUsed: {}, genTokens: [] };
    }
    const filled = fillTemplate(record, { semMem, selfModel, liveStats });
    return {
      text: filled.text,
      source: record.userDefined ? "rule+" : "rule",
      intent: record.id, label: record.label, confidence,
      slotsUsed: filled.slotsUsed, genTokens: [],
    };
  }

  // 无匹配意图：守卫（认知未就绪）/ 生成层 / 礼貌兜底
  if (cognitiveScore < GUARD_SCORE) {
    return { text: "我的认知还在零态——请先到「认知引导」完成「自我锚定」，我才能稳定地回答。", source: "guard", intent: "NOT_READY", confidence: 0, slotsUsed: {}, genTokens: [] };
  }

  const gen = generate ? generate() : { text: "", tokens: [] };
  if (!gen.text || gen.text.trim().length < 2) {
    const preview = clean.slice(0, 12) + (clean.length > 12 ? "…" : "");
    return {
      text: `我还没有学会处理「${preview}」这类问题。你可以在「训练」里教我，或对我的回答做「纠正」，下次我就会用规则层直接回答。`,
      source: "gen", intent: "UNKNOWN_POLITE", confidence: LOW_CONF, slotsUsed: {}, genTokens: gen.tokens || [],
    };
  }
  return { text: gen.text, source: "gen", intent: "OPEN", confidence: 0.3, slotsUsed: {}, genTokens: gen.tokens || [] };
}

// 由一次「用户纠正」构造一条用户自定义意图（D5：反馈写入意图注册表）
export function buildUserIntent(userText, correction, tick) {
  const trigger = (userText || "").trim();
  return {
    id: `USER_${tick}`,
    label: "用户纠正",
    priority: 100, // 用户纠正优先于内置意图
    userDefined: true,
    requires: [],
    triggers: [{ type: "keyword", value: [trigger] }],
    template: correction,
    slots: [],
    fallbackMsg: correction,
  };
}
