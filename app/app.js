"use strict";
/*
 * pypath-тренажёр — клиентское приложение.
 * Все данные (уроки, тесты, harness.py) вшиты в app/data.js генератором
 * tools/build_site.py. Проверка решений выполняется harness'ом на Pyodide
 * (тот же код, что у tools/validate_lessons.py) — «прошло здесь == пройдёт в тренажёре».
 */

const DATA = window.PY_TRAINER_DATA;
if (!DATA) throw new Error("app/data.js не найден — запусти python3 tools/build_site.py");
const CORE = window.PypathCore;
if (!CORE) throw new Error("app/core.js не подключён");

const LS_KEY = "pypath-trainer-v1";
const $ = (sel, root) => (root || document).querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ---------- состояние и прогресс ---------- */

const store = (() => {
  let data;
  try { data = CORE.normalizeProgress(JSON.parse(localStorage.getItem(LS_KEY))); } catch (e) { data = null; }
  const empty = () => CORE.normalizeProgress({ done: {}, drafts: {} });
  if (!data) data = empty();
  let timer = null;
  const later = () => { clearTimeout(timer); timer = setTimeout(save, 350); };
  return {
    isDone: (lid, tid) => data.done[CORE.taskKey(lid, tid)] === true,
    markDone: (lid, tid) => { data.done[CORE.taskKey(lid, tid)] = true; save(); },
    draft: (lid, tid) => data.drafts[CORE.taskKey(lid, tid)] || "",
    setDraft: (lid, tid, code) => { data.drafts[CORE.taskKey(lid, tid)] = code; later(); },
    reviewStats: () => data.review.stats,
    recordReview: (key, outcome) => {
      data.review.stats[key] = CORE.applyReviewResult(data.review.stats[key], outcome);
      save();
    },
    reviewDraft: key => ({ code: "", hadErrors: false, usedHelp: false, ...data.review.drafts[key] }),
    setReviewDraft: round => {
      data.review.drafts[round.entry.key] = {
        code: round.code, hadErrors: round.hadErrors, usedHelp: round.usedHelp,
      };
      later();
    },
    clearReviewDraft: key => { delete data.review.drafts[key]; save(); },
    recent: () => data.review.recent,
    rememberReview: key => { data.review.recent = [...data.review.recent, key].slice(-2); save(); },
    reset: () => { clearTimeout(timer); data = empty(); save(); },
    snapshot: () => data,
    restore: obj => {
      const restored = CORE.normalizeProgress(obj);
      if (!restored) return false;
      clearTimeout(timer); data = restored; save(); return true;
    },
    flush: save,
  };
  function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (e) { /* приватный режим */ } }
})();
window.addEventListener("pagehide", store.flush);

const ALL_TASKS = [];
DATA.stages.forEach(st => st.lessons.forEach(ls => {
  ls.data.tasks.forEach(t => ALL_TASKS.push({ stage: st, lesson: ls, task: t }));
}));
const doneCount = () => ALL_TASKS.filter(x => store.isDone(x.lesson.data.id, x.task.id)).length;

const FLAT = CORE.makeIndex(DATA.stages);
const isDone = (lid, tid) => store.isDone(lid, tid);
const unlockedFlags = () => CORE.unlockedFlags(FLAT, isDone);
const flatPos = () => FLAT.findIndex((x) => x.si === state.stage && x.li === state.lesson);

const newReviewState = () => ({ mode: "all", screen: "home", session: null, round: null, celebration: null });
const state = { stage: 0, lesson: 0, view: "lesson", py: { status: "idle" }, review: newReviewState() };
let advanceTimer = null;
const reviewPool = () => CORE.reviewPool(DATA.stages, isDone);

function resetNavigation() {
  state.stage = 0; state.lesson = 0; state.view = "lesson";
  state.review = newReviewState();
  render();
}

/* ---------- подсветка python и лёгкий markdown ---------- */

const PY_KW = new Set(("def return if elif else for while in not and or is None True False " +
  "import from as class try except finally raise with lambda pass break continue assert " +
  "del global yield async await match case").split(" "));
const PY_BI = new Set(("print len range int float str list dict set tuple bool sum min max abs " +
  "sorted round input open enumerate zip type repr help dir isinstance next").split(" "));

function highlightPy(codeText) {
  const rx = /("""[\s\S]*?"""|'''[\s\S]*?'''|[rbfu]{0,2}"(?:[^"\\\n]|\\.)*"?|[rbfu]{0,2}'(?:[^'\\\n]|\\.)*'?)|(#[^\n]*)|\b([A-Za-z_][A-Za-z_0-9]*)\b|(\b\d+(?:\.\d+)?\b)/g;
  const safe = esc(codeText);
  return safe.replace(rx, (m, str, com, name, num) => {
    if (str) return '<span class="str">' + m + "</span>";
    if (com) return '<span class="com">' + m + "</span>";
    if (num) return '<span class="num">' + m + "</span>";
    if (name) {
      if (PY_KW.has(name)) return '<span class="kw">' + name + "</span>";
      if (PY_BI.has(name)) return '<span class="bi">' + name + "</span>";
    }
    return m;
  });
}

