import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BookOpen,
  Brain,
  Check,
  Database,
  FileSearch,
  Gauge,
  GraduationCap,
  History,
  MessageSquare,
  Network,
  Pause,
  Play,
  Plus,
  Radar,
  RefreshCcw,
  RotateCcw,
  ScanLine,
  Search,
  Settings2,
  ShieldCheck,
  SkipForward,
  SlidersHorizontal,
  Sparkles,
  Square,
  Tag,
  ThumbsDown,
  ThumbsUp,
  Zap,
} from "lucide-react";
import {
  NodeState,
  clamp,
  tokenToVector,
  randomVector,
  mixVector,
  averageVector,
  cosine,
  tokenize,
  scoreOutput,
  generateResponse,
  adjustOutputs,
} from "./engine.js";
import {
  COGNITIVE_SEEDS,
  TRAINING_PHASES,
  TOTAL_SEED_ENTRIES,
  SEED_TO_SELFMODEL,
  SELFMODEL_LABELS,
  PRESET_CORPUS,
  SEED_MEANINGS,
  phaseForScore,
} from "./cognitive.js";
import { MANUAL } from "./manual.js";
import { routeAndRespond, buildUserIntent } from "./hca.js";

const DEFAULT_CONFIG = {
  INITIAL_NODE_COUNT: 48,
  MAX_NODES: 120,
  INITIAL_VITALITY: 100,
  DECAY_RATE: 0.36,
  SIGNAL_GAIN: 12,
  CRITICAL_THRESHOLD: 22,
  SELF_ACTIVATE_BONUS: 6,
  SELF_ACTIVATE_PENALTY: 3,
  NEIGHBOR_DEATH_PENALTY: 9,
  DIFFUSION_THRESHOLD: 72,
  DIFFUSION_RATE: 0.06,
  DIFFUSION_COST_FACTOR: 1.22,
  MEMORY_WINDOW: 12,
  STM_CAPACITY: 12,
  STM_DECAY_TICKS: 40,
  LTM_CAPACITY: 256,
  LTM_CONSOLIDATE: 5,
  DN_THRESHOLD: 12,
  MIN_CONN_STRENGTH: 0.06,
  CONN_DECAY: 0.008,
  CONN_LR: 0.12,
  SYNC_WINDOW: 4,
  REWARD_BONUS: 11,
  PENALTY: 5,
  MAX_CONNECTIONS: 6,
  SPAWN_THRESHOLD: 4,
  D_MODEL: 32,
  VOCAB_SIZE: 512,
  TEMPERATURE: 0.82,
  CURIOSITY_THRESHOLD: 35,
  ASK_THRESHOLD: 60,
  TICK_MS: 120,
};

// 预置语料：用于在启动/重置时给空网络喂养基础词表与输出权重（设计 §7.1 预置语料）
const SEED_CORPUS = [
  "活性节点在网络中感知信号并自激活。",
  "节点活性衰减时进入濒危状态，触发探索模式。",
  "濒危节点会主动寻找新连接，并生成新的节点。",
  "共同激活的节点之间连接会加强，这就是Hebbian学习。",
  "活性扩散是抗马太效应的合作机制。",
  "短期记忆编码激活路径，长期记忆巩固embedding向量。",
  "意识界面层聚合全网输出，并进行多维度评分。",
  "好奇心积分驱动主动认知模块去探索知识缺口。",
  "存续压力让每个节点都具有真实的利害关系。",
  "主动对话系统会在合适的时机主动提问和分享发现。",
];

const PANEL_ITEMS = [
  ["bootstrap", "认知引导", GraduationCap],
  ["training", "训练", Sparkles],
  ["dialogue", "对话", MessageSquare],
  ["network", "网络", Network],
  ["memory", "记忆", Database],
  ["acm", "ACM", Radar],
  ["analysis", "分析", BarChart3],
  ["config", "参数", SlidersHorizontal],
  ["audit", "审计", History],
  ["manual", "手册", BookOpen],
];

function initialSelfModel() {
  return {
    name: "LACN",
    type: "active_cell_network",
    knows_self: false,
    knows_other: false,
    knows_structure: false,
    knows_world: false,
    knows_affect: false,
  };
}

const MODULE_META = [
  ["ede", "EDE", "探索驱动", Search],
  ["lel", "LEL", "环境感知", FileSearch],
  ["ads", "ADS", "主动对话", MessageSquare],
  ["sie", "SIE", "内化引擎", Brain],
  ["sro", "SRO", "自迭代", RefreshCcw],
  ["ill", "ILL", "交互学习", Zap],
];

const PARAM_GROUPS = [
  {
    title: "节点生命参数",
    accent: "mint",
    params: [
      ["INITIAL_VITALITY", "初始活性", 50, 100, 1],
      ["DECAY_RATE", "自然衰减", 0.05, 2, 0.05],
      ["SIGNAL_GAIN", "信号增益", 1, 30, 0.5],
      ["CRITICAL_THRESHOLD", "濒危阈值", 5, 40, 1],
    ],
  },
  {
    title: "自激活与扩散",
    accent: "cyan",
    params: [
      ["SELF_ACTIVATE_BONUS", "自激活奖励", 1, 20, 0.5],
      ["SELF_ACTIVATE_PENALTY", "自激活惩罚", 0.5, 10, 0.5],
      ["DIFFUSION_THRESHOLD", "扩散阈值", 40, 95, 1],
      ["DIFFUSION_RATE", "扩散速率", 0.01, 0.2, 0.01],
      ["DIFFUSION_COST_FACTOR", "扩散代价", 0.8, 2, 0.05],
    ],
  },
  {
    title: "连接学习",
    accent: "amber",
    params: [
      ["CONN_LR", "Hebbian 学习率", 0.01, 0.5, 0.01],
      ["CONN_DECAY", "连接衰减", 0.001, 0.05, 0.001],
      ["MIN_CONN_STRENGTH", "最低连接", 0.01, 0.2, 0.01],
      ["SYNC_WINDOW", "共激活窗口", 1, 10, 1],
    ],
  },
  {
    title: "记忆与 ACM",
    accent: "violet",
    params: [
      ["STM_CAPACITY", "STM 容量", 6, 24, 1],
      ["STM_DECAY_TICKS", "STM 衰减", 15, 120, 5],
      ["LTM_CONSOLIDATE", "LTM 巩固阈值", 2, 12, 1],
      ["CURIOSITY_THRESHOLD", "好奇心阈值", 10, 80, 1],
      ["ASK_THRESHOLD", "提问阈值", 20, 95, 1],
    ],
  },
  {
    title: "生成与解码",
    accent: "cyan",
    params: [
      ["TEMPERATURE", "采样温度", 0.3, 1.5, 0.05],
    ],
  },
  {
    title: "网络结构",
    accent: "rose",
    params: [
      ["INITIAL_NODE_COUNT", "初始节点数", 10, 120, 5],
      ["MAX_NODES", "最大节点数", 40, 220, 5],
      ["MAX_CONNECTIONS", "最大连接数", 2, 12, 1],
      ["SPAWN_THRESHOLD", "新生阈值", 2, 12, 1],
      ["TICK_MS", "tick 间隔", 30, 500, 10],
    ],
  },
];

function createNode(id, x, y, cfg, generation = 0, inherited = null, tick = 0) {
  const inheritedEmbedding = inherited ? mixVector(randomVector(cfg.D_MODEL), inherited, 0.4) : randomVector(cfg.D_MODEL);
  return {
    id,
    x,
    y,
    vitality: cfg.INITIAL_VITALITY * (0.72 + Math.random() * 0.28),
    state: NodeState.NEWBORN,
    connections: {},
    memory: [],
    activationCount: 0,
    lastActivated: tick,
    generation,
    createdAt: tick,
    age: 0,
    selfActivateTimer: Math.floor(Math.random() * 20),
    embedding: inheritedEmbedding,
    curiosityScore: Math.random() * 12,
    knowledgeGaps: [],
    explorationHistory: [],
    baseline: 0,
  };
}

function createNetwork(cfg) {
  const nodes = {};
  const width = 960;
  const height = 620;
  for (let i = 0; i < cfg.INITIAL_NODE_COUNT; i++) {
    const id = `N${i.toString().padStart(3, "0")}`;
    const angle = (i / cfg.INITIAL_NODE_COUNT) * Math.PI * 2 + Math.random() * 0.38;
    const radius = 150 + Math.random() * 205;
    const x = width / 2 + Math.cos(angle) * radius + (Math.random() - 0.5) * 70;
    const y = height / 2 + Math.sin(angle) * radius * 0.72 + (Math.random() - 0.5) * 48;
    nodes[id] = createNode(id, clamp(x, 40, width - 40), clamp(y, 40, height - 40), cfg);
  }

  const ids = Object.keys(nodes);
  ids.forEach((id) => {
    const count = 2 + Math.floor(Math.random() * 3);
    const shuffled = [...ids].filter((candidate) => candidate !== id).sort(() => Math.random() - 0.5);
    shuffled.slice(0, count).forEach((targetId) => {
      if (Object.keys(nodes[id].connections).length >= cfg.MAX_CONNECTIONS) return;
      if (Object.keys(nodes[targetId].connections).length >= cfg.MAX_CONNECTIONS) return;
      const strength = 0.2 + Math.random() * 0.5;
      nodes[id].connections[targetId] = strength;
      nodes[targetId].connections[id] = strength;
    });
  });

  return nodes;
}

function computeStats(nodes) {
  const ids = Object.keys(nodes);
  if (!ids.length) {
    return { count: 0, avgVitality: 0, critical: 0, newborn: 0, totalConnections: 0, maxGen: 0, avgCuriosity: 0, vitalityVariance: 0 };
  }

  const vitality = ids.map((id) => nodes[id].vitality);
  const avgVitality = vitality.reduce((a, b) => a + b, 0) / ids.length;
  const variance = vitality.reduce((sum, value) => sum + Math.pow(value - avgVitality, 2), 0) / ids.length;
  const totalConnections = ids.reduce((sum, id) => sum + Object.keys(nodes[id].connections).length, 0) / 2;
  const avgCuriosity = ids.reduce((sum, id) => sum + nodes[id].curiosityScore, 0) / ids.length;

  return {
    count: ids.length,
    avgVitality,
    critical: ids.filter((id) => nodes[id].state === NodeState.CRITICAL).length,
    newborn: ids.filter((id) => nodes[id].state === NodeState.NEWBORN).length,
    totalConnections,
    maxGen: Math.max(...ids.map((id) => nodes[id].generation)),
    avgCuriosity,
    vitalityVariance: variance,
  };
}

function trimConnections(node, cfg) {
  const entries = Object.entries(node.connections).sort((a, b) => b[1] - a[1]).slice(0, cfg.MAX_CONNECTIONS);
  node.connections = Object.fromEntries(entries);
}

