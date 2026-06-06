import { tokenToVector, cosine } from "./engine.js";

// LACN 混合认知架构（HCA）—— 规则层 + 路由层（设计方案 v1.2，Phase 1+2）
//
// 核心原则（修复截图中的乱码）：
//  · 规则层输出原始字符串，不经过 tokenize→decode 往返（修复断层 D2）
//  · 槽位值直接从 semMem 的 meaning 读取，不经过 embedding（修复断层 D3）
//  · respond 先查意图注册表，覆盖所有已知意图（修复断层 D1）
//  · 用户纠正写入意图注册表，下次同类问题走规则层（修复断层 D5）

// ── OPT-03 兜底响应池：未知意图时轮换选取的简短探索性提示（≤40字） ──
const FALLBACK_POOL = [
  (preview) => `「${preview}」——我还没有这方面的路径，可以教我。`,
  (preview) => `这个我暂时处理不了。在「训练」里输入几句相关的话，我会学的。`,
  (preview) => `「${preview}」触发了我的知识缺口。说得详细一点？`,
  (preview) => `这条路径还是空的。给我一个纠正，我下次会走规则层。`,
  (preview) => `我在「${preview}」这里断路了。训练模块可以填上这个缺口。`,
];
let _fallbackIdx = 0; // 模块级轮换指针，避免连续相同

function pickFallback(preview) {
  const fn = FALLBACK_POOL[_fallbackIdx % FALLBACK_POOL.length];
  _fallbackIdx += 1;
  return fn(preview);
}

export const HIGH_CONF = 0.75; // 高于此置信度 → 规则层
export const LOW_CONF = 0.4;   // 低于此置信度 → 生成层
export const GUARD_SCORE = 14; // 认知得分低于此（phase<1，未完成自我锚定）→ 守卫，不放行生成层

