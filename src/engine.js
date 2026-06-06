// LACN 纯计算引擎：与 UI 完全解耦的向量/分词/记忆/生成原语（设计 §7.2 引擎与UI解耦）
// 该模块不依赖 React，可独立在 Node 中测试。

export const NodeState = {
  ACTIVE: "ACTIVE",
  CRITICAL: "CRITICAL",
  DEAD: "DEAD",
  NEWBORN: "NEWBORN",
};

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function seededUnit(seed) {
  let value = seed >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return ((value >>> 0) / 0xffffffff) * 2 - 1;
}

// 确定性哈希向量化：token_id → D_MODEL 维向量，无 embedding 层参数（设计 §5.3.2）
export function tokenToVector(tokenId, dim) {
  return Array.from({ length: dim }, (_, i) => {
    const seed = (tokenId * 2654435761 + i * 1234567) >>> 0;
    return seededUnit(seed);
  });
}

export function randomVector(dim, scale = 0.1) {
  return Array.from({ length: dim }, () => (Math.random() - 0.5) * 2 * scale);
}

export function mixVector(base, target, rate) {
  return base.map((value, i) => value * (1 - rate) + (target[i] ?? 0) * rate);
}

export function averageVector(vectors, dim) {
  if (!vectors.length) return randomVector(dim, 0.02);
  const acc = Array.from({ length: dim }, () => 0);
  vectors.forEach((vec) => vec.forEach((value, i) => { acc[i] += value; }));
  return acc.map((value) => value / vectors.length);
}

export function cosine(a, b) {
  let dot = 0;
  let am = 0;
  let bm = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    am += a[i] * a[i];
    bm += b[i] * b[i];
  }
  return dot / (Math.sqrt(am || 1) * Math.sqrt(bm || 1));
}