function md(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, (m, g1) => '<code class="inline-code">' + g1 + "</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

/* ---------- сайдбар ---------- */

function renderSidebar() {
  const side = $("#sidebar");
  side.innerHTML = "";

  const brand = el("div", "brand");
  brand.innerHTML = '<div class="logo">🐍</div><div><h1>Python-тренажёр</h1><small>Основы · Мостик</small></div>';
  side.appendChild(brand);

  const total = ALL_TASKS.length, done = doneCount();
  const ov = el("div", "overall");
  ov.innerHTML =
    '<div class="bar"><div class="fill" style="width:' + (total ? (done / total * 100) : 0) + '%"></div></div>' +
    '<div class="txt"><span>решено задач</span><span>' + done + " / " + total + "</span></div>";
  side.appendChild(ov);

  const pool = reviewPool();
  const topics = CORE.reviewTopics(pool, store.reviewStats());
  const weak = topics.filter(topic => topic.weak).length;
  const reviewBtn = el("button", "side-btn review-nav" + (state.view === "review" ? " active" : ""));
  reviewBtn.id = "review-nav";
  reviewBtn.innerHTML = '<span class="review-nav-icon" aria-hidden="true">' + (pool.length ? "↻" : "◇") + '</span>' +
    '<span><strong>Повторение</strong><small>' + (pool.length
      ? (weak ? "Есть темы для закрепления" : "Смешанная практика")
      : "После первой пройденной темы") + '</small></span><span aria-hidden="true">' + (pool.length ? "→" : "🔒") + '</span>';
  reviewBtn.onclick = () => { state.view = "review"; render(); closeNav(); window.scrollTo(0, 0); };
  side.appendChild(reviewBtn);

  const flags = unlockedFlags();
  let fi = -1;
  DATA.stages.forEach((st, si) => {
    side.appendChild(el("div", "stage-title", esc(st.title)));
    st.lessons.forEach((ls, li) => {
      fi++;
      const d = ls.data;
      const nDone = d.tasks.filter(t => store.isDone(d.id, t.id)).length;
      const isCur = state.view === "lesson" && state.stage === si && state.lesson === li;
      const btn = el("button", "lesson-item" + (nDone === d.tasks.length ? " complete" : ""));
      if (isCur) btn.classList.add("active");
      btn.innerHTML =
        '<span class="num">' + (nDone === d.tasks.length ? "✓" : (flags[fi] ? d.order : "🔒")) + "</span>" +
        '<span class="name">' + esc(d.title) + "</span>" +
        '<span class="frac">' + nDone + "/" + d.tasks.length + "</span>";
      if (!flags[fi] && !isCur) {
        btn.classList.add("locked");
        btn.title = "Откроется, когда пройдёшь предыдущую тему";
        btn.onclick = () => toast("Тема закрыта: реши все задачи предыдущей темы");
      } else {
        btn.onclick = () => { state.view = "lesson"; state.stage = si; state.lesson = li; render(); closeNav(); };
      }
      side.appendChild(btn);
    });
  });

  const planBtn = el("button", "side-btn" + (state.view === "plan" ? " active" : ""), "📋 Мой план обучения");
  planBtn.onclick = () => { state.view = "plan"; render(); closeNav(); };
  side.appendChild(planBtn);

  const foot = el("div", "side-foot");
  const reset = el("button", "side-btn", "↺ сбросить прогресс");
  reset.onclick = () => {
    if (confirm("Сбросить решённые задачи, черновики и статистику повторения?")) { store.reset(); resetNavigation(); }
  };
  foot.appendChild(reset);
  const exp = el("button", "side-btn", "⬇ экспорт прогресса (.json)");
  exp.onclick = () => {
    const blob = new Blob([JSON.stringify({ app: "pypath", v: 2, ...store.snapshot() }, null, 1)],
      { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pypath-progress.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  };
  foot.appendChild(exp);
  const imp = el("button", "side-btn", "⬆ импорт прогресса из файла");
  imp.onclick = () => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".json,application/json";
    inp.onchange = () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      f.text().then((t) => {
        let obj = null;
        try { obj = JSON.parse(t); } catch (e) { obj = null; }
        if (obj && store.restore(obj)) { resetNavigation(); toast("Прогресс и статистика загружены"); }
        else toast("Не похоже на бэкап pypath-progress.json");
      });
    };
    inp.click();
  };
  foot.appendChild(imp);
  const fresh = el("button", "side-btn", "🧹 жёсткая перезагрузка (без кэша)");
  fresh.title = "Перезагрузить app.css, app.js и data.js минуя кэш браузера";
  fresh.onclick = hardReload;
  foot.appendChild(fresh);
  side.appendChild(foot);

  if (DATA.built) {
    side.appendChild(el("div", "build-info", "сборка данных: " + esc(DATA.built)));
  }
}

async function hardReload() {
  // обновляем кэш HTTP принудительно, затем обычный reload — он возьмёт свежие файлы
  try {
    await Promise.all(["app/app.css", "app/core.js", "app/app.js", "app/data.js"].map(
      (u) => fetch(u, { cache: "reload" }).catch(() => null)));
  } catch (e) { /* file:// — fetch может быть недоступен, перезагрузка всё равно поможет */ }
  location.reload();
}

/* ---------- теория ---------- */

function renderTheoryBlocks(container, theory) {
  theory.forEach(block => {
    switch (block.type) {
      case "text":
        container.appendChild(el("p", null, md(block.text)));
        break;
      case "note":
        container.appendChild(el("div", "callout note", '<span class="ico">💡</span>' + md(block.text)));
        break;
      case "warning":
        container.appendChild(el("div", "callout warning", '<span class="ico">⚠️</span>' + md(block.text)));
        break;
      case "code": {
        const wrap = el("div", "codeblock");
        const head = el("div", "cb-head");
        head.innerHTML = '<span class="caption">' + esc(block.caption || "python") + "</span>";
        const run = el("button", "run-btn", "▶ Запустить");
        head.appendChild(run);
        const pre = el("pre", null, '<code>' + highlightPy(block.code) + "</code>");
        wrap.append(head, pre);
        if (block.output) {
          const out = el("div", "cb-out");
          out.innerHTML = '<div class="out-label">' + (block.run_check ? "вывод в консоли:" : "возможный вывод:") + "</div>" +
            "<pre>" + esc(block.output) + "</pre>";
          wrap.appendChild(out);
        }
        run.onclick = () => runExample(block, wrap, head, run);
        container.appendChild(wrap);
        break;
      }
      case "table": {
        const table = el("table", "cmp");
        let html = "";
        if (block.header) html += "<thead><tr>" + block.header.map(h => "<th>" + md(h) + "</th>").join("") + "</tr></thead>";
        html += "<tbody>" + block.rows.map(r => "<tr>" + r.map(c => "<td>" + md(c) + "</td>").join("") + "</tr>").join("") + "</tbody>";
        table.innerHTML = html;
        container.appendChild(table);
        break;
      }
      case "list": {
        const box = el("div");
        if (block.title) box.appendChild(el("div", null, "<b>" + md(block.title) + "</b>"));
        box.appendChild(el("ul", "checklist", block.items.map(i => "<li>" + md(i) + "</li>").join("")));
        container.appendChild(box);
        break;
      }
      case "compare": {
        const grid = el("div", "two-cols");
        const col = (kind, label, codeText) => {
          const c = el("div", "col " + kind);
          c.innerHTML = '<div class="col-h">' + label + "</div><pre class=\"codeblock\"><code>" + highlightPy(codeText) + "</code></pre>";
          return c;
        };
        grid.append(col("bad", "✗ так не надо", block.bad), col("good", "✓ так надо", block.good));
        if (block.title) container.appendChild(el("div", null, "<b>" + md(block.title) + "</b>"));
        container.appendChild(grid);
        break;
      }
    }
  });
}

async function runExample(block, wrap, head, btn) {
  if (state.py.status !== "ready") { ensurePy(); return flash(btn, "Python грузится…"); }
  btn.disabled = true;
  try {
    const res = callRun(block.code, block.input || "");
    let out = wrap.querySelector(".cb-run");
    if (!out) { out = el("div", "cb-out cb-run"); wrap.appendChild(out); }
    out.classList.toggle("err", !res.ok);
    if (res.ok) {
      out.innerHTML = '<div class="out-label">вывод:</div><pre>' +
        (res.stdout ? esc(res.stdout.replace(/\n$/, "")) : "— пусто —") + "</pre>";
    } else {
      out.innerHTML = '<div class="out-label">ошибка:</div><pre class="rerr">' + esc(res.error || "неизвестная ошибка") + "</pre>";
    }
  } finally { btn.disabled = false; }
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = old; }, 1200);
}