function tickNetwork(nodes, tick, cfg, signals, acm) {
  const next = {};
  const newEvents = [];
  const newSignals = [];
  const auditEntries = [];
  const aliveIds = Object.keys(nodes).filter((id) => nodes[id].state !== NodeState.DEAD);
  const deadIds = [];

  aliveIds.forEach((id) => {
    const node = nodes[id];
    next[id] = {
      ...node,
      connections: { ...node.connections },
      memory: [...node.memory],
      embedding: [...node.embedding],
      knowledgeGaps: [...node.knowledgeGaps],
      explorationHistory: [...node.explorationHistory],
      age: node.age + 1,
      state: node.state === NodeState.NEWBORN ? NodeState.ACTIVE : node.state,
    };
  });

  aliveIds.forEach((id) => {
    const node = next[id];
    const baseline = acm.enabled && acm.modules.sie ? node.baseline || 0 : 0;
    node.vitality -= cfg.DECAY_RATE;
    node.vitality = clamp(node.vitality + baseline, 0, 112);
    if (acm.enabled && acm.modules.ede) {
      const idleTicks = tick - node.lastActivated;
      node.curiosityScore = clamp(node.curiosityScore + (idleTicks > 40 ? 0.16 : 0.035) - 0.02, 0, 100);
    }
  });

  signals.forEach((signal) => {
    const target = next[signal.to];
    if (!target || target.state === NodeState.DEAD) return;
    const gain = cfg.SIGNAL_GAIN * signal.strength;
    target.vitality = clamp(target.vitality + gain, 0, 110);
    target.activationCount += 1;
    target.lastActivated = tick;
    target.curiosityScore = clamp(target.curiosityScore - 2.4, 0, 100);
    if (signal.vector) {
      target.embedding = mixVector(target.embedding, signal.vector, cfg.CONN_LR * 0.45);
    }
    target.memory = [...target.memory.slice(-cfg.MEMORY_WINDOW + 1), {
      tick,
      from: signal.from,
      token: signal.token,
      strength: signal.strength,
    }];
  });

  aliveIds.forEach((id) => {
    const node = next[id];
    node.selfActivateTimer -= 1;
    if (node.selfActivateTimer > 0) return;
    node.selfActivateTimer = 8 + Math.floor(Math.random() * 16);
    const score = 0.3 + Math.random() * 0.7 + (node.curiosityScore > cfg.CURIOSITY_THRESHOLD ? 0.08 : 0);
    if (score > 0.47) {
      node.vitality = clamp(node.vitality + cfg.SELF_ACTIVATE_BONUS, 0, 105);
      node.activationCount += 1;
      node.lastActivated = tick;
      Object.entries(node.connections).forEach(([targetId, strength]) => {
        if (next[targetId] && Math.random() < strength) {
          newSignals.push({ from: id, to: targetId, strength: strength * 0.58, tick });
        }
      });
    } else {
      node.vitality -= cfg.SELF_ACTIVATE_PENALTY;
      node.curiosityScore = clamp(node.curiosityScore + 1.5, 0, 100);
    }
  });

  aliveIds.forEach((id) => {
    const node = next[id];
    if (node.vitality <= cfg.DIFFUSION_THRESHOLD) return;
    Object.entries(node.connections).forEach(([targetId, strength]) => {
      const target = next[targetId];
      if (!target || target.state === NodeState.DEAD) return;
      const gain = cfg.DIFFUSION_RATE * node.vitality * strength;
      target.vitality = clamp(target.vitality + gain, 0, 105);
      node.vitality -= gain * cfg.DIFFUSION_COST_FACTOR;
    });
  });

  const exploringIds = [];
  aliveIds.forEach((id) => {
    const node = next[id];
    if (node.vitality <= 0) {
      node.state = NodeState.DEAD;
      deadIds.push(id);
      newEvents.push({ tick, type: "death", nodeId: id, msg: `${id} 死亡，痛感信号已广播` });
      Object.keys(node.connections).forEach((targetId) => {
        const target = next[targetId];
        if (!target || target.state === NodeState.DEAD) return;
        target.vitality -= cfg.NEIGHBOR_DEATH_PENALTY;
        target.curiosityScore = clamp(target.curiosityScore + 6, 0, 100);
        delete target.connections[id];
      });
    } else if (node.vitality < cfg.CRITICAL_THRESHOLD) {
      node.state = NodeState.CRITICAL;
      exploringIds.push(id);
      node.curiosityScore = clamp(node.curiosityScore + 0.9, 0, 100);
    } else {
      node.state = NodeState.ACTIVE;
    }
  });

  aliveIds.forEach((id) => {
    const node = next[id];
    if (!node || node.state === NodeState.DEAD) return;
    Object.keys(node.connections).forEach((targetId) => {
      const target = next[targetId];
      if (!target || target.state === NodeState.DEAD) {
        delete node.connections[targetId];
        return;
      }
      const coActivated = Math.abs(node.lastActivated - target.lastActivated) < cfg.SYNC_WINDOW;
      let strength = node.connections[targetId];
      strength = coActivated ? strength + cfg.CONN_LR * (1 - strength) : strength * (1 - cfg.CONN_DECAY);
      if (strength < cfg.MIN_CONN_STRENGTH) {
        delete node.connections[targetId];
      } else {
        node.connections[targetId] = Math.min(1, strength);
      }
    });
    trimConnections(node, cfg);
  });

  if (exploringIds.length >= cfg.SPAWN_THRESHOLD && Object.keys(next).length < cfg.MAX_NODES) {
    const aliveArr = aliveIds.filter((id) => next[id] && next[id].state !== NodeState.DEAD);
    const spawnerId = exploringIds[Math.floor(Math.random() * exploringIds.length)];
    const spawner = next[spawnerId];
    const newId = `N${(tick + Object.keys(next).length).toString().padStart(3, "0")}g${spawner.generation + 1}`;
    const angle = Math.random() * Math.PI * 2;
    const distance = 38 + Math.random() * 92;
    const node = createNode(
      newId,
      clamp(spawner.x + Math.cos(angle) * distance, 40, 920),
      clamp(spawner.y + Math.sin(angle) * distance, 40, 580),
      cfg,
      spawner.generation + 1,
      spawner.embedding,
      tick
    );
    node.connections[spawnerId] = 0.42;
    node.curiosityScore = clamp(spawner.curiosityScore * 0.5 + 12, 0, 100);
    next[spawnerId].connections[newId] = 0.42;
    aliveArr.sort(() => Math.random() - 0.5).slice(0, 2).forEach((targetId) => {
      if (targetId === spawnerId || !next[targetId]) return;
      node.connections[targetId] = 0.24;
      next[targetId].connections[newId] = 0.24;
    });
    next[newId] = node;
    newEvents.push({ tick, type: "spawn", nodeId: newId, msg: `${newId} 诞生，第 ${node.generation} 代，继承 ${spawnerId}` });
    auditEntries.push(makeAudit(tick, "SIE", "SIE_CONCEPT_PERCEIVED", newId, "L0", "success"));
  }

  deadIds.forEach((id) => {
    delete next[id];
  });

  return { nodes: next, newEvents, newSignals, auditEntries };
}

function makeAudit(tick, module, action, target, permission = "L0", outcome = "success", before = null, after = null, confirmed = false) {
  return {
    id: `${module}-${action}-${tick}-${Math.random().toString(16).slice(2)}`,
    time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    tick,
    module,
    action,
    target,
    before,
    after,
    permission,
    userConfirmed: confirmed,
    outcome,
  };
}

function initialAcmState() {
  return {
    enabled: true,
    paused: false,
    modules: { ede: true, lel: false, ads: false, sie: true, sro: true, ill: true },
    permissions: { L1: false, L2: false, L3: false, L4: false },
    ads: {
      inquiry: false,
      sharing: false,
      clarification: true,
      minIntervalMin: 30,
      dailyLimit: 5,
      dailyCount: 0,
      lastMessageTick: -99999,
    },
    tasks: [],
    knowledgeGaps: [
      { id: "G-001", topic: "自发符号交流", urgency: 0.72, filledBy: null },
      { id: "G-002", topic: "低密度网络补生策略", urgency: 0.58, filledBy: null },
    ],
    audit: [makeAudit(0, "系统", "ACM_START", "workbench", "L0", "success")],
    defaultNetwork: {
      conceptAnchors: [
        { conceptId: "C001", label: "活性节点", source: "design_doc", strength: 0.62, accessCount: 8, associatedNodeIds: [] },
        { conceptId: "C002", label: "存续压力", source: "design_doc", strength: 0.58, accessCount: 7, associatedNodeIds: [] },
        { conceptId: "C003", label: "主动认知", source: "acm_doc", strength: 0.54, accessCount: 5, associatedNodeIds: [] },
      ],
      userInterestGraph: {
        biology: 0.92,
        ai_architecture: 0.88,
        philosophy_of_mind: 0.76,
      },
      lastUpdated: 0,
    },
    localIndex: {
      scanRoot: "",
      entries: [],
      lastScan: null,
      scanning: false,
    },
    lastSroTick: 0,
  };
}

function runAcmCycle(nodes, tick, cfg, acm, stats) {
  if (!acm.enabled || acm.paused) return acm;
  let next = acm;
  const additions = [];
  const shouldCreateTask = acm.modules.ede
    && stats.avgCuriosity > cfg.CURIOSITY_THRESHOLD
    && acm.tasks.filter((task) => task.status === "pending").length < 8
    && tick % 28 === 0;

  if (shouldCreateTask) {
    const topNode = Object.values(nodes).sort((a, b) => b.curiosityScore - a.curiosityScore)[0];
    const taskType = acm.modules.lel && acm.permissions.L1
      ? "file_scan"
      : acm.modules.ads && acm.permissions.L3 && stats.avgCuriosity > cfg.ASK_THRESHOLD
        ? "ask_user"
        : "self_reflect";
    const gap = acm.knowledgeGaps.find((item) => !item.filledBy);
    const task = {
      id: `T-${tick}-${Math.floor(Math.random() * 99)}`,
      type: taskType,
      target: taskType === "file_scan" ? acm.localIndex.scanRoot || "授权目录" : gap?.topic || "网络稳定性",
      priority: taskType === "ask_user" ? 0.82 : taskType === "file_scan" ? 0.62 : 0.34,
      triggeredBy: topNode?.id ?? "system",
      createdAt: tick,
      status: "pending",
    };
    additions.push(task);
    next = {
      ...next,
      tasks: [task, ...next.tasks].slice(0, 24),
      audit: [makeAudit(tick, "EDE", "EDE_TASK_CREATED", task.target, taskType === "file_scan" ? "L1" : "L0"), ...next.audit].slice(0, 240),
    };
  }

  if (tick % 60 === 0 && next.modules.sie) {
    const dominant = Object.values(nodes).sort((a, b) => b.activationCount - a.activationCount)[0];
    if (dominant && next.defaultNetwork.conceptAnchors.length) {
      const anchors = next.defaultNetwork.conceptAnchors.map((anchor, index) => {
        if (index > 2) return anchor;
        const ids = Array.from(new Set([...(anchor.associatedNodeIds || []), dominant.id])).slice(-5);
        return { ...anchor, associatedNodeIds: ids, accessCount: anchor.accessCount + 1, strength: clamp(anchor.strength + 0.006, 0, 1) };
      });
      next = {
        ...next,
        defaultNetwork: { ...next.defaultNetwork, conceptAnchors: anchors, lastUpdated: tick },
      };
    }
  }

  return additions.length ? next : next;
}

