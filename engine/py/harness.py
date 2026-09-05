# -*- coding: utf-8 -*-
"""
harness.py — единый «прогонщик» кода ученика.

Один и тот же файл используется в двух местах:
  1) в браузере (Pyodide) — приложением-тренажёром при нажатии «Запустить» / «Проверить»;
  2) локально (CPython 3.10+) — валидатором уроков tools/validate_lessons.py.

Поэтому здесь ТОЛЬКО стандартная библиотека и ничего специфичного для одной среды.

Главные функции:
  run_program(code, stdin, ...)   — выполнить программу, вернуть вывод / ошибку.
  check_task(code, task)          — прогнать код по всем тестам задачи (формат lesson.json).
  compare_output(expected, got)   — сравнить ожидаемый и полученный вывод.
  run_checks(code, checks)        — статические проверки (must_use / must_not_use / must_define).
  explain_error(error_type, msg)  — понятное объяснение ошибки по-русски.

JSON-обёртки для вызова из JavaScript: run_program_json(), check_task_json().
"""

import ast
import builtins
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import tokenize
import traceback

OUTPUT_LIMIT = 200_000          # символов вывода на один запуск
FILENAME_MAIN = "main.py"       # так называется файл ученика в traceback
FILENAME_BEFORE = "<подготовка>"
FILENAME_AFTER = "<проверка>"


# ----------------------------------------------------------------------------
# Вывод и ввод
# ----------------------------------------------------------------------------

class OutputLimitExceeded(Exception):
    """Программа напечатала слишком много (скорее всего, бесконечный цикл)."""


class _LimitedOutput(io.StringIO):
    def __init__(self, limit):
        super().__init__()
        self._limit = limit
        self._size = 0

    def write(self, s):
        s = str(s)
        if self._size + len(s) > self._limit:
            super().write(s[: max(0, self._limit - self._size)])
            self._size = self._limit
            raise OutputLimitExceeded()
        self._size += len(s)
        return super().write(s)


class _InputState:
    """Счётчики для сообщений вида «программа не прочитала все данные»."""
    def __init__(self, total_lines):
        self.total_lines = total_lines
        self.calls = 0


def _make_input(out, echo_prompts, state):
    def _input(prompt=""):
        state.calls += 1
        line = sys.stdin.readline()
        if line == "":
            raise EOFError("нет данных для input()")
        line = line.rstrip("\n")
        if echo_prompts:
            # Режим «Запустить»: показываем как в терминале — подсказку и введённую строку.
            out.write(str(prompt) + line + "\n")
        return line
    return _input


# ----------------------------------------------------------------------------
# Запуск программы
# ----------------------------------------------------------------------------

