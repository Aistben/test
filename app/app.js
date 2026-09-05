"use strict";
/*
 * pypath-тренажёр — клиентское приложение.
 * Все данные (уроки, тесты, harness.py) вшиты в app/data.js генератором
 * tools/build_site.py. Проверка решений выполняется harness'ом на Pyodide
 * (тот же код, что у tools/validate_lessons.py) — «прошло здесь == пройдёт в тренажёре».
 */

const DATA = window.PY_TRAINER_DATA;
if (!DATA) throw new Error("app/data.js не найден — запусти python3 tools/build_site.py");

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
  try { data = JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) { data = null; }
  if (!data || typeof data !== "object") data = { done: {}, drafts: {} };
  if (!data.done) data.done = {};
  if (!data.drafts) data.drafts = {};
  let timer = null;
  return {
    isDone: (lid, tid) => !!data.done[lid + ":" + tid],
    markDone: (lid, tid) => { data.done[lid + ":" + tid] = true; save(); },
    draft: (lid, tid) => data.drafts[lid + ":" + tid] || "",
    setDraft: (lid, tid, code) => {
      data.drafts[lid + ":" + tid] = code;
      clearTimeout(timer); timer = setTimeout(save, 350);
    },
    reset: () => { data = { done: {}, drafts: {} }; save(); },
  };
  function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (e) { /* приватный режим */ } }
})();

const ALL_TASKS = [];
DATA.stages.forEach(st => st.lessons.forEach(ls => {
  ls.data.tasks.forEach(t => ALL_TASKS.push({ stage: st, lesson: ls, task: t }));
}));
const doneCount = () => ALL_TASKS.filter(x => store.isDone(x.lesson.data.id, x.task.id)).length;

