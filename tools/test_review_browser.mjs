/*
 * Сквозная проверка интерфейса с настоящим Pyodide (не подменяет проверки задач).
 * Сначала запусти статический сервер на порту 8000. Установка тестовых зависимостей
 * и запуск описаны в README. Все данные пишутся в изолированный профиль Chromium.
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, basename } from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const base = process.env.BASE_URL || "http://127.0.0.1:8000";
const pyodidePath = dirname(require.resolve("pyodide"));
const launch = { headless: true };
if (process.env.CHROMIUM_EXECUTABLE) launch.executablePath = process.env.CHROMIUM_EXECUTABLE;
else {
  // В урезанной Linux-песочнице браузер и NSS можно взять из npm, без apt.
  let packagedPath;
  try { packagedPath = require.resolve("@sparticuz/chromium"); } catch { /* обычный Playwright */ }
  if (packagedPath && process.platform === "linux") {
    const pack = await import(packagedPath);
    const libs = await pack.inflate(join(dirname(packagedPath), "../bin/al2023.tar.br"));
    pack.setupLambdaEnvironment(join(libs, "lib"));
    launch.executablePath = await pack.default.executablePath();
    launch.args = ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader"];
  }
}
const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1360, height: 960 }, acceptDownloads: true });
const errors = [];
await context.route("https://cdn.jsdelivr.net/pyodide/v0.26.4/full/**", async route => {
  const path = join(pyodidePath, basename(new URL(route.request().url()).pathname));
  assert.ok(existsSync(path), "В npm-дистрибутиве Pyodide нет " + path);
  const contentType = path.endsWith(".js") ? "application/javascript" : path.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
  await route.fulfill({ path, contentType, headers: { "access-control-allow-origin": "*" } });
});
const page = await context.newPage();
page.on("pageerror", e => errors.push(String(e)));
page.on("dialog", dialog => dialog.accept());
const pass = text => console.log("PASS — " + text);
const snapshot = () => page.evaluate(() => structuredClone(store.snapshot()));
const check = async (card, code, expected) => {
  await card.locator(".editor textarea").fill(code);
  await card.getByRole("button", { name: "Проверить", exact: true }).click();
  await page.waitForFunction(({ id, expected }) => {
    const card = document.getElementById(id);
    return card && !card.querySelector('.task-actions button').disabled && !!card.querySelector('.verdict.' + expected)
      || card && !!card.querySelector('.done-badge') && !!card.querySelector('.verdict.' + expected);
  }, { id: await card.getAttribute("id"), expected });
};
const openReview = () => page.locator("#review-nav").click();
const checkReview = async () => {
  const solution = await page.evaluate(() => state.review.round.entry.task.solution);
  await check(page.locator(".review-task"), solution, "pass");
  await page.waitForFunction(() => state.review.round.finished);
};
const ready = async () => {
  await page.waitForFunction(() => state.py.status === "ready" || state.py.status === "error", null, { timeout: 45000 });
  assert.equal(await page.evaluate(() => state.py.status), "ready", await page.evaluate(() => state.py.err || ""));
};
const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "горизонтальный скролл");