def run_program(code, stdin="", *, code_before="", code_after="", files=None,
                want_files=None, echo_prompts=False, output_limit=OUTPUT_LIMIT):
    """
    Выполняет код ученика в чистом пространстве имён и временной папке.

    code          — код ученика (файл main.py).
    stdin         — текст, который будет читаться через input() / sys.stdin.
    code_before   — код, выполняемый ДО кода ученика в том же пространстве имён
                    (подготовка данных). Номера строк ученика не сдвигаются.
    code_after    — код, выполняемый ПОСЛЕ (например, вызов функции ученика).
    files         — {имя: содержимое}: файлы, создаваемые в рабочей папке до запуска.
    want_files    — список имён файлов, содержимое которых нужно вернуть после запуска.
    echo_prompts  — True: подсказка input() и введённая строка попадают в вывод
                    (режим «Запустить»); False: не попадают (режим «Проверить»).

    Возвращает dict:
      ok, stdout, exited, error, error_type, line, where, friendly, files,
      input_calls, input_total
    """
    result = {
        "ok": True, "stdout": "", "exited": False,
        "error": None, "error_type": None, "line": None, "where": None,
        "friendly": None, "files": {},
        "input_calls": 0, "input_total": 0,
    }
    stdin = stdin or ""
    state = _InputState(len(stdin.splitlines()))
    out = _LimitedOutput(output_limit)
    ns = {"__name__": "__main__", "__builtins__": builtins}

    old_cwd = os.getcwd()
    old_stdin, old_input = sys.stdin, builtins.input
    old_argv = sys.argv
    old_modules = set(sys.modules)
    tmp = tempfile.mkdtemp(prefix="run_")
    try:
        os.chdir(tmp)
        # Чтобы `import helpers` находил файлы задачи (files={"helpers.py": ...})
        # одинаково и в Pyodide, и в CPython, где sys.path[0] — папка скрипта.
        sys.path.insert(0, tmp)
        for name, content in (files or {}).items():
            d = os.path.dirname(name)
            if d:
                os.makedirs(d, exist_ok=True)
            with open(name, "w", encoding="utf-8", newline="") as f:
                f.write(content)

        sys.stdin = io.StringIO(stdin)
        sys.argv = [FILENAME_MAIN]
        builtins.input = _make_input(out, echo_prompts, state)

        parts = (
            ("before", code_before, FILENAME_BEFORE),
            ("main", code, FILENAME_MAIN),
            ("after", code_after, FILENAME_AFTER),
        )
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            for where, src, fname in parts:
                if not src:
                    continue
                try:
                    exec(compile(src, fname, "exec"), ns)
                except SystemExit:
                    result["exited"] = True
                    break
                except BaseException as e:  # noqa: B902 — нужно ловить всё, включая RecursionError
                    _fill_error(result, e, where, state)
                    break
    finally:
        result["stdout"] = out.getvalue()
        result["input_calls"] = state.calls
        result["input_total"] = state.total_lines
        for name in (want_files or []):
            try:
                with open(name, "r", encoding="utf-8") as f:
                    result["files"][name] = f.read()
            except OSError:
                result["files"][name] = None
        sys.stdin, builtins.input, sys.argv = old_stdin, old_input, old_argv
        # Убираем модули, импортированные из временной папки, чтобы следующий тест
        # с другим содержимым helpers.py не получил закешированную версию.
        for name in set(sys.modules) - old_modules:
            mod = sys.modules.get(name)
            mfile = getattr(mod, "__file__", None) or ""
            if mfile.startswith(tmp):
                del sys.modules[name]
        try:
            sys.path.remove(tmp)
        except ValueError:
            pass
        os.chdir(old_cwd)
        shutil.rmtree(tmp, ignore_errors=True)
    return result


def _fill_error(result, e, where, state):
    etype = type(e).__name__
    msg = str(e)
    line = None
    text = ""

    if isinstance(e, OutputLimitExceeded):
        etype, msg = "OutputLimitExceeded", "слишком много вывода"
    elif isinstance(e, SyntaxError):
        msg = e.msg or msg
        text = (e.text or "").strip()
        if e.filename == FILENAME_MAIN:
            line = e.lineno
    else:
        for fr in reversed(traceback.extract_tb(e.__traceback__)):
            if fr.filename == FILENAME_MAIN:
                line = fr.lineno
                text = (fr.line or "").strip()
                break

    result["ok"] = False
    result["error_type"] = etype
    result["error"] = _format_error(e, etype, msg, line, text, where)
    result["line"] = line
    result["where"] = where
    result["friendly"] = explain_error(etype, msg, line=line, where=where,
                                       input_total=state.total_lines,
                                       input_calls=state.calls)


def _format_error(e, etype, msg, line, text, where):
    lines = []
    if where == "after":
        lines.append("Ошибка возникла, когда проверка вызвала ваш код:")
    elif where == "before":
        lines.append("Ошибка в подготовительном коде задачи (сообщите автору урока):")
    if isinstance(e, SyntaxError):
        if line is not None:
            lines.append(f'  Файл "{FILENAME_MAIN}", строка {line}')
            if text:
                lines.append("    " + text)
        lines.append(f"{etype}: {msg}")
    else:
        frames = [fr for fr in traceback.extract_tb(e.__traceback__) if fr.filename == FILENAME_MAIN]
        if frames:
            lines.append("Traceback (последний вызов — внизу):")
            for fr in frames:
                lines.append(f'  Файл "{FILENAME_MAIN}", строка {fr.lineno}, в {fr.name}')
                if fr.line:
                    lines.append("    " + fr.line.strip())
        lines.append(f"{etype}: {msg}" if msg else etype)
    return "\n".join(lines)


# ----------------------------------------------------------------------------
# Понятные объяснения ошибок
# ----------------------------------------------------------------------------

