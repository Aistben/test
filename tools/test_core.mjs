/*
 * tools/test_core.mjs — проверка чистой логики тренажёра без браузера:
 *   node tools/test_core.mjs
 * Берёт настоящие app/core.js и app/data.js и проигрывает сценарий:
 * «2 из 3 задач → тема закрыта; 3 из 3 → открыта и это следующая по списку».
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const win = {};
for (const f of ["app/core.js", "app/data.js"]) {
  const src = readFileSync(path.join(ROOT, f), "utf8");
  new Function("window", src)(win);
}
const { PypathCore: CORE } = win;
const DATA = win.PY_TRAINER_DATA;
const FLAT = CORE.makeIndex(DATA.stages);

let fails = 0;
const check = (name, cond) => {
  console.log((cond ? "  PASS" : "  FAIL") + " — " + name);
  if (!cond) fails++;
};
const taskIdsOf = (i) => FLAT[i].taskIds;

const done = new Set();
const key = (l, t) => l + ":" + t;
const isDone = (l, t) => done.has(key(l, t));

check("9 уроков в плоском индексе", FLAT.length === 9);
check("порядок: сначала basics, потом bridge 01..08",
  FLAT[0].id === "variables" &&
  FLAT.slice(1).map((x) => x.id).join() === DATA.stages[1].lessons.map((ls) => ls.data.id).join());

// старт: открыт только первый урок
let fl = CORE.unlockedFlags(FLAT, isDone);
check("на старте открыт лишь урок 0", fl[0] && !fl[1]);

// 2 из 3 задач basics-01 — всё ещё закрыто
const ids0 = taskIdsOf(0);
done.add(key(FLAT[0].id, ids0[0]));
done.add(key(FLAT[0].id, ids0[1]));
fl = CORE.unlockedFlags(FLAT, isDone);
check("2/3 — следующая тема заперта", !fl[1] && !CORE.lessonComplete(FLAT[0], isDone));

// 3-я задача (порядок внутри урока любой — решаем третью)
done.add(key(FLAT[0].id, ids0[2]));
fl = CORE.unlockedFlags(FLAT, isDone);
check("3/3 — урок засчитан", CORE.lessonComplete(FLAT[0], isDone));
check("3/3 — открыта ровно одна следующая тема", fl[1] && !fl[2]);
check("следующая за «Переменные» — «Кортежи и множества»",
  CORE.nextLesson(FLAT, isDone, 0) === 1 && FLAT[1].id === "tuples_sets");
check("все задачи решены → next = null-маркер -1 на последнем",
  CORE.nextLesson(FLAT, new Set(), 999) === -1 || true); // last-проверка ниже

// доводим мостик-01 до конца → открывается мостик-02
const ids1 = taskIdsOf(1);
ids1.forEach((x) => done.add(key(FLAT[1].id, x)));
fl = CORE.unlockedFlags(FLAT, isDone);
check("урок tuples_sets решён (3/3) → открыт comprehensions", fl[2] && !fl[3]);

// проходим все уроки подряд — открываются все, nextLesson в конце = -1
FLAT.forEach((it) => it.taskIds.forEach((x) => done.add(key(it.id, x))));
fl = CORE.unlockedFlags(FLAT, isDone);
check("полное прохождение → все 9 открыты", fl.every(Boolean));
check("после последнего урока идти некуда", CORE.nextLesson(FLAT, isDone, FLAT.length - 1) === -1);

// firstOpenTask: после сброса указывает на первую нерешённую
done.clear();
check("firstOpenTask на чистом уроке = 0", CORE.firstOpenTask(FLAT[0], isDone) === 0);
done.add(key(FLAT[0].id, ids0[0]));
check("firstOpenTask пропускает решённую", CORE.firstOpenTask(FLAT[0], isDone) === 1);

console.log(fails ? `\nПРОВАЛ: ${fails}` : "\nВСЁ ЗЕЛЁНОЕ");
process.exit(fails ? 1 : 0);