function Sparkline({ data, color = "var(--mint)", height = 42 }) {
  if (data.length < 2) return <div className="sparkline-empty" />;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const points = data
    .map((value, index) => `${(index / (data.length - 1)) * 160},${height - 4 - ((value - min) / range) * (height - 8)}`)
    .join(" ");
  return (
    <svg className="sparkline" viewBox={`0 0 160 ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} fill="none" stroke={color} strokeWidth="2" />
      <polyline points={`0,${height} ${points} 160,${height}`} fill={color} fillOpacity="0.08" stroke="none" />
    </svg>
  );
}

function StatusPill({ label, value, tone = "mint" }) {
  return (
    <div className={`status-pill ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function IconButton({ title, active, danger, children, onClick, className = "" }) {
  return (
    <button
      className={`icon-button ${active ? "active" : ""} ${danger ? "danger" : ""} ${className}`}
      title={title}
      aria-label={title}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export default function App() {
  const [cfg, setCfg] = useState(DEFAULT_CONFIG);
  const [nodes, setNodes] = useState(() => createNetwork(DEFAULT_CONFIG));
  const [tick, setTick] = useState(0);
  const [running, setRunning] = useState(false);
  const [panel, setPanel] = useState("bootstrap");
  const [signals, setSignals] = useState([]);
  const [activeSignals, setActiveSignals] = useState([]);
  const [events, setEvents] = useState([]);
  const [selectedNode, setSelectedNode] = useState(null);
  const [statsHistory, setStatsHistory] = useState([]);
  const [totalSpawned, setTotalSpawned] = useState(DEFAULT_CONFIG.INITIAL_NODE_COUNT);
  const [totalDied, setTotalDied] = useState(0);
  const [messages, setMessages] = useState([
    { id: 0, role: "system", text: "LACN 在线。建议先到「认知引导」完成引导训练，再开始对话。", tick: 0, proactive: false },
  ]);
  const [input, setInput] = useState("");
  const [stm, setStm] = useState([]);
  const [ltm, setLtm] = useState([]);
  const [lastScores, setLastScores] = useState(null);
  const [lastPath, setLastPath] = useState([]);
  const [acm, setAcm] = useState(() => initialAcmState());
  const [auditFilter, setAuditFilter] = useState("ALL");
  const [seedNonce, setSeedNonce] = useState(0); // 递增以触发预置语料喂养（设计 §7.1）

  // ── v2.0：认知引导 / 训练模块 / 反馈标注 状态 ──
  const [cognitiveScore, setCognitiveScore] = useState(0);
  const [selfModel, setSelfModel] = useState(() => initialSelfModel());
  const [cogTrainLog, setCogTrainLog] = useState([]);
  const [isTraining, setIsTraining] = useState(false);
  const [seedStream, setSeedStream] = useState([]); // 训练时滚动显示的「符号→意义」流
  const [vocabSize, setVocabSize] = useState(0);
  const [semanticAnchors, setSemanticAnchors] = useState([]); // 已建立语义锚点的符号
  const [customVocab, setCustomVocab] = useState([]); // 用户自定义词汇 [{symbol, meaning}]
  const [feedbackLog, setFeedbackLog] = useState([]);
  const [trainStats, setTrainStats] = useState(null); // 语料训练反馈 {error, pathLen, vocabSize}
  const [userIntents, setUserIntents] = useState([]); // HCA：用户纠正生成的意图（D5）

  const canvasRef = useRef(null);
  const tickRef = useRef(tick);
  const nodesRef = useRef(nodes);
  const signalsRef = useRef(signals);
  const runningRef = useRef(running);
  const acmRef = useRef(acm);
  const cfgRef = useRef(cfg);
  const vocabRef = useRef(new Map());
  const freqRef = useRef(new Map());
  const nextTokenIdRef = useRef(1);
  const outputWeightsRef = useRef(new Map()); // nodeId -> Map(tokenId -> 输出权重)，设计 §6.1/§6.3
  const msgIdRef = useRef(1); // 消息唯一 id（用于反馈定位）
  const semanticAnchorsRef = useRef([]); // semanticAnchors 的 ref 镜像，供 injectText 读取
  const isTrainingRef = useRef(false);
  const cognitiveScoreRef = useRef(0);
  const customVocabRef = useRef([]);   // HCA semMem 来源
  const selfModelRef = useRef(null);   // HCA requires/槽位来源
  const userIntentsRef = useRef([]);   // HCA 用户意图（D5）

  tickRef.current = tick;
  semanticAnchorsRef.current = semanticAnchors;
  isTrainingRef.current = isTraining;
  cognitiveScoreRef.current = cognitiveScore;
  customVocabRef.current = customVocab;
  selfModelRef.current = selfModel;
  userIntentsRef.current = userIntents;
  nodesRef.current = nodes;
  signalsRef.current = signals;
  runningRef.current = running;
  acmRef.current = acm;
  cfgRef.current = cfg;

  const stats = useMemo(() => computeStats(nodes), [nodes]);
  const selected = selectedNode ? nodes[selectedNode] : null;

  useEffect(() => {
    if (!running) return undefined;
    const interval = window.setInterval(() => {
      const currentCfg = cfgRef.current;
      const currentTick = tickRef.current;
      const result = tickNetwork(nodesRef.current, currentTick, currentCfg, signalsRef.current, acmRef.current);
      const resultStats = computeStats(result.nodes);
      const nextAcm = runAcmCycle(result.nodes, currentTick, currentCfg, acmRef.current, resultStats);

      setNodes(result.nodes);
      setTick((value) => value + 1);
      signalsRef.current = result.newSignals;
      setSignals(result.newSignals);
      setActiveSignals(result.newSignals);
      setStatsHistory((history) => [...history.slice(-239), { tick: currentTick, ...resultStats }]);
      setAcm(nextAcm);

      if (result.newEvents.length || result.auditEntries.length) {
        const spawned = result.newEvents.filter((event) => event.type === "spawn").length;
        const died = result.newEvents.filter((event) => event.type === "death").length;
        if (spawned) setTotalSpawned((value) => value + spawned);
        if (died) setTotalDied((value) => value + died);
        setEvents((history) => [...result.newEvents, ...history].slice(0, 220));
        if (result.auditEntries.length) {
          setAcm((state) => ({ ...state, audit: [...result.auditEntries, ...state.audit].slice(0, 240) }));
        }
      }

      // ADS 主动对话系统：好奇心超阈值、已授权 L3 且节律允许时，主动向用户提问（设计 ACM §5）
      const a = nextAcm;
      if (
        a.enabled && !a.paused && a.modules.ads && a.permissions.L3 && a.ads.inquiry
        && a.ads.dailyCount < a.ads.dailyLimit
        && currentTick - a.ads.lastMessageTick > 90 // 节律控制器：两次主动发声的最小 tick 间隔
        && resultStats.avgCuriosity > currentCfg.ASK_THRESHOLD
      ) {
        const gap = a.knowledgeGaps.find((item) => !item.filledBy);
        if (gap) {
          const probe = generateResponse({
            nodesMap: result.nodes,
            path: [],
            contextTokens: tokenize(gap.topic),
            ltmHit: null,
            cfg: currentCfg,
            vocab: vocabRef.current,
            outputWeights: outputWeightsRef.current,
            temperature: currentCfg.TEMPERATURE,
          });
          const question = `我注意到「${gap.topic}」还是空白——${probe.text || "能跟我多讲讲吗"}？`;
          setMessages((history) => [...history, { id: msgIdRef.current++, role: "system", text: question, tick: currentTick, proactive: true }].slice(-80));
          setAcm((state) => ({
            ...state,
            ads: { ...state.ads, dailyCount: state.ads.dailyCount + 1, lastMessageTick: currentTick },
            audit: [makeAudit(currentTick, "ADS", "ADS_INQUIRY_SENT", gap.topic, "L3", "success", null, null, true), ...state.audit].slice(0, 240),
          }));
        }
      }
    }, cfg.TICK_MS);

    return () => window.clearInterval(interval);
  }, [running, cfg.TICK_MS]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const background = ctx.createLinearGradient(0, 0, width, height);
    background.addColorStop(0, "#081114");
    background.addColorStop(0.58, "#101319");
    background.addColorStop(1, "#120f14");
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = "rgba(139, 245, 204, 0.055)";
    ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 48) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y < height; y += 48) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    const ids = Object.keys(nodes);
    const drawn = new Set();
    ids.forEach((id) => {
      const node = nodes[id];
      Object.entries(node.connections).forEach(([targetId, strength]) => {
        const target = nodes[targetId];
        if (!target) return;
        const key = [id, targetId].sort().join(":");
        if (drawn.has(key)) return;
        drawn.add(key);
        const stressed = node.state === NodeState.CRITICAL || target.state === NodeState.CRITICAL;
        ctx.beginPath();
        ctx.moveTo(node.x, node.y);
        ctx.lineTo(target.x, target.y);
        ctx.strokeStyle = stressed ? `rgba(255, 183, 77, ${0.08 + strength * 0.32})` : `rgba(89, 218, 255, ${0.06 + strength * 0.26})`;
        ctx.lineWidth = 0.8 + strength * 2.4;
        ctx.stroke();
      });
    });

    activeSignals.forEach((signal) => {
      const from = nodes[signal.from];
      const to = nodes[signal.to];
      if (!from || !to) return;
      const progress = 0.5 + Math.sin(tick * 0.35) * 0.18;
      const x = from.x + (to.x - from.x) * progress;
      const y = from.y + (to.y - from.y) * progress;
      const pulse = ctx.createRadialGradient(x, y, 0, x, y, 18);
      pulse.addColorStop(0, "rgba(125, 249, 192, 0.95)");
      pulse.addColorStop(1, "rgba(125, 249, 192, 0)");
      ctx.fillStyle = pulse;
      ctx.beginPath();
      ctx.arc(x, y, 18, 0, Math.PI * 2);
      ctx.fill();
    });

    ids.forEach((id) => {
      const node = nodes[id];
      const vitalityRatio = clamp(node.vitality / 100, 0, 1);
      const radius = 7 + vitalityRatio * 9;
      let fill = "#7df9c0";
      let stroke = "rgba(125,249,192,0.72)";
      let glowColor = "rgba(125,249,192,0.26)";
      if (node.state === NodeState.CRITICAL) {
        fill = "#ffb14a";
        stroke = "rgba(255, 177, 74, 0.85)";
        glowColor = "rgba(255, 177, 74, 0.32)";
      }
      if (node.state === NodeState.NEWBORN) {
        fill = "#59daff";
        stroke = "rgba(255,255,255,0.86)";
        glowColor = "rgba(89,218,255,0.35)";
      }

      const glow = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, radius * 2.8);
      glow.addColorStop(0, glowColor);
      glow.addColorStop(1, "transparent");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius * 2.8, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.globalAlpha = 0.68 + vitalityRatio * 0.28;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = id === selectedNode ? "#f6f1d8" : stroke;
      ctx.lineWidth = id === selectedNode ? 3 : 1.4;
      ctx.stroke();

      if (node.curiosityScore > cfg.CURIOSITY_THRESHOLD) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius + 5, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(196, 141, 255, ${clamp(node.curiosityScore / 110, 0.18, 0.72)})`;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      if (node.generation > 0) {
        ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.fillStyle = "rgba(196,141,255,0.86)";
        ctx.fillText(`G${node.generation}`, node.x + radius + 3, node.y - radius);
      }
    });
  }, [nodes, activeSignals, selectedNode, tick, cfg.CURIOSITY_THRESHOLD]);

  const reset = useCallback(() => {
    setRunning(false);
    runningRef.current = false;
    const fresh = createNetwork(cfgRef.current);
    setNodes(fresh);
    nodesRef.current = fresh;
    setTick(0);
    setSignals([]);
    signalsRef.current = [];
    setActiveSignals([]);
    setEvents([]);
    setSelectedNode(null);
    setStatsHistory([]);
    setTotalSpawned(cfgRef.current.INITIAL_NODE_COUNT);
    setTotalDied(0);
    setStm([]);
    setLtm([]);
    setLastPath([]);
    setLastScores(null);
    setAcm(initialAcmState());
    // 重置 v2.0 认知/训练/反馈状态
    setCognitiveScore(0);
    setSelfModel(initialSelfModel());
    setCogTrainLog([]);
    setSeedStream([]);
    setSemanticAnchors([]);
    setCustomVocab([]);
    setFeedbackLog([]);
    setTrainStats(null);
    setUserIntents([]);
    setMessages([{ id: 0, role: "system", text: "LACN 已重置为零态。请到「认知引导」重新进行引导训练。", tick: 0, proactive: false }]);
    msgIdRef.current = 1;
    setSeedNonce((value) => value + 1); // 重置后重新喂养预置语料
  }, []);

  const handleCanvasClick = useCallback((event) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const mx = (event.clientX - rect.left) * (960 / rect.width);
    const my = (event.clientY - rect.top) * (620 / rect.height);
    let hit = null;
    let best = 22;
    Object.values(nodesRef.current).forEach((node) => {
      const distance = Math.hypot(node.x - mx, node.y - my);
      if (distance < best) {
        best = distance;
        hit = node.id;
      }
    });
    setSelectedNode((current) => (current === hit ? null : hit));
  }, []);

  const registerToken = useCallback((token) => {
    if (!vocabRef.current.has(token)) {
      if (vocabRef.current.size >= cfgRef.current.VOCAB_SIZE) {
        const least = [...freqRef.current.entries()].sort((a, b) => a[1] - b[1])[0]?.[0];
        if (least) {
          const id = vocabRef.current.get(least);
          vocabRef.current.delete(least);
          freqRef.current.delete(least);
          vocabRef.current.set(token, id);
        }
      } else {
        vocabRef.current.set(token, nextTokenIdRef.current);
        nextTokenIdRef.current += 1;
      }
    }
    freqRef.current.set(token, (freqRef.current.get(token) || 0) + 1);
    return vocabRef.current.get(token);
  }, []);

  const findBestNode = useCallback((nodesMap, vector, excluded = new Set()) => {
    const candidates = Object.values(nodesMap).filter((node) => node.state !== NodeState.DEAD && !excluded.has(node.id));
    if (!candidates.length) return null;
    return candidates
      .map((node) => ({ node, score: cosine(node.embedding, vector) + node.vitality / 500 + Math.random() * 0.08 }))
      .sort((a, b) => b.score - a.score)[0].node;
  }, []);

  const injectText = useCallback((text, source = "user_input", opts = {}) => {
    const silent = opts.silent === true; // silent=true 仅喂养语料，不产生对话回复
    const tokens = tokenize(text);
    if (!tokens.length) return;

    const currentCfg = cfgRef.current;
    const currentTick = tickRef.current;
    const nextNodes = {};
    Object.entries(nodesRef.current).forEach(([id, node]) => {
      nextNodes[id] = {
        ...node,
        connections: { ...node.connections },
        memory: [...node.memory],
        embedding: [...node.embedding],
        knowledgeGaps: [...node.knowledgeGaps],
        explorationHistory: [...node.explorationHistory],
      };
    });

    const path = [];
    const pathPairs = []; // {nodeId, tokenId} 用于更新输出权重矩阵
    const tokenVectors = [];
    const excluded = new Set();
    tokens.slice(0, 28).forEach((token) => {
      const previousFreq = freqRef.current.get(token) || 0;
      const tokenId = registerToken(token);
      const vector = tokenToVector(tokenId, currentCfg.D_MODEL);
      tokenVectors.push(vector);
      const selectedNodeForToken = findBestNode(nextNodes, vector, excluded);
      if (!selectedNodeForToken) return;
      excluded.add(selectedNodeForToken.id);
      const node = nextNodes[selectedNodeForToken.id];
      const novelty = previousFreq <= 1 ? 1 : 1 / Math.sqrt(previousFreq);
      node.vitality = clamp(node.vitality + currentCfg.SIGNAL_GAIN * 1.12, 0, 112);
      node.activationCount += 1;
      node.lastActivated = currentTick;
      node.curiosityScore = clamp(node.curiosityScore + 15 * novelty - 5, 0, 100);
      if (previousFreq <= 1) node.knowledgeGaps = Array.from(new Set([...node.knowledgeGaps, token])).slice(-6);
      node.embedding = mixVector(node.embedding, vector, currentCfg.CONN_LR * 0.78);
      node.memory = [...node.memory.slice(-currentCfg.MEMORY_WINDOW + 1), {
        tick: currentTick,
        from: source,
        token,
        strength: 1,
      }];
      path.push(node.id);
      pathPairs.push({ nodeId: node.id, tokenId });
    });

    for (let i = 1; i < path.length; i++) {
      const a = nextNodes[path[i - 1]];
      const b = nextNodes[path[i]];
      if (!a || !b) continue;
      const strength = Math.min(1, (a.connections[b.id] || 0.12) + currentCfg.CONN_LR * 0.9);
      a.connections[b.id] = strength;
      b.connections[a.id] = strength;
      trimConnections(a, currentCfg);
      trimConnections(b, currentCfg);
    }

    // 输出权重更新：激活路径上的节点提升其对应 token 的预测权重（设计 §6.1 / §6.3）
    pathPairs.forEach(({ nodeId, tokenId }) => {
      let row = outputWeightsRef.current.get(nodeId);
      if (!row) {
        row = new Map();
        outputWeightsRef.current.set(nodeId, row);
      }
      const prev = row.get(tokenId) || 0;
      row.set(tokenId, Math.min(1, prev + currentCfg.CONN_LR * (1 - prev)));
    });

    const key = tokens.slice(0, 6).join("");
    const embedding = averageVector(tokenVectors, currentCfg.D_MODEL);
    let ltmHit = null;
    setStm((history) => {
      const existing = history.find((item) => item.key === key);
      const nextEntry = {
        id: `STM-${currentTick}`,
        key,
        tokens,
        path,
        source,
        createdAt: currentTick,
        lastAccessed: currentTick,
        count: (existing?.count || 0) + 1,
        embedding,
      };
      const without = history.filter((item) => item.key !== key);
      return [nextEntry, ...without].slice(0, currentCfg.STM_CAPACITY);
    });

    setLtm((history) => {
      const direct = history.find((item) => item.key === key);
      const fuzzy = history
        .map((item) => {
          const overlap = item.tokens.filter((token) => tokens.includes(token)).length / Math.max(1, Math.min(item.tokens.length, tokens.length));
          return { item, score: overlap * item.strength };
        })
        .filter(({ score }) => score > 0.28)
        .sort((a, b) => b.score - a.score)[0]?.item;
      ltmHit = direct || fuzzy || null;

      const repetition = (stm.find((item) => item.key === key)?.count || 0) + 1;
      if (direct) {
        return history.map((item) => item.key === key
          ? { ...item, accessCount: item.accessCount + 1, lastAccessed: currentTick, strength: clamp(item.strength + 0.04, 0, 1) }
          : item);
      }
      if (repetition < currentCfg.LTM_CONSOLIDATE && !fuzzy) return history;
      const entry = {
        id: `LTM-${currentTick}`,
        key,
        tokens,
        path,
        source,
        embedding,
        strength: 0.42,
        accessCount: 1,
        createdAt: currentTick,
        lastAccessed: currentTick,
      };
      return [entry, ...history].slice(0, currentCfg.LTM_CAPACITY);
    });

    setNodes(nextNodes);
    nodesRef.current = nextNodes;
    setVocabSize(vocabRef.current.size);

    if (silent) return; // 预置语料/训练：只更新网络与记忆，不生成回复

    const nextStats = computeStats(nextNodes);
    // HCA 路由层：先查规则层（确定性、原始字符串，绕过 token 往返）；未知意图再降级到生成层
    const semMem = {};
    semanticAnchorsRef.current.forEach((sym) => { if (SEED_MEANINGS[sym]) semMem[sym] = { meaning: SEED_MEANINGS[sym] }; });
    customVocabRef.current.forEach((vocab) => { semMem[vocab.symbol] = { meaning: vocab.meaning }; });
    const hca = routeAndRespond({
      text,
      userIntents: userIntentsRef.current,
      semMem,
      selfModel: selfModelRef.current,
      liveStats: { avgVitality: nextStats.avgVitality },
      cognitiveScore: cognitiveScoreRef.current,
      // 生成层回调：仅在路由到生成层（未知意图）时调用（设计 §3.3）
      generate: () => generateResponse({
        nodesMap: nextNodes,
        path,
        contextTokens: tokens,
        ltmHit,
        cfg: currentCfg,
        vocab: vocabRef.current,
        outputWeights: outputWeightsRef.current,
        temperature: currentCfg.TEMPERATURE,
      }),
    });
    const output = hca.text;
    const scores = scoreOutput(output, tokens, nextStats);
    // 元信息：本次输入命中的语义锚点（手册 §6.2 已激活的语义节点）
    const anchors = semanticAnchorsRef.current.filter((sym) => text.includes(sym)).slice(0, 6);
    const userMsgId = msgIdRef.current++;
    const sysMsgId = msgIdRef.current++;
    setLastScores(scores);
    setLastPath(path);
    setMessages((history) => [
      ...history,
      { id: userMsgId, role: "user", text, tick: currentTick, proactive: false },
      { id: sysMsgId, role: "system", text: output, tick: currentTick, proactive: false,
        userText: text, path, genTokens: hca.genTokens || [], scores, anchors, feedback: null,
        source: hca.source, intent: hca.intent, intentLabel: hca.label, confidence: hca.confidence },
    ].slice(-80));
    setEvents((history) => [{ tick: currentTick, type: "input", nodeId: path[0] || "input", msg: `输入注入 ${path.length} 节点 → ${hca.source === "rule" || hca.source === "rule+" ? `规则层[${hca.intent}]` : hca.source === "guard" ? "守卫" : "生成层"}` }, ...history].slice(0, 220));
    setAcm((state) => {
      const newConcepts = tokens
        .filter((token) => (freqRef.current.get(token) || 0) <= 2)
        .slice(0, 3)
        .map((token) => ({ id: `G-${currentTick}-${token}`, topic: token, urgency: 0.42 + Math.random() * 0.28, filledBy: null }));
      const audit = [
        makeAudit(currentTick, "ILL", "ILL_PERSONALIZATION_UPDATED", key, "L0", "success"),
        ...newConcepts.map((concept) => makeAudit(currentTick, "SIE", "SIE_CONCEPT_PERCEIVED", concept.topic, "L0", "success")),
        ...state.audit,
      ].slice(0, 240);
      return {
        ...state,
        knowledgeGaps: [...newConcepts, ...state.knowledgeGaps].slice(0, 18),
        audit,
      };
    });
  }, [findBestNode, registerToken, stm]);

  const injectTextRef = useRef(injectText);
  injectTextRef.current = injectText;

  // 预置语料喂养：启动与每次重置后给空网络喂养基础语料，建立词表与输出权重（设计 §7.1）
  useEffect(() => {
    vocabRef.current = new Map();
    freqRef.current = new Map();
    nextTokenIdRef.current = 1;
    outputWeightsRef.current = new Map();
    SEED_CORPUS.forEach((line) => injectTextRef.current(line, "seed", { silent: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedNonce]);

  // ── 认知引导训练：把认知种子通过真实引擎喂入活性网络（亲手训练系统） ──
  const trainSeedEntry = useCallback((entry, seedKey) => {
    injectTextRef.current(`${entry.symbol}，${entry.meaning}`, "cognitive_seed", { silent: true });
    const selfKey = SEED_TO_SELFMODEL[seedKey];
    if (selfKey) setSelfModel((model) => (model[selfKey] ? model : { ...model, [selfKey]: true }));
    setSemanticAnchors((list) => (list.includes(entry.symbol) ? list : [...list, entry.symbol]));
    // 每个种子条目均分贡献，使完整引导训练恰好到达 100%（认知就绪）
    setCognitiveScore((value) => Math.min(100, value + 100 / TOTAL_SEED_ENTRIES));
  }, []);

  const trainPhaseCore = useCallback(async (phaseIdx) => {
    const phaseData = TRAINING_PHASES[phaseIdx];
    if (!phaseData?.seeds) return;
    for (const seedKey of phaseData.seeds) {
      const group = COGNITIVE_SEEDS[seedKey];
      if (!group) continue;
      for (const entry of group.entries) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 130));
        trainSeedEntry(entry, seedKey);
        setSeedStream((stream) => [...stream.slice(-60), { ...entry, seedKey }]);
      }
    }
    setCogTrainLog((log) => [{ phase: phaseIdx, name: phaseData.name, time: new Date().toLocaleTimeString("zh-CN", { hour12: false }), score: cognitiveScoreRef.current }, ...log].slice(0, 12));
  }, [trainSeedEntry]);

  const runBootPhase = useCallback(async (phaseIdx) => {
    if (isTrainingRef.current) return;
    setIsTraining(true);
    setSeedStream([]);
    await trainPhaseCore(phaseIdx);
    setIsTraining(false);
    setAcm((state) => ({ ...state, audit: [makeAudit(tickRef.current, "SIE", "SIE_CONCEPT_CONSOLIDATED", TRAINING_PHASES[phaseIdx]?.name || "phase", "L0", "success", null, null, true), ...state.audit].slice(0, 240) }));
  }, [trainPhaseCore]);

  const runAllBoot = useCallback(async () => {
    if (isTrainingRef.current) return;
    setIsTraining(true);
    setSeedStream([]);
    for (let i = 1; i < TRAINING_PHASES.length - 1; i++) {
      // eslint-disable-next-line no-await-in-loop
      await trainPhaseCore(i);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    setIsTraining(false);
    setAcm((state) => ({ ...state, audit: [makeAudit(tickRef.current, "SIE", "SIE_DN_UPDATED", "认知引导完成", "L0", "success", null, null, true), ...state.audit].slice(0, 240) }));
  }, [trainPhaseCore]);

  // ── 语料训练（手册 §4）：喂养自由文本，返回训练反馈 ──
  const trainCorpus = useCallback((text) => {
    const clean = (text || "").trim();
    if (!clean) return;
    const before = vocabRef.current.size;
    const tokens = tokenize(clean);
    injectTextRef.current(clean, "corpus", { silent: true });
    const known = tokens.filter((token) => (freqRef.current.get(token) || 0) > 1).length;
    const error = Math.max(0, 1 - known / Math.max(1, tokens.length));
    setTrainStats({ error, pathLen: Math.min(tokens.length, 28), vocab: vocabRef.current.size, added: vocabRef.current.size - before });
    setEvents((history) => [{ tick: tickRef.current, type: "input", nodeId: "corpus", msg: `语料注入：${tokens.length} token · 预测误差 ${(error * 100).toFixed(0)}%` }, ...history].slice(0, 220));
    setAcm((state) => ({ ...state, audit: [makeAudit(tickRef.current, "ILL", "ILL_PERSONALIZATION_UPDATED", clean.slice(0, 16), "L0", "success", null, null, true), ...state.audit].slice(0, 240) }));
  }, []);

  // ── 词汇定制（手册 §5）：高优先级符号→含义定义，重复注入强化 ──
  const addCustomVocab = useCallback((symbol, meaning) => {
    const sym = (symbol || "").trim();
    const mean = (meaning || "").trim();
    if (!sym || !mean) return;
    injectTextRef.current(`${sym}，${mean}`, "vocab", { silent: true });
    injectTextRef.current(`${sym}就是${mean}`, "vocab", { silent: true });
    setCustomVocab((list) => [{ symbol: sym, meaning: mean }, ...list.filter((item) => item.symbol !== sym)].slice(0, 60));
    setSemanticAnchors((list) => (list.includes(sym) ? list : [...list, sym]));
    setAcm((state) => ({ ...state, audit: [makeAudit(tickRef.current, "SIE", "SIE_CONCEPT_CONSOLIDATED", sym, "L0", "success", null, null, true), ...state.audit].slice(0, 240) }));
  }, []);

  // 强化激活路径上的连接（👍 反馈）
  const strengthenPath = useCallback((nodeIds, amount) => {
    setNodes((prev) => {
      const next = { ...prev };
      for (let i = 1; i < nodeIds.length; i++) {
        const aId = nodeIds[i - 1];
        const bId = nodeIds[i];
        if (!next[aId] || !next[bId]) continue;
        const a = { ...next[aId], connections: { ...next[aId].connections } };
        const b = { ...next[bId], connections: { ...next[bId].connections } };
        const strength = Math.min(1, (a.connections[bId] || 0.12) + amount);
        a.connections[bId] = strength;
        b.connections[aId] = strength;
        next[aId] = a;
        next[bId] = b;
      }
      nodesRef.current = next;
      return next;
    });
  }, []);

  // ── 对话反馈标注（手册 §6.3）：真实地强化/惩罚上一回应的路径与输出权重 ──
  const submitFeedback = useCallback((message, kind, opts = {}) => {
    const { tag = "", correction = "" } = opts;
    const currentTick = tickRef.current;
    if (kind === "skip") {
      setMessages((history) => history.map((item) => (item.id === message.id ? { ...item, feedback: { kind: "skip" } } : item)));
      return;
    }
    const nodeIds = message.path || [];
    const tokenIds = (message.genTokens || []).map((token) => vocabRef.current.get(token)).filter((id) => id != null);
    if (kind === "up") {
      adjustOutputs(outputWeightsRef.current, nodeIds, tokenIds, 0.2);
      strengthenPath(nodeIds, 0.12);
    } else if (kind === "down") {
      adjustOutputs(outputWeightsRef.current, nodeIds, tokenIds, -0.5);
    }
    if (correction.trim()) {
      injectTextRef.current(correction.trim(), "correction", { silent: true });
      injectTextRef.current(correction.trim(), "correction", { silent: true });
      // D5：把纠正写入意图注册表，下次同类输入直接走规则层输出纠正内容
      if (message.userText && message.userText.trim()) {
        const intent = buildUserIntent(message.userText.trim(), correction.trim(), currentTick);
        const key = intent.triggers[0].value[0];
        setUserIntents((list) => [intent, ...list.filter((item) => item.triggers[0].value[0] !== key)].slice(0, 40));
      }
    }
    setMessages((history) => history.map((item) => (item.id === message.id ? { ...item, feedback: { kind, tag, correction } } : item)));
    setFeedbackLog((log) => [{ id: `FB-${currentTick}-${Math.random().toString(16).slice(2, 6)}`, kind, tag, correction, tick: currentTick, preview: (message.text || "").slice(0, 20) }, ...log].slice(0, 80));
    const action = kind === "up" ? "ILL_FEEDBACK_POSITIVE" : "ILL_FEEDBACK_NEGATIVE";
    setAcm((state) => ({ ...state, audit: [makeAudit(currentTick, "ILL", action, tag || correction.slice(0, 16) || "feedback", "L0", "success", null, null, true), ...state.audit].slice(0, 240) }));
    setVocabSize(vocabRef.current.size);
  }, [strengthenPath]);

  const handleSubmit = useCallback((event) => {
    event.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput("");
    injectText(text);
  }, [input, injectText]);

  const handlePickDirectory = useCallback(async () => {
    const currentTick = tickRef.current;
    if (!window.showDirectoryPicker) {
      setAcm((state) => ({
        ...state,
        audit: [makeAudit(currentTick, "LEL", "LEL_SCAN_CANCELLED", "File System Access API unavailable", "L1", "failed"), ...state.audit],
      }));
      return;
    }
    setAcm((state) => ({ ...state, localIndex: { ...state.localIndex, scanning: true } }));
    try {
      const handle = await window.showDirectoryPicker();
      const entries = [];
      const walk = async (dirHandle, prefix = "", depth = 0) => {
        if (depth > 2 || entries.length > 80) return;
        for await (const [name, child] of dirHandle.entries()) {
          if (name === ".git" || name === "node_modules" || entries.length > 80) continue;
          const path = prefix ? `${prefix}/${name}` : name;
          if (child.kind === "file") {
            const file = await child.getFile();
            entries.push({
              path,
              fileType: file.type || name.split(".").pop() || "other",
              sizeBytes: file.size,
              modifiedAt: file.lastModified,
              summary: name.replace(/[._-]/g, " ").slice(0, 80),
              relevance: Math.random() * 0.45 + 0.2,
              readCount: 0,
            });
          } else if (child.kind === "directory") {
            await walk(child, path, depth + 1);
          }
        }
      };
      await walk(handle);
      setAcm((state) => ({
        ...state,
        modules: { ...state.modules, lel: true },
        permissions: { ...state.permissions, L1: true, L2: true },
        localIndex: {
          scanRoot: handle.name,
          entries,
          lastScan: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
          scanning: false,
        },
        audit: [
          makeAudit(currentTick, "LEL", "LEL_SCAN_COMPLETED", handle.name, "L1", "success", null, `${entries.length} files`, true),
          ...state.audit,
        ].slice(0, 240),
      }));
    } catch {
      setAcm((state) => ({
        ...state,
        localIndex: { ...state.localIndex, scanning: false },
        audit: [makeAudit(currentTick, "LEL", "LEL_SCAN_CANCELLED", "directory_picker", "L1", "failed"), ...state.audit],
      }));
    }
  }, []);

  const runSroCycle = useCallback(() => {
    const currentTick = tickRef.current;
    const currentStats = computeStats(nodesRef.current);
    const before = {
      DIFFUSION_RATE: cfgRef.current.DIFFUSION_RATE,
      DECAY_RATE: cfgRef.current.DECAY_RATE,
    };
    const canRun = currentTick > 120 && currentStats.count / Math.max(1, totalSpawned) > 0.35 && currentStats.avgVitality > 25;
    if (!canRun) {
      setAcm((state) => ({
        ...state,
        audit: [makeAudit(currentTick, "SRO", "SRO_ROLLED_BACK", "health_gate", "L0", "failed", currentStats, null), ...state.audit],
      }));
      return;
    }
    setCfg((value) => {
      const vitalitySpread = currentStats.vitalityVariance;
      const diffusionRate = vitalitySpread > 520 ? clamp(value.DIFFUSION_RATE * 1.04, 0.01, 0.2) : value.DIFFUSION_RATE;
      const decayRate = currentStats.avgVitality < 38 ? clamp(value.DECAY_RATE * 0.97, 0.05, 2) : value.DECAY_RATE;
      const after = { DIFFUSION_RATE: diffusionRate, DECAY_RATE: decayRate };
      setAcm((state) => ({
        ...state,
        lastSroTick: currentTick,
        audit: [makeAudit(currentTick, "SRO", "SRO_PARAM_ADJUSTED", "stability_params", "L0", "success", before, after), ...state.audit],
      }));
      return { ...value, DIFFUSION_RATE: diffusionRate, DECAY_RATE: decayRate };
    });
  }, [totalSpawned]);

  const toggleModule = useCallback((key) => {
    setAcm((state) => ({
      ...state,
      modules: { ...state.modules, [key]: !state.modules[key] },
      audit: [makeAudit(tickRef.current, "系统", state.modules[key] ? "ACM_MODULE_DISABLED" : "ACM_MODULE_ENABLED", key, "L0"), ...state.audit],
    }));
  }, []);

  const togglePermission = useCallback((key) => {
    if (key === "L4") return;
    setAcm((state) => ({
      ...state,
      permissions: { ...state.permissions, [key]: !state.permissions[key] },
      audit: [makeAudit(tickRef.current, "系统", state.permissions[key] ? "PERMISSION_REVOKED" : "PERMISSION_GRANTED", key, key, "success", null, null, true), ...state.audit],
    }));
  }, []);

  const vitalityHistory = statsHistory.slice(-80).map((item) => item.avgVitality);
  const countHistory = statsHistory.slice(-80).map((item) => item.count);
  const curiosityHistory = statsHistory.slice(-80).map((item) => item.avgCuriosity);
  const filteredAudit = acm.audit.filter((entry) => auditFilter === "ALL" || entry.module === auditFilter);
  const cogPhase = TRAINING_PHASES[phaseForScore(cognitiveScore)];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><Activity size={22} /></div>
          <div>
            <h1>LACN</h1>
            <span>v2.0 Unified · 认知引导 + 用户训练</span>
          </div>
        </div>
        <div className="cog-badge" style={{ color: cogPhase.color, borderColor: `${cogPhase.color}55`, background: `${cogPhase.color}14` }} title="当前认知发展阶段">
          <span className="cog-icon">{cogPhase.icon}</span>
          <span className="cog-name">{cogPhase.name}</span>
          <span className="cog-prog"><i style={{ width: `${cognitiveScore}%`, background: cogPhase.color }} /></span>
          <b>{cognitiveScore.toFixed(0)}%</b>
        </div>
        <div className="top-stats">
          <StatusPill label="节点" value={stats.count} tone="mint" />
          <StatusPill label="活性" value={stats.avgVitality.toFixed(1)} tone={stats.avgVitality > 45 ? "mint" : "amber"} />
          <StatusPill label="词表" value={vocabSize} tone="cyan" />
          <StatusPill label="语义" value={semanticAnchors.length} tone="mint" />
          <StatusPill label="LTM" value={ltm.length} tone="violet" />
          <StatusPill label="反馈" value={feedbackLog.length} tone="amber" />
          <StatusPill label="tick" value={tick} tone="steel" />
        </div>
        <div className="top-actions">
          <IconButton title={running ? "暂停" : "运行"} active={!running} onClick={() => setRunning((value) => !value)}>
            {running ? <Pause size={18} /> : <Play size={18} />}
          </IconButton>
          <IconButton title="重置" onClick={reset}><RotateCcw size={18} /></IconButton>
          <IconButton title="暂停 ACM" danger={acm.paused} onClick={() => setAcm((state) => ({ ...state, paused: !state.paused }))}>
            {acm.paused ? <Square size={17} /> : <ShieldCheck size={18} />}
          </IconButton>
        </div>
      </header>

      <main className="workspace">
        <nav className="panel-nav" aria-label="LACN panels">
          {PANEL_ITEMS.map(([id, label, Icon]) => (
            <button key={id} className={panel === id ? "active" : ""} type="button" onClick={() => setPanel(id)}>
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <section className="panel-stage">
          {panel === "bootstrap" && (
            <BootstrapPanel
              cognitiveScore={cognitiveScore}
              selfModel={selfModel}
              cogPhase={cogPhase}
              isTraining={isTraining}
              seedStream={seedStream}
              cogTrainLog={cogTrainLog}
              runBootPhase={runBootPhase}
              runAllBoot={runAllBoot}
              goTrain={() => setPanel("training")}
            />
          )}

          {panel === "training" && (
            <TrainingPanel
              trainCorpus={trainCorpus}
              addCustomVocab={addCustomVocab}
              customVocab={customVocab}
              trainStats={trainStats}
              feedbackLog={feedbackLog}
              vocabSize={vocabSize}
              semanticCount={semanticAnchors.length}
              goChat={() => setPanel("dialogue")}
            />
          )}

          {panel === "manual" && <ManualPanel />}

          {panel === "network" && (
            <NetworkPanel
              canvasRef={canvasRef}
              onCanvasClick={handleCanvasClick}
              selected={selected}
              setSelectedNode={setSelectedNode}
              nodes={nodes}
              stats={stats}
              totalSpawned={totalSpawned}
              totalDied={totalDied}
              events={events}
              vitalityHistory={vitalityHistory}
              countHistory={countHistory}
            />
          )}

          {panel === "dialogue" && (
            <DialoguePanel
              messages={messages}
              input={input}
              setInput={setInput}
              handleSubmit={handleSubmit}
              lastPath={lastPath}
              lastScores={lastScores}
              stats={stats}
              injectText={injectText}
              cfg={cfg}
              setCfg={setCfg}
              submitFeedback={submitFeedback}
              cognitiveScore={cognitiveScore}
            />
          )}

          {panel === "memory" && (
            <MemoryPanel stm={stm} ltm={ltm} acm={acm} nodes={nodes} />
          )}

          {panel === "acm" && (
            <AcmPanel
              acm={acm}
              cfg={cfg}
              toggleModule={toggleModule}
              togglePermission={togglePermission}
              handlePickDirectory={handlePickDirectory}
              runSroCycle={runSroCycle}
              setAcm={setAcm}
            />
          )}

          {panel === "analysis" && (
            <AnalysisPanel
              nodes={nodes}
              stats={stats}
              statsHistory={statsHistory}
              vitalityHistory={vitalityHistory}
              countHistory={countHistory}
              curiosityHistory={curiosityHistory}
              totalSpawned={totalSpawned}
            />
          )}

          {panel === "config" && (
            <ConfigPanel cfg={cfg} setCfg={setCfg} reset={reset} />
          )}

          {panel === "audit" && (
            <AuditPanel audit={filteredAudit} filter={auditFilter} setFilter={setAuditFilter} events={events} />
          )}
        </section>
      </main>

      <footer className="statusbar">
        <span>三层架构：活性节点层 / 网络动态层 / 意识界面层</span>
        <span>{running ? "运行中" : "已暂停"}</span>
        <span>存活率 {totalSpawned > 0 ? ((stats.count / totalSpawned) * 100).toFixed(0) : 0}%</span>
        <span>ACM {acm.enabled && !acm.paused ? "ACTIVE" : "PAUSED"}</span>
      </footer>
    </div>
  );
}

function NetworkPanel({ canvasRef, onCanvasClick, selected, setSelectedNode, nodes, stats, totalSpawned, totalDied, events, vitalityHistory, countHistory }) {
  const connectionEntries = selected ? Object.entries(selected.connections).sort((a, b) => b[1] - a[1]) : [];

  return (
    <div className="network-layout">
      <div className="network-canvas-wrap">
        <canvas ref={canvasRef} width={960} height={620} onClick={onCanvasClick} />
        <div className="canvas-overlay top-left">
          <span>诞生 {totalSpawned}</span>
          <span>死亡 {totalDied}</span>
          <span>存活 {totalSpawned > 0 ? ((stats.count / totalSpawned) * 100).toFixed(0) : 0}%</span>
        </div>
        <div className="canvas-overlay legend">
          <span><i className="dot mint" />ACTIVE</span>
          <span><i className="dot amber" />CRITICAL</span>
          <span><i className="dot cyan" />NEWBORN</span>
          <span><i className="dot violet" />CURIOSITY</span>
        </div>
      </div>
      <aside className="side-surface">
        {selected ? (
          <>
            <div className="surface-title">
              <span>NODE DETAIL</span>
              <button type="button" onClick={() => setSelectedNode(null)}>关闭</button>
            </div>
            <div className="node-id">{selected.id}</div>
            <MetricRows rows={[
              ["状态", selected.state],
              ["活性", selected.vitality.toFixed(1)],
              ["好奇心", selected.curiosityScore.toFixed(1)],
              ["年龄", `${selected.age} ticks`],
              ["代数", `G${selected.generation}`],
              ["累计激活", selected.activationCount],
              ["连接数", connectionEntries.length],
              ["记忆", selected.memory.length],
            ]} />
            <Progress label="活性积分" value={selected.vitality} tone={selected.vitality < 24 ? "rose" : selected.vitality < 52 ? "amber" : "mint"} />
            <Progress label="好奇心积分" value={selected.curiosityScore} tone="violet" />
            <h3>连接节点</h3>
            <div className="compact-list">
              {connectionEntries.map(([id, strength]) => (
                <button key={id} type="button" onClick={() => setSelectedNode(id)}>
                  <span>{id}</span>
                  <b>{strength.toFixed(2)}</b>
                </button>
              ))}
            </div>
            <h3>最近记忆</h3>
            <div className="memory-snippets">
              {[...selected.memory].reverse().slice(0, 9).map((item, index) => (
                <div key={`${item.tick}-${index}`}>[{item.tick}] {item.token || item.from || "signal"}</div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="surface-title"><span>NETWORK STATUS</span></div>
            <Progress label="平均活性" value={stats.avgVitality} tone={stats.avgVitality > 45 ? "mint" : "amber"} />
            <Progress label="濒危比例" value={stats.count ? (stats.critical / stats.count) * 100 : 0} tone={stats.critical > 6 ? "rose" : "amber"} />
            <Progress label="平均好奇心" value={stats.avgCuriosity} tone="violet" />
            <div className="mini-chart">
              <span>活性趋势</span>
              <Sparkline data={vitalityHistory} color="var(--mint)" />
            </div>
            <div className="mini-chart">
              <span>节点趋势</span>
              <Sparkline data={countHistory} color="var(--cyan)" />
            </div>
            <h3>最新事件</h3>
            <div className="event-feed">
              {events.slice(0, 10).map((event, index) => (
                <div key={`${event.tick}-${index}`} className={event.type}>
                  <span>[{event.tick}]</span>
                  <p>{event.msg}</p>
                </div>
              ))}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

function MessageFeedback({ message, submitFeedback }) {
  const [tag, setTag] = useState("");
  const [correction, setCorrection] = useState("");

  if (message.feedback) {
    const fb = message.feedback;
    return (
      <div className="fb-done">
        {fb.kind === "up" && <span className="fb-chip up"><ThumbsUp size={11} /> 已标注正确</span>}
        {fb.kind === "down" && <span className="fb-chip down"><ThumbsDown size={11} /> 已标注错误</span>}
        {fb.kind === "skip" && <span className="fb-chip skip">已跳过</span>}
        {fb.tag && <span className="fb-chip tag">#{fb.tag}</span>}
        {fb.correction && <span className="fb-chip corr">✎ 纠正已学习</span>}
      </div>
    );
  }

  return (
    <div className="fb-panel">
      <div className="fb-actions">
        <button className="fb-btn up" type="button" onClick={() => submitFeedback(message, "up", { tag })}><ThumbsUp size={13} /> 正确</button>
        <button className="fb-btn down" type="button" onClick={() => submitFeedback(message, "down", { tag, correction })}><ThumbsDown size={13} /> 错误</button>
        <button className="fb-btn skip" type="button" onClick={() => submitFeedback(message, "skip")}><SkipForward size={13} /> 跳过</button>
      </div>
      <div className="fb-inputs">
        <label><Tag size={12} /><input value={tag} onChange={(event) => setTag(event.target.value)} placeholder="标签（可选，如：自我介绍）" /></label>
        <label><Check size={12} /><input value={correction} onChange={(event) => setCorrection(event.target.value)} placeholder="纠正：写出正确回应内容（配合👎）" /></label>
      </div>
    </div>
  );
}

function DialoguePanel({ messages, input, setInput, handleSubmit, lastPath, lastScores, stats, injectText, cfg, setCfg, submitFeedback, cognitiveScore }) {
  const presets = ["你是谁？", "你由什么构成？", "你和我有什么不同？", "什么是活性扩散"];

  return (
    <div className="dialogue-layout">
      <section className="conversation">
        {cognitiveScore < 65 && (
          <div className="not-ready-notice">
            <b>认知尚未就绪</b>（当前 {cognitiveScore.toFixed(0)}% / 建议 ≥65%）—— 输出可能是碎片或乱码。
            建议先到「认知引导」完成引导训练，再开始对话。
          </div>
        )}
        <div className="messages">
          {messages.map((message) => {
            const isResp = message.role === "system" && !!message.source;
            const isRule = message.source === "rule" || message.source === "rule+";
            const s = message.scores;
            const understanding = s ? Math.round(((s.integrity + s.relevance + s.coherence) / 3) * 100) : 0;
            const srcLabel = isRule ? (message.source === "rule+" ? "规则层·用户" : "规则层") : message.source === "guard" ? "守卫" : "生成层";
            const srcTone = isRule ? "rule" : message.source === "guard" ? "guard" : "gen";
            return (
              <div key={message.id} className={`message ${message.role} ${message.proactive ? "proactive" : ""}`}>
                <span>{message.role === "user" ? "USER" : message.proactive ? "ACM" : "LACN"} · tick {message.tick}</span>
                <p>{message.text}</p>
                {isResp && (
                  <div className="msg-meta">
                    <span className={`src-badge ${srcTone}`}>{srcLabel}</span>
                    {isRule && message.intentLabel && <span className="intent-tag">{message.intentLabel}</span>}
                    {message.source === "gen" && (
                      <>
                        <span>理解度</span>
                        <span className="q-bar"><i style={{ width: `${understanding}%` }} /></span>
                        <b>{understanding}%</b>
                      </>
                    )}
                    {message.anchors?.length > 0 && (
                      <span className="anchor-tags">激活：{message.anchors.map((anchor) => <em key={anchor}>{anchor}</em>)}</span>
                    )}
                  </div>
                )}
                {isResp && message.source !== "guard" && submitFeedback && <MessageFeedback message={message} submitFeedback={submitFeedback} />}
              </div>
            );
          })}
        </div>
        <form className="input-row" onSubmit={handleSubmit}>
          <input value={input} onChange={(event) => setInput(event.target.value)} placeholder="与 LACN 对话…（Enter 发送）" />
          <button type="submit"><Zap size={16} />发送</button>
        </form>
        <div className="preset-row">
          {presets.map((text) => (
            <button key={text} type="button" onClick={() => injectText(text)}>{text}</button>
          ))}
        </div>
      </section>
      <aside className="side-surface">
        <div className="surface-title"><span>CONSCIOUSNESS INTERFACE</span></div>
        {lastScores ? (
          <div className="score-grid">
            <Score label="语言完整性" value={lastScores.integrity} />
            <Score label="场景吻合" value={lastScores.relevance} />
            <Score label="逻辑连贯" value={lastScores.coherence} />
            <Score label="自我指涉" value={lastScores.selfReference} />
            <Score label="主动探询" value={lastScores.inquiry} />
          </div>
        ) : (
          <div className="empty-state">等待输入信号</div>
        )}
        <label className="param-row" style={{ marginTop: 12 }}>
          <span>采样温度</span>
          <input
            type="range"
            min={0.3}
            max={1.5}
            step={0.05}
            value={cfg.TEMPERATURE}
            onChange={(event) => setCfg((value) => ({ ...value, TEMPERATURE: Number(event.target.value) }))}
          />
          <b>{cfg.TEMPERATURE.toFixed(2)}</b>
        </label>
        <h3>激活路径</h3>
        <div className="path-list">
          {lastPath.slice(0, 18).map((id, index) => (
            <span key={`${id}-${index}`}>{id}</span>
          ))}
        </div>
        <h3>当前状态</h3>
        <MetricRows rows={[
          ["平均活性", stats.avgVitality.toFixed(1)],
          ["平均好奇心", stats.avgCuriosity.toFixed(1)],
          ["濒危节点", stats.critical],
          ["最高代数", `G${stats.maxGen}`],
        ]} />
      </aside>
    </div>
  );
}

function BootstrapPanel({ cognitiveScore, selfModel, cogPhase, isTraining, seedStream, cogTrainLog, runBootPhase, runAllBoot, goTrain }) {
  const trainablePhases = TRAINING_PHASES.slice(1, -1);
  return (
    <div className="boot-layout">
      <aside className="boot-phases">
        <div className="surface-title"><span>认知阶段</span></div>
        {TRAINING_PHASES.map((phase) => {
          const done = cognitiveScore >= phase.minScore;
          const active = cogPhase.id === phase.id;
          return (
            <div key={phase.id} className={`boot-phase ${active ? "active" : ""}`} style={{ borderLeftColor: done ? phase.color : "transparent" }}>
              <span className="bp-icon" style={{ color: done ? phase.color : "var(--muted)" }}>{phase.icon}</span>
              <div>
                <div className="bp-name" style={{ color: done ? phase.color : "var(--muted)" }}>{phase.name}</div>
                <div className="bp-sub">{phase.subtitle}</div>
                <div className="bp-need" style={{ color: done ? phase.color : "var(--muted)" }}>{done ? "✓ 完成" : `需要 ${phase.minScore}%`}</div>
              </div>
            </div>
          );
        })}
      </aside>
      <div className="boot-main">
        <div className="boot-head">
          <div className="boot-title" style={{ color: cogPhase.color }}>{cogPhase.icon} {cogPhase.name}</div>
          <div className="boot-sub" style={{ color: cogPhase.color }}>{cogPhase.subtitle}</div>
          <div className="boot-desc">{cogPhase.description}</div>
        </div>
        <div className="boot-actions">
          {trainablePhases.map((phase) => (
            <button key={phase.id} type="button" className="train-btn" disabled={isTraining}
              style={{ borderColor: `${phase.color}55`, color: phase.color }}
              onClick={() => runBootPhase(TRAINING_PHASES.indexOf(phase))}>{phase.icon} {phase.name}</button>
          ))}
          <button type="button" className="train-btn all" disabled={isTraining} onClick={runAllBoot}><Sparkles size={14} /> 全部引导训练</button>
          <button type="button" className="train-btn go" onClick={goTrain}>完成 → 去训练 ›</button>
        </div>
        <div className="boot-stream">
          {seedStream.length === 0 ? (
            <div className="empty-state">{isTraining ? "正在绑定语义锚点…" : "点击上方阶段按钮开始训练 —— 观察「符号 → 意义」的语义锚定过程"}</div>
          ) : (
            <>
              <div className="stream-head">SYMBOL → MEANING · 语义锚定过程</div>
              {seedStream.map((item, index) => (
                <div key={`${item.symbol}-${index}`} className="seed-row">
                  <span className="seed-sym" style={{ color: COGNITIVE_SEEDS[item.seedKey]?.color }}>{item.symbol}</span>
                  <span className="seed-arrow">→</span>
                  <span className="seed-mean">{item.meaning}</span>
                  <span className="seed-w" style={{ color: COGNITIVE_SEEDS[item.seedKey]?.color }}>×{item.weight.toFixed(1)}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
      <aside className="side-surface">
        <div className="surface-title"><span>自我模型</span></div>
        <MetricRows rows={[["名称", selfModel.name], ["类型", selfModel.type]]} />
        <h3>认知能力状态</h3>
        <div className="selfmodel-list">
          {SELFMODEL_LABELS.map(([key, label, desc]) => (
            <div key={key} className={`sm-row ${selfModel[key] ? "on" : ""}`}>
              <i className="sm-dot" />
              <div><strong>{label}</strong><small>{desc}</small></div>
            </div>
          ))}
        </div>
        <h3>训练时间线</h3>
        <div className="event-feed">
          {cogTrainLog.length === 0 ? <div className="empty-state">尚无训练记录</div> : cogTrainLog.map((log, index) => (
            <div key={index} className="spawn"><span>[{log.time}]</span><p>{TRAINING_PHASES[log.phase]?.icon} {log.name} → {log.score.toFixed(0)}%</p></div>
          ))}
        </div>
      </aside>
    </div>
  );
}

function TrainingPanel({ trainCorpus, addCustomVocab, customVocab, trainStats, feedbackLog, vocabSize, semanticCount, goChat }) {
  const [corpus, setCorpus] = useState("");
  const [sym, setSym] = useState("");
  const [mean, setMean] = useState("");

  const inject = () => { if (corpus.trim()) { trainCorpus(corpus); setCorpus(""); } };
  const addVocab = () => { if (sym.trim() && mean.trim()) { addCustomVocab(sym, mean); setSym(""); setMean(""); } };

  return (
    <div className="training-layout">
      <section className="train-col">
        <div className="table-surface">
          <div className="surface-title"><span>语料训练 · 喂养知识</span></div>
          <textarea className="corpus-input" value={corpus} onChange={(event) => setCorpus(event.target.value)} rows={4}
            placeholder="输入想让 LACN 学习的文本（陈述句、主语明确、不超过 200 字）。换不同说法重复注入同一主题，可加深连接。" />
          <div className="button-row">
            <button type="button" onClick={inject}><Zap size={15} /> 注入学习</button>
          </div>
          {trainStats && (
            <div className="train-feedback">
              <span>预测误差 <b style={{ color: trainStats.error < 0.3 ? "var(--mint)" : trainStats.error > 0.7 ? "var(--rose)" : "var(--amber)" }}>{(trainStats.error * 100).toFixed(0)}%</b></span>
              <span>激活路径 <b>{trainStats.pathLen}</b></span>
              <span>词表 <b>{trainStats.vocab}</b>{trainStats.added > 0 ? ` (+${trainStats.added})` : ""}</span>
            </div>
          )}
          <div className="preset-label">预置语料（点击即训练）</div>
          <div className="preset-row">
            {PRESET_CORPUS.map((preset) => (
              <button key={preset.name} type="button" title={preset.hint} onClick={() => trainCorpus(preset.text)}>{preset.name}</button>
            ))}
          </div>
        </div>

        <div className="table-surface">
          <div className="surface-title"><span>词汇定制 · 专属符号表</span><b>{customVocab.length}</b></div>
          <div className="vocab-form">
            <input value={sym} onChange={(event) => setSym(event.target.value)} placeholder="符号 / 词汇（如：欧拉公式）" />
            <input value={mean} onChange={(event) => setMean(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addVocab(); }} placeholder="含义 / 解释（定义 + 功能 + 语境，约 100 字最佳）" />
            <button type="button" onClick={addVocab}><Plus size={15} /> 添加词汇</button>
          </div>
          <div className="vocab-tags">
            {customVocab.length === 0 ? <div className="empty-state">尚未定制词汇 —— 优先定制你的专业领域词汇</div> : customVocab.map((vocab) => (
              <div key={vocab.symbol} className="vocab-tag" title={vocab.meaning}><strong>{vocab.symbol}</strong><span>{vocab.meaning.slice(0, 30)}{vocab.meaning.length > 30 ? "…" : ""}</span></div>
            ))}
          </div>
        </div>
      </section>

      <aside className="side-surface">
        <div className="surface-title"><span>训练状态</span></div>
        <MetricRows rows={[["词表大小", vocabSize], ["语义锚点", semanticCount], ["自定义词汇", customVocab.length], ["累计反馈", feedbackLog.length]]} />
        <button type="button" className="train-btn go" style={{ marginTop: 12, width: "100%" }} onClick={goChat}>去对话验证 ›</button>
        <h3>反馈记录</h3>
        <div className="event-feed">
          {feedbackLog.length === 0 ? <div className="empty-state">尚无反馈 —— 在「对话」里给回应打 👍👎</div> : feedbackLog.slice(0, 24).map((entry) => (
            <div key={entry.id} className={entry.kind === "up" ? "spawn" : "death"}>
              <span>{entry.kind === "up" ? "👍" : "👎"}</span>
              <p>{entry.tag ? `#${entry.tag} ` : ""}{entry.correction ? `纠正：${entry.correction.slice(0, 24)}` : entry.preview}</p>
            </div>
          ))}
        </div>
        <div className="hint-box">重复比数量更重要：同一主题换三种说法注入，胜过三个主题各说一遍。反馈是最强信号——一个 👍 胜过十条语料。</div>
      </aside>
    </div>
  );
}

function ManualBlock({ block }) {
  if (block.type === "p") return <p className="man-p">{block.text}</p>;
  if (block.type === "h") return <h4 className="man-h">{block.text}</h4>;
  if (block.type === "list") return <ul className="man-list">{block.items.map((item, index) => <li key={index}>{item}</li>)}</ul>;
  if (block.type === "callout") return <div className={`man-callout ${block.variant}`}><strong>{block.label}</strong><span>{block.text}</span></div>;
  if (block.type === "steps") return (
    <div className="man-steps">{block.items.map((step) => <div key={step.n} className="man-step"><b>{step.n}</b><div><strong>{step.title}</strong><span>{step.text}</span></div></div>)}</div>
  );
  if (block.type === "example") return (
    <div className={`man-example ${block.verdict}`}><div className="me-head"><span>{block.role}</span><em>{block.verdict === "good" ? "✓ 好" : "✗ 差"}</em></div><p>{block.text}</p><small>{block.note}</small></div>
  );
  if (block.type === "table") return (
    <div className="man-table-wrap"><table className="man-table"><thead><tr>{block.headers.map((header, index) => <th key={index}>{header}</th>)}</tr></thead><tbody>{block.rows.map((row, ri) => <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{cell}</td>)}</tr>)}</tbody></table></div>
  );
  return null;
}

