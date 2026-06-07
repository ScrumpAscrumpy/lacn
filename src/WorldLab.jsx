// =============================================================================
//  WorldLab —— LACN 的"接地"核心（取代旧的"符号预测符号"对话引擎）
//
//  本面板就是新架构本体。它不再让网络去预测下一个汉字，而是：
//    1. 提供一个小型、自主、带隐藏规则的环境（world.js 的耦合映射格）；
//    2. 让网络去预测环境的下一刻状态——预测误差既是"学习信号"也是"存续信号"
//       （预测准 → 获活性 → 存活/繁殖；预测差 → 衰减 → 死亡）；
//    3. 网络能对环境施加动作（探索扰动 + 稳态驱动），环境的响应又回到感知，
//       形成真正的来回交换（双向耦合）；
//    4. 允许把一个"当下的环境状态"用语言命名（实指/ostension）——符号被绑定到
//       网络亲历过的、被环境锚定的状态，而不是绑定到别的符号。
// =============================================================================
import React, { useEffect, useRef, useState, useCallback } from "react";
import { Play, Pause, RotateCcw, Zap, Target, Compass, Tag, FlaskConical } from "lucide-react";
import { WORLD, worldStep, randomWorld, perceiveFeatures } from "./world.js";
import {
  PCFG, NodeState, createPredNetwork, predictAll, learnAndSurvive, createAgent, agentAct,
} from "./predictive.js";

// 值 [0,1] → 主题色（深青 → 琥珀）
function valColor(v) {
  const t = Math.max(0, Math.min(1, v));
  const h = 175 - 140 * t;          // 175(青) → 35(琥珀)
  const l = 28 + 34 * t;
  return `hsl(${h} 85% ${l}%)`;
}
// 预测误差 → 颜色（绿=准, 红=差）
function errColor(e) {
  const t = Math.max(0, Math.min(1, e / 0.08));
  return `hsl(${140 - 140 * t} 75% 52%)`;
}

const TICK_MS = 90;

