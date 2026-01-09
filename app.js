// api base (统一到 api.darrius.ai)
const API_BASE = "https://api.darrius.ai";

function $(id){ return document.getElementById(id); }
function log(msg){
  console.log("[Darrius Frontend]", msg);
  const box = $("logBox");
  if(box) box.textContent = "Log: " + msg;
}

function setBadge(text, ok=true){
  const b = $("statusBadge");
  if(!b) return;
  b.textContent = text;
  b.style.background = ok ? "rgba(0,255,136,.14)" : "rgba(255,71,87,.14)";
  b.style.borderColor = ok ? "rgba(0,255,136,.35)" : "rgba(255,71,87,.35)";
  b.style.color = ok ? "#6dffb6" : "#ff9aa3";
}

// ✅ 生成一份示例K线数据（保证你不依赖后端也能看到图）
function genDemoCandles(n=120){
  const now = Math.floor(Date.now()/1000);
  const step = 60 * 60; // 1h
  let t = now - n * step;
  let price = 67000;
  const arr = [];
  for(let i=0;i<n;i++){
    const drift = Math.sin(i/12) * 120;
    const noise = (Math.random()-0.5) * 220;
    const open = price;
    const close = open + drift + noise;
    const high = Math.max(open, close) + Math.random()*180;
    const low  = Math.min(open, close) - Math.random()*180;
    price = close;
    arr.push({
      time: t,
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low: +low.toFixed(2),
      close: +close.toFixed(2),
    });
    t += step;
  }
  return arr;
}

function initChart(){
  // ✅ 关键：确保 LightweightCharts 已加载
  if(typeof LightweightCharts === "undefined"){
    setBadge("Chart lib missing", false);
    log("❌ lightweight-charts 未加载（请确认 index.html 已加入 CDN）");
    return;
  }

  const el = $("chart");
  if(!el){
    setBadge("Chart DOM missing", false);
    log("❌ 找不到 #chart 容器");
    return;
  }

  // 计算尺寸
  const rect = el.getBoundingClientRect();
  const chart = LightweightCharts.createChart(el, {
    width: Math.max(300, Math.floor(rect.width)),
    height: Math.max(260, Math.floor(rect.height)),
    layout: { background: { color: "transparent" }, textColor: "#d1d4dc" },
    grid: { vertLines: { color: "transparent" }, horzLines: { color: "transparent" } },
    timeScale: { timeVisible: true, secondsVisible: false },
    rightPriceScale: { borderVisible: false },
    crosshair: { mode: 1 },
  });

  const candle = chart.addCandlestickSeries({
    upColor: "#00ff88",
    downColor: "#ff4757",
    wickUpColor: "#00ff88",
    wickDownColor: "#ff4757",
    borderVisible: false,
  });

  candle.setData(genDemoCandles(150));
  setBadge("Chart OK", true);
  log("✅ 图表已渲染（Demo candles）。");

  // 自适应
  const ro = new ResizeObserver(() => {
    const r = el.getBoundingClientRect();
    chart.applyOptions({ width: Math.floor(r.width), height: Math.floor(r.height) });
  });
  ro.observe(el);
}

function bindUI(){
  const btn = $("subscribeBtn");
  const plan = $("planSelect");
  const healthBtn = $("healthBtn");

  if(btn){
    btn.addEventListener("click", () => {
      const v = plan ? plan.value : "monthly";

      // 这里先用占位链接，等你把 Stripe checkout session 接到后端，再改为调用 API
      // 未来推荐改为：fetch(`${API_BASE}/billing/checkout`, {method:"POST", ...})
      const placeholder = {
        monthly: "https://buy.stripe.com/test_placeholder_monthly",
        annual: "https://buy.stripe.com/test_placeholder_annual",
        lifetime: "https://buy.stripe.com/test_placeholder_lifetime",
      }[v];

      log(`准备订阅：${v}（当前为占位链接，后续接后端生成真实Checkout）`);
      if(placeholder.includes("test_placeholder")){
        alert("当前 Subscribe 仍为占位链接（未接后端Stripe Session）。下一步需要部署后端 billing API。");
      }else{
        window.location.href = placeholder;
      }
    });
  }

  if(healthBtn){
    healthBtn.addEventListener("click", async () => {
      try{
        setBadge("Checking API…", true);
        log("调用 API health…");
        const r = await fetch(`${API_BASE}/health`, { method:"GET" });
        if(!r.ok) throw new Error("HTTP " + r.status);
        const text = await r.text();
        setBadge("API OK", true);
        log("✅ API health 返回：" + text.slice(0,120));
      }catch(e){
        setBadge("API FAIL", false);
        log("❌ API health 失败（正常，因为你后端可能还没部署）：" + e.message);
      }
    });
  }
}

document.addEventListener("DOMContentLoaded", () => {
  log("页面加载完成，开始初始化…");
  initChart();
  bindUI();
});