function ManualPanel() {
  const [active, setActive] = useState(0);
  const chapter = MANUAL.chapters[active];
  const heading = chapter.num.startsWith("附录") ? `${chapter.num} · ${chapter.title}` : `第${chapter.num}章 · ${chapter.title}`;
  return (
    <div className="manual-layout">
      <aside className="manual-nav">
        <div className="surface-title"><span>使用手册 v2.0</span></div>
        {MANUAL.chapters.map((item, index) => (
          <button key={item.num} type="button" className={index === active ? "active" : ""} onClick={() => setActive(index)}>
            <b>{item.num}</b><span>{item.title}</span>
          </button>
        ))}
      </aside>
      <article className="manual-content">
        {active === 0 && <div className="man-intro">{MANUAL.intro}</div>}
        <h2 className="man-chapter">{heading}</h2>
        {chapter.blocks.map((block, index) => <ManualBlock key={index} block={block} />)}
      </article>
    </div>
  );
}

function MemoryPanel({ stm, ltm, acm, nodes }) {
  return (
    <div className="memory-layout">
      <section className="table-surface">
        <div className="surface-title"><span>SHORT-TERM MEMORY</span><b>{stm.length}</b></div>
        <div className="memory-table">
          {stm.map((item) => (
            <div key={item.id} className="memory-row">
              <span>{item.key || "empty"}</span>
              <b>{item.path.length} nodes</b>
              <em>{item.count}x</em>
            </div>
          ))}
        </div>
      </section>
      <section className="table-surface">
        <div className="surface-title"><span>LONG-TERM MEMORY</span><b>{ltm.length}</b></div>
        <div className="memory-table">
          {ltm.map((item) => (
            <div key={item.id} className="memory-row">
              <span>{item.key}</span>
              <b>{item.strength.toFixed(2)}</b>
              <em>{item.accessCount} hits</em>
            </div>
          ))}
        </div>
      </section>
      <section className="table-surface wide">
        <div className="surface-title"><span>DEFAULT NETWORK</span><b>{acm.defaultNetwork.conceptAnchors.length}</b></div>
        <div className="anchor-grid">
          {acm.defaultNetwork.conceptAnchors.map((anchor) => (
            <div key={anchor.conceptId} className="anchor-card">
              <strong>{anchor.label}</strong>
              <span>{anchor.source}</span>
              <Progress label="内化强度" value={anchor.strength * 100} tone="violet" />
              <small>{anchor.accessCount} access · {anchor.associatedNodeIds?.length || 0} nodes</small>
            </div>
          ))}
        </div>
        <div className="interest-strip">
          {Object.entries(acm.defaultNetwork.userInterestGraph).map(([key, value]) => (
            <Progress key={key} label={key} value={value * 100} tone="cyan" />
          ))}
        </div>
      </section>
    </div>
  );
}