/* ---------- задачи ---------- */

function renderTask(lessonData, task, idx, options = {}) {
  const review = options.round;
  const key = CORE.taskKey(lessonData.id, task.id);
  const attempt = review || { hadErrors: CORE.reviewStat(store.reviewStats()[key]).errors > 0, usedHelp: false };
  const solved = () => review ? review.finished : store.isDone(lessonData.id, task.id);
  const card = el("section", "task" + (solved() ? " done-task" : ""));
  card.id = "task-" + task.id;

  const head = el("div", "task-head");
  head.innerHTML =
    "<h4>Задача " + (idx + 1) + " · " + esc(task.title) + "</h4>" +
    '<span class="diff" title="сложность">' + "●".repeat(task.difficulty) + "○".repeat(3 - task.difficulty) + "</span>" +
    (solved() ? '<span class="done-badge">✓ ' + (review ? "повторено" : "решено") + '</span>' : "");
  card.appendChild(head);

  card.appendChild(el("div", "statement", md(task.statement)));

  const fmt = el("div", "fmt");
  fmt.innerHTML =
    "<div><b>вход</b>" + md(task.input_format || "—") + "</div>" +
    "<div><b>выход</b>" + md(task.output_format || "—") + "</div>";
  card.appendChild(fmt);

  if (task.examples && task.examples.length) {
    const exBox = el("div", "examples");
    exBox.innerHTML = task.examples.map(ex =>
      '<div class="ex"><div><b>вход</b><pre>' + esc(ex.input || "—") + '</pre></div>' +
      "<div><b>выход</b><pre>" + esc(ex.output || "") + "</pre></div></div>").join("");
    exBox.firstChild && exBox.insertBefore(el("b", null, "Пример"), exBox.firstChild);
    card.appendChild(exBox);
  }

  if (task.hints && task.hints.length) {
    const det = el("details", "hints");
    det.innerHTML = "<summary>Подсказки (" + task.hints.length + ") — открывай по одной</summary><ol>" +
      task.hints.map(h => "<li>" + md(h) + "</li>").join("") + "</ol>";
    det.addEventListener("toggle", () => {
      if (!det.open || solved()) return;
      attempt.usedHelp = true;
      if (review) options.onHelp();
    });
    card.appendChild(det);
  }

  const editor = el("div", "editor");
  const ta = document.createElement("textarea");
  ta.spellcheck = false;
  ta.value = review ? review.code : store.draft(lessonData.id, task.id);
  ta.setAttribute("aria-label", "Решение: " + task.title);
  ta.placeholder = "# пиши решение здесь…";
  const saveDraft = () => {
    if (review) {
      review.code = ta.value;
      if (!review.finished) store.setReviewDraft(review);
    } else store.setDraft(lessonData.id, task.id, ta.value);
  };
  ta.addEventListener("input", saveDraft);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const s = ta.selectionStart, t = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + "    " + ta.value.slice(t);
      ta.selectionStart = ta.selectionEnd = s + 4;
      saveDraft();
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doCheck(); }
  });
  editor.appendChild(ta);
  card.appendChild(editor);

  const visTest = (task.tests || []).find((t) => t.visible) || (task.tests || [])[0] || {};
  const ioBox = el("div", "io-box");
  const ioLabel = el("label", null, "ввод программы для «Запустить» (как если бы ученик напечатал с клавиатуры)");
  const stdinTa = document.createElement("textarea");
  stdinTa.className = "stdin";
  stdinTa.rows = 2;
  stdinTa.placeholder = "— ввод не нужен —";
  stdinTa.value = visTest.input || "";
  stdinTa.id = "stdin-" + task.id;
  ioLabel.htmlFor = stdinTa.id;
  ioBox.append(ioLabel, stdinTa);
  card.appendChild(ioBox);

  const actions = el("div", "task-actions");
  const checkBtn = el("button", "btn primary", "Проверить");
  const runBtn = el("button", "btn ghost", "▶ Запустить на примере");
  if (task.tests && task.tests.some((t) => t.code_before || t.code_after)) {
    runBtn.title = "Задача проверяется вызовом твоей функции — нажми «Проверить»";
  } else if (visTest.files) {
    runBtn.title = "Файлы из visible-теста будут созданы в песочнице запуска";
  }
  actions.append(checkBtn, runBtn, el("span", "kbd", "Ctrl + Enter — проверить"));
  const out = el("div", "results");
  out.setAttribute("aria-live", "polite");

  checkBtn.onclick = doCheck;
  runBtn.onclick = () => doRun(ta.value);
  card.append(actions, out);
  if (review && review.result) {
    renderResults(out, review.result);
    if (review.finished) showSolutionBox(out, task);
  }
  checkBtn.disabled = !!(review && review.finished);

  function doCheck() {
    if (checkBtn.disabled || (review && review.finished)) return;
    if (state.py.status !== "ready") { ensurePy(); return toast("Python ещё грузится — попробуй через пару секунд"); }
    const code = ta.value;
    if (!code.trim()) return renderResults(out, { passed: false, results: [], note: "Пусто: редактор же пустой :)" });
    checkBtn.disabled = true;
    setTimeout(() => {
      if (!card.isConnected) { checkBtn.disabled = false; return; }
      try {
        const payload = { tests: task.tests, checks: task.checks, compare: task.compare };
        const res = JSON.parse(state.py.check(code, JSON.stringify(payload)));
        renderResults(out, res);
        if (review) {
          review.code = code;
          review.result = res;
          options.onCheck(res);
          if (res.passed) {
            card.classList.add("done-task");
            if (!head.querySelector(".done-badge")) head.appendChild(el("span", "done-badge", "✓ повторено"));
            showSolutionBox(out, task);
          }
          return;
        }
        if (!store.isDone(lessonData.id, task.id)) {
          store.recordReview(key, res.passed ? (attempt.hadErrors || attempt.usedHelp ? "supported" : "independent") : "wrong");
          if (!res.passed) attempt.hadErrors = true;
        }
        if (res.passed && !store.isDone(lessonData.id, task.id)) {
          store.markDone(lessonData.id, task.id);
          if (!head.querySelector(".done-badge")) head.appendChild(el("span", "done-badge", "✓ решено"));
          card.classList.add("done-task");
          celebrate(task, idx, out);
          showSolutionBox(out, task);
          renderSidebar();
          const fill = $(".lesson-head .lessonprog .fill");
          if (fill) fill.style.width = (lessonData.tasks.filter(t => store.isDone(lessonData.id, t.id)).length / lessonData.tasks.length * 100) + "%";
          maybeAdvanceLesson(lessonData);
        } else if (res.passed) {
          showSolutionBox(out, task);
        }
      } catch (e) {
        out.innerHTML = '<div class="verdict fail">Сбой проверки: ' + esc(String(e)) + "</div>";
      } finally { checkBtn.disabled = !!(review && review.finished); }
    }, 0);
  }

  function doRun(code) {
    if (state.py.status !== "ready") { ensurePy(); return toast("Python ещё грузится"); }
    const opts = {};
    if (visTest.files) opts.files = visTest.files;
    const want = Object.keys(visTest.output_files || {});
    if (want.length) opts.want_files = want;
    try {
      const res = callRun(code, stdinTa.value, opts);
      const runBox = el("div", "runout");
      if (res.ok) {
        let html = "<pre>" + (res.stdout ? esc(res.stdout.replace(/\n$/, "")) : "— программа ничего не напечатала —") + "</pre>";
        for (const fname of Object.keys(res.files || {})) {
          const body = res.files[fname];
          html += '<div class="out-label">файл ' + esc(fname) + ":</div><pre>" +
            (body == null ? "— не создан —" : esc(body)) + "</pre>";
        }
        runBox.innerHTML = html;
      } else {
        runBox.innerHTML = '<pre class="rerr">' + esc(res.error || "ошибка") + "</pre>" +
          (res.friendly ? '<div class="rfriendly">' + esc(res.friendly) + "</div>" : "");
      }
      out.innerHTML = "";
      out.appendChild(runBox);
    } catch (e) {
      toast("Запуск невозможен: " + e);
    }
  }
  return card;
}