def explain_error(etype, msg, line=None, where=None, input_total=None, input_calls=None):
    """Возвращает короткое объяснение ошибки по-русски (строка) или None."""
    m = msg or ""
    ml = m.lower()
    where_note = ""
    if line is not None:
        where_note = f" (строка {line})"

    def q(s):
        return f"`{s}`"

    if etype == "OutputLimitExceeded":
        return "Программа вывела слишком много текста — почти наверняка бесконечный цикл. " \
               "Проверь условие while и то, что переменная-счётчик меняется."
    if etype == "KeyboardInterrupt":
        return "Выполнение остановлено по лимиту времени. Похоже на бесконечный цикл: " \
               "проверь условие while и изменение счётчика внутри цикла."
    if etype == "EOFError":
        n = input_total if input_total is not None else "?"
        k = input_calls if input_calls is not None else "?"
        return f"Программа вызвала input() {k}-й раз, а строк во входных данных всего {n}. " \
               "Читай ровно столько строк, сколько описано в условии; лишний input() — ошибка."
    if etype == "SyntaxError":
        if "was never closed" in ml:
            return f"Не закрыта скобка{where_note}: у каждой ( [ {{ должна быть пара ) ] }}."
        if "unterminated string" in ml or "eol while scanning" in ml:
            return f"Не закрыта кавычка строки{where_note}: у текста должны быть кавычки с обеих сторон."
        if "expected ':'" in ml:
            return f"Пропущено двоеточие{where_note}: после if / elif / else / for / while / def нужен символ `:`."
        if "maybe you meant '==' or ':='" in ml or "cannot assign to" in ml:
            return f"В условии сравнение записывается как `==`, а `=` — это присваивание{where_note}."
        if "perhaps you forgot a comma" in ml:
            return f"Похоже, пропущена запятая между элементами{where_note}."
        if "unmatched" in ml or "closing parenthesis" in ml:
            return f"Лишняя или несогласованная закрывающая скобка{where_note}."
        if "invalid decimal literal" in ml or "invalid character" in ml:
            return f"Недопустимый символ{where_note}: имя переменной не может начинаться с цифры, " \
                   "а в коде не должно быть «умных» кавычек « » “ ” или русских букв вне строк."
        if "'return' outside function" in ml:
            return "`return` можно писать только внутри функции (внутри блока def)."
        if "'break' outside loop" in ml or "'continue' not properly in loop" in ml:
            return "`break` и `continue` работают только внутри цикла for / while."
        if "print" in ml and "missing parentheses" in ml:
            return "В Python 3 print — это функция: пиши `print(...)` со скобками."
        return f"Синтаксическая ошибка{where_note}: Python не смог прочитать эту строку. " \
               "Проверь скобки, кавычки, двоеточия и лишние символы. " \
               "Часто ошибка на самом деле строкой выше."
    if etype == "IndentationError":
        if "expected an indented block" in ml:
            return f"После строки с двоеточием нужен отступ{where_note}: тело if / for / def " \
                   "сдвигается на 4 пробела."
        if "unexpected indent" in ml:
            return f"Лишний отступ{where_note}: строка сдвинута, хотя блок не начинался."
        if "unindent does not match" in ml:
            return f"Отступы не совпадают{where_note}: все строки одного блока должны иметь " \
                   "одинаковый сдвиг (используй 4 пробела)."
        return f"Ошибка отступов{where_note}: проверь, что блоки сдвинуты ровно на 4 пробела."
    if etype == "TabError":
        return "В файле смешаны табы и пробелы. Используй только пробелы (4 на уровень)."
    if etype == "NameError":
        name = _between(m, "name '", "'")
        hint = ""
        if name in ("true", "false", "none"):
            hint = " В Python пишется с большой буквы: True, False, None."
        elif name in ("Print", "PRINT", "Input", "Len", "Range", "Int", "Str"):
            hint = " Встроенные функции пишутся с маленькой буквы."
        return f"Имя {q(name)} не определено{where_note}: такая переменная или функция ещё не создана. " \
               f"Проверь опечатку и порядок строк — создать переменную нужно ДО использования.{hint}"
    if etype == "UnboundLocalError":
        name = _between(m, "'", "'")
        return f"Переменная {q(name)} используется внутри функции до присваивания. " \
               "Внутри функции создаётся своя локальная переменная — передай значение параметром " \
               "или верни его через return."
    if etype == "TypeError":
        if "can only concatenate str" in ml or ("unsupported operand" in ml and "str" in ml):
            return f"Нельзя складывать строку и число{where_note}. Преобразуй: `int(...)` для расчёта " \
                   "или `str(...)` / f-строку для вывода."
        if "not supported between instances" in ml:
            return f"Нельзя сравнивать значения разных типов{where_note} (например, строку и число). " \
                   "Данные из input() — всегда строка: примени int() или float()."
        if "object is not subscriptable" in ml:
            return f"К этому значению нельзя обращаться по индексу [ ]{where_note}: скорее всего, " \
                   "это число или None, а не список/строка."
        if "does not support item assignment" in ml:
            return f"Этот тип нельзя менять по индексу{where_note}. Строки и кортежи неизменяемы — " \
                   "создай новое значение или используй список."
        if "object is not callable" in ml:
            return f"Ты вызываешь как функцию то, что функцией не является{where_note}. Частая причина: " \
                   "переменная названа как функция (`print`, `len`, `sum`, `input`) и перекрыла её."
        if "object is not iterable" in ml:
            return f"Перебирать циклом for можно список, строку, range и т. п., но не число{where_note}. " \
                   "Возможно, нужно `range(n)`."
        if "positional argument" in ml or "required positional" in ml or "takes" in ml and "given" in ml:
            return f"Функция вызвана с неверным числом аргументов{where_note}: сравни def и вызов."
        if "must be str, not" in ml:
            return f"Ожидалась строка, а передано число{where_note}: используй str(...) или f-строку."
        if "'nonetype'" in ml:
            return f"Значение None{where_note}: обычно функция ничего не вернула (забыт return) " \
                   "или ты присвоил результат метода, который меняет объект на месте (.sort(), .append())."
        if "string indices must be integers" in ml or "list indices must be integers" in ml:
            return f"Индекс должен быть целым числом{where_note}, а не строкой или float. " \
                   "Данные из input() — строка: примени int()."
        return f"Ошибка типов{where_note}: операция не подходит для этих типов данных. " \
               "Проверь, что где нужно число — число (int/float), а где текст — строка."
    if etype == "ValueError":
        if "invalid literal for int()" in ml:
            bad = _between(m, ": '", "'")
            return f"int() не смог превратить {q(bad)} в целое число{where_note}. В строке есть не только " \
                   "цифры: пробелы, буквы, точка (для дробных нужен float()) или она пустая."
        if "could not convert string to float" in ml:
            return f"float() не смог прочитать число{where_note}: проверь, что дробная часть отделена " \
                   "точкой, а не запятой, и нет лишних символов."
        if "not enough values to unpack" in ml or "too many values to unpack" in ml:
            return f"Количество переменных слева от `=` не совпадает с количеством значений справа{where_note}."
        if "is not in list" in ml:
            return f"list.remove(): такого элемента нет в списке{where_note}. Проверь через `in` перед удалением."
        if "substring not found" in ml:
            return f"index(): подстрока не найдена{where_note}. Используй find() — он вернёт -1 вместо ошибки."
        if "math domain error" in ml:
            return f"Математическая функция получила недопустимый аргумент{where_note} " \
                   "(например, корень из отрицательного числа)."
        return f"Некорректное значение{where_note}: функция получила правильный тип, но неподходящее значение."
    if etype == "ZeroDivisionError":
        return f"Деление на ноль{where_note}. Перед делением проверь делитель: `if b != 0:`."
    if etype == "IndexError":
        return f"Индекс за пределами последовательности{where_note}. Индексы идут от 0 до len(x) - 1; " \
               "проверь границы цикла и пустые списки."
    if etype == "KeyError":
        return f"В словаре нет ключа {m}{where_note}. Проверь наличие через `in` или используй " \
               "`.get(ключ, значение_по_умолчанию)`."
    if etype == "AttributeError":
        if "'nonetype'" in ml:
            return f"Обращение к None{where_note}: функция ничего не вернула (нет return) или методы " \
                   ".sort() / .append() / .reverse() возвращают None — не присваивай их результат."
        obj = _between(m, "'", "'")
        attr = _between(m, "attribute '", "'")
        return f"У значения типа {q(obj)} нет метода или атрибута {q(attr)}{where_note}. " \
               "Проверь название (например, у списка метод append, а не push/add)."
    if etype == "RecursionError":
        return "Слишком глубокая рекурсия: функция вызывает сама себя без условия остановки."
    if etype == "ModuleNotFoundError" or etype == "ImportError":
        return f"Модуль не найден{where_note}. В тренажёре доступна стандартная библиотека Python " \
               "(random, math, datetime, json, csv, os, pathlib и др.) — проверь имя модуля."
    if etype == "FileNotFoundError":
        return f"Файл не найден{where_note}. Проверь имя файла (регистр букв, расширение) и режим " \
               "открытия: для чтения файл должен существовать заранее."
    if etype == "PermissionError" or etype == "IsADirectoryError":
        return f"Нет доступа к файлу или это папка{where_note}."
    if etype == "OverflowError":
        return f"Число слишком большое для этой операции{where_note}."
    if etype == "MemoryError":
        return "Не хватило памяти — вероятно, список растёт бесконечно."
    if etype == "AssertionError":
        return f"assert не выполнился{where_note}: условие оказалось ложным."
    if etype == "StopIteration":
        return f"Итератор закончился{where_note}: next() вызван, когда элементов больше нет."
    return None