function AcmPanel({ acm, cfg, toggleModule, togglePermission, handlePickDirectory, runSroCycle, setAcm }) {
  return (
    <div className="acm-layout">
      <section className="module-grid">
        {MODULE_META.map(([key, short, label, Icon]) => (
          <button key={key} className={`module-tile ${acm.modules[key] ? "enabled" : ""}`} type="button" onClick={() => toggleModule(key)}>
            <Icon size={20} />
            <strong>{short}</strong>
            <span>{label}</span>
          </button>
        ))}
      </section>

      <section className="table-surface">
        <div className="surface-title"><span>权限矩阵</span></div>
        <div className="permission-grid">
          {["L1", "L2", "L3", "L4"].map((level) => (
            <button key={level} type="button" className={acm.permissions[level] ? "granted" : ""} onClick={() => togglePermission(level)}>
              <strong>{level}</strong>
              <span>{level === "L1" ? "只读文件" : level === "L2" ? "索引权限" : level === "L3" ? "主动对话" : "写操作确认"}</span>
            </button>
          ))}
        </div>
        <div className="button-row">
          <button type="button" onClick={handlePickDirectory}><ScanLine size={16} />选择目录</button>
          <button type="button" onClick={runSroCycle}><RefreshCcw size={16} />执行 SRO</button>
          <button type="button" className="danger" onClick={() => setAcm(initialAcmState())}><AlertTriangle size={16} />紧急重置</button>
        </div>
      </section>

      <section className="table-surface">
        <div className="surface-title"><span>探索队列</span><b>{acm.tasks.length}</b></div>
        <div className="task-list">
          {acm.tasks.length === 0 ? <div className="empty-state">暂无任务</div> : acm.tasks.slice(0, 12).map((task) => (
            <div key={task.id} className="task-row">
              <span>{task.type}</span>
              <strong>{task.target}</strong>
              <b>{task.priority.toFixed(2)}</b>
              <em>{task.status}</em>
            </div>
          ))}
        </div>
      </section>

      <section className="table-surface">
        <div className="surface-title"><span>本地环境索引</span><b>{acm.localIndex.entries.length}</b></div>
        <div className="index-list">
          {acm.localIndex.entries.slice(0, 16).map((entry) => (
            <div key={entry.path}>
              <span>{entry.path}</span>
              <b>{Math.round(entry.sizeBytes / 1024)} KB</b>
            </div>
          ))}
        </div>
      </section>

      <section className="table-surface">
        <div className="surface-title"><span>ACM 阈值</span></div>
        <MetricRows rows={[
          ["好奇心阈值", cfg.CURIOSITY_THRESHOLD],
          ["提问阈值", cfg.ASK_THRESHOLD],
          ["每日上限", acm.ads.dailyLimit],
          ["主动次数", acm.ads.dailyCount],
          ["SRO tick", acm.lastSroTick],
        ]} />
      </section>
    </div>
  );
}