function renderResults(out, res) {
  out.innerHTML = "";
  if (res.note) {
    out.appendChild(el("div", "verdict fail", esc(res.note)));
    return;
  }
  if (res.syntax_error) {
    out.appendChild(el("div", "verdict fail", "Синтаксис: " + esc(res.syntax_error.error) +
      (res.syntax_error.friendly ? "<br><small>" + esc(res.syntax_error.friendly) + "</small>" : "")));
    return;
  }
  if (res.checks_failed && res.checks_failed.length) {
    res.checks_failed.forEach(msg => out.appendChild(el("div", "checks-fail", "⚠️ " + esc(msg))));
  }
  const results = res.results || [];
  const nHidden = results.filter(r => !r.visible).length;
  const nVis = results.length - nHidden;

  out.appendChild(el("div", "tests-note",
    "одно нажатие «Проверить» уже прогнало <b>все</b> тесты (" + nVis + " видимых" +
    (nHidden ? " + " + nHidden + " скрытых" : "") +
    ") — переходить между тестами не нужно и некуда; задача засчитывается, когда зелёные все"));

  let visAllOk = true, hidAnyFail = false;
  const rows = [];
  results.forEach(r => {
    const row = el("div", "test-row " + (r.ok ? "ok" : "fail"));
    const io = r.visible && r.input
      ? '<span class="t-io">ввод: «' + esc(String(r.input).split("\n")[0] + (String(r.input).includes("\n") ? "…" : "")) + "»</span>"
      : (r.visible ? '<span class="t-io">ввода нет</span>' : '<span class="t-io">данные скрыты</span>');
    let inner = '<div class="t-head"><span class="t-status">' + (r.ok ? "✓" : "✗") + "</span><span>" +
      (r.visible ? "Тест-пример " + (r.index + 1) : "Скрытый тест " + (r.index + 1)) + "</span>" + io + "</div>";
    if (!r.ok) {
      if (r.visible) {
        inner += '<div class="t-detail">' + esc(r.friendly || r.detail || r.error || "вывод не совпал") + "</div>";
        if (r.expected !== null && r.expected !== undefined && r.expected !== "") {
          inner += '<div class="t-diff"><div><b>ожидалось</b>' + esc(r.expected) + "</div>" +
            "<div><b>твой вывод</b>" + esc(r.stdout == null ? "" : r.stdout) + "</div></div>";
        }
      } else {
        // скрытый тест: не показываем ни ожидаемый вывод, ни ввод (r.detail), иначе он не скрытый;
        // но ошибки ВВОДА программы (traceback, EOF, int("Пётр")) — это про код ученика, их оставляем
        if (r.error || r.friendly) {
          inner += '<div class="t-detail">' + esc(r.friendly || r.error) + "</div>";
        } else {
          inner += '<div class="t-detail">вывод не совпал на скрытых данных</div>' +
            '<div class="t-detail muted2">сверь формат до символа: регистр, пробелы, порядок строк; ' +
            "программа должна работать для любого ввода, а не только для примера</div>";
        }
      }
    }
    if (r.visible && !r.ok) visAllOk = false;
    if (!r.visible && !r.ok) hidAnyFail = true;
    row.innerHTML = inner;
    rows.push(row);
  });
  rows.forEach(r => out.appendChild(r));

  const passedN = results.filter(r => r.ok).length;
  const ok = res.passed;
  out.appendChild(el("div", "verdict " + (ok ? "pass" : "fail"),
    ok ? "🎉 Все тесты пройдены — задача засчитана!"
       : "Пройдено " + passedN + " тестов из " + results.length + " — исправь код и снова жми «Проверить»"));
  if (!ok && visAllOk && hidAnyFail) {
    out.appendChild(el("div", "coach",
      "Тест-пример проходит, а скрытые — нет. Так обычно выглядит ответ, «подогнанный» " +
      "под пример из условия: числа и имена нельзя писать в код от руки, программа должна " +
      "читать ввод и работать с любыми данными. Убедись сам: нажми «▶ Запустить на примере» " +
      "и поменяй значение в поле ввода — твой код споткнётся на первом же другом имени."));
  }
}