def _between(s, left, right):
    i = s.find(left)
    if i < 0:
        return "?"
    j = s.find(right, i + len(left))
    if j < 0:
        return s[i + len(left):]
    return s[i + len(left):j]


# ----------------------------------------------------------------------------
# Сравнение вывода
# ----------------------------------------------------------------------------

def normalize_lines(text):
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = [ln.rstrip() for ln in text.split("\n")]
    while lines and lines[-1] == "":
        lines.pop()
    return lines


def _num(s):
    try:
        return float(s.replace(",", ".")) if s.count(",") == 1 and "." not in s else float(s)
    except ValueError:
        return None


def compare_output(expected, actual, mode="exact"):
    """
    mode = "exact"  — построчно; концевые пробелы строк и пустые строки в конце игнорируются.
    mode = "tokens" — сравнение по «словам» (любые пробелы/переводы строк), числа с допуском 1e-6.
    Возвращает (ok, описание_расхождения).
    """
    if mode == "tokens":
        et, at = (expected or "").split(), (actual or "").split()
        if len(et) != len(at):
            return False, f"Ожидалось значений: {len(et)}, получено: {len(at)}"
        for i, (e, a) in enumerate(zip(et, at)):
            en, an = _num(e), _num(a)
            if en is not None and an is not None:
                if abs(en - an) > 1e-6 * max(1.0, abs(en)):
                    return False, f"Значение №{i + 1}: ожидалось {e}, получено {a}"
            elif e != a:
                return False, f"Значение №{i + 1}: ожидалось {e!r}, получено {a!r}"
        return True, ""

    exp, act = normalize_lines(expected), normalize_lines(actual)
    if exp == act:
        return True, ""
    for i, (e, a) in enumerate(zip(exp, act)):
        if e != a:
            extra = ""
            if e.strip() == a.strip():
                extra = " (отличаются пробелы в начале строки)"
            elif e.lower() == a.lower():
                extra = " (отличается регистр букв)"
            elif e.replace(" ", "") == a.replace(" ", ""):
                extra = " (отличаются пробелы)"
            return False, f"Строка {i + 1}: ожидалось {e!r}, получено {a!r}{extra}"
    if len(exp) > len(act):
        return False, f"Не хватает строк вывода: ожидалось {len(exp)}, получено {len(act)}"
    return False, f"Лишние строки вывода: ожидалось {len(exp)}, получено {len(act)}"