const state = { stage: 0, lesson: 0, view: "lesson", py: { status: "idle" } };

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

  DATA.stages.forEach((st, si) => {
    side.appendChild(el("div", "stage-title", esc(st.title)));
    st.lessons.forEach((ls, li) => {
      const d = ls.data;
      const nDone = d.tasks.filter(t => store.isDone(d.id, t.id)).length;
      const btn = el("button", "lesson-item" + (nDone === d.tasks.length ? " complete" : ""));
      if (state.view === "lesson" && state.stage === si && state.lesson === li) btn.classList.add("active");
      btn.innerHTML =
        '<span class="num">' + (nDone === d.tasks.length ? "✓" : d.order) + "</span>" +
        '<span class="name">' + esc(d.title) + "</span>" +
        '<span class="frac">' + nDone + "/" + d.tasks.length + "</span>";
      btn.onclick = () => { state.view = "lesson"; state.stage = si; state.lesson = li; render(); closeNav(); };
      side.appendChild(btn);
    });
  });

  const planBtn = el("button", "side-btn" + (state.view === "plan" ? " active" : ""), "📋 Мой план обучения");
  planBtn.onclick = () => { state.view = "plan"; render(); closeNav(); };
  side.appendChild(planBtn);

  const foot = el("div", "side-foot");
  const reset = el("button", "side-btn", "↺ сбросить прогресс");
  reset.onclick = () => {
    if (confirm("Сбросить отметки о решённых задачах и все черновики кода?")) { store.reset(); render(); }
  };
  foot.appendChild(reset);
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
    await Promise.all(["app/app.css", "app/app.js", "app/data.js"].map(
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

function renderTask(lessonData, task, idx) {
  const card = el("section", "task" + (store.isDone(lessonData.id, task.id) ? " done-task" : ""));
  card.id = "task-" + task.id;

  const head = el("div", "task-head");
  head.innerHTML =
    "<h4>Задача " + (idx + 1) + " · " + esc(task.title) + "</h4>" +
    '<span class="diff" title="сложность">' + "●".repeat(task.difficulty) + "○".repeat(3 - task.difficulty) + "</span>" +
    (store.isDone(lessonData.id, task.id) ? '<span class="done-badge">✓ решено</span>' : "");
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
    card.appendChild(det);
  }

  const editor = el("div", "editor");
  const ta = document.createElement("textarea");
  ta.spellcheck = false;
  ta.value = store.draft(lessonData.id, task.id) || "";
  ta.placeholder = "# пиши решение здесь…";
  ta.addEventListener("input", () => store.setDraft(lessonData.id, task.id, ta.value));
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const s = ta.selectionStart, t = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + "    " + ta.value.slice(t);
      ta.selectionStart = ta.selectionEnd = s + 4;
      store.setDraft(lessonData.id, task.id, ta.value);
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doCheck(); }
  });
  editor.appendChild(ta);
  card.appendChild(editor);

  const actions = el("div", "task-actions");
  const checkBtn = el("button", "btn primary", "Проверить");
  const runBtn = el("button", "btn ghost", "▶ Запустить");
  actions.append(checkBtn, runBtn, el("span", "kbd", "Ctrl + Enter — проверить"));
  const out = el("div", "results");
  actions.appendChild(out);

  const needsFiles = (task.tests || []).some(t => t.files || t.code_before || t.code_after);
  if (needsFiles) runBtn.title = "В задаче участвуют тестовые файлы/проверочный код — используй «Проверить»";
  checkBtn.onclick = doCheck;
  runBtn.onclick = () => doRun(ta.value);
  card.append(actions, out);

  function doCheck() {
    if (state.py.status !== "ready") { ensurePy(); return toast("Python ещё грузится — попробуй через пару секунд"); }
    const code = ta.value;
    if (!code.trim()) return renderResults(out, { passed: false, results: [], note: "Пусто: редактор же пустой :)" });
    checkBtn.disabled = true;
    setTimeout(() => {
      try {
        const payload = { tests: task.tests, checks: task.checks, compare: task.compare };
        const res = JSON.parse(state.py.check(code, JSON.stringify(payload)));
        renderResults(out, res);
        if (res.passed && !store.isDone(lessonData.id, task.id)) {
          store.markDone(lessonData.id, task.id);
          if (!head.querySelector(".done-badge")) head.appendChild(el("span", "done-badge", "✓ решено"));
          card.classList.add("done-task");
          celebrate(task, idx, out);
          renderSidebar();
        }
      } catch (e) {
        out.innerHTML = '<div class="verdict fail">Сбой проверки: ' + esc(String(e)) + "</div>";
      } finally { checkBtn.disabled = false; }
    }, 0);
  }

  function doRun(code) {
    if (state.py.status !== "ready") { ensurePy(); return toast("Python ещё грузится"); }
    try {
      const res = callRun(code, "");
      const runBox = el("div", "runout");
      if (res.ok) {
        runBox.innerHTML = "<pre>" + (res.stdout ? esc(res.stdout.replace(/\n$/, "")) : "— программа ничего не напечатала —") + "</pre>";
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
  const rows = [];
  let passedN = 0;
  (res.results || []).forEach(r => {
    if (r.ok) passedN++;
    const row = el("div", "test-row " + (r.ok ? "ok" : "fail"));
    let inner = '<div class="t-head"><span class="t-status">' + (r.ok ? "✓" : "✗") + "</span><span>" +
      (r.visible ? "Тест " + (r.index + 1) : "Скрытый тест " + (r.index + 1)) + "</span></div>";
    if (!r.ok) {
      inner += '<div class="t-detail">' + esc(r.friendly || r.detail || r.error || "не прошло") + "</div>";
      if (r.expected !== null && r.expected !== undefined && r.expected !== "") {
        inner += '<div class="t-diff"><div><b>ожидалось</b>' + esc(r.expected) + "</div>" +
          "<div><b>твой вывод</b>" + esc(r.stdout == null ? "" : r.stdout) + "</div></div>";
      }
    }
    row.innerHTML = inner;
    rows.push(row);
  });
  rows.forEach(r => out.appendChild(r));
  const ok = res.passed;
  out.appendChild(el("div", "verdict " + (ok ? "pass" : "fail"),
    ok ? "🎉 Все тесты пройдены — задача засчитана!" : "Пока не проходит: " + passedN + "/" + (res.results || []).length + " тестов"));
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
  renderSidebar();
  const main = $("#main");
  main.innerHTML = "";
  if (state.view === "plan") return renderPlan(main);

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
  if (pos < flat.length - 1) nextBtn.onclick = () => { state.stage = flat[pos + 1].si; state.lesson = flat[pos + 1].li; state.view = "lesson"; render(); window.scrollTo(0, 0); };
  else nextBtn.disabled = true;
  nav.append(prevBtn, nextBtn);
  main.appendChild(nav);
}

function flatLessons() {
  const arr = [];
  DATA.stages.forEach((st, si) => st.lessons.forEach((ls, li) => arr.push({ si, li })));
  return arr;
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
function callRun(code, stdin) {
  return JSON.parse(state.py.run(code, stdin || "", JSON.stringify({ echo_prompts: true })));
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