function AnalysisPanel({ nodes, stats, statsHistory, vitalityHistory, countHistory, curiosityHistory, totalSpawned }) {
  const vitalityBuckets = Array.from({ length: 10 }, (_, index) => {
    const low = index * 10;
    return Object.values(nodes).filter((node) => node.vitality >= low && node.vitality < low + 10).length;
  });
  const connBuckets = Array.from({ length: 10 }, (_, index) => {
    const low = index / 10;
    return Object.values(nodes).flatMap((node) => Object.values(node.connections)).filter((strength) => strength >= low && strength < low + 0.1).length;
  });

  return (
    <div className="analysis-layout">
      <ChartCard title="活性分布" data={vitalityBuckets} tone="mint" />
      <ChartCard title="连接强度" data={connBuckets} tone="cyan" />
      <section className="table-surface wide">
        <div className="surface-title"><span>长期趋势</span><b>{statsHistory.length}</b></div>
        <div className="trend-grid">
          <div><span>平均活性</span><Sparkline data={vitalityHistory} color="var(--mint)" height={62} /></div>
          <div><span>节点数量</span><Sparkline data={countHistory} color="var(--cyan)" height={62} /></div>
          <div><span>好奇心</span><Sparkline data={curiosityHistory} color="var(--violet)" height={62} /></div>
        </div>
      </section>
      <section className="table-surface">
        <div className="surface-title"><span>网络健康</span></div>
        <MetricRows rows={[
          ["存活率", `${totalSpawned ? ((stats.count / totalSpawned) * 100).toFixed(1) : 0}%`],
          ["濒危比例", `${stats.count ? ((stats.critical / stats.count) * 100).toFixed(1) : 0}%`],
          ["平均连接度", stats.count ? ((stats.totalConnections * 2) / stats.count).toFixed(1) : "0"],
          ["活性方差", stats.vitalityVariance.toFixed(1)],
          ["最高代数", `G${stats.maxGen}`],
        ]} />
      </section>
    </div>
  );
}