# ----------------------------------------------------------------------------
# Статические проверки кода
# ----------------------------------------------------------------------------

def _scan_tokens(code):
    names, ops, has_fstring = set(), set(), False
    try:
        for tok in tokenize.generate_tokens(io.StringIO(code).readline):
            tname = tokenize.tok_name.get(tok.type, "")
            if tok.type == tokenize.NAME:
                names.add(tok.string)
            elif tok.type == tokenize.OP:
                ops.add(tok.string)
            elif tok.type == tokenize.STRING:
                prefix = tok.string[:2].lower()
                if "f" in prefix.rstrip("'\""):
                    has_fstring = True
            elif tname == "FSTRING_START":
                has_fstring = True
    except (tokenize.TokenError, SyntaxError, IndentationError):
        pass
    return names, ops, has_fstring


def _defined_names(code):
    names = set()
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return names
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
    return names


def run_checks(code, checks):
    """
    checks = {"must_use": [...], "must_not_use": [...], "must_define": [...]}
    Элементы must_use / must_not_use — имена, ключевые слова, операторы ("for", "len", "//", "%")
    или специальное значение "f-string". Возвращает список сообщений о нарушениях (пустой = всё ок).
    """
    if not checks:
        return []
    names, ops, has_f = _scan_tokens(code)

    def used(item):
        if item == "f-string":
            return has_f
        return item in names or item in ops

    failed = []
    missing = [x for x in checks.get("must_use", []) if not used(x)]
    if missing:
        failed.append("В решении нужно использовать: " + ", ".join(f"`{x}`" for x in missing))
    forbidden = [x for x in checks.get("must_not_use", []) if used(x)]
    if forbidden:
        failed.append("В этой задаче нельзя использовать: " + ", ".join(f"`{x}`" for x in forbidden))
    if checks.get("must_define"):
        defined = _defined_names(code)
        nodef = [x for x in checks["must_define"] if x not in defined]
        if nodef:
            failed.append("Нужно определить функцию или класс с именем: " + ", ".join(f"`{x}`" for x in nodef))
    return failed


