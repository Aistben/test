/* node tools/test_review.mjs — без npm, браузера и сети. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const win = {};
for (const name of ["core", "data"]) {
  new Function("window", readFileSync(new URL(`../app/${name}.js`, import.meta.url), "utf8"))(win);
}
const C = win.PypathCore;
const stages = win.PY_TRAINER_DATA.stages;
const flat = C.makeIndex(stages);
const now = 1788696000000;
const mark = (done, index) => flat[index].taskIds.forEach(tid => done.add(C.taskKey(flat[index].id, tid)));
const poolFor = done => C.reviewPool(stages, (lid, tid) => done.has(C.taskKey(lid, tid)));
const allDone = new Set();
flat.forEach((_, index) => mark(allDone, index));
const pool = poolFor(allDone);

function repeat(outcomes) {
  return outcomes.reduce((stat, outcome, i) => C.applyReviewResult(stat, outcome, now + i), undefined);
}
function rng(seed = 41) {
  return () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
}

test("повторение закрыто до полного прохождения первой темы", () => {
  const done = new Set();
  assert.equal(poolFor(done).length, 0);
  flat[0].taskIds.slice(0, -1).forEach(tid => done.add(C.taskKey(flat[0].id, tid)));
  assert.equal(poolFor(done).length, 0);
  mark(done, 0);
  assert.equal(poolFor(done).length, flat[0].taskIds.length);
  assert.ok(poolFor(done).every(entry => entry.lesson.id === flat[0].id));
});

test("полностью отмеченная, но закрытая по порядку тема не попадает в подборку", () => {
  const done = new Set();
  mark(done, 2);
  assert.equal(poolFor(done).length, 0);
  mark(done, 0);
  assert.ok(poolFor(done).every(entry => entry.lesson.id === flat[0].id));
  mark(done, 1);
  assert.equal(new Set(poolFor(done).map(entry => entry.lesson.id)).size, 3);
});

test("все пройденные темы дают весь банк без дублей и без изменения данных", () => {
  const before = JSON.stringify(stages);
  assert.equal(pool.length, flat.reduce((n, lesson) => n + lesson.taskIds.length, 0));
  assert.equal(new Set(pool.map(entry => entry.key)).size, pool.length);
  assert.ok(pool.every(entry => entry.task.tests.length && entry.lesson.theory.length));
  assert.equal(JSON.stringify(stages), before);
});

test("одна ошибочная проверка — одна ошибка, приоритет растёт", () => {
  const initial = C.reviewStat();
  const next = C.applyReviewResult(initial, "wrong", now);
  assert.deepEqual(initial, C.reviewStat());
  assert.equal(next.attempts, 1);
  assert.equal(next.errors, 1);
  assert.equal(next.passed, 0);
  assert.ok(next.priority > initial.priority);
  assert.equal(next.lastSeen, now);
});

test("чистые решения снижают приоритет; старые ошибки не вечный штраф", () => {
  const weak = repeat(["wrong", "wrong", "supported"]);
  assert.ok(weak.priority >= 4);
  assert.equal(weak.independent, 0);
  const strong = Array.from({ length: 12 }).reduce(s => C.applyReviewResult(s, "independent", now + 20), weak);
  assert.equal(strong.errors, 2);
  assert.equal(strong.passed, 13);
  assert.equal(strong.independent, 12);
  assert.ok(strong.priority < 1);
  assert.ok(strong.streak > 0);
});

test("помощь не ошибка, но не самостоятельное решение; пропуск не проверка", () => {
  const supported = repeat(["supported"]);
  assert.equal(supported.errors, 0);
  assert.equal(supported.passed, 1);
  assert.equal(supported.independent, 0);
  const skipped = C.applyReviewResult(supported, "skip", now + 1);
  assert.equal(skipped.attempts, 1);
  assert.equal(skipped.passed, 1);
  assert.equal(skipped.errors, 0);
  assert.equal(skipped.skipped, 1);
  assert.ok(skipped.priority > supported.priority);
});

test("приоритет ограничен, часы назад и неизвестный результат безопасны", () => {
  const high = repeat(Array(40).fill("wrong"));
  const low = repeat(Array(40).fill("independent"));
  assert.equal(high.priority, 12);
  assert.equal(low.priority, 0.5);
  assert.deepEqual(C.applyReviewResult(low, "unknown", now + 100), low);
  assert.equal(C.applyReviewResult(high, "wrong", 0).lastSeen, high.lastSeen);
});

test("пустой банк, единственная задача и крайние RNG корректны", () => {
  assert.equal(C.pickReviewTask([]), null);
  const one = pool.slice(0, 1);
  assert.equal(C.pickReviewTask(one, {}, { recent: [one[0].key] }), one[0]);
  assert.equal(C.pickReviewTask(pool, {}, { random: () => 0 }), pool[0]);
  assert.equal(C.pickReviewTask(pool, {}, { random: () => 1 }), pool.at(-1));
  assert.equal(C.pickReviewTask(pool, {}, { random: () => NaN }), pool[0]);
});

test("задача не идёт два раза подряд; банк из трёх не превращается в фиксированный цикл", () => {
  const two = pool.slice(0, 2);
  assert.equal(C.pickReviewTask(two, {}, { recent: two.map(e => e.key) }), two[0]);
  const three = pool.slice(0, 3);
  const shortHistory = three.slice(0, 2).map(e => e.key);
  assert.equal(C.pickReviewTask(three, {}, { recent: shortHistory, random: () => 0 }), three[0]);
  assert.equal(C.pickReviewTask(three, {}, { recent: shortHistory, random: () => 0.999 }), three[2]);
  const random = rng();
  const recent = [];
  for (let i = 0; i < 100; i++) {
    const picked = C.pickReviewTask(pool, {}, { recent, random, now });
    assert.notEqual(recent.at(-1), picked.key);
    recent.push(picked.key);
  }
});

test("слабая тема выбирается заметно чаще, но сильная не исчезает", () => {
  const candidates = pool.filter(e => [flat[0].id, flat[1].id].includes(e.lesson.id));
  const stats = Object.fromEntries(candidates.map(entry => [entry.key,
    entry.lesson.id === flat[0].id ? repeat(Array(5).fill("wrong")) : repeat(Array(8).fill("independent"))]));
  const topics = C.reviewTopics(candidates, stats);
  assert.equal(topics[0].weak, true);
  assert.equal(topics[1].weak, false);
  let weak = 0, strong = 0;
  const random = rng();
  for (let i = 0; i < 5000; i++) {
    const chosen = C.pickReviewTask(candidates, stats, { random, now });
    if (chosen.lesson.id === flat[0].id) weak++;
    else strong++;
  }
  assert.ok(weak > strong * 3, `weak=${weak}, strong=${strong}`);
  assert.ok(strong > 0);
});

test("после одной темы слабая задача тоже повторяется чаще, даже с защитой от повторов подряд", () => {
  const candidates = pool.slice(0, 3);
  const stats = Object.fromEntries(candidates.map((entry, i) => [entry.key,
    repeat(Array(8).fill(i === 0 ? "wrong" : "independent"))]));
  const picks = [0, 0, 0];
  const random = rng();
  let recent = [];
  for (let i = 0; i < 5000; i++) {
    const next = C.pickReviewTask(candidates, stats, { recent, random, now });
    assert.notEqual(next.key, recent.at(-1));
    picks[candidates.indexOf(next)]++;
    recent = [...recent, next.key].slice(-2);
  }
  assert.ok(picks[0] > picks[1] * 1.25 && picks[0] > picks[2] * 1.25, String(picks));
});

test("давно не встречавшаяся задача получает больший шанс", () => {
  const candidates = pool.slice(0, 2);
  const base = repeat(["independent"]);
  const stats = { [candidates[0].key]: { ...base, lastSeen: now - 30 * 86400000 }, [candidates[1].key]: base };
  let older = 0;
  const random = rng();
  for (let i = 0; i < 3000; i++) {
    if (C.pickReviewTask(candidates, stats, { random, now }) === candidates[0]) older++;
  }
  assert.ok(older > 1800);
});

test("старый v1-бэкап сохраняет зачёты и черновики, статистика начинается с нуля", () => {
  const key = pool[0].key;
  const legacy = { app: "pypath", v: 1, done: { [key]: true }, drafts: { [key]: "print('черновик')" } };
  const copy = structuredClone(legacy);
  const result = C.normalizeProgress(legacy);
  assert.deepEqual(result.done, legacy.done);
  assert.deepEqual(result.drafts, legacy.drafts);
  assert.deepEqual(result.review, { stats: {}, drafts: {}, recent: [] });
  assert.deepEqual(legacy, copy);
});

test("v2 проходит экспорт/импорт, черновики повторения отделены от курса", () => {
  const key = pool[0].key;
  const progress = C.normalizeProgress({ done: { [key]: true }, drafts: { [key]: "course solution" }, review: {
    stats: { [key]: repeat(["wrong", "supported"]) },
    drafts: { [key]: { code: "practice draft", hadErrors: true, usedHelp: true } }, recent: [key],
  } });
  assert.deepEqual(C.normalizeProgress(JSON.parse(JSON.stringify(progress))), progress);
  assert.equal(progress.drafts[key], "course solution");
  assert.equal(progress.review.drafts[key].code, "practice draft");
  const done = structuredClone(progress.done);
  C.applyReviewResult(progress.review.stats[key], "wrong", now);
  assert.deepEqual(progress.done, done);
});

test("повреждённые бэкапы и нечисловые счётчики не ломают приложение", () => {
  for (const bad of [null, [], "x", {}, { done: [], drafts: {} }, { done: {}, drafts: [] }]) {
    assert.equal(C.normalizeProgress(bad), null);
  }
  const key = pool[0].key;
  const bad = JSON.parse('{"done":{"__proto__":true},"drafts":{"constructor":"x"},"review":{}}');
  assert.deepEqual(C.normalizeProgress(bad), C.normalizeProgress({ done: {}, drafts: {} }));
  const cleaned = C.normalizeProgress({ done: { [key]: "false" }, drafts: { [key]: [] }, review: {
    stats: { [key]: { attempts: 1, passed: 900, independent: 999, errors: 99, priority: "oops", lastSeen: -4 } },
    drafts: { [key]: { code: 42, usedHelp: "yes", hadErrors: true } }, recent: [null, 42, "constructor", key],
  } });
  assert.deepEqual(cleaned.done, {});
  assert.deepEqual(cleaned.drafts, {});
  assert.equal(cleaned.review.stats[key].independent, 1);
  assert.equal(cleaned.review.stats[key].errors, 0);
  assert.equal(cleaned.review.stats[key].priority, 3);
  assert.equal(cleaned.review.stats[key].lastSeen, 0);
  assert.deepEqual(cleaned.review.recent, [key]);
  assert.deepEqual(cleaned.review.drafts[key], { code: "", hadErrors: true, usedHelp: false });
});