try {
  await page.goto(base);
  await ready();
  assert.equal(await page.locator('.lesson-nav button').last().isDisabled(), true);
  await openReview();
  assert.match(await page.locator("#main").innerText(), /Пройди первую тему целиком/);
  assert.equal(await page.locator(".review-start").count(), 0);
  pass("повторение и переход к следующему уроку закрыты на чистом профиле");

  await page.getByRole("button", { name: "К обучению →", exact: true }).click();
  const firstLesson = await page.evaluate(() => DATA.stages[0].lessons[0].data);
  const firstCard = page.locator("#task-" + firstLesson.tasks[0].id);
  await check(firstCard, firstLesson.tasks[0].wrong_solution, "fail");
  assert.equal((await snapshot()).review.stats[firstLesson.id + ":" + firstLesson.tasks[0].id].errors, 1);
  for (const task of firstLesson.tasks) await check(page.locator("#task-" + task.id), task.solution, "pass");
  await page.waitForFunction(() => state.view === "review");
  assert.match(await page.locator(".review-unlocked").innerText(), /пройдена/);
  assert.equal(Object.keys((await snapshot()).done).length, 3);
  assert.equal(await page.locator(".lesson-item").nth(1).evaluate(el => el.classList.contains("locked")), false);
  assert.equal(await page.locator(".lesson-item").nth(2).evaluate(el => el.classList.contains("locked")), true);
  await noOverflow();
  await page.locator(".toast").waitFor({ state: "detached" });
  await page.screenshot({ animations: "disabled", path: "tmp/review-home-desktop.png", fullPage: true });
  pass("после последней задачи автоматически открыт обзор повторения; следующий урок доступен");

  const courseDrafts = (await snapshot()).drafts;
  await page.locator(".review-start").click();
  assert.equal(await page.locator(".review-task .editor textarea").inputValue(), "");
  assert.equal(await page.locator(".review-task .done-badge").count(), 0);
  assert.equal(await page.locator(".review-task .solution-box").count(), 0);
  assert.equal(await page.locator(".review-next").isDisabled(), true);
  const roundKey = await page.evaluate(() => state.review.round.entry.key);
  const beforeEmpty = await snapshot();
  await page.locator(".review-task").getByRole("button", { name: "Проверить", exact: true }).click();
  assert.deepEqual((await snapshot()).review.stats, beforeEmpty.review.stats);
  await check(page.locator(".review-task"), "print('ошибка')", "fail");
  assert.equal((await snapshot()).review.stats[roundKey].errors, (beforeEmpty.review.stats[roundKey]?.errors || 0) + 1);
  const beforeRun = (await snapshot()).review.stats;
  await page.locator(".review-task").getByRole("button", { name: "▶ Запустить на примере", exact: true }).click();
  assert.deepEqual((await snapshot()).review.stats, beforeRun);
  await page.locator(".review-theory > summary").click();
  await page.waitForFunction(() => state.review.round.usedHelp);
  await page.getByRole("button", { name: "📋 Мой план обучения", exact: true }).click();
  await openReview();
  assert.equal(await page.locator(".review-task .editor textarea").inputValue(), "print('ошибка')");
  assert.equal(await page.evaluate(() => state.review.round.usedHelp), true);
  pass("отдельные черновики; ошибка учитывается один раз, пустой редактор и запуск — не ошибки; помощь сохраняется");

  const beforePass = (await snapshot()).review.stats[roundKey];
  await checkReview();
  const afterPass = (await snapshot()).review.stats[roundKey];
  assert.equal(afterPass.passed, beforePass.passed + 1);
  assert.equal(afterPass.independent, beforePass.independent);
  assert.equal((await snapshot()).review.drafts[roundKey], undefined);
  await page.locator(".review-task .editor textarea").press("Control+Enter");
  assert.deepEqual((await snapshot()).review.stats[roundKey], afterPass);
  assert.equal(Object.keys((await snapshot()).done).length, 3);
  assert.deepEqual((await snapshot()).drafts, courseDrafts);
  pass("прохождение повторения не меняет зачёт и черновики курса; повторный submit не накручивает статистику");

  await page.locator(".review-next").click();
  assert.notEqual(await page.evaluate(() => state.review.round.entry.key), roundKey);
  const secondKey = await page.evaluate(() => state.review.round.entry.key);
  const beforeSkip = await snapshot();
  await page.locator(".review-skip").click();
  assert.equal((await snapshot()).review.stats[secondKey].skipped, (beforeSkip.review.stats[secondKey]?.skipped || 0) + 1);
  assert.equal(await page.evaluate(() => state.review.session.completed), 2);
  for (let i = 0; i < 3; i++) {
    await checkReview();
    await page.locator(".review-next").click();
  }
  assert.equal(await page.evaluate(() => state.review.screen), "summary");
  assert.equal(await page.locator(".review-session-results li").count(), 5);
  assert.equal(await page.evaluate(() => state.review.session.passed), 4);
  assert.equal(await page.evaluate(() => state.review.session.skipped), 1);
  pass("5 карточек заканчиваются итогом; пропуски повторяются чаще, подряд одна задача не выдаётся");

  const exportSnapshot = await snapshot();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "⬇ экспорт прогресса (.json)", exact: true }).click();
  const download = await downloadPromise;
  await download.saveAs("tmp/review-progress-test.json");
  const exported = JSON.parse(readFileSync("tmp/review-progress-test.json", "utf8"));
  assert.equal(exported.v, 2);
  assert.deepEqual(exported.review, exportSnapshot.review);
  await page.reload(); await ready();
  assert.deepEqual((await snapshot()).review, exportSnapshot.review);
  pass("статистика и отдельные черновики переживают перезагрузку и попадают в экспорт");

  const importFile = async value => {
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "⬆ импорт прогресса из файла", exact: true }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles({ name: "progress.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(value)) });
    await page.waitForFunction(() => !!document.querySelector(".toast"));
  };
  const legacy = { done: exportSnapshot.done, drafts: courseDrafts };
  await importFile(legacy);
  await page.waitForFunction(() => Object.keys(store.reviewStats()).length === 0);
  assert.deepEqual((await snapshot()).drafts, courseDrafts);
  await openReview();
  await page.getByRole("button", { name: "Слабые места", exact: true }).click();
  assert.equal(await page.locator(".review-start").isDisabled(), true);
  await page.getByRole("button", { name: "Все пройденные темы", exact: true }).click();
  assert.equal(await page.locator(".review-start").isDisabled(), false);
  pass("импорт старого прогресса открывает повторение, не выдумывает историю ошибок; пустой слабый фильтр объяснён");

  // Сессия могла успеть укрепить все темы. Для теста слабого фильтра импортируем
  // фиксированную историю с двумя дополнительными ошибками, а не надеемся на RNG.
  const weakExport = structuredClone(exported);
  const weakKey = firstLesson.id + ":" + firstLesson.tasks[0].id;
  const weakStat = weakExport.review.stats[weakKey];
  weakExport.review.stats[weakKey] = { ...weakStat, attempts: weakStat.attempts + 2, errors: weakStat.errors + 2, priority: 8, streak: 0 };
  await importFile(weakExport);
  await page.waitForFunction(() => Object.keys(store.reviewStats()).length > 0);
  assert.deepEqual((await snapshot()).review, weakExport.review);
  await openReview();
  await page.getByRole("button", { name: "Слабые места", exact: true }).click();
  assert.equal(await page.locator(".review-start").isDisabled(), false);
  await page.locator(".review-start").click();
  assert.deepEqual(await page.evaluate(() => state.review.session.lessonIds), [firstLesson.id]);
  await page.getByRole("button", { name: "Завершить сессию", exact: true }).click();
  assert.equal(await page.evaluate(() => state.review.session.skipped), 0);
  assert.equal(await page.evaluate(() => state.review.session.completed), 0);
  pass("v2 восстанавливает статистику; слабый режим работает; завершение без ответа не считается пропуском");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Карта повторения", exact: true }).click();
  await noOverflow();
  await page.locator(".toast").waitFor({ state: "detached" });
  await page.screenshot({ animations: "disabled", path: "tmp/review-home-mobile.png", fullPage: true });
  await page.locator(".review-start").click();
  await noOverflow();
  await page.locator(".toast").waitFor({ state: "detached" });
  await page.screenshot({ animations: "disabled", path: "tmp/review-session-mobile.png", fullPage: true });
  await page.locator(".review-theory > summary").click();
  await page.locator(".review-full-theory > summary").click();
  await noOverflow();
  pass("обзор, задача и теория без горизонтального скролла на 390 px");

  await page.setViewportSize({ width: 1360, height: 960 });
  await page.getByRole("button", { name: "↺ сбросить прогресс", exact: true }).click();
  await page.waitForFunction(() => Object.keys(store.snapshot().done).length === 0);
  await openReview();
  assert.match(await page.locator("#main").innerText(), /Пройди первую тему целиком/);
  assert.deepEqual((await snapshot()).review, { stats: {}, drafts: {}, recent: [] });
  pass("сброс очищает статистику и снова запирает повторение");

  await page.goto(base + "/pypath.html"); await ready();
  await page.evaluate(value => { store.restore(value); resetNavigation(); }, legacy);
  await openReview();
  await page.locator(".review-start").click();
  await checkReview();
  assert.equal(await page.evaluate(() => state.review.session.passed), 1);
  const engineResults = await page.evaluate(() => ALL_TASKS.map(({ lesson, task }) => ({
    id: task.id, passed: JSON.parse(state.py.check(task.solution, JSON.stringify({ tests: task.tests, checks: task.checks, compare: task.compare }))).passed,
  })));
  assert.ok(engineResults.every(r => r.passed), JSON.stringify(engineResults.filter(r => !r.passed)));
  assert.deepEqual(errors, []);
  pass("одиночный pypath.html работает; все " + engineResults.length + " эталонных решений прошли настоящий Pyodide; ошибок JS нет");
} finally {
  await browser.close();
}