# ----------------------------------------------------------------------------
# Проверка задачи целиком
# ----------------------------------------------------------------------------

def check_task(code, task):
    """
    task — словарь задачи из lesson.json (нужны поля tests, checks, compare).
    Возвращает:
      {"passed": bool, "syntax_error": {...}|None, "checks_failed": [...],
       "results": [{"index", "visible", "ok", "detail", "input", "expected", "stdout",
                    "error", "error_type", "line", "friendly"}]}
    """
    out = {"passed": False, "syntax_error": None, "checks_failed": [], "results": []}
    if not code or not code.strip():
        out["checks_failed"] = ["Редактор пуст — напиши решение."]
        return out

    try:
        compile(code, FILENAME_MAIN, "exec")
    except SyntaxError as e:
        etype = type(e).__name__
        out["syntax_error"] = {
            "error_type": etype,
            "line": e.lineno,
            "text": (e.text or "").strip(),
            "error": f"{etype}: {e.msg} (строка {e.lineno})",
            "friendly": explain_error(etype, e.msg, line=e.lineno),
        }
        return out

    out["checks_failed"] = run_checks(code, task.get("checks") or {})
    mode = task.get("compare", "exact")
    all_ok = not out["checks_failed"]

    for i, t in enumerate(task.get("tests", [])):
        want = list((t.get("output_files") or {}).keys())
        r = run_program(
            code, t.get("input", ""),
            code_before=t.get("code_before", ""), code_after=t.get("code_after", ""),
            files=t.get("files"), want_files=want, echo_prompts=False,
        )
        ok, detail = r["ok"], ""
        if not ok:
            detail = r["friendly"] or r["error"]
        else:
            if t.get("output") is not None:
                ok, detail = compare_output(t["output"], r["stdout"], mode)
            if ok:
                for name, expected in (t.get("output_files") or {}).items():
                    got = r["files"].get(name)
                    if got is None:
                        ok, detail = False, f"Файл `{name}` не создан"
                        break
                    ok, d = compare_output(expected, got, mode)
                    if not ok:
                        detail = f"Файл `{name}`: {d}"
                        break
        out["results"].append({
            "index": i, "visible": bool(t.get("visible")), "ok": ok, "detail": detail,
            "input": t.get("input", ""), "expected": t.get("output"), "stdout": r["stdout"],
            "error": r["error"], "error_type": r["error_type"], "line": r["line"],
            "friendly": r["friendly"], "files": r["files"],
        })
        all_ok = all_ok and ok
    out["passed"] = all_ok
    return out


# ----------------------------------------------------------------------------
# JSON-обёртки (для вызова из JavaScript / подпроцессов)
# ----------------------------------------------------------------------------

def run_program_json(code, stdin="", options_json="{}"):
    opts = json.loads(options_json or "{}")
    return json.dumps(run_program(code, stdin, **opts), ensure_ascii=False)


def check_task_json(code, task_json):
    return json.dumps(check_task(code, json.loads(task_json)), ensure_ascii=False)
