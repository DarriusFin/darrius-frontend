// ===============================
// Darrius Frontend - app.js
// Step 2: Frontend align with Stripe LIVE price_id
// ===============================

// ✅ API base（统一到 https://darrius-api.onrender.com）
const API_BASE = "https://darrius-api.onrender.com";

// ✅ Stripe Plans (LIVE price_id) - provided by you
const PLANS = [
  {
    key: "weekly",
    label: "Weekly · 周付",
    displayPrice: "$4.9",
    priceId: "price_1SpJMmR84UMUVSTg0T7xfm6r",
  },
  {
    key: "monthly",
    label: "Monthly · 月付",
    displayPrice: "$19.9",
    priceId: "price_1SpbvRR84UMUVSTggbg0SFzi",
  },
  {
    key: "quarterly",
    label: "Quarterly · 季付",
    displayPrice: "$49.9",
    priceId: "price_1SpbwYR84UMUVSTgMQpUrE42",
  },
  {
    key: "yearly",
    label: "Annual · 年付",
    displayPrice: "$189",
    priceId: "price_1SpbpxR84UMUVSTgapaJDjMX",
  },
];

function $(id) {
  return document.getElementById(id);
}

function setBadge(text, ok = true) {
  const b = $("statusBadge");
  if (!b) return;
  b.textContent = text;
  b.classList.remove("ok", "bad");
  b.classList.add(ok ? "ok" : "bad");
}

function log(msg) {
  const box = $("logBox");
  const t = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  if (box) {
    box.textContent = (box.textContent || "").split("\n").slice(-30).join("\n");
    box.textContent += (box.textContent ? "\n" : "") + t;
    box.scrollTop = box.scrollHeight;
  }
  console.log("[Darrius Frontend]", msg);
}

// ✅ 生成演示K线（保证后端没好也能看到图）
function genDemoCandles(n = 180) {
  const now = Math.floor(Date.now() / 1000);
  const step = 60 * 60; // 1h
  let t = now - n * step;

  let price = 67000;
  const arr = [];

  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 18) * 120;
    const noise = (Math.random() - 0.5) * 220;
    const open = price;
    const close = open + drift + noise;

    const high = Math.max(open, close) + Math.random() * 180;
    const low = Math.min(open, close) - Math.random() * 180;

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

function setSignal(side = "NEUTRAL", price = null) {
  const box = $("signalBox");
  if (!box) return;

  box.innerHTML = "";
  const div = document.createElement("div");

  if (side === "BUY") {
    div.className = "signal buy";
    div.innerHTML = `<b>BUY · 买入</b>${price ? ` @ ${price}` : ""}<br/><span style="font-size:12px;color:#9aa4b2;">Demo signal · 演示信号</span>`;
  } else if (side === "SELL") {
    div.className = "signal sell";
    div.innerHTML = `<b>SELL · 卖出</b>${price ? ` @ ${price}` : ""}<br/><span style="font-size:12px;color:#9aa4b2;">Demo signal · 演示信号</span>`;
  } else {
    div.className = "signal neutral";
    div.textContent = "Waiting for data… / 等待数据…";
  }
  box.appendChild(div);
}

