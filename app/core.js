"use strict";
/*
 * core.js — чистая логика тренажёра без DOM.
 * Вынесено отдельно, чтобы проверяться автотестом (node) без браузера:
 * «урок засчитан при 3/3» и «следующая тема открывается» — здесь.
 */
window.PypathCore = (function () {

  /* Плоский список уроков: [{si, li, id, taskIds:[...]}, ...] в порядке следования. */
  function makeIndex(stages) {
    const flat = [];
    stages.forEach((st, si) => st.lessons.forEach((ls, li) => {
      flat.push({ si, li, id: ls.data.id, taskIds: ls.data.tasks.map(t => t.id) });
    }));
    return flat;
  }

  /* Урок засчитан, если решены ВСЕ его задачи (порядок внутри урока — любой). */
  function lessonComplete(item, isDone) {
    return item.taskIds.length > 0 && item.taskIds.every(tid => isDone(item.id, tid));
  }

  /*
   * Линейная разблокировка: открыт первый урок и всё, что идёт после
   * полностью засчитанных уроков.
   */
  function unlockedFlags(flat, isDone) {
    const flags = [];
    let open = true;
    for (let i = 0; i < flat.length; i++) {
      flags.push(open);
      open = open && lessonComplete(flat[i], isDone);
    }
    return flags;
  }

  /* Позиция, куда отправить ученика, когда он закончил урок; -1 — конец. */
  function nextLesson(flat, isDone, pos) {
    if (pos + 1 < flat.length && unlockedFlags(flat, isDone)[pos + 1]) return pos + 1;
    return -1;
  }

  /* Первая незакрытая задача текущего урока (для кнопки «Следующая задача»). */
  function firstOpenTask(item, isDone) {
    return item.taskIds.findIndex(tid => !isDone(item.id, tid));
  }

  /* ---------- адаптивное повторение ---------- */

  const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const count = value => Number.isFinite(value) ? Math.max(0, Math.min(1e9, Math.floor(value))) : 0;
  const taskKey = (lid, tid) => lid + ":" + tid;

  function reviewStat(value) {
    const s = isRecord(value) ? value : {};
    const attempts = count(s.attempts);
    const passed = Math.min(attempts, count(s.passed));
    const independent = Math.min(passed, count(s.independent));
    return {
      attempts, errors: Math.min(attempts - passed, count(s.errors)), passed,
      independent, skipped: count(s.skipped), streak: Math.min(independent, count(s.streak)),
      priority: Number.isFinite(s.priority) ? Math.max(0.5, Math.min(12, s.priority)) : 3,
      lastSeen: Number.isFinite(s.lastSeen) ? Math.max(0, s.lastSeen) : 0,
    };
  }

  /* Одна ошибка = одна неуспешная проверка, а не число упавших тестов.
   * supported — решение после ошибки, подсказки или обращения к теории.
   * Успех учитывается только один раз за карточку (это гарантирует интерфейс).
   * Старые ошибки не остаются вечным штрафом: чистые решения снижают приоритет.
   */
  function applyReviewResult(value, outcome, now = Date.now()) {
    const s = reviewStat(value);
    if (!["wrong", "independent", "supported", "skip"].includes(outcome)) return s;
    s.lastSeen = Math.max(s.lastSeen, Number.isFinite(now) ? now : 0);
    if (outcome === "skip") {
      s.skipped++;
      s.streak = 0;
      s.priority = Math.min(12, s.priority + 2);
      return s;
    }
    s.attempts++;
    if (outcome === "wrong") {
      s.errors++;
      s.streak = 0;
      s.priority = Math.min(12, s.priority + 2);
    } else {
      s.passed++;
      if (outcome === "independent") {
        s.independent++;
        s.streak++;
        s.priority = Math.max(0.5, s.priority * 0.6);
      } else {
        s.streak = 0;
        s.priority = Math.max(2, s.priority * 0.9);
      }
    }
    return s;
  }

  /* Только полностью пройденные И открытые по порядку темы. */
  function reviewPool(stages, isDone) {
    const flat = makeIndex(stages);
    const flags = unlockedFlags(flat, isDone);
    return flat.flatMap((item, pos) => {
      if (!flags[pos] || !lessonComplete(item, isDone)) return [];
      const lesson = stages[item.si].lessons[item.li].data;
      return lesson.tasks.map((task, index) => ({
        key: taskKey(lesson.id, task.id), lesson, task, index, si: item.si, li: item.li,
      }));
    });
  }

  function reviewTopics(pool, stats = {}) {
    const groups = new Map();
    pool.forEach(entry => {
      if (!groups.has(entry.lesson.id)) groups.set(entry.lesson.id, {
        id: entry.lesson.id, title: entry.lesson.title, tasks: 0, priority: 0,
        attempts: 0, errors: 0, passed: 0, independent: 0, skipped: 0, weak: false,
      });
      const topic = groups.get(entry.lesson.id);
      const s = reviewStat(stats[entry.key]);
      topic.tasks++;
      topic.priority += s.priority;
      for (const field of ["attempts", "errors", "passed", "independent", "skipped"]) topic[field] += s[field];
      topic.weak = topic.weak || s.priority >= 4;
    });
    return [...groups.values()].map(topic => ({ ...topic, priority: topic.priority / topic.tasks }));
  }

  /* Взвешенная случайная выборка: трудная задача + трудная тема + давность.
   * Все допущенные задачи имеют ненулевой шанс; последняя исключается,
   * предпоследняя получает меньший вес (иначе банк из трёх задач превратится в цикл).
   * RNG/время передаются в тестах, чтобы тесты не зависели от удачи.
   */
  function pickReviewTask(pool, stats = {}, { recent = [], random = Math.random, now = Date.now() } = {}) {
    if (!pool.length) return null;
    let candidates = pool.filter(entry => entry.key !== recent[recent.length - 1]);
    if (!candidates.length) candidates = pool;
    const topics = new Map(reviewTopics(pool, stats).map(topic => [topic.id, topic]));
    const weights = candidates.map(entry => {
      const s = reviewStat(stats[entry.key]);
      const age = s.lastSeen ? Math.min(3, Math.max(0, now - s.lastSeen) / 86400000 * 0.3) : 2;
      const recentPenalty = entry.key === recent[recent.length - 2] ? 0.6 : 1;
      return (s.priority + topics.get(entry.lesson.id).priority * 0.5 + age) * recentPenalty;
    });
    const sample = random();
    let target = (Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0) * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < candidates.length; i++) {
      target -= weights[i];
      if (target < 0) return candidates[i];
    }
    return candidates[candidates.length - 1];
  }

  /* v1-бэкапы без review остаются совместимыми. Импорт не принимает массивы,
   * служебные ключи и неверные типы; входной объект никогда не изменяется.
   */
  function normalizeProgress(value) {
    if (!isRecord(value) || !isRecord(value.done) || !isRecord(value.drafts)) return null;
    const validKey = key => /^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/.test(key);
    const map = (object, valid, convert = x => x) => Object.fromEntries(
      Object.entries(isRecord(object) ? object : {}).filter(([key, val]) => validKey(key) && valid(val))
        .map(([key, val]) => [key, convert(val)]));
    const review = isRecord(value.review) ? value.review : {};
    return {
      done: map(value.done, v => v === true),
      drafts: map(value.drafts, v => typeof v === "string"),
      review: {
        stats: map(review.stats, isRecord, reviewStat),
        drafts: map(review.drafts, isRecord, d => ({
          code: typeof d.code === "string" ? d.code : "",
          hadErrors: d.hadErrors === true, usedHelp: d.usedHelp === true,
        })),
        recent: Array.isArray(review.recent) ? review.recent.filter(k => typeof k === "string" && validKey(k)).slice(-2) : [],
      },
    };
  }

  return {
    makeIndex, lessonComplete, unlockedFlags, nextLesson, firstOpenTask,
    taskKey, reviewStat, applyReviewResult, reviewPool, reviewTopics, pickReviewTask, normalizeProgress,
  };
})();