// 字符级+词级混合分词：中文按字、英文按词、标点独立（设计 §5.3.1）
export function tokenize(text) {
  return Array.from(text.matchAll(/[一-鿿]|[A-Za-z][A-Za-z0-9_'-]*|\d+(?:\.\d+)?|[^\s]/g), (match) => match[0]).slice(0, 96);
}

// 意识界面层五维评分（设计 §3.4）
export function scoreOutput(output, inputTokens, stats) {
  const outputTokens = tokenize(output);
  const overlap = outputTokens.filter((token) => inputTokens.includes(token)).length;
  const uniqueRatio = new Set(outputTokens).size / Math.max(1, outputTokens.length);
  return {
    integrity: clamp(outputTokens.length / 18, 0, 1),
    relevance: clamp(overlap / Math.max(1, Math.min(8, inputTokens.length)) + 0.22, 0, 1),
    coherence: clamp(uniqueRatio * 0.8 + 0.12, 0, 1),
    selfReference: /节点|网络|记忆|活性|好奇心|路径/.test(output) ? 0.88 : 0.22,
    inquiry: /？|\?/.test(output) || stats.avgCuriosity > 55 ? 0.72 : 0.18,
  };
}

export function detokenize(tokens) {
  let out = "";
  for (const tok of tokens) {
    if (!out) {
      out = tok;
      continue;
    }
    const prev = out[out.length - 1];
    // 中文、紧跟的标点、以及开括号后不加空格；英文词之间补空格
    const noSpace = /[一-鿿]/.test(tok)
      || /[一-鿿]/.test(prev)
      || /^[，。！？、；：,.!?;:)\]}'"]/.test(tok)
      || /[（(\[{'"]$/.test(prev);
    out += noSpace ? tok : ` ${tok}`;
  }
  return out;
}

export function aggregateEmbedding(nodesMap, dim) {
  // 全网节点 embedding 以活性为权重加权平均，作为输出层输入（设计 §3.2.3）
  const acc = new Array(dim).fill(0);
  let weightSum = 0;
  Object.values(nodesMap).forEach((node) => {
    if (node.state === NodeState.DEAD) return;
    const weight = Math.max(0, node.vitality);
    if (weight <= 0) return;
    weightSum += weight;
    for (let i = 0; i < dim; i++) acc[i] += (node.embedding[i] ?? 0) * weight;
  });
  if (weightSum <= 0) return acc;
  return acc.map((value) => value / weightSum);
}

// 反馈训练：强化(delta>0，向1收敛)或惩罚(delta<0，向0衰减)一组节点对一组token的输出权重
// 对应手册 §6.3：👍 强化激活路径的输出权重，👎 对输出权重施加惩罚。
export function adjustOutputs(outputWeights, nodeIds, tokenIds, delta) {
  if (!nodeIds.length || !tokenIds.length) return;
  nodeIds.forEach((nodeId) => {
    let row = outputWeights.get(nodeId);
    if (!row) {
      if (delta < 0) return; // 惩罚一个不存在的权重无意义
      row = new Map();
      outputWeights.set(nodeId, row);
    }
    tokenIds.forEach((tokenId) => {
      const prev = row.get(tokenId) || 0;
      const next = delta >= 0 ? prev + delta * (1 - prev) : prev + delta * prev;
      row.set(tokenId, Math.max(0, Math.min(1, next)));
    });
  });
}

export function sampleFromLogits(items, temperature) {
  // temperature softmax 采样（设计 §5.3.3）
  if (!items.length) return null;
  const temp = Math.max(0.05, temperature);
  let max = -Infinity;
  for (const item of items) if (item.logit > max) max = item.logit;
  const weights = items.map((item) => Math.exp((item.logit - max) / temp));
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  let roll = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return items[i];
  }
  return items[items.length - 1];
}

// 自回归文本生成：全网活性加权聚合 + LTM 增强 → logit 向量 → 温度采样 → 采样（设计 §5.3.3）
export function generateResponse({ nodesMap, path, contextTokens, ltmHit, cfg, vocab, outputWeights, temperature }) {
  const dim = cfg.D_MODEL;
  const vocabEntries = [...vocab.entries()]; // [token, tokenId]
  if (!vocabEntries.length) return { text: "", tokens: [] };

  // 输出向量 = 全网活性加权聚合，再以 40% 权重混入命中的长期记忆（设计 §3.2.3 / §4.3）
  let aggregate = aggregateEmbedding(nodesMap, dim);
  if (ltmHit && Array.isArray(ltmHit.embedding)) {
    aggregate = mixVector(aggregate, ltmHit.embedding, 0.4);
  }

  // 节点激活分布：从本次输入的激活路径起步（最新最热），之后沿连接路由（设计 §3.3 信号路由）
  let activation = new Map();
  const seedIds = path.length ? path : Object.keys(nodesMap);
  seedIds.forEach((id) => {
    const node = nodesMap[id];
    if (node && node.state !== NodeState.DEAD) activation.set(id, Math.max(0.25, node.vitality / 100));
  });
  if (!activation.size) return { text: "", tokens: [] };

  const generated = [];
  const generatedIds = [];
  const maxLen = clamp(6 + Math.round(contextTokens.length * 1.3), 8, 24);
  const temp = clamp(temperature ?? cfg.TEMPERATURE, 0.3, 1.5);

  for (let step = 0; step < maxLen; step++) {
    const scored = vocabEntries.map(([token, id]) => {
      const tokenVec = tokenToVector(id, dim);
      const align = cosine(aggregate, tokenVec); // 内容路径：与聚合向量的语义对齐
      let vote = 0; // 学习路径：当前激活节点对该 token 的输出权重投票（设计 §6.1/§6.3）
      activation.forEach((level, nodeId) => {
        const row = outputWeights.get(nodeId);
        if (row && row.has(id)) vote += level * row.get(id);
      });
      const repeats = generatedIds.reduce((sum, gid) => sum + (gid === id ? 1 : 0), 0);
      // 学习路径（输出权重投票）主导，内容对齐路径提供语义先验，重复惩罚抑制复读
      return { token, id, logit: vote * 2.6 + align * 1.1 - repeats * 1.7 };
    });

    const choice = sampleFromLogits(scored, temp);
    if (!choice) break;

    // 重复终止：连续三次相同 token 即停（设计 §5.3.3 重复终止）
    const len = generatedIds.length;
    if (len >= 2 && choice.id === generatedIds[len - 1] && choice.id === generatedIds[len - 2]) break;

    generated.push(choice.token);
    generatedIds.push(choice.id);

    // 句末标点且长度足够 → 自然停止
    if (/[。！？.!?]/.test(choice.token) && generated.length >= 4) break;

    // 信号路由：取对该 token 输出最强的活跃节点作为发射源，沿其连接向邻居传播激活
    let emitterId = null;
    let emitterScore = -Infinity;
    activation.forEach((level, nodeId) => {
      const row = outputWeights.get(nodeId);
      const score = level * (row && row.has(choice.id) ? row.get(choice.id) : 0.001);
      if (score > emitterScore) {
        emitterScore = score;
        emitterId = nodeId;
      }
    });
    const nextActivation = new Map();
    const emitter = emitterId ? nodesMap[emitterId] : null;
    if (emitter) {
      nextActivation.set(emitterId, 0.4);
      Object.entries(emitter.connections).forEach(([neighborId, strength]) => {
        const neighbor = nodesMap[neighborId];
        if (neighbor && neighbor.state !== NodeState.DEAD) {
          nextActivation.set(neighborId, strength * (neighbor.vitality / 100 + 0.3));
        }
      });
    }
    activation.forEach((level, nodeId) => {
      nextActivation.set(nodeId, (nextActivation.get(nodeId) || 0) + level * 0.25);
    });
    // 仅保留激活最强的若干节点，避免分布发散
    activation = new Map([...nextActivation.entries()].sort((a, b) => b[1] - a[1]).slice(0, 32));

    // 自回归反馈：把刚生成的 token 混入聚合向量，驱动下一步生成
    aggregate = mixVector(aggregate, tokenToVector(choice.id, dim), 0.14);
  }

  return { text: detokenize(generated), tokens: generated };
}