function ConfigPanel({ cfg, setCfg, reset }) {
  return (
    <div className="config-layout">
      {PARAM_GROUPS.map((group) => (
        <section key={group.title} className={`param-card ${group.accent}`}>
          <div className="surface-title"><span>{group.title}</span></div>
          {group.params.map(([key, label, min, max, step]) => (
            <label key={key} className="param-row">
              <span>{label}</span>
              <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={cfg[key]}
                onChange={(event) => setCfg((value) => ({ ...value, [key]: Number(event.target.value) }))}
              />
              <b>{Number.isInteger(cfg[key]) ? cfg[key] : cfg[key].toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}</b>
            </label>
          ))}
        </section>
      ))}
      <section className="table-surface wide">
        <div className="button-row">
          <button type="button" onClick={reset}><RotateCcw size={16} />重置并应用</button>
          <button type="button" onClick={() => setCfg(DEFAULT_CONFIG)}><Settings2 size={16} />默认参数</button>
        </div>
      </section>
    </div>
  );
}

function AuditPanel({ audit, filter, setFilter, events }) {
  const modules = ["ALL", "系统", "EDE", "LEL", "ADS", "SIE", "SRO", "ILL"];
  return (
    <div className="audit-layout">
      <section className="table-surface">
        <div className="surface-title"><span>模块筛选</span></div>
        <div className="filter-row">
          {modules.map((module) => (
            <button key={module} type="button" className={filter === module ? "active" : ""} onClick={() => setFilter(module)}>{module}</button>
          ))}
        </div>
      </section>
      <section className="table-surface wide">
        <div className="surface-title"><span>ACM 审计日志</span><b>{audit.length}</b></div>
        <div className="audit-table">
          {audit.map((entry) => (
            <div key={entry.id} className={`audit-row ${entry.outcome}`}>
              <span>{entry.time}</span>
              <b>{entry.module}</b>
              <strong>{entry.action}</strong>
              <em>{entry.permission}</em>
              <p>{entry.target}</p>
            </div>
          ))}
        </div>
      </section>
      <section className="table-surface">
        <div className="surface-title"><span>运行事件</span><b>{events.length}</b></div>
        <div className="event-feed tall">
          {events.slice(0, 40).map((event, index) => (
            <div key={`${event.tick}-${index}`} className={event.type}>
              <span>[{event.tick}]</span>
              <p>{event.msg}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function ChartCard({ title, data, tone }) {
  const max = Math.max(1, ...data);
  return (
    <section className="table-surface">
      <div className="surface-title"><span>{title}</span></div>
      <div className="bar-chart">
        {data.map((value, index) => (
          <div key={index} className={tone}>
            <span>{value}</span>
            <i style={{ height: `${Math.max(4, (value / max) * 96)}%` }} />
            <em>{index}</em>
          </div>
        ))}
      </div>
    </section>
  );
}

function MetricRows({ rows }) {
  return (
    <div className="metric-rows">
      {rows.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function Progress({ label, value, tone = "mint" }) {
  const pct = clamp(Number(value) || 0, 0, 100);
  return (
    <div className={`progress ${tone}`}>
      <div>
        <span>{label}</span>
        <b>{pct.toFixed(pct % 1 === 0 ? 0 : 1)}%</b>
      </div>
      <i><span style={{ width: `${pct}%` }} /></i>
    </div>
  );
}

function Score({ label, value }) {
  return (
    <div className="score">
      <Gauge size={16} />
      <span>{label}</span>
      <strong>{Math.round(value * 100)}</strong>
    </div>
  );
}