export default function WorldLab() {
  // —— 可变状态用 ref 持有，避免 setInterval 闭包读到旧值 ——
  const worldRef = useRef(randomWorld());
  const predRef = useRef(null);                 // 上一刻的群体预测（用于鬼影叠加）
  const nodesRef = useRef(createPredNetwork());
  const agentRef = useRef(createAgent(0.35));
  const bufferRef = useRef([]);                 // 记忆基线样本环形缓冲（邻域→下一刻）
  const perturbRef = useRef(null);              // 用户手动扰动（点击通道注入脉冲）
  const frozenRef = useRef(false);              // 泛化测试时冻结学习
  const tickRef = useRef(0);

  // —— UI 控制 ——
  const [running, setRunning] = useState(true);
  const [exploreRate, setExploreRate] = useState(0.5);   // 探索强度（激发动力学→规律可辨识）
  const [agentOn, setAgentOn] = useState(false);          // 稳态驱动开关
  const [target, setTarget] = useState(0.35);             // 稳态目标（场均值）
  const exploreRef = useRef(exploreRate); exploreRef.current = exploreRate;
  const agentOnRef = useRef(agentOn); agentOnRef.current = agentOn;
  const targetRef = useRef(target); targetRef.current = target;

  // —— 展示用状态 ——
  const [field, setField] = useState(worldRef.current);
  const [ghost, setGhost] = useState(null);
  const [nodesView, setNodesView] = useState([]);
  const [errHist, setErrHist] = useState([]);
  const [stat, setStat] = useState({ alive: PCFG.NODES, meanField: 0.5, popErr: 0.2, homeoErr: 0, beta: 0, gen: 0 });
  const [symbols, setSymbols] = useState([]);             // 实指绑定的符号
  const [nameInput, setNameInput] = useState("");
  const [recognized, setRecognized] = useState(null);
  const [genResult, setGenResult] = useState(null);
  const [selCell, setSelCell] = useState(null);

  const symbolsRef = useRef(symbols); symbolsRef.current = symbols;

  // —— 组合动作：探索噪声(按强度) + 稳态驱动(若开) + 用户手动扰动 ——
  const buildAction = useCallback((state) => {
    const n = state.length;
    let a = new Array(n).fill(0);
    const er = exploreRef.current;
    if (er > 0.001) for (let i = 0; i < n; i++) a[i] += (Math.random() - 0.5) * 2 * er;
    if (agentOnRef.current) {
      agentRef.current.target = targetRef.current;
      const drive = agentAct(agentRef.current, state);
      for (let i = 0; i < n; i++) a[i] += drive[i];
    } else {
      // 不驱动时也要喂均值给 agent，使 β 估计持续（便于一开就准）
      agentRef.current.lastMean = state.reduce((x, y) => x + y, 0) / n;
      agentRef.current.lastAction = 0;
    }
    if (perturbRef.current) {
      const { cell, amp } = perturbRef.current; a[cell] += amp; perturbRef.current = null;
    }
    for (let i = 0; i < n; i++) a[i] = Math.max(-1, Math.min(1, a[i]));
    return a;
  }, []);

  // —— 主循环：感知→预测→施动→世界推进→学习+存续 ——
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      const state = worldRef.current;
      const action = buildAction(state);
      const agg = predictAll(nodesRef.current, state, action);   // 群体对"下一刻"的预测
      predRef.current = agg;
      const next = worldStep(state, action);                      // 隐藏规则推进（含动作注入）

      // 记忆基线样本（逐通道：邻域→下一刻），仅用于泛化对照
      const buf = bufferRef.current;
      for (let c = 0; c < WORLD.CELLS; c++) {
        const nn = state.length;
        buf.push({ c, phi: [state[(c - 1 + nn) % nn], state[c], state[(c + 1) % nn]], y: next[c] });
      }
      if (buf.length > 6000) buf.splice(0, buf.length - 6000);

      let res = { meanErr: stat.popErr, events: [], alive: stat.alive };
      if (!frozenRef.current) res = learnAndSurvive(nodesRef.current, next, tickRef.current);

      worldRef.current = next;
      tickRef.current += 1;

      // —— 节点视图 ——
      const ns = Object.values(nodesRef.current).filter((nd) => nd.state !== NodeState.DEAD);
      let maxGen = 0; ns.forEach((nd) => { if (nd.generation > maxGen) maxGen = nd.generation; });
      const meanField = next.reduce((a, b) => a + b, 0) / next.length;
      const homeoErr = (meanField - targetRef.current) ** 2;

      // —— 实指识别：当前场状态最接近哪个已命名符号 ——
      const syms = symbolsRef.current;
      if (syms.length) {
        let best = null, bd = Infinity;
        for (const s of syms) {
          let d = 0; for (let i = 0; i < next.length; i++) d += (s.vec[i] - next[i]) ** 2;
          d = Math.sqrt(d / next.length);
          if (d < bd) { bd = d; best = s; }
        }
        setRecognized({ name: best.name, dist: bd });
      }

      // 降低渲染频率压力：每 2 拍刷新一次重型视图
      if (tickRef.current % 2 === 0) {
        setField(next);
        setGhost(agg);
        setNodesView(ns.map((nd) => ({ id: nd.id, cell: nd.cell, vitality: nd.vitality, err: nd.errEMA, frozen: nd.frozen, gen: nd.generation })));
        setErrHist((h) => { const nh = [...h, res.meanErr]; return nh.length > 120 ? nh.slice(-120) : nh; });
        setStat({ alive: ns.length, meanField, popErr: res.meanErr, homeoErr, beta: agentRef.current.beta, gen: maxGen });
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [running, buildAction, stat.popErr, stat.alive]);

  // —— 手动扰动：点击通道注入一个大脉冲，观察预测误差骤升后回落、场经耦合扩散 ——
  const pokeCell = (c) => {
    setSelCell(c);
    perturbRef.current = { cell: c, amp: worldRef.current[c] > 0.5 ? -1 : 1 };
  };

  // —— 重置 ——
  const reset = () => {
    worldRef.current = randomWorld();
    nodesRef.current = createPredNetwork();
    agentRef.current = createAgent(targetRef.current);
    bufferRef.current = [];
    tickRef.current = 0;
    frozenRef.current = false;
    setErrHist([]); setGenResult(null); setGhost(null); setRecognized(null);
    setField(worldRef.current);
  };

  // —— 泛化测试：冻结学习，在"同一世界的全新轨迹"上比较 规则学习 vs 记忆查表 ——
  const runGenTest = () => {
    frozenRef.current = true;
    const nodes = nodesRef.current;
    const sample = bufferRef.current.slice(-4000);

    // 全新随机初值 + burn-in 进入吸引子（在分布内、未见过的具体状态）
    let st = randomWorld();
    for (let b = 0; b < 100; b++) st = worldStep(st, null);

    let ruleAcc = 0, nnAcc = 0, n = 0;
    let stRule = st.slice(), stNN = st.slice();
    for (let t = 0; t < 400; t++) {
      const aggR = predictAll(nodes, stRule, null);
      const nxR = worldStep(stRule, null);
      for (let c = 0; c < WORLD.CELLS; c++) ruleAcc += (aggR[c] - nxR[c]) ** 2;
      stRule = nxR;

      const nxN = worldStep(stNN, null);
      for (let c = 0; c < WORLD.CELLS; c++) {
        const nn = stNN.length;
        const q = [stNN[(c - 1 + nn) % nn], stNN[c], stNN[(c + 1) % nn]];
        let by = 0.5, bd = Infinity;
        for (const m of sample) {
          if (m.c !== c) continue;
          let d = 0; for (let i = 0; i < 3; i++) d += (m.phi[i] - q[i]) ** 2;
          if (d < bd) { bd = d; by = m.y; }
        }
        nnAcc += (by - nxN[c]) ** 2;
      }
      stNN = nxN; n += WORLD.CELLS;
    }
    setGenResult({ rule: ruleAcc / n, nn: nnAcc / n });
    setTimeout(() => { frozenRef.current = false; }, 50);
  };

  // —— 实指：把当前场状态绑定到一个符号（接地于亲历状态，而非别的符号） ——
  const nameCurrent = () => {
    const nm = nameInput.trim();
    if (!nm) return;
    setSymbols((s) => [...s.filter((x) => x.name !== nm), { name: nm, vec: worldRef.current.slice(), t: tickRef.current }]);
    setNameInput("");
  };

  const cellW = 100 / WORLD.CELLS;

  return (
    <div className="wl-root">
      <div className="wl-head">
        <div>
          <div className="wl-title">世界实验台 · 预测耦合核</div>
          <div className="wl-sub">网络通过"预测被环境锚定的下一刻"而存续——预测即生存</div>
        </div>
        <div className="wl-controls">
          <button className="wl-btn" onClick={() => setRunning((r) => !r)}>
            {running ? <Pause size={15} /> : <Play size={15} />}{running ? "暂停" : "运行"}
          </button>
          <button className="wl-btn" onClick={reset}><RotateCcw size={15} />重置</button>
        </div>
      </div>

      {/* —— 环境场 + 预测鬼影 —— */}
      <div className="wl-card">
        <div className="wl-card-h"><span>环境场（12 通道环 · 隐藏规则：耦合 logistic 映射）</span>
          <span className="wl-hint">点击任一通道注入扰动 →</span></div>
        <div className="wl-field">
          {field.map((v, i) => (
            <div key={i} className="wl-cell" style={{ width: `${cellW}%` }} onClick={() => pokeCell(i)}>
              <div className="wl-bar" style={{ height: `${v * 100}%`, background: valColor(v) }} />
              {ghost && (
                <div className="wl-ghost" style={{ bottom: `${ghost[i] * 100}%` }}
                     title={`预测 ${ghost[i].toFixed(2)} / 实际 ${v.toFixed(2)}`} />
              )}
              {selCell === i && <div className="wl-poke" />}
            </div>
          ))}
        </div>
        <div className="wl-legend">
          <span><i className="wl-dot" style={{ background: valColor(0.85) }} />高</span>
          <span><i className="wl-dot" style={{ background: valColor(0.15) }} />低</span>
          <span><i className="wl-ghost-dot" />虚线=群体对下一刻的预测</span>
        </div>
      </div>

      {/* —— 指标 —— */}
      <div className="wl-metrics">
        <Metric label="存活节点" value={stat.alive} sub={`最高 G${stat.gen}`} />
        <Metric label="群体预测误差" value={stat.popErr.toExponential(1)} sub="↓ 即在学会规则" accent={errColor(stat.popErr)} />
        <Metric label="场均值" value={stat.meanField.toFixed(3)} sub={agentOn ? `目标 ${target.toFixed(2)}` : "自由演化"} />
        <Metric label="稳态误差" value={agentOn ? stat.homeoErr.toFixed(4) : "—"} sub={agentOn ? `学到 β=${stat.beta.toFixed(2)}` : "未驱动"} />
      </div>

      {/* —— 预测误差曲线 —— */}
      <div className="wl-card">
        <div className="wl-card-h"><span>群体预测误差（在线）</span></div>
        <Spark data={errHist} />
      </div>

      {/* —— 动作 / 双向耦合控制 —— */}
      <div className="wl-card">
        <div className="wl-card-h"><span>动作层 · 双向耦合</span></div>
        <div className="wl-row">
          <Compass size={15} />
          <label className="wl-lab">探索强度 {exploreRate.toFixed(2)}</label>
          <input type="range" min="0" max="1" step="0.05" value={exploreRate}
                 onChange={(e) => setExploreRate(parseFloat(e.target.value))} className="wl-range" />
        </div>
        <div className="wl-note">探索 = 主动扰动环境以激发动力学，使隐藏规则可辨识（被动旁观会让规则欠定）。</div>
        <div className="wl-row">
          <Target size={15} />
          <label className="wl-lab">稳态驱动</label>
          <button className={`wl-toggle ${agentOn ? "on" : ""}`} onClick={() => setAgentOn((v) => !v)}>
            {agentOn ? "开" : "关"}
          </button>
          <input type="range" min="0.1" max="0.7" step="0.01" value={target} disabled={!agentOn}
                 onChange={(e) => setTarget(parseFloat(e.target.value))} className="wl-range" />
          <span className="wl-lab">→ {target.toFixed(2)}</span>
        </div>
        <div className="wl-note">开启后智能体会施动把场均值拉向目标——它必须先学会"自己动作如何影响环境"(隐藏的 κ)。关掉看场如何回弹。</div>
      </div>

      {/* —— 节点种群（活性按预测误差着色）—— */}
      <div className="wl-card">
        <div className="wl-card-h"><span>节点种群（{stat.alive}）· 颜色=预测精度，高度=活性</span>
          <span className="wl-hint">红=预测差→正在饿死</span></div>
        <div className="wl-pop">
          {nodesView.slice(0, 96).map((nd) => (
            <div key={nd.id} className={`wl-node ${nd.frozen ? "frozen" : ""}`}
                 title={`${nd.id} · 通道${nd.cell} · 误差${nd.err.toExponential(1)} · 活性${nd.vitality.toFixed(0)}${nd.frozen ? " · 冻结(旧哲学)" : ""}`}>
              <div className="wl-node-bar" style={{ height: `${Math.min(100, nd.vitality)}%`, background: nd.frozen ? "#6b7280" : errColor(nd.err) }} />
            </div>
          ))}
        </div>
      </div>

      {/* —— 泛化测试 —— */}
      <div className="wl-card">
        <div className="wl-card-h"><span>泛化测试 · 举一反三 vs 查表</span>
          <button className="wl-btn sm" onClick={runGenTest}><FlaskConical size={14} />在全新轨迹上测试</button></div>
        {genResult ? (
          <div className="wl-gen">
            <div className="wl-gen-row">
              <span>规则学习（本网络）</span>
              <div className="wl-gen-bar"><div style={{ width: `${Math.min(100, genResult.rule / 0.08 * 100)}%`, background: "var(--mint,#7df9c0)" }} /></div>
              <b>{genResult.rule.toExponential(2)}</b>
            </div>
            <div className="wl-gen-row">
              <span>记忆查表（旧哲学）</span>
              <div className="wl-gen-bar"><div style={{ width: `${Math.min(100, genResult.nn / 0.08 * 100)}%`, background: "#ef6a6a" }} /></div>
              <b>{genResult.nn.toExponential(2)}</b>
            </div>
            <div className="wl-note">
              在从未见过的状态上：学到局部规则者可平移泛化到整个场。
              {genResult.rule < genResult.nn
                ? `本次规则学习误差更低（约 ${(genResult.nn / genResult.rule).toFixed(1)}×）。`
                : "本次差距不显著——逐通道仅 3 维，查表可近邻插值；维度升高后差距才决定性拉开。"}
            </div>
          </div>
        ) : <div className="wl-note">点击上方按钮：冻结学习，在同一世界的新轨迹上对照两种策略。</div>}
      </div>

      {/* —— 实指 / 接地 —— */}
      <div className="wl-card">
        <div className="wl-card-h"><span>实指接地 · 给当下的环境状态命名</span></div>
        <div className="wl-row">
          <Tag size={15} />
          <input className="wl-input" placeholder="例如：左行波 / 同步 / 碎裂…" value={nameInput}
                 onChange={(e) => setNameInput(e.target.value)}
                 onKeyDown={(e) => { if (e.key === "Enter") nameCurrent(); }} />
          <button className="wl-btn sm" onClick={nameCurrent}><Zap size={14} />绑定当前状态</button>
        </div>
        <div className="wl-note">符号被绑定到网络此刻亲历的 12 维环境状态，而非别的符号——这才是"接地"。</div>
        {recognized && (
          <div className="wl-recog">当前状态最接近你命名的「<b>{recognized.name}</b>」（距离 {recognized.dist.toFixed(3)}）</div>
        )}
        {symbols.length > 0 && (
          <div className="wl-symbols">
            {symbols.map((s) => (
              <div key={s.name} className="wl-symbol">
                <span className="wl-symbol-name">{s.name}</span>
                <div className="wl-symbol-strip">
                  {s.vec.map((v, i) => <i key={i} style={{ background: valColor(v) }} />)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, sub, accent }) {
  return (
    <div className="wl-metric">
      <div className="wl-metric-label">{label}</div>
      <div className="wl-metric-value" style={accent ? { color: accent } : undefined}>{value}</div>
      <div className="wl-metric-sub">{sub}</div>
    </div>
  );
}

function Spark({ data }) {
  if (!data || data.length < 2) return <div className="wl-spark-empty">采集中…</div>;
  const w = 600, h = 70, max = Math.max(...data, 0.05);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - (v / max) * h}`).join(" ");
  return (
    <svg className="wl-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke="var(--cyan,#59daff)" strokeWidth="2" />
    </svg>
  );
}