function celebrate(task, idx, out) {
  const btn = el("button", "btn ghost", "Следующая задача →");
  btn.onclick = () => {
    const cards = [...out.closest(".task").parentElement.querySelectorAll(".task")];
    const cur = cards[idx];
    const target = cards.slice(idx + 1).find(c => !c.classList.contains("done-task")) || cards[idx + 1];
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  if (idx < out.closest(".task").parentElement.querySelectorAll(".task").length - 1) {
    out.appendChild(btn);
  }
  toast("Задача «" + task.title + "» решена!");
}

/* ---------- урок ---------- */

function render() {
  clearTimeout(advanceTimer);
  renderSidebar();
  const main = $("#main");
  main.innerHTML = "";
  main.classList.toggle("review-main", state.view === "review");
  if (state.view === "plan") return renderPlan(main);
  if (state.view === "review") return renderReview(main);

  const stage = DATA.stages[state.stage];
  const lessonEntry = stage.lessons[state.lesson];
  const d = lessonEntry.data;

  const boot = el("div");
  boot.style.cssText = "display:flex;justify-content:flex-end;margin-bottom:-34px";
  boot.appendChild(bootPill());
  main.appendChild(boot);

  const head = el("header", "lesson-head");
  head.innerHTML =
    '<div class="kicker">' + esc(stage.title) + "</div>" +
    "<h2>" + d.order + ". " + esc(d.title) + "</h2>" +
    '<p class="sub">' + esc(d.subtitle || "") + "</p>" +
    '<div class="meta"><span>⏱ ~' + d.minutes + " мин</span><span>" + d.tasks.length + " задач(и)</span>" +
    '<div class="lessonprog"><div class="bar"><div class="fill" style="width:' +
    (d.tasks.filter(t => store.isDone(d.id, t.id)).length / d.tasks.length * 100) + '%"></div></div></div></div>';
  main.appendChild(head);

  if (d.goals && d.goals.length) {
    const g = el("div", "goals");
    g.innerHTML = "<b>Цели урока</b><ul>" + d.goals.map(x => "<li>" + md(x) + "</li>").join("") + "</ul>";
    main.appendChild(g);
  }

  main.appendChild(el("h3", "block-h", "📖 Теория"));
  const theory = el("div", "theory");
  renderTheoryBlocks(theory, d.theory);
  main.appendChild(theory);

  main.appendChild(el("h3", "block-h", "⌨️ Практика"));
  const tasksWrap = el("div", "tasks");
  d.tasks.forEach((t, i) => tasksWrap.appendChild(renderTask(d, t, i)));
  main.appendChild(tasksWrap);

  if (d.summary && d.summary.length) {
    const s = el("div", "summary-box");
    s.innerHTML = "<h3>Что запомнить</h3><ul class=\"checklist\">" +
      d.summary.map(x => "<li>" + md(x) + "</li>").join("") + "</ul>" +
      (d.further && d.further.length ? '<div class="further" style="margin-top:8px">Читать дальше: ' +
        d.further.map(f => "«" + esc(f) + "»").join(" · ") + "</div>" : "");
    main.appendChild(s);
  }

  const nav = el("div", "lesson-nav");
  const prevBtn = el("button", "btn ghost", "← предыдущий");
  const nextBtn = el("button", "btn ghost", "следующий →");
  const flat = flatLessons();
  const pos = flat.findIndex(x => x.si === state.stage && x.li === state.lesson);
  if (pos > 0) prevBtn.onclick = () => { state.stage = flat[pos - 1].si; state.lesson = flat[pos - 1].li; state.view = "lesson"; render(); window.scrollTo(0, 0); };
  else prevBtn.disabled = true;
  if (pos < flat.length - 1 && unlockedFlags()[pos + 1]) nextBtn.onclick = () => { state.stage = flat[pos + 1].si; state.lesson = flat[pos + 1].li; state.view = "lesson"; render(); window.scrollTo(0, 0); };
  else { nextBtn.disabled = true; nextBtn.title = "Сначала реши все задачи этой темы"; }
  nav.append(prevBtn, nextBtn);
  main.appendChild(nav);
}

function flatLessons() {
  const arr = [];
  DATA.stages.forEach((st, si) => st.lessons.forEach((ls, li) => arr.push({ si, li })));
  return arr;
}

/* ---------- повторение: короткие адаптивные сессии ---------- */

function continueLearning() {
  const flags = unlockedFlags();
  let pos = FLAT.findIndex((item, i) => flags[i] && !CORE.lessonComplete(item, isDone));
  if (pos < 0) pos = FLAT.length - 1;
  state.stage = FLAT[pos].si; state.lesson = FLAT[pos].li; state.view = "lesson";
  render(); closeNav(); window.scrollTo(0, 0);
}

function reviewMetric(value, label) {
  return el("div", "review-metric", '<strong>' + esc(value) + '</strong><span>' + esc(label) + '</span>');
}

function reviewCourseButton() {
  const btn = el("button", "btn ghost", "К обучению →");
  btn.onclick = continueLearning;
  return btn;
}

function renderReview(main) {
  main.classList.add("review-main");
  const pool = reviewPool();
  const topics = CORE.reviewTopics(pool, store.reviewStats());
  const top = el("div", "review-topline");
  top.append(el("span", "review-kicker", "ПРАКТИКА НА ПАМЯТЬ"), bootPill());
  main.appendChild(top);

  if (!pool.length) {
    state.review = newReviewState();
    const box = el("section", "review-empty");
    box.innerHTML = '<div class="review-orbit" aria-hidden="true">↻</div>' +
      '<h2>Сначала узнаём. Потом вспоминаем.</h2>' +
      '<p>Пройди первую тему целиком — реши все её задачи. Здесь откроется тренировка по уже знакомому материалу.</p>' +
      '<p class="review-muted">Непройденные темы в подборку не попадут.</p>';
    box.appendChild(reviewCourseButton());
    main.appendChild(box);
    return;
  }

  if (state.review.screen === "session" && state.review.session && state.review.round) {
    renderReviewSession(main);
    return;
  }
  if (state.review.screen === "summary" && state.review.session) {
    renderReviewSummary(main, topics);
    return;
  }

  if (state.review.celebration) {
    const banner = el("div", "review-unlocked");
    banner.setAttribute("role", "status");
    banner.innerHTML = '<span class="review-check" aria-hidden="true">✓</span><div><strong>Тема «' +
      esc(state.review.celebration) + '» пройдена!</strong><p>Она уже в подборке. Закрепи материал или переходи к следующей теме.</p></div>';
    banner.appendChild(reviewCourseButton());
    main.appendChild(banner);
  }

  const head = el("header", "lesson-head review-heading");
  head.innerHTML = '<h2>Что осталось в памяти?</h2><p class="sub">Немного практики, чтобы знания остались с тобой.</p>';
  main.appendChild(head);

  const totals = topics.reduce((sum, t) => ({ passed: sum.passed + t.passed, independent: sum.independent + t.independent, skipped: sum.skipped + t.skipped }),
    { passed: 0, independent: 0, skipped: 0 });
  const measured = totals.passed + totals.skipped;
  const metrics = el("div", "review-metrics");
  metrics.append(reviewMetric(topics.length, "пройдено тем"), reviewMetric(pool.length, "задач в подборке"),
    reviewMetric(measured ? Math.round(totals.independent / measured * 100) + "%" : "—", "с первой попытки, без помощи"));
  main.appendChild(metrics);

  const weakTopics = topics.filter(t => t.weak);
  const sessionCard = el("section", "review-start-card");
  const title = el("div", "review-start-title");
  title.innerHTML = '<div><span class="review-kicker">КОРОТКАЯ СЕССИЯ</span><h3>Пять задач. Чуть увереннее.</h3></div><span class="review-five" aria-hidden="true">05</span>';
  sessionCard.appendChild(title);
  sessionCard.appendChild(el("p", null, "Знакомые задачи вперемешку, но решение пишешь заново. Где сложнее — туда будем возвращаться чаще."));
  const modes = el("div", "review-modes");
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "Подбор задач");
  for (const [value, label] of [["all", "Все пройденные темы"], ["weak", "Слабые места"]]) {
    const btn = el("button", "review-mode" + (state.review.mode === value ? " selected" : ""), label);
    btn.setAttribute("aria-pressed", String(state.review.mode === value));
    btn.onclick = () => { state.review.mode = value; render(); };
    modes.appendChild(btn);
  }
  sessionCard.appendChild(modes);
  const emptyWeak = state.review.mode === "weak" && !weakTopics.length;
  sessionCard.appendChild(el("p", "review-mode-note", emptyWeak
    ? "Слабых мест пока не отмечено. Выбери все темы — первые проверки покажут, что стоит закрепить."
    : state.review.mode === "weak"
      ? "Берём темы с трудными задачами. Их список фиксируется на эту сессию; приоритеты меняются после каждой проверки."
      : "Ошибки и пропуски повышают частоту повторения. Уверенные решения снижают её; давно не встречавшиеся задачи тоже возвращаются."));
  const start = el("button", "btn primary review-start", "Начать тренировку →");
  start.disabled = emptyWeak;
  start.onclick = startReviewSession;
  sessionCard.appendChild(start);
  main.appendChild(sessionCard);
  renderReviewTopics(main, topics);
  main.appendChild(el("p", "review-footnote", "Статистика учитывает первое прохождение уроков и повторение с момента этого обновления. Чтение теории и подсказок во время тренировки не считается ошибкой, но такое решение не попадает в «с первой попытки, без помощи»."));
}

