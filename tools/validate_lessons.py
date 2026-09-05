#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
validate_lessons.py — проверка файлов уроков (content/**/*.json).

Запуск из корня репозитория:
    python3 tools/validate_lessons.py                       # все уроки из content/index.json
    python3 tools/validate_lessons.py content/bridge/*.json # конкретные файлы
    python3 tools/validate_lessons.py --strict              # предупреждения считать ошибками
    python3 tools/validate_lessons.py --quiet               # только итог и ошибки

Что проверяется:
  1. JSON читается, обязательные поля на месте, типы верные, id уникальны.
  2. Каждая задача: эталонное решение (solution) ПРОХОДИТ все тесты через тот же
     harness.py, что и приложение. Если нет — урок сломан, ученик не сможет его сдать.
  3. Обратная проверка: пустая программа и программа-заглушка (wrong_solution, если
     задан) НЕ проходят тесты — иначе тесты ничего не проверяют.
  4. Ограничения checks не противоречат эталонному решению.
  5. Стиль: длина теории, наличие примеров, подсказок, хотя бы одного видимого теста,
     длина строк кода в примерах, отсутствие «умных» кавычек в коде.

Код возврата: 0 — ошибок нет, 1 — есть ошибки.
"""

import glob
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "engine", "py"))
import harness  # noqa: E402

ID_RE = re.compile(r"^[a-z0-9]+(?:_[a-z0-9]+)*$")
TASK_ID_RE = re.compile(r"^[a-z0-9_]+_t\d+$")
SMART_QUOTES = "«»“”‘’"
ALLOWED_TASK_KEYS = {
    "id", "title", "difficulty", "statement", "input_format", "output_format",
    "examples", "hints", "tests", "checks", "compare", "solution", "wrong_solution",
    "starter_code", "note",
}
ALLOWED_TEST_KEYS = {"input", "output", "visible", "files", "output_files",
                     "code_before", "code_after", "note"}
ALLOWED_LESSON_KEYS = {
    "id", "stage", "order", "title", "subtitle", "minutes", "goals", "theory",
    "tasks", "summary", "further", "version", "author",
}
ALLOWED_THEORY_TYPES = {"text", "code", "note", "warning", "table", "list", "compare"}


class Report:
    def __init__(self, quiet=False):
        self.errors, self.warnings, self.quiet = [], [], quiet
        self.solutions_run = 0

    def error(self, where, msg):
        self.errors.append(f"[ОШИБКА] {where}: {msg}")

    def warn(self, where, msg):
        self.warnings.append(f"[предупреждение] {where}: {msg}")

    def info(self, msg):
        if not self.quiet:
            print(msg)


# ----------------------------------------------------------------------------

def load_json(path, rep):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        rep.error(path, f"невалидный JSON: {e.msg} (строка {e.lineno}, колонка {e.colno})")
    except OSError as e:
        rep.error(path, f"не читается: {e}")
    return None


def expect(rep, where, obj, key, types, required=True):
    if key not in obj:
        if required:
            rep.error(where, f"нет обязательного поля `{key}`")
        return None
    val = obj[key]
    if not isinstance(val, types):
        names = "/".join(t.__name__ for t in (types if isinstance(types, tuple) else (types,)))
        rep.error(where, f"поле `{key}` должно быть типа {names}, а не {type(val).__name__}")
        return None
    return val


def check_code_style(rep, where, code, what="код"):
    for ch in SMART_QUOTES:
        if ch in code:
            rep.error(where, f"в {what} есть «умная» кавычка {ch!r} — Python её не поймёт; замени на ' или \"")
            break
    if "\t" in code:
        rep.warn(where, f"в {what} есть табуляция — используй 4 пробела")
    for i, ln in enumerate(code.split("\n"), 1):
        if len(ln) > 88:
            rep.warn(where, f"{what}, строка {i}: длиннее 88 символов ({len(ln)})")
            break


# ----------------------------------------------------------------------------

def validate_theory(rep, where, theory):
    if not theory:
        rep.error(where, "теория пуста")
        return
    n_text = n_code = 0
    for i, block in enumerate(theory):
        bw = f"{where}.theory[{i}]"
        if not isinstance(block, dict):
            rep.error(bw, "блок теории должен быть объектом {type, ...}")
            continue
        btype = block.get("type")
        if btype not in ALLOWED_THEORY_TYPES:
            rep.error(bw, f"неизвестный type={btype!r}; допустимы: {sorted(ALLOWED_THEORY_TYPES)}")
            continue
        if btype in ("text", "note", "warning"):
            if not isinstance(block.get("text"), str) or not block["text"].strip():
                rep.error(bw, "нужно непустое строковое поле `text`")
            n_text += btype == "text"
        elif btype == "code":
            code = block.get("code")
            if not isinstance(code, str) or not code.strip():
                rep.error(bw, "нужно непустое поле `code`")
                continue
            n_code += 1
            check_code_style(rep, bw, code, "примере кода")
            try:
                compile(code, "<theory>", "exec")
            except SyntaxError as e:
                if not block.get("allow_invalid"):
                    rep.error(bw, f"пример кода не компилируется: {e.msg} (строка {e.lineno}). "
                                  "Если это намеренно (показываем ошибку) — добавь \"allow_invalid\": true")
            if "output" in block and not isinstance(block["output"], str):
                rep.error(bw, "`output` должен быть строкой")
            if block.get("run_check") and "output" in block and not block.get("allow_invalid"):
                # Пример обещает конкретный вывод — проверим.
                r = harness.run_program(code, block.get("input", ""))
                if not r["ok"]:
                    rep.error(bw, f"пример кода падает при запуске: {r['error_type']}: {r['error']}")
                else:
                    ok, detail = harness.compare_output(block["output"], r["stdout"])
                    if not ok:
                        rep.error(bw, f"вывод примера не совпадает с указанным: {detail}")
        elif btype == "table":
            rows = block.get("rows")
            if not isinstance(rows, list) or not rows or not all(isinstance(r, list) for r in rows):
                rep.error(bw, "`rows` должен быть списком списков строк")
            if "header" in block and not isinstance(block["header"], list):
                rep.error(bw, "`header` должен быть списком строк")
        elif btype == "list":
            items = block.get("items")
            if not isinstance(items, list) or not items or not all(isinstance(x, str) for x in items):
                rep.error(bw, "`items` должен быть непустым списком строк")
        elif btype == "compare":
            for k in ("bad", "good"):
                if not isinstance(block.get(k), str) or not block[k].strip():
                    rep.error(bw, f"нужно поле `{k}` (строка с кодом)")
    if n_text == 0:
        rep.error(where, "в теории нет ни одного текстового блока")
    if n_code == 0:
        rep.warn(where, "в теории нет ни одного примера кода — новичку будет трудно")
    total_chars = sum(len(b.get("text", "")) + len(b.get("code", "")) for b in theory if isinstance(b, dict))
    if total_chars < 800:
        rep.warn(where, f"теория очень короткая ({total_chars} символов), ориентир 1500–5000")
    if total_chars > 9000:
        rep.warn(where, f"теория очень длинная ({total_chars} символов) — разбей на два урока")


def validate_task(rep, where, task, lesson_id, seen_ids):
    tid = expect(rep, where, task, "id", str)
    if tid:
        if tid in seen_ids:
            rep.error(where, f"дублируется id задачи `{tid}`")
        seen_ids.add(tid)
        if not TASK_ID_RE.match(tid) or not tid.startswith(lesson_id + "_t"):
            rep.error(where, f"id задачи должен быть вида `{lesson_id}_t1`, `{lesson_id}_t2`…, а не `{tid}`")
    for k in task:
        if k not in ALLOWED_TASK_KEYS:
            rep.warn(where, f"неизвестное поле задачи `{k}` — приложение его проигнорирует")

    expect(rep, where, task, "title", str)
    diff = expect(rep, where, task, "difficulty", int)
    if diff is not None and diff not in (1, 2, 3):
        rep.error(where, "difficulty должен быть 1, 2 или 3")
    statement = expect(rep, where, task, "statement", str)
    if statement and len(statement) < 40:
        rep.warn(where, "условие слишком короткое — опиши, что дано и что вывести")

    hints = expect(rep, where, task, "hints", list)
    if hints is not None and len(hints) == 0:
        rep.warn(where, "нет подсказок (рекомендуется 2–3: от общей идеи к почти-решению)")

    if "starter_code" in task and task["starter_code"]:
        rep.warn(where, "starter_code непустой: по требованию проекта редактор должен быть ПУСТ. "
                        "Разрешено только для задач на дописывание функции — убедись, что это так")

    compare_mode = task.get("compare", "exact")
    if compare_mode not in ("exact", "tokens"):
        rep.error(where, f"compare должен быть 'exact' или 'tokens', а не {compare_mode!r}")

    checks = task.get("checks") or {}
    if not isinstance(checks, dict):
        rep.error(where, "checks должен быть объектом")
        checks = {}
    for k in checks:
        if k not in ("must_use", "must_not_use", "must_define"):
            rep.error(where, f"checks: неизвестный ключ `{k}`")
        elif not isinstance(checks[k], list):
            rep.error(where, f"checks.{k} должен быть списком строк")

    tests = expect(rep, where, task, "tests", list)
    if not tests:
        rep.error(where, "нет тестов")
        return
    if len(tests) < 2:
        rep.warn(where, "меньше 2 тестов — одно решение легко «подогнать» под ответ")
    if not any(t.get("visible") for t in tests if isinstance(t, dict)):
        rep.error(where, "ни один тест не помечен visible: true — ученик не увидит пример ввода/вывода")

    uses_after = False
    for i, t in enumerate(tests):
        tw = f"{where}.tests[{i}]"
        if not isinstance(t, dict):
            rep.error(tw, "тест должен быть объектом")
            continue
        for k in t:
            if k not in ALLOWED_TEST_KEYS:
                rep.warn(tw, f"неизвестное поле теста `{k}`")
        if "output" not in t and not t.get("output_files"):
            rep.error(tw, "в тесте нужен `output` (ожидаемый вывод) или `output_files`")
        if "output" in t and not isinstance(t["output"], str):
            rep.error(tw, "`output` должен быть строкой (многострочный вывод — через \\n)")
        if "input" in t and not isinstance(t["input"], str):
            rep.error(tw, "`input` должен быть строкой")
        for k in ("code_before", "code_after"):
            if k in t:
                uses_after = uses_after or k == "code_after"
                try:
                    compile(t[k], k, "exec")
                except SyntaxError as e:
                    rep.error(tw, f"{k} не компилируется: {e.msg} (строка {e.lineno})")
        for k in ("files", "output_files"):
            if k in t and (not isinstance(t[k], dict) or not all(isinstance(v, str) for v in t[k].values())):
                rep.error(tw, f"`{k}` должен быть объектом {{имя_файла: строка}}")

    if checks.get("must_define") and not uses_after:
        rep.warn(where, "checks.must_define задан, но ни один тест не вызывает функцию через code_after")

    solution = expect(rep, where, task, "solution", str)
    if not solution:
        return
    check_code_style(rep, where, solution, "solution")

    # --- главное: эталонное решение проходит все тесты
    res = harness.check_task(solution, task)
    rep.solutions_run += 1
    if res["syntax_error"]:
        rep.error(where, f"эталонное решение не компилируется: {res['syntax_error']['error']}")
        return
    if res["checks_failed"]:
        rep.error(where, "эталонное решение нарушает собственные checks: " + "; ".join(res["checks_failed"]))
    for r in res["results"]:
        if not r["ok"]:
            rep.error(f"{where}.tests[{r['index']}]",
                      f"эталонное решение НЕ проходит тест: {r['detail']}"
                      + (f"\n      ввод: {r['input']!r}\n      ожидалось: {r['expected']!r}\n      получено: {r['stdout']!r}"
                         if r["expected"] is not None else ""))

    # --- тесты должны отсеивать неверные программы
    empty_res = harness.check_task("pass", task)
    if empty_res["passed"]:
        rep.error(where, "программа `pass` (ничего не делает) проходит все тесты — тесты не проверяют вывод")
    if task.get("wrong_solution"):
        wr = harness.check_task(task["wrong_solution"], task)
        if wr["passed"]:
            rep.error(where, "wrong_solution проходит все тесты — тесты слишком слабые, добавь граничные случаи")

    # --- «подогнанный» вывод: программа, печатающая ответ первого теста, не должна проходить,
    # если тестов > 1 и ожидаемые выводы различаются
    outputs = {t.get("output") for t in tests if isinstance(t, dict) and "output" in t}
    if len(tests) >= 2 and len(outputs) == 1 and not uses_after and not any(t.get("output_files") for t in tests):
        rep.warn(where, "у всех тестов одинаковый ожидаемый вывод — решение `print(...)` с константой пройдёт")


def validate_lesson(path, rep, seen_lesson_ids, seen_task_ids):
    data = load_json(path, rep)
    if data is None:
        return None
    where = os.path.relpath(path, ROOT)
    for k in data:
        if k not in ALLOWED_LESSON_KEYS:
            rep.warn(where, f"неизвестное поле урока `{k}`")
    lid = expect(rep, where, data, "id", str)
    if lid:
        if not ID_RE.match(lid):
            rep.error(where, f"id урока должен быть в snake_case латиницей: `{lid}`")
        if lid in seen_lesson_ids:
            rep.error(where, f"дублируется id урока `{lid}`")
        seen_lesson_ids.add(lid)
        base = os.path.splitext(os.path.basename(path))[0]
        # Имя файла: NN_id.json (NN — порядковый номер) или просто id.json
        if re.sub(r"^\d+_", "", base) != lid:
            rep.warn(where, f"имя файла `{base}.json` не совпадает с id `{lid}` (ожидается `NN_{lid}.json`)")
        m = re.match(r"^(\d+)_", base)
        if m and int(m.group(1)) != data.get("order"):
            rep.warn(where, f"номер в имени файла ({m.group(1)}) не совпадает с order={data.get('order')}")
    stage = expect(rep, where, data, "stage", str)
    if stage and stage not in ("basics", "bridge", "track_a", "track_b", "track_c"):
        rep.error(where, f"stage должен быть одним из basics / bridge / track_a / track_b / track_c, а не {stage!r}")
    expect(rep, where, data, "order", int)
    expect(rep, where, data, "title", str)
    minutes = expect(rep, where, data, "minutes", int, required=False)
    if minutes is not None and not (10 <= minutes <= 120):
        rep.warn(where, f"minutes={minutes}: ориентир 20–60 минут на урок")
    goals = expect(rep, where, data, "goals", list)
    if goals is not None and not (2 <= len(goals) <= 6):
        rep.warn(where, f"goals: {len(goals)} пунктов, ориентир 2–5")
    theory = expect(rep, where, data, "theory", list)
    if theory is not None:
        validate_theory(rep, where, theory)
    tasks = expect(rep, where, data, "tasks", list)
    if tasks is not None:
        if not (2 <= len(tasks) <= 5):
            rep.warn(where, f"tasks: {len(tasks)} задач, ориентир 3–4 (от простой к сложной)")
        diffs = []
        for i, task in enumerate(tasks):
            tw = f"{where}.tasks[{i}]"
            if not isinstance(task, dict):
                rep.error(tw, "задача должна быть объектом")
                continue
            validate_task(rep, tw, task, lid or "", seen_task_ids)
            diffs.append(task.get("difficulty", 0))
        if diffs and diffs != sorted(diffs):
            rep.warn(where, f"сложность задач не возрастает: {diffs}")
    summary = expect(rep, where, data, "summary", list, required=False)
    if summary is not None and len(summary) == 0:
        rep.warn(where, "summary пуст — добавь 3–5 пунктов «что запомнить»")
    return data


def validate_index(rep):
    path = os.path.join(ROOT, "content", "index.json")
    data = load_json(path, rep)
    if data is None:
        return []
    files = []
    stages = expect(rep, "content/index.json", data, "stages", list)
    if not stages:
        return files
    for i, st in enumerate(stages):
        w = f"content/index.json.stages[{i}]"
        expect(rep, w, st, "id", str)
        expect(rep, w, st, "title", str)
        lessons = expect(rep, w, st, "lessons", list)
        for rel in lessons or []:
            p = os.path.join(ROOT, "content", rel)
            if not os.path.exists(p):
                rep.error(w, f"файл урока не найден: content/{rel}")
            else:
                files.append((st["id"], p))
    return files


# ----------------------------------------------------------------------------

def main(argv):
    strict = "--strict" in argv
    quiet = "--quiet" in argv
    paths = [a for a in argv if not a.startswith("--")]
    rep = Report(quiet=quiet)

    if paths:
        files = []
        for p in paths:
            files.extend((None, f) for f in sorted(glob.glob(p)))
        if not files:
            print("Файлы не найдены:", paths)
            return 1
    else:
        files = validate_index(rep)

    seen_lessons, seen_tasks = set(), set()
    n_tasks = 0
    for stage_id, path in files:
        data = validate_lesson(path, rep, seen_lessons, seen_tasks)
        if data:
            if stage_id and data.get("stage") != stage_id:
                rep.error(os.path.relpath(path, ROOT),
                          f"урок указан в index.json в этапе `{stage_id}`, а внутри stage=`{data.get('stage')}`")
            n = len(data.get("tasks") or [])
            n_tasks += n
            rep.info(f"  {os.path.relpath(path, ROOT)}: {data.get('title', '?')} — задач: {n}")

    print()
    for w in rep.warnings:
        print(w)
    for e in rep.errors:
        print(e)
    print()
    print(f"Уроков: {len(files)}, задач: {n_tasks}, эталонных решений прогнано: {rep.solutions_run}")
    print(f"Ошибок: {len(rep.errors)}, предупреждений: {len(rep.warnings)}")
    if rep.errors or (strict and rep.warnings):
        print("РЕЗУЛЬТАТ: НЕ ПРОЙДЕНО")
        return 1
    print("РЕЗУЛЬТАТ: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
