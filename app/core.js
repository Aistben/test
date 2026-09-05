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

  return { makeIndex, lessonComplete, unlockedFlags, nextLesson, firstOpenTask };
})();