function renderReviewTopics(main, topics) {
  const header = el("div", "review-section-head");
  header.innerHTML = '<h3>Карта повторения</h3><span>Только пройденные темы</span>';
  main.appendChild(header);
  const list = el("div", "review-topics");
  for (const topic of topics) {
    const level = topic.weak ? "weak" : !topic.attempts && !topic.skipped ? "new" : topic.priority <= 1.5 ? "strong" : "learning";
    const labels = { weak: "Повторим чаще", new: "Пока нет статистики", strong: "Уверенно", learning: "Закрепляем" };
    const item = el("article", "review-topic");
    item.innerHTML = '<div><h4>' + esc(topic.title) + '</h4><p>Проверок: ' + topic.attempts +
      ' · Ошибок: ' + topic.errors + ' · Отложено: ' + topic.skipped + '</p></div>' +
      '<span class="review-tag ' + level + '">' + labels[level] + '</span>';
    list.appendChild(item);
  }
  main.appendChild(list);
}

function startReviewSession() {
  const pool = reviewPool();
  const topics = CORE.reviewTopics(pool, store.reviewStats());
  const selected = topics.filter(t => state.review.mode !== "weak" || t.weak).map(t => t.id);
  if (!selected.length) { state.review.screen = "home"; render(); return; }
  state.review.session = { goal: 5, completed: 0, passed: 0, independent: 0, errors: 0, skipped: 0, lessonIds: selected, results: [] };
  state.review.celebration = null;
  nextReviewRound();
}

