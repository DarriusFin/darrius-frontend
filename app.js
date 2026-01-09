// ✅ API base（统一到 api.darrius.ai）
const API_BASE = "https://api.darrius.ai";

function $(id){ return document.getElementById(id); }

function setBadge(text, ok=true){
  const b = $("statusBadge");
  if(!b) return;
  b.textContent = text;
  b.classList.remove("ok","bad");
  b.classList.add(ok ? "ok" : "bad");
}

function log(msg){
  const box = $("logBox");
  const t = `[${new Date().toISOString().slice(11,19)}] ${msg}`;
  if(box){
    box.textContent = (box.textContent || "").split("\n").slice(-30).join("\n");
    box.textContent += (box.textContent ? "\n" : "") + t;
    box.scrollTop = box.scrollHeight;
  }
  console.log("[Darrius Frontend]", msg);
}

// ✅ 生成演示K线（保证后端没好也能看到图）
function genDemoCandles(n=180){
  const now = Math.floor(Date.now()/1000);
  const step = 60 * 60; // 1h
  let t = now - n * step;

  let price = 67000;
  const arr = [];

  for(let i=0;i<n;i++){
    const drift = Math.sin(i/18) * 120;
    const noise = (Math.random()-0.5) * 220;
    const open = price;
    const close = open + drift + noise;

    const high = Math.max(open, close) + Math.random() * 180;
    const low  = Math.min(open, close)  - Math.random() * 180;

    price = close;

    arr.push({
      time: t,
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low:  +low.toFixed(2),
      close:+close.toFixed(2),
    });

    t += step;
  }
  return arr;
}

function setSignal(side="NEUTRAL", price=null){
  const box = $("signalBox");
  if(!box) return;

  box.innerHTML = "";
  const div = document.createElement("div");

  if(side === "BUY"){
    div.className = "signal buy";
    div.innerHTML = `<b>BUY · 买入</b>${price?` @ ${price}`:""}<br/><span style="font-size:12px;color:#9aa4b2;">Demo signal · 演示信号</span>`;
  }else if(side === "SELL"){
    div.className = "signal sell";
    div.innerHTML = `<b>SELL · 卖出</b>${price?` @ ${price}`:""}<br/><span style="font-size:12px;color:#9aa4b2;">Demo signal · 演示信号</span>`;
  }else{
    div.className = "signal neutral";
    div.textContent = "Waiting for data… / 等待数据…";
  }
  box.appendChild(div);
}

function initChart(){
  if(typeof LightweightCharts === "undefined"){
    setBadge("Chart lib missing", false);
    log("❌ lightweight-charts 未加载：请确认 index.html 已加入 CDN 脚本");
    return null;
  }

  const el = $("chart");
  if(!el){
    setBadge("Chart container missing", false);
    log("❌ 找不到 #chart 容器");
    return null;
  }

  const chart = LightweightCharts.createChart(el, {
    layout: { background: { color: "transparent" }, textColor: "#d1d4dc" },
    grid: { vertLines: { color: "transparent" }, horzLines: { color: "transparent" } },
    timeScale: { timeVisible:true, secondsVisible:false },
    rightPriceScale: { borderVisible:false },
    crosshair: { mode: 1 },
  });

  const candle = chart.addCandlestickSeries({
    upColor: "#00ff88",
    downColor:"#ff4757",
    wickUpColor:"#00ff88",
    wickDownColor:"#ff4757",
    borderVisible:false,
  });

  // ✅ resize：不然会出现你那种“空大框”或不自适应
  function fit(){
    const r = el.getBoundingClientRect();
    chart.applyOptions({ width: Math.max(1, Math.floor(r.width)), height: Math.max(1, Math.floor(r.height)) });
    chart.timeScale().fitContent();
  }

  const ro = new ResizeObserver(() => fit());
  ro.observe(el);
  window.addEventListener("resize", fit);

  // demo data
  const bars = genDemoCandles(220);
  candle.setData(bars);
  const last = bars[bars.length-1];
  $("priceText").textContent = `BTCUSDT · ${last.close.toFixed(2)}`;
  $("hintText").textContent = "Demo chart loaded · 演示图表已加载";
  setBadge("Ready · 前端已就绪", true);

  // demo signal (just for display)
  setSignal(Math.random() > 0.5 ? "BUY" : "SELL", last.close.toFixed(2));

  return { chart, candle };
}

async function testApiHealth(){
  setBadge("Checking API…", true);
  $("hintText").textContent = "Testing API health…";
  try{
    // 你后端将来可提供：GET https://api.darrius.ai/health
    const resp = await fetch(`${API_BASE}/health`, { method:"GET" });
    if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const txt = await resp.text();
    setBadge("API OK", true);
    $("hintText").textContent = "API connected · 已连接 API";
    log(`✅ API OK: ${txt.slice(0,120)}`);
  }catch(e){
    setBadge("API Not Ready", false);
    $("hintText").textContent = "API not ready (normal in early stage) · API未就绪（早期正常）";
    log(`⚠️ API health failed: ${e.message}`);
  }
}

function subscribe(){
  const plan = $("planSelect").value;

  // 你将来可以把这里改成：先请求后端创建 Stripe Checkout Session，再跳转 session.url
  // POST https://api.darrius.ai/billing/checkout  { plan, referralCode? }
  // 目前先做占位跳转提示
  const placeholder = {
    monthly:  "https://buy.stripe.com/test_placeholder_monthly",
    annual:   "https://buy.stripe.com/test_placeholder_annual",
    lifetime: "https://buy.stripe.com/test_placeholder_lifetime",
  }[plan];

  log(`Subscribe clicked: plan=${plan}`);
  alert(`Test env: would redirect to Stripe for plan=${plan}\n\nLater we will replace with real checkout session from ${API_BASE}`);

  // 如果你已经有真实链接，就把上面的 placeholder 换成真实 buy.stripe.com 链接，然后取消注释：
  // window.location.href = placeholder;
}

(function boot(){
  log("Booting frontend…");
  $("symText").textContent = "BTCUSDT";
  $("tfText").textContent  = "1D";

  initChart();

  $("healthBtn").addEventListener("click", testApiHealth);
  $("subscribeBtn").addEventListener("click", subscribe);
})();