function initChart() {
  if (typeof LightweightCharts === "undefined") {
    setBadge("Chart lib missing", false);
    log("❌ lightweight-charts 未加载：请确认 index.html 已加入 CDN 脚本");
    return null;
  }

  const el = $("chart");
  if (!el) {
    setBadge("Chart container missing", false);
    log("❌ 找不到 #chart 容器");
    return null;
  }

  const chart = LightweightCharts.createChart(el, {
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

  // ✅ resize：避免“空大框”或不自适应
  function fit() {
    const r = el.getBoundingClientRect();
    chart.applyOptions({
      width: Math.max(1, Math.floor(r.width)),
      height: Math.max(1, Math.floor(r.height)),
    });
    chart.timeScale().fitContent();
  }

  const ro = new ResizeObserver(() => fit());
  ro.observe(el);
  window.addEventListener("resize", fit);

  // demo data
  const bars = genDemoCandles(220);
  candle.setData(bars);
  const last = bars[bars.length - 1];
  if ($("priceText")) $("priceText").textContent = `BTCUSDT · ${last.close.toFixed(2)}`;
  if ($("hintText")) $("hintText").textContent = "Demo chart loaded · 演示图表已加载";
  setBadge("Ready · 前端已就绪", true);

  // demo signal (display only)
  setSignal(Math.random() > 0.5 ? "BUY" : "SELL", last.close.toFixed(2));

  return { chart, candle };
}

async function testApiHealth() {
  setBadge("Checking API…", true);
  if ($("hintText")) $("hintText").textContent = "Testing API health…";
  try {
    // 你后端将来可提供：GET https://api.darrius.ai/health
    const resp = await fetch(`${API_BASE}/health`, { method: "GET" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const txt = await resp.text();
    setBadge("API OK", true);
    if ($("hintText")) $("hintText").textContent = "API connected · 已连接 API";
    log(`✅ API OK: ${txt.slice(0, 120)}`);
  } catch (e) {
    setBadge("API Not Ready", false);
    if ($("hintText")) $("hintText").textContent = "API not ready (normal in early stage) · API未就绪（早期正常）";
    log(`⚠️ API health failed: ${e.message}`);
  }
}

// ✅ 渲染套餐下拉框（根据 PLANS 自动生成）
function renderPlanOptions() {
  const select = $("planSelect");
  if (!select) return;

  select.innerHTML = "";
  for (const p of PLANS) {
    const opt = document.createElement("option");
    // value 用 price_id，避免前端/后端错配
    opt.value = p.priceId;
    opt.textContent = `${p.label} · ${p.displayPrice}`;
    select.appendChild(opt);
  }
}

// ✅ 从浏览器/本地拿一个“用户标识”（用于 client_reference_id 兜底）
// 你后端现在是“登录后才有 Pro 功能”，未来应直接传真实 user_id
function getClientRef() {
  // 优先：你如果已有登录逻辑，把 user_id 放到 localStorage，比如 localStorage.setItem("user_id", "xxx")
  const uid = localStorage.getItem("user_id");
  if (uid) return uid;

  // 兜底：给未登录用户生成一个匿名 id（仅用于测试）
  let anon = localStorage.getItem("anon_id");
  if (!anon) {
    anon = "anon_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
    localStorage.setItem("anon_id", anon);
  }
  return anon;
}

// ✅ 订阅：前端把 price_id 交给后端创建 Checkout Session，然后跳转 session.url
async function subscribe() {
  const btn = $("subscribeBtn");
  if (btn) btn.disabled = true;

  try {
    const priceId = $("planSelect")?.value;
    if (!priceId) {
      alert("请选择一个套餐 / Please select a plan.");
      return;
    }

    const picked = PLANS.find((p) => p.priceId === priceId);
    log(`Subscribe clicked: plan=${picked?.key || "unknown"} price_id=${priceId}`);

    // 建议：后端提供这个 endpoint（你们之前的最小改动方案就是这么做）
    // POST https://api.darrius.ai/billing/checkout
    // body: { price_id, client_reference_id, success_url?, cancel_url? }
    const payload = {
      price_id: priceId,
      plan_key: picked?.key || null,
      client_reference_id: getClientRef(),
      // 这两个 url 可选；后端也可自己拼
      success_url: `${window.location.origin}/success.html`,
      cancel_url: `${window.location.origin}/cancel.html`,
    };

    const resp = await fetch(`${API_BASE}/billing/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    // 如果你的后端暂时不是这个路由名，你可以把上面改成你实际的
    // 例如：`${API_BASE}/create-checkout-session`

    if (!resp.ok) {
      const errTxt = await resp.text().catch(() => "");
      throw new Error(`Checkout failed: HTTP ${resp.status} ${errTxt ? " - " + errTxt.slice(0, 200) : ""}`);
    }

    const data = await resp.json().catch(() => ({}));
    const url = data.url || data.checkout_url || data.session_url;

    if (!url) {
      throw new Error("Checkout created but no redirect url returned (expected {url: ...}).");
    }

    // ✅ 跳转到 Stripe Checkout
    window.location.href = url;
  } catch (e) {
    log(`❌ subscribe error: ${e.message}`);
    alert(`订阅创建失败 / Checkout error:\n\n${e.message}\n\n请确认后端 /billing/checkout 已部署且返回 {url}.`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

(function boot() {
  log("Booting frontend…");
  if ($("symText")) $("symText").textContent = "BTCUSDT";
  if ($("tfText")) $("tfText").textContent = "1D";

  renderPlanOptions();
  initChart();

  $("healthBtn")?.addEventListener("click", testApiHealth);
  $("subscribeBtn")?.addEventListener("click", subscribe);
})();
