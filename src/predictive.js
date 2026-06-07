import { worldStep, randomWorld, perceiveFeatures, FEATURE_DIM, WORLD } from "./world.js";
export const NodeState = { ACTIVE:"ACTIVE", CRITICAL:"CRITICAL", DEAD:"DEAD", NEWBORN:"NEWBORN" };
export const PCFG = {
  NODES:48, MAX_NODES:120, INIT_VIT:100, GRACE:90, PRED_LR:0.12,
  V_GAIN:160, TOL:0.025, DECAY:0.45, CRITICAL:22, MUT:0.05, SPAWN_ERR:0.02, FLOOR:0.35,
};
const dot=(w,phi)=>w.reduce((a,wi,i)=>a+wi*phi[i],0);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const randW=()=>Array.from({length:FEATURE_DIM},()=>(Math.random()-0.5)*0.1);

export function createPredNode(id, cell, tick, parentW=null, gen=0, frozen=false, startAge=0, startErr=0.2){
  const w = parentW ? parentW.map(v=>v+(Math.random()-0.5)*2*PCFG.MUT) : randW();
  return { id, cell, w, frozen, vitality:PCFG.INIT_VIT*(0.7+Math.random()*0.3), state:NodeState.NEWBORN,
    errEMA:startErr, lastErr:startErr, lastPred:0.5, born:tick, age:startAge, generation:gen, activationCount:0,
    curiosity:Math.random()*10, connections:{} };
}
export function createPredNetwork(cfg=PCFG){
  const nodes={};
  for(let i=0;i<cfg.NODES;i++){ const id=`N${i.toString().padStart(3,"0")}`; nodes[id]=createPredNode(id, i%WORLD.CELLS, 0); }
  return nodes;
}
export function predictAll(nodes, state, action){
  const perChannel={};
  for(const id in nodes){ const nd=nodes[id]; if(nd.state===NodeState.DEAD) continue;
    const aSelf = action ? action[nd.cell] : 0;
    const phi = perceiveFeatures(state, nd.cell, aSelf);
    nd._phi=phi; nd._pred=dot(nd.w,phi); nd.lastPred=nd._pred;
    const wgt=Math.max(0.01,nd.vitality);
    const c=nd.cell; if(!perChannel[c]) perChannel[c]={sum:0,wsum:0};
    perChannel[c].sum+=nd._pred*wgt; perChannel[c].wsum+=wgt;
  }
  const agg=new Array(WORLD.CELLS).fill(0);
  for(let c=0;c<WORLD.CELLS;c++){ const e=perChannel[c]; agg[c]= e&&e.wsum>0 ? clamp(e.sum/e.wsum,0,1) : 0.5; }
  return agg;
}
export function learnAndSurvive(nodes, nextState, tick, cfg=PCFG){
  let popErr=0,popN=0; const events=[];
  for(const id in nodes){ const nd=nodes[id]; if(nd.state===NodeState.DEAD) continue;
    const y=nextState[nd.cell]; const e=(nd._pred-y)**2;
    nd.lastErr=e; nd.errEMA=nd.errEMA*0.9+e*0.1; popErr+=e; popN++;
    if(!nd.frozen){ const lr=cfg.PRED_LR/(1+nd.age/150); const g=(nd._pred-y); nd.w=nd.w.map((wi,i)=>wi-lr*g*nd._phi[i]); }
    nd.age++; nd.activationCount++;
    const profit = nd.age<cfg.GRACE ? 0 : Math.max(-4, cfg.V_GAIN*(cfg.TOL-nd.errEMA));
    nd.vitality=clamp(nd.vitality+profit-cfg.DECAY,0,140);
    nd.curiosity=clamp(nd.curiosity + (e>cfg.TOL?0.4:-0.2),0,100);
    if(nd.state===NodeState.NEWBORN && nd.age>2) nd.state=NodeState.ACTIVE;
  }
  const meanErr=popN?popErr/popN:0;
  const deadNow=[];
  for(const id in nodes){ const nd=nodes[id]; if(nd.state===NodeState.DEAD) continue;
    if(nd.vitality<=0){ nd.state=NodeState.DEAD; deadNow.push(id); events.push({type:"death",id,frozen:nd.frozen}); }
    else if(nd.vitality<cfg.CRITICAL) nd.state=NodeState.CRITICAL;
    else nd.state=NodeState.ACTIVE;
  }
  const alive=Object.keys(nodes).filter(id=>nodes[id].state!==NodeState.DEAD);
  // 繁殖：群体已学得好且有空位时,把"最优学习者"的权重(平移不变→可迁移到任意通道)
  // 复制到"覆盖最少的通道",既维持全通道覆盖,又传播优良预测器(神经达尔文式选择)。
  if(meanErr<cfg.SPAWN_ERR && alive.length<cfg.NODES){
    const best=alive.map(id=>nodes[id]).filter(n=>!n.frozen).sort((a,b)=>a.errEMA-b.errEMA)[0];
    const births=Math.min(3, cfg.NODES-alive.length);
    for(let b=0;b<births && best;b++){
      const cov=new Array(WORLD.CELLS).fill(0);
      Object.keys(nodes).forEach(id=>{ if(nodes[id].state!==NodeState.DEAD) cov[nodes[id].cell]++; });
      let tc=0,mn=Infinity; for(let c=0;c<WORLD.CELLS;c++){ if(cov[c]<mn){mn=cov[c];tc=c;} }
      const nid=`N${tick}_${Math.floor(Math.random()*9999)}`;
      const child=createPredNode(nid, tc, tick, best.w, best.generation+1, false, 250, best.errEMA);
      child.vitality=cfg.INIT_VIT*0.85; nodes[nid]=child; events.push({type:"spawn",id:nid,gen:child.generation});
    }
  }
  for(const id of deadNow){ delete nodes[id]; }
  return { meanErr, events, alive: alive.length };
}
export function createAgent(target=0.35){ return { target, beta:0.0, lastMean:null, lastAction:0, gain:3.5, lr:0.4 }; }
export function agentAct(agent, state, kappaSignKnown=false){
  const mean=state.reduce((a,b)=>a+b,0)/state.length;
  if(agent.lastMean!==null && Math.abs(agent.lastAction)>1e-6){
    const dMean=mean-agent.lastMean;
    agent.beta+=agent.lr*(dMean-agent.beta*agent.lastAction)*agent.lastAction;
  }
  const err=mean-agent.target;
  const dir = Math.abs(agent.beta)>1e-3 ? Math.sign(agent.beta) : 1;
  const u=clamp(-agent.gain*dir*err,-1,1);
  agent.lastMean=mean; agent.lastAction=u;
  return state.map(()=>u);
}