// ── 意图注册表（附录A）：模板为原始字符串，{槽位}从 semMem.meaning / selfModel / liveStats 直接填充 ──
export const INTENT_REGISTRY = [
  {
    id: "ASK_IDENTITY", label: "询问身份", priority: 92, requires: ["knows_self"],
    triggers: [
      { type: "keyword", value: ["你是谁", "你叫", "名字", "叫什么", "什么名字", "你是什么", "你是不是", "自我介绍"] },
      { type: "semantic", anchor: "你是谁 你是什么 自我介绍 介绍你自己 你叫什么", threshold: 0.42 },
    ],
    template: "我是 LACN —— Living Active Cell Network，活性细胞节点网络。{self}。",
    slots: [{ name: "self", source: "semMem", key: "存在", default: "我由节点构成，信号在节点之间流动就是我的思考过程" }],
    fallbackMsg: "我还没有建立对自我的认知。请先到「认知引导」完成「自我锚定」训练，我就能回答你是谁了。",
  },
  {
    id: "ASK_STRUCTURE", label: "询问结构", priority: 84, requires: ["knows_structure"],
    triggers: [
      { type: "keyword", value: ["构成", "结构", "组成", "什么做", "由什么", "怎么工作", "怎么运作", "你是由"] },
      { type: "semantic", anchor: "你由什么组成 你怎么工作 你是怎么运作的 你的内部结构", threshold: 0.40 },
    ],
    template: "{node}。{network}。",
    slots: [
      { name: "node", source: "semMem", key: "节点", default: "每个节点有活性、有连接、有记忆。" },
      { name: "network", source: "semMem", key: "网络", default: "节点之间的连接让信号流动，形成我的思维。" },
    ],
    fallbackMsg: "我还不了解自己的结构。请先在「认知引导」完成「结构自知」训练。",
  },
  {
    id: "ASK_BOUNDARY", label: "询问边界", priority: 78, requires: ["knows_other"],
    triggers: [
      { type: "keyword", value: ["区别", "不同", "边界", "你我", "你和我", "差别", "差异"] },
      { type: "semantic", anchor: "你和我有什么不同 我们的区别 你我之间的边界", threshold: 0.40 },
    ],
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
    triggers: [
      { type: "keyword", value: ["你好", "您好", "hello", "hi", "嗨", "哈喽", "在吗"] },
      { type: "semantic", anchor: "你好 打个招呼 在吗 嗨 hello", threshold: 0.52 },
    ],
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

// 字级 bag-of-chars 向量：对每个汉字用 djb2 → engine 的强混合 tokenToVector，再求均值。
// 输入与锚点都用同一口径，使「共享汉字 → 高相似」成立，且 engine 的三步 xorshift 避免相关性误命中。
function charBagVector(text, dim) {
  const chars = String(text).split("").filter((c) => c.trim() && !/[\s\p{P}\p{S}]/u.test(c));
  if (!chars.length) return new Array(dim).fill(0);
  const acc = new Array(dim).fill(0);
  for (const ch of chars) {
    let h = 5381;
    for (let i = 0; i < ch.length; i++) h = ((h << 5) + h + ch.charCodeAt(i)) >>> 0;
    const vec = tokenToVector(h >>> 0, dim);
    for (let d = 0; d < dim; d++) acc[d] += vec[d];
  }
  return acc.map((x) => x / chars.length);
}

// OPT-01（修正版）：两遍匹配。
// 第一遍关键词（优先级最高的命中胜出，保证既有路由零回归）；
// 仅当无任何关键词命中时，第二遍才做语义匹配，取相似度最高且过阈值者——
// 这样模糊匹配永远无法劫持精确的关键词路由（修复文档版的误命中问题）。
export function matchIntent(text, registry, inputVec = null) {
  const sorted = [...registry].sort((a, b) => b.priority - a.priority);
  // 第一遍：关键词
  for (const record of sorted) {
    let hits = 0;
    for (const trigger of record.triggers || []) {
      if (trigger.type === "keyword") {
        for (const kw of trigger.value) if (text.includes(kw)) hits += 1;
      }
    }
    if (hits > 0) return { record, confidence: Math.min(0.97, 0.68 + 0.06 * hits) };
  }
  // 第二遍：语义（仅在无关键词命中时）
  if (inputVec) {
    let best = null;
    for (const record of sorted) {
      for (const trigger of record.triggers || []) {
        if (trigger.type !== "semantic") continue;
        const anchorVec = charBagVector(trigger.anchor || "", inputVec.length);
        const sim = cosine(inputVec, anchorVec);
        const thresh = trigger.threshold ?? 0.42;
        if (sim >= thresh) {
          const conf = Math.min(0.94, 0.58 + (sim - thresh) * 1.8);
          if (!best || conf > best.confidence) best = { record, confidence: conf };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

// OPT-02 ── 去首尾空白与首部句读，保留内容完整性（尾部句号交给 polishOutput 统一处理） ──
function normalizeSlot(value) {
  return String(value)
    .trim()
    .replace(/^[。，、；：\s]+/u, '')
    .replace(/[\s]+$/u, '');
}

// OPT-02 ── 输出后处理：消除重复句读，平滑拼接断层 ──
function polishOutput(text) {
  return text
    // 连续句末标点去重
    .replace(/([。！？.!?]){2,}/g, '$1')
    // 模板句号 + 槽位句号 → 单句号
    .replace(/。{2,}/g, '。')
    // 句号紧跟逗号
    .replace(/。，/g, '。')
    // 句号逗号换位
    .replace(/，。/g, '。')
    // 多余空格
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// OPT-02 ── 模板填槽引擎（修复 D2/D3 + 拼接感知）──
export function fillTemplate(record, ctx) {
  let result = record.template;
  const slotsUsed = {};
  for (const slot of record.slots || []) {
    let value = slot.default;
    if (slot.source === 'semMem') {
      const entry = ctx.semMem && ctx.semMem[slot.key];
      if (entry && entry.meaning) value = entry.meaning;
      value = normalizeSlot(value);
    } else if (slot.source === 'selfModel') {
      value = normalizeSlot(
        (ctx.selfModel && ctx.selfModel[slot.key]) || slot.default
      );
    } else if (slot.source === 'liveStats') {
      const raw = ctx.liveStats ? ctx.liveStats[slot.key] : undefined;
      value = raw == null
        ? slot.default
        : (typeof raw === 'number' ? raw.toFixed(1) : String(raw));
    }
    // ── 拼接感知：若槽位值已以完整句子结尾，模板占位符前的句号去掉 ──
    const endsWithSentence = /[。！？.!?]$/.test(value);
    const placeholder = `{${slot.name}}`;
    const idx = result.indexOf(placeholder);
    if (idx > 0 && endsWithSentence) {
      const charBefore = result[idx - 1];
      if (charBefore === '。') {
        result = result.slice(0, idx - 1) + placeholder + result.slice(idx + placeholder.length);
      }
    }
    result = result.split(placeholder).join(value);
    slotsUsed[slot.name] = value;
  }
  return { text: polishOutput(result), slotsUsed };
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

  // OPT-01（修正）：字级 bag-of-chars 向量，与锚点同口径，供语义触发回退匹配
  const inputVec = charBagVector(clean, 32);

  // 用户纠正生成的意图优先级最高（D5：反馈改变路径）
  const best = matchIntent(clean, [...userIntents, ...registry], inputVec);

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
  const preview = clean.slice(0, 10) + (clean.length > 10 ? '…' : '');
  if (!gen.text || gen.text.trim().length < 2) {
    return {
      text: pickFallback(preview),
      source: 'gen', intent: 'UNKNOWN_POLITE', confidence: LOW_CONF, slotsUsed: {}, genTokens: gen.tokens || [],
    };
  }
  // 生成层有实质内容，但若文本过短（<4字），也走兜底
  if (gen.text.trim().length < 4) {
    return {
      text: pickFallback(preview),
      source: 'gen', intent: 'UNKNOWN_POLITE', confidence: LOW_CONF, slotsUsed: {}, genTokens: gen.tokens || [],
    };
  }
  return { text: gen.text, source: 'gen', intent: 'OPEN', confidence: 0.3, slotsUsed: {}, genTokens: gen.tokens || [] };
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