function nextReviewRound() {
  const session = state.review.session;
  if (session.completed >= session.goal) {
    state.review.screen = "summary";
  } else {
    const pool = reviewPool().filter(entry => session.lessonIds.includes(entry.lesson.id));
    const entry = CORE.pickReviewTask(pool, store.reviewStats(), { recent: store.recent() });
    if (!entry) {
      state.review.screen = "summary";
    } else {
      const stat = CORE.reviewStat(store.reviewStats()[entry.key]);
      state.review.round = {
        entry, ...store.reviewDraft(entry.key), finished: false, result: null,
        reason: stat.priority >= 4 ? "Здесь было сложно — попробуем ещё" : stat.lastSeen && Date.now() - stat.lastSeen > 3 * 86400000
          ? "Давно не встречались с этой задачей" : "Закрепляем знакомое",
      };
      store.rememberReview(entry.key);
      state.review.screen = "session";
    }
  }
  state.view = "review";
  render(); window.scrollTo(0, 0);
}

function finishReviewRound(outcome) {
  const { round, session } = state.review;
  if (round.finished) return;
  round.finished = true;
  session.completed++;
  if (outcome === "skip") session.skipped++;
  else session.passed++;
  if (outcome === "independent") session.independent++;
  session.results.push({ key: round.entry.key, title: round.entry.task.title, topic: round.entry.lesson.title, outcome });
  renderSidebar();
}

function renderReviewSession(main) {
  const { round, session } = state.review;
  const { entry } = round;
  const toolbar = el("div", "review-session-toolbar");
  const end = el("button", "btn ghost", "Завершить сессию");
  end.onclick = () => { store.flush(); state.review.screen = "summary"; render(); window.scrollTo(0, 0); };
  const counter = el("span", "review-counter");
  toolbar.append(counter, end);
  main.appendChild(toolbar);
  const progress = el("div", "review-progress");
  progress.setAttribute("role", "progressbar");
  progress.setAttribute("aria-label", "Завершено задач в сессии");
  progress.setAttribute("aria-valuemin", "0");
  progress.setAttribute("aria-valuemax", String(session.goal));
  progress.innerHTML = "<span></span>";
  main.appendChild(progress);

  const context = el("header", "review-task-context");
  context.innerHTML = '<span class="review-kicker">' + esc(entry.lesson.title) + '</span><h2>Вспомни и реши</h2><p>' + esc(round.reason) + '</p>';
  main.appendChild(context);

  const theory = el("details", "review-theory");
  theory.innerHTML = '<summary>📖 Вспомнить теорию</summary>';
  const reminder = el("div", "review-reminder");
  reminder.innerHTML = '<p class="review-muted">Можно подглядеть — это нормально. Тогда закрепим задачу ещё раз.</p><ul class="checklist">' +
    (entry.lesson.summary || []).map(text => "<li>" + md(text) + "</li>").join("") + "</ul>";
  const full = el("details", "review-full-theory");
  full.innerHTML = "<summary>Открыть полную теорию с примерами</summary>";
  const content = el("div", "theory");
  renderTheoryBlocks(content, entry.lesson.theory);
  full.appendChild(content);
  reminder.appendChild(full);
  theory.appendChild(reminder);
  theory.addEventListener("toggle", () => { if (theory.open) helpUsed(); });
  main.appendChild(theory);

  const feedback = el("p", "review-feedback");
  feedback.setAttribute("aria-live", "polite");
  main.appendChild(feedback);
  const card = renderTask(entry.lesson, entry.task, entry.index, {
    round, onHelp: helpUsed,
    onCheck: res => {
      if (round.finished) return;
      if (!res.passed) {
        store.recordReview(entry.key, "wrong");
        round.hadErrors = true;
        session.errors++;
        store.setReviewDraft(round);
        store.flush();
      } else {
        const outcome = round.hadErrors || round.usedHelp ? "supported" : "independent";
        store.recordReview(entry.key, outcome);
        store.clearReviewDraft(entry.key);
        finishReviewRound(outcome);
      }
      updateStatus();
    },
  });
  card.classList.add("review-task");
  main.appendChild(card);

  const controls = el("div", "review-controls");
  const skip = el("button", "btn ghost review-skip", "Не помню — повторить позже");
  skip.onclick = () => {
    if (round.finished) return;
    round.hadErrors = true;
    store.setReviewDraft(round);
    store.recordReview(entry.key, "skip");
    finishReviewRound("skip");
    nextReviewRound();
  };
  const next = el("button", "btn primary review-next", "Следующая задача →");
  next.onclick = () => { if (round.finished) nextReviewRound(); };
  controls.append(skip, next);
  const stats = el("p", "review-session-stats");
  main.append(controls, stats);
  updateStatus();

  function helpUsed() {
    if (round.finished) return;
    round.usedHelp = true;
    store.setReviewDraft(round);
    store.flush();
    updateStatus();
  }
  function updateStatus() {
    counter.textContent = "Задача " + (session.completed + (round.finished ? 0 : 1)) + " из " + session.goal;
    progress.setAttribute("aria-valuenow", String(session.completed));
    progress.firstChild.style.width = (session.completed / session.goal * 100) + "%";
    skip.disabled = round.finished;
    next.disabled = !round.finished;
    next.textContent = session.completed >= session.goal ? "Посмотреть итог →" : "Следующая задача →";
    feedback.textContent = round.finished ? (round.hadErrors || round.usedHelp
      ? "Разобрались! Вернёмся к задаче ещё раз, чтобы закрепить."
      : "С первой попытки и без помощи — отлично помнишь!")
      : round.hadErrors ? "Ошибка — это подсказка, что повторить. Исправь код или загляни в теорию."
      : round.usedHelp ? "Теория или подсказка использована. Решай спокойно — закрепим ещё раз."
      : "Пиши по памяти. Старое решение из урока сюда не подставляется.";
    stats.textContent = "В этой сессии: самостоятельно с первого раза — " + session.independent +
      " · Ошибок — " + session.errors + " · Отложено — " + session.skipped;
  }
}

