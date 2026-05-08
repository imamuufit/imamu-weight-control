const STORAGE_KEY = "imamuWeightLog:v1";
const MS_PER_DAY = 86400000;

const defaultState = {
  settings: {
    height: "",
    age: "",
    sex: "female",
    activity: "1.375",
    goalWeight: "",
    goalDate: "",
    goalType: "fatloss"
  },
  entries: [],
  weeklyChecks: []
};

let state = loadState();
let deferredInstallPrompt = null;

const $ = (id) => document.getElementById(id);

const formatDate = (date) => {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
};

const today = () => formatDate(new Date());

const toNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return { ...defaultState, ...saved, settings: { ...defaultState.settings, ...(saved?.settings || {}) } };
  } catch {
    return structuredClone(defaultState);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2600);
}

function sortedEntries() {
  return [...state.entries].sort((a, b) => a.date.localeCompare(b.date));
}

function latestEntriesFirst() {
  return [...state.entries].sort((a, b) => b.date.localeCompare(a.date));
}

function average(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function averageForRange(endDate, days) {
  const end = new Date(`${endDate}T00:00:00`);
  const start = new Date(end.getTime() - (days - 1) * MS_PER_DAY);
  const values = sortedEntries()
    .filter((entry) => {
      const date = new Date(`${entry.date}T00:00:00`);
      return date >= start && date <= end;
    })
    .map((entry) => entry.weight);
  return average(values);
}

function rollingAverage(date, days = 7) {
  return averageForRange(date, days);
}

function getLatestEntry() {
  return latestEntriesFirst()[0] || null;
}

function getCurrentWeight() {
  return getLatestEntry()?.weight || null;
}

function getAvg7() {
  const latest = getLatestEntry();
  return latest ? averageForRange(latest.date, 7) : null;
}

function getPreviousAvg7() {
  const latest = getLatestEntry();
  if (!latest) return null;
  const latestDate = new Date(`${latest.date}T00:00:00`);
  const prevEnd = formatDate(new Date(latestDate.getTime() - 7 * MS_PER_DAY));
  return averageForRange(prevEnd, 7);
}

function formatKg(value, signed = false) {
  if (!Number.isFinite(value)) return "--.-kg";
  const prefix = signed && value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(1)}kg`;
}

function formatInteger(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("ja-JP") : "----";
}

function getBmr(weight) {
  const height = toNumber(state.settings.height);
  const age = toNumber(state.settings.age);
  if (!weight || !height || !age) return null;
  const sexAdjust = state.settings.sex === "male" ? 5 : state.settings.sex === "female" ? -161 : -78;
  return 10 * weight + 6.25 * height - 5 * age + sexAdjust;
}

function getNutrition() {
  const weight = getCurrentWeight();
  const bmr = getBmr(weight);
  if (!weight || !bmr) return null;
  const tdee = bmr * Number(state.settings.activity || 1.375);
  const goalType = state.settings.goalType;
  const calorieAdjust = {
    fatloss: -350,
    maintain: 0,
    leanbulk: 180,
    weightclass: -250
  }[goalType] ?? -300;
  const targetCalories = Math.max(1200, tdee + calorieAdjust);
  const protein = weight * (goalType === "leanbulk" ? 2.0 : 1.8);
  const fat = weight * 0.8;
  const carbs = Math.max(0, (targetCalories - protein * 4 - fat * 9) / 4);
  return { tdee, targetCalories, protein, fat, carbs };
}

function getTrendText() {
  const entries = sortedEntries();
  if (entries.length < 10) return "記録待ち";
  const latest = getLatestEntry();
  const current = averageForRange(latest.date, 7);
  const latestDate = new Date(`${latest.date}T00:00:00`);
  const priorEnd = formatDate(new Date(latestDate.getTime() - 7 * MS_PER_DAY));
  const prior = averageForRange(priorEnd, 7);
  if (!Number.isFinite(current) || !Number.isFinite(prior)) return "記録待ち";
  const diff = current - prior;
  if (diff <= -0.4) return "下降";
  if (diff >= 0.4) return "上昇";
  return "安定";
}

function getAdvice() {
  const avg7 = getAvg7();
  const prev = getPreviousAvg7();
  const goal = toNumber(state.settings.goalWeight);
  const goalType = state.settings.goalType;
  if (!Number.isFinite(avg7) || !Number.isFinite(prev)) {
    return "7日平均を出すために、まずは同じ条件で記録を続けましょう。判断は最低7日、できれば14日分が集まってからが安定します。";
  }
  const diff = avg7 - prev;
  if (goalType === "maintain" && Math.abs(diff) <= 0.3) {
    return "維持としては良い範囲です。摂取量や運動量を大きく変えず、体調メモで疲労や睡眠も見ていきましょう。";
  }
  if (goalType === "leanbulk") {
    if (diff < 0.1) return "増量目的としては増え方が控えめです。体調が良ければ摂取カロリーを100から150kcalほど上げる余地があります。";
    if (diff > 0.6) return "増え方がやや速めです。体脂肪の増加が気になる場合は、摂取カロリーを100kcalほど抑えて様子を見ましょう。";
    return "筋トレしながらの増量として自然な範囲です。トレーニング重量と体調の両方を見て続けましょう。";
  }
  if (diff < -0.9) return "落ち方が速めです。疲労感や空腹が強い場合は、摂取カロリーを100から200kcal戻すか、休養を優先しましょう。";
  if (diff > -0.2 && goal && avg7 > goal) return "減量の動きが弱めです。14日平均でも停滞するなら、間食や外食頻度を確認し、摂取を100kcalほど調整します。";
  if (diff <= -0.2 && diff >= -0.8) return "良いペースです。日々の上下に反応しすぎず、このまま7日平均の流れを追いましょう。";
  return "目標と体調を見ながら、2週間単位で小さく調整しましょう。急な変更より、続く設定が優先です。";
}

function fillFormValues() {
  $("entryDate").value = today();
  $("weekStart").value = formatDate(new Date(Date.now() - 6 * MS_PER_DAY));
  Object.entries(state.settings).forEach(([key, value]) => {
    const input = $(key);
    if (input) input.value = value;
  });
}

function renderAll() {
  renderDate();
  renderMetrics();
  renderEntries();
  renderWeeklyChecks();
  renderChart();
}

function renderDate() {
  const date = new Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric", weekday: "short" }).format(new Date());
  $("todayLabel").textContent = date;
}

function renderMetrics() {
  const latest = getLatestEntry();
  const avg7 = getAvg7();
  const prev = getPreviousAvg7();
  const diff = Number.isFinite(avg7) && Number.isFinite(prev) ? avg7 - prev : null;
  const goal = toNumber(state.settings.goalWeight);
  const goalGap = Number.isFinite(avg7) && Number.isFinite(goal) ? avg7 - goal : null;
  const goalDate = state.settings.goalDate ? new Date(`${state.settings.goalDate}T00:00:00`) : null;
  const daysLeft = goalDate ? Math.ceil((goalDate - new Date(`${today()}T00:00:00`)) / MS_PER_DAY) : null;
  const nutrition = getNutrition();

  $("heroAverage").textContent = formatKg(avg7);
  $("latestWeight").textContent = latest ? formatKg(latest.weight) : "--.-kg";
  $("weeklyDiff").textContent = formatKg(diff, true);
  $("avg7").textContent = formatKg(avg7);
  $("trend14").textContent = getTrendText();
  $("daysLeft").textContent = Number.isFinite(daysLeft) ? `${Math.max(0, daysLeft)}日` : "--日";
  $("goalGap").textContent = formatKg(goalGap, true);
  $("tdee").textContent = nutrition ? formatInteger(nutrition.tdee) : "----";
  $("targetCalories").textContent = nutrition ? formatInteger(nutrition.targetCalories) : "----";
  $("protein").textContent = nutrition ? `${Math.round(nutrition.protein)}g` : "--g";
  $("fat").textContent = nutrition ? `${Math.round(nutrition.fat)}g` : "--g";
  $("carbs").textContent = nutrition ? `${Math.round(nutrition.carbs)}g` : "--g";
  $("adviceText").textContent = getAdvice();
}

function renderEntries() {
  const list = $("entryList");
  const entries = latestEntriesFirst().slice(0, 10);
  if (!entries.length) {
    list.innerHTML = '<p class="empty-state">まだ記録がありません。</p>';
    return;
  }
  list.innerHTML = entries.map((entry) => `
    <div class="entry-row">
      <div>
        <strong>${entry.date} ${formatKg(entry.weight)}</strong>
        <p>${escapeHtml(conditionLabel(entry.condition))}${entry.memo ? ` / ${escapeHtml(entry.memo)}` : ""}</p>
      </div>
      <button class="mini-button" type="button" data-delete-entry="${entry.date}" aria-label="${entry.date}の記録を削除">削除</button>
    </div>
  `).join("");
}

function renderWeeklyChecks() {
  const list = $("weeklyList");
  const checks = [...state.weeklyChecks].sort((a, b) => b.weekStart.localeCompare(a.weekStart));
  if (!checks.length) {
    list.innerHTML = '<p class="empty-state">週間チェックはまだありません。</p>';
    return;
  }
  list.innerHTML = checks.map((check) => `
    <div class="entry-row">
      <div>
        <strong>${check.weekStart}</strong>
        <p>食事 ${check.mealScore}/5・疲労 ${check.fatigueScore}/5${check.memo ? ` / ${escapeHtml(check.memo)}` : ""}</p>
      </div>
      <button class="mini-button" type="button" data-delete-week="${check.weekStart}" aria-label="${check.weekStart}の週間チェックを削除">削除</button>
    </div>
  `).join("");
}

function renderChart() {
  const canvas = $("weightChart");
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);

  const entries = sortedEntries().slice(-35);
  const goal = toNumber(state.settings.goalWeight);
  const values = entries.flatMap((entry) => [entry.weight, rollingAverage(entry.date)]).filter(Number.isFinite);
  if (Number.isFinite(goal)) values.push(goal);

  ctx.fillStyle = "#fbfaf7";
  ctx.fillRect(0, 0, width, height);

  if (entries.length < 2 || values.length < 2) {
    ctx.fillStyle = "#6d6a63";
    ctx.font = "28px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("2日以上記録するとグラフを表示します", width / 2, height / 2);
    return;
  }

  const padding = { top: 34, right: 34, bottom: 54, left: 58 };
  const min = Math.floor(Math.min(...values) - 0.8);
  const max = Math.ceil(Math.max(...values) + 0.8);
  const x = (index) => padding.left + index * ((width - padding.left - padding.right) / Math.max(1, entries.length - 1));
  const y = (value) => padding.top + (max - value) * ((height - padding.top - padding.bottom) / Math.max(1, max - min));

  ctx.strokeStyle = "#e8e4dc";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#6d6a63";
  ctx.font = "20px system-ui";
  ctx.textAlign = "right";
  for (let i = 0; i <= 4; i += 1) {
    const value = min + ((max - min) / 4) * i;
    const yy = y(value);
    ctx.beginPath();
    ctx.moveTo(padding.left, yy);
    ctx.lineTo(width - padding.right, yy);
    ctx.stroke();
    ctx.fillText(value.toFixed(1), padding.left - 10, yy + 7);
  }

  if (Number.isFinite(goal)) {
    ctx.setLineDash([10, 8]);
    ctx.strokeStyle = "#c7a85d";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(padding.left, y(goal));
    ctx.lineTo(width - padding.right, y(goal));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  drawLine(ctx, entries.map((entry, index) => [x(index), y(entry.weight)]), "#111111", 4);
  drawLine(ctx, entries.map((entry, index) => {
    const avg = rollingAverage(entry.date);
    return Number.isFinite(avg) ? [x(index), y(avg)] : null;
  }).filter(Boolean), "#2f7d5b", 5);

  entries.forEach((entry, index) => {
    ctx.beginPath();
    ctx.arc(x(index), y(entry.weight), 5, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "#111111";
    ctx.lineWidth = 3;
    ctx.stroke();
  });

  ctx.textAlign = "left";
  ctx.fillStyle = "#111111";
  ctx.font = "22px system-ui";
  ctx.fillText("実測", padding.left, height - 18);
  ctx.fillStyle = "#2f7d5b";
  ctx.fillText("7日平均", padding.left + 86, height - 18);
  ctx.fillStyle = "#c7a85d";
  ctx.fillText("目標", padding.left + 210, height - 18);
}

function drawLine(ctx, points, color, lineWidth) {
  if (points.length < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  points.forEach(([x, y], index) => {
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function conditionLabel(value) {
  return { good: "体調 良い", normal: "体調 普通", tired: "体調 重い" }[value] || "体調 普通";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function upsertEntry(entry) {
  state.entries = state.entries.filter((item) => item.date !== entry.date);
  state.entries.push(entry);
  saveState();
}

function upsertWeeklyCheck(check) {
  state.weeklyChecks = state.weeklyChecks.filter((item) => item.weekStart !== check.weekStart);
  state.weeklyChecks.push(check);
  saveState();
}

function getLineReport() {
  const latest = getLatestEntry();
  const avg7 = getAvg7();
  const prev = getPreviousAvg7();
  const diff = Number.isFinite(avg7) && Number.isFinite(prev) ? avg7 - prev : null;
  const trend = getTrendText();
  const memo = latest?.memo ? `\nメモ：${latest.memo}` : "";
  return [
    "【体重報告】",
    `日付：${latest?.date || today()}`,
    `体重：${latest ? formatKg(latest.weight) : "未記録"}`,
    `7日平均：${formatKg(avg7)}`,
    `先週平均比：${formatKg(diff, true)}`,
    `14日傾向：${trend}${memo}`
  ].join("\n");
}

function exportCsv() {
  const rows = [
    ["type", "date", "weight", "condition", "memo", "mealScore", "fatigueScore"],
    ...sortedEntries().map((entry) => ["entry", entry.date, entry.weight, entry.condition, entry.memo || "", "", ""]),
    ...state.weeklyChecks.map((check) => ["weekly", check.weekStart, "", "", check.memo || "", check.mealScore, check.fatigueScore])
  ];
  const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `imamu-weight-log-${today()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function setupEvents() {
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab-button").forEach((tab) => tab.classList.remove("active"));
      document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
      button.classList.add("active");
      $(`view-${button.dataset.view}`).classList.add("active");
      if (button.dataset.view === "dashboard") renderChart();
    });
  });

  $("entryForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const weight = toNumber($("entryWeight").value);
    if (!weight) return showToast("体重を入力してください");
    const condition = document.querySelector('input[name="condition"]:checked')?.value || "normal";
    upsertEntry({
      date: $("entryDate").value,
      weight,
      memo: $("entryMemo").value.trim(),
      condition
    });
    $("entryMemo").value = "";
    renderAll();
    showToast("記録しました");
  });

  $("settingsForm").addEventListener("submit", (event) => {
    event.preventDefault();
    state.settings = {
      height: $("height").value,
      age: $("age").value,
      sex: $("sex").value,
      activity: $("activity").value,
      goalWeight: $("goalWeight").value,
      goalDate: $("goalDate").value,
      goalType: $("goalType").value
    };
    saveState();
    renderAll();
    showToast("設定を保存しました");
  });

  $("weeklyForm").addEventListener("submit", (event) => {
    event.preventDefault();
    upsertWeeklyCheck({
      weekStart: $("weekStart").value,
      mealScore: $("mealScore").value,
      fatigueScore: $("fatigueScore").value,
      memo: $("weeklyMemo").value.trim()
    });
    $("weeklyMemo").value = "";
    renderAll();
    showToast("週間チェックを保存しました");
  });

  $("entryList").addEventListener("click", (event) => {
    const date = event.target.dataset.deleteEntry;
    if (!date) return;
    state.entries = state.entries.filter((entry) => entry.date !== date);
    saveState();
    renderAll();
    showToast("記録を削除しました");
  });

  $("weeklyList").addEventListener("click", (event) => {
    const weekStart = event.target.dataset.deleteWeek;
    if (!weekStart) return;
    state.weeklyChecks = state.weeklyChecks.filter((check) => check.weekStart !== weekStart);
    saveState();
    renderAll();
    showToast("週間チェックを削除しました");
  });

  $("copyLineButton").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(getLineReport());
      showToast("LINE報告文をコピーしました");
    } catch {
      showToast("コピーできませんでした。ブラウザの共有設定を確認してください");
    }
  });

  $("exportCsvButton").addEventListener("click", exportCsv);

  $("deleteDataButton").addEventListener("click", () => {
    if (!confirm("すべての記録と設定を削除します。よろしいですか？")) return;
    state = structuredClone(defaultState);
    saveState();
    fillFormValues();
    renderAll();
    showToast("データを削除しました");
  });

  window.addEventListener("resize", () => renderChart());

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    $("installButton").hidden = false;
  });

  $("installButton").addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $("installButton").hidden = true;
  });
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("service-worker.js");
  } catch {
    console.info("Service worker registration skipped.");
  }
}

fillFormValues();
setupEvents();
renderAll();
registerServiceWorker();