function renderReviewSummary(main, topics) {
  const session = state.review.session;
  const box = el("section", "review-summary");
  box.innerHTML = '<div class="review-orbit" aria-hidden="true">✓</div><span class="review-kicker">' +
    (session.completed >= session.goal ? "СЕССИЯ ЗАВЕРШЕНА" : "МОЖНО ПРОДОЛЖИТЬ В ДРУГОЙ РАЗ") +
    '</span><h2>' + (session.completed ? "Ещё немного практики — в копилку." : "Вернёмся, когда будет удобно.") + '</h2>' +
    '<p>Ошибки не отменяют пройденные уроки. Они помогают подобрать следующую тренировку.</p>';
  const metrics = el("div", "review-metrics");
  metrics.append(reviewMetric(session.passed + " / " + session.goal, "задач решено"),
    reviewMetric(session.independent, "с первого раза, без помощи"), reviewMetric(session.errors, "ошибочных проверок"));
  box.appendChild(metrics);
  const list = el("ol", "review-session-results");
  for (const result of session.results) {
    const names = { independent: "Самостоятельно", supported: "Закрепим ещё раз", skip: "Повторим позже" };
    const item = el("li", result.outcome);
    item.innerHTML = '<div><strong>' + esc(result.title) + '</strong><small>' + esc(result.topic) + '</small></div><span>' + names[result.outcome] + '</span>';
    list.appendChild(item);
  }
  box.appendChild(list);
  const actions = el("div", "review-summary-actions");
  const again = el("button", "btn primary", "Ещё 5 задач →");
  again.onclick = () => {
    if (state.review.mode === "weak" && !topics.some(t => t.weak)) state.review.mode = "all";
    startReviewSession();
  };
  const home = el("button", "btn ghost", "Карта повторения");
  home.onclick = () => { state.review.screen = "home"; render(); window.scrollTo(0, 0); };
  actions.append(again, home, reviewCourseButton());
  box.appendChild(actions);
  main.appendChild(box);
  if (session.skipped) main.appendChild(el("p", "review-footnote", "Отложено задач: " + session.skipped + ". Они получили повышенный приоритет. Незавершённый черновик сохранён отдельно от решения в уроке."));
}

/* ---------- план ---------- */

function renderPlan(main) {
  const head = el("header", "lesson-head");
  head.innerHTML = '<div class="kicker">PYTHON_PLAN.txt</div><h2>Мой план обучения</h2>' +
    '<p class="sub">Единственный источник правды: чеклисты, сроки, дневник. Отмечать прогресс — в файле (правила в разделе 10).</p>';
  main.appendChild(head);
  main.appendChild(el("div", "plan-note", "Это представление файла из репозитория: здесь только читать, отмечать [x] нужно руками в PYTHON_PLAN.txt после того, как написал тему собственными руками без подсказок. ✅"));
  const box = el("div", "plan");
  const lines = DATA.plan.split("\n");
  const html = lines.map(line => {
    let l = esc(line);
    if (/^={3,}/.test(line) || /^-{3,}/.test(line)) return l;
    l = l.replace(/\[x\]/g, '<span class="chx-done">[x]</span>').replace(/\[ \]/g, '<span class="chx-todo">[ ]</span>');
    if (/^\s*\d+(\.\d+)?\.?\s+\S/.test(line) && line.length < 95) l = '<span class="sec">' + l + "</span>";
    return l;
  }).join("\n");
  box.innerHTML = "<pre>" + html + "</pre>";
  main.appendChild(box);
}

/* ---------- pyodide ---------- */

function bootPill() {
  const p = el("div", "bootpill " + state.py.status);
  const s = { idle: "python: ждёт запуска", loading: "python: загрузка… (~10 МБ, один раз)", ready: "python: готов — проверки работают", error: "python не загрузился (нужен интернет). <span class=\"retry\">повторить</span>" };
  p.innerHTML = '<span class="dot"></span>' + s[state.py.status];
  if (state.py.status === "error") p.querySelector(".retry").onclick = () => { state.py.status = "idle"; ensurePy(); render(); };
  return p;
}

function ensurePy() {
  if (state.py.status !== "idle") return;
  state.py.status = "loading";
  renderBootPills();
  const s = document.createElement("script");
  s.src = DATA.pyodide.cdn + "pyodide.js";
  s.onload = async () => {
    try {
      const py = await window.loadPyodide({ indexURL: DATA.pyodide.cdn });
      py.runPython(DATA.harness);
      state.py = {
        status: "ready", pyodide: py,
        check: py.globals.get("check_task_json"),
        run: py.globals.get("run_program_json"),
      };
    } catch (e) {
      state.py = { status: "error", err: String(e) };
    }
    renderBootPills();
  };
  s.onerror = () => { state.py = { status: "error", err: "cdn недоступен" }; renderBootPills(); };
  document.head.appendChild(s);
}

function renderBootPills() { document.querySelectorAll(".bootpill").forEach(n => n.replaceWith(bootPill())); }
function callRun(code, stdin, opts) {
  const o = Object.assign({ echo_prompts: true }, opts || {});
  return JSON.parse(state.py.run(code, stdin || "", JSON.stringify(o)));
}

function showSolutionBox(out, task) {
  if (!task.solution || out.querySelector(".solution-box")) return;
  const box = el("div", "solution-box");
  const btn = el("button", "tiny-btn", "👀 эталонное решение — сравни со своим");
  const pre = document.createElement("pre");
  pre.innerHTML = "<code>" + highlightPy(task.solution) + "</code>";
  pre.style.display = "none";
  btn.onclick = () => { pre.style.display = pre.style.display === "none" ? "block" : "none"; };
  box.append(btn, pre);
  out.appendChild(box);
}

/* Все задачи темы решены → предлагаем закрепить материал, не блокируя курс. */
function maybeAdvanceLesson(lessonData) {
  const pos = flatPos();
  if (state.view !== "lesson" || pos < 0 || FLAT[pos].id !== lessonData.id) return;
  if (!CORE.lessonComplete(FLAT[pos], isDone)) return;
  toast("Тема «" + lessonData.title + "» пройдена! Открываю повторение");
  clearTimeout(advanceTimer);
  advanceTimer = setTimeout(() => {
    if (state.view !== "lesson" || flatPos() !== pos || !CORE.lessonComplete(FLAT[pos], isDone)) return;
    state.review = newReviewState();
    state.review.celebration = lessonData.title;
    state.view = "review";
    render();
    window.scrollTo(0, 0);
  }, 1600);
}

/* ---------- мелочи ---------- */

let toastTimer = null;
function toast(text) {
  document.querySelectorAll(".toast").forEach(n => n.remove());
  const t = el("div", "toast", esc(text));
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2600);
}

$("#burger").onclick = () => document.body.classList.toggle("nav-open");
function closeNav() { document.body.classList.remove("nav-open"); }

render();
ensurePy();
