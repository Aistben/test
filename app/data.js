window.PY_TRAINER_DATA = {
 "built": "2026-09-06 15:40",
 "pyodide": {
  "version": "0.26.4",
  "cdn": "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/"
 },
 "harness": "# -*- coding: utf-8 -*-\n\"\"\"\nharness.py — единый «прогонщик» кода ученика.\n\nОдин и тот же файл используется в двух местах:\n  1) в браузере (Pyodide) — приложением-тренажёром при нажатии «Запустить» / «Проверить»;\n  2) локально (CPython 3.10+) — валидатором уроков tools/validate_lessons.py.\n\nПоэтому здесь ТОЛЬКО стандартная библиотека и ничего специфичного для одной среды.\n\nГлавные функции:\n  run_program(code, stdin, ...)   — выполнить программу, вернуть вывод / ошибку.\n  check_task(code, task)          — прогнать код по всем тестам задачи (формат lesson.json).\n  compare_output(expected, got)   — сравнить ожидаемый и полученный вывод.\n  run_checks(code, checks)        — статические проверки (must_use / must_not_use / must_define).\n  explain_error(error_type, msg)  — понятное объяснение ошибки по-русски.\n\nJSON-обёртки для вызова из JavaScript: run_program_json(), check_task_json().\n\"\"\"\n\nimport ast\nimport builtins\nimport contextlib\nimport io\nimport json\nimport os\nimport shutil\nimport sys\nimport tempfile\nimport tokenize\nimport traceback\n\nOUTPUT_LIMIT = 200_000          # символов вывода на один запуск\nFILENAME_MAIN = \"main.py\"       # так называется файл ученика в traceback\nFILENAME_BEFORE = \"<подготовка>\"\nFILENAME_AFTER = \"<проверка>\"\n\n\n# ----------------------------------------------------------------------------\n# Вывод и ввод\n# ----------------------------------------------------------------------------\n\nclass OutputLimitExceeded(Exception):\n    \"\"\"Программа напечатала слишком много (скорее всего, бесконечный цикл).\"\"\"\n\n\nclass _LimitedOutput(io.StringIO):\n    def __init__(self, limit):\n        super().__init__()\n        self._limit = limit\n        self._size = 0\n\n    def write(self, s):\n        s = str(s)\n        if self._size + len(s) > self._limit:\n            super().write(s[: max(0, self._limit - self._size)])\n            self._size = self._limit\n            raise OutputLimitExceeded()\n        self._size += len(s)\n        return super().write(s)\n\n\nclass _InputState:\n    \"\"\"Счётчики для сообщений вида «программа не прочитала все данные».\"\"\"\n    def __init__(self, total_lines):\n        self.total_lines = total_lines\n        self.calls = 0\n\n\ndef _make_input(out, echo_prompts, state):\n    def _input(prompt=\"\"):\n        state.calls += 1\n        line = sys.stdin.readline()\n        if line == \"\":\n            raise EOFError(\"нет данных для input()\")\n        line = line.rstrip(\"\\n\")\n        if echo_prompts:\n            # Режим «Запустить»: показываем как в терминале — подсказку и введённую строку.\n            out.write(str(prompt) + line + \"\\n\")\n        return line\n    return _input\n\n\n# ----------------------------------------------------------------------------\n# Запуск программы\n# ----------------------------------------------------------------------------\n\ndef run_program(code, stdin=\"\", *, code_before=\"\", code_after=\"\", files=None,\n                want_files=None, echo_prompts=False, output_limit=OUTPUT_LIMIT):\n    \"\"\"\n    Выполняет код ученика в чистом пространстве имён и временной папке.\n\n    code          — код ученика (файл main.py).\n    stdin         — текст, который будет читаться через input() / sys.stdin.\n    code_before   — код, выполняемый ДО кода ученика в том же пространстве имён\n                    (подготовка данных). Номера строк ученика не сдвигаются.\n    code_after    — код, выполняемый ПОСЛЕ (например, вызов функции ученика).\n    files         — {имя: содержимое}: файлы, создаваемые в рабочей папке до запуска.\n    want_files    — список имён файлов, содержимое которых нужно вернуть после запуска.\n    echo_prompts  — True: подсказка input() и введённая строка попадают в вывод\n                    (режим «Запустить»); False: не попадают (режим «Проверить»).\n\n    Возвращает dict:\n      ok, stdout, exited, error, error_type, line, where, friendly, files,\n      input_calls, input_total\n    \"\"\"\n    result = {\n        \"ok\": True, \"stdout\": \"\", \"exited\": False,\n        \"error\": None, \"error_type\": None, \"line\": None, \"where\": None,\n        \"friendly\": None, \"files\": {},\n        \"input_calls\": 0, \"input_total\": 0,\n    }\n    stdin = stdin or \"\"\n    state = _InputState(len(stdin.splitlines()))\n    out = _LimitedOutput(output_limit)\n    ns = {\"__name__\": \"__main__\", \"__builtins__\": builtins}\n\n    old_cwd = os.getcwd()\n    old_stdin, old_input = sys.stdin, builtins.input\n    old_argv = sys.argv\n    old_modules = set(sys.modules)\n    tmp = tempfile.mkdtemp(prefix=\"run_\")\n    try:\n        os.chdir(tmp)\n        # Чтобы `import helpers` находил файлы задачи (files={\"helpers.py\": ...})\n        # одинаково и в Pyodide, и в CPython, где sys.path[0] — папка скрипта.\n        sys.path.insert(0, tmp)\n        for name, content in (files or {}).items():\n            d = os.path.dirname(name)\n            if d:\n                os.makedirs(d, exist_ok=True)\n            with open(name, \"w\", encoding=\"utf-8\", newline=\"\") as f:\n                f.write(content)\n\n        sys.stdin = io.StringIO(stdin)\n        sys.argv = [FILENAME_MAIN]\n        builtins.input = _make_input(out, echo_prompts, state)\n\n        parts = (\n            (\"before\", code_before, FILENAME_BEFORE),\n            (\"main\", code, FILENAME_MAIN),\n            (\"after\", code_after, FILENAME_AFTER),\n        )\n        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):\n            for where, src, fname in parts:\n                if not src:\n                    continue\n                try:\n                    exec(compile(src, fname, \"exec\"), ns)\n                except SystemExit:\n                    result[\"exited\"] = True\n                    break\n                except BaseException as e:  # noqa: B902 — нужно ловить всё, включая RecursionError\n                    _fill_error(result, e, where, state)\n                    break\n    finally:\n        result[\"stdout\"] = out.getvalue()\n        result[\"input_calls\"] = state.calls\n        result[\"input_total\"] = state.total_lines\n        for name in (want_files or []):\n            try:\n                with open(name, \"r\", encoding=\"utf-8\") as f:\n                    result[\"files\"][name] = f.read()\n            except OSError:\n                result[\"files\"][name] = None\n        sys.stdin, builtins.input, sys.argv = old_stdin, old_input, old_argv\n        # Убираем модули, импортированные из временной папки, чтобы следующий тест\n        # с другим содержимым helpers.py не получил закешированную версию.\n        for name in set(sys.modules) - old_modules:\n            mod = sys.modules.get(name)\n            mfile = getattr(mod, \"__file__\", None) or \"\"\n            if mfile.startswith(tmp):\n                del sys.modules[name]\n        try:\n            sys.path.remove(tmp)\n        except ValueError:\n            pass\n        os.chdir(old_cwd)\n        shutil.rmtree(tmp, ignore_errors=True)\n    return result\n\n\ndef _fill_error(result, e, where, state):\n    etype = type(e).__name__\n    msg = str(e)\n    line = None\n    text = \"\"\n\n    if isinstance(e, OutputLimitExceeded):\n        etype, msg = \"OutputLimitExceeded\", \"слишком много вывода\"\n    elif isinstance(e, SyntaxError):\n        msg = e.msg or msg\n        text = (e.text or \"\").strip()\n        if e.filename == FILENAME_MAIN:\n            line = e.lineno\n    else:\n        for fr in reversed(traceback.extract_tb(e.__traceback__)):\n            if fr.filename == FILENAME_MAIN:\n                line = fr.lineno\n                text = (fr.line or \"\").strip()\n                break\n\n    result[\"ok\"] = False\n    result[\"error_type\"] = etype\n    result[\"error\"] = _format_error(e, etype, msg, line, text, where)\n    result[\"line\"] = line\n    result[\"where\"] = where\n    result[\"friendly\"] = explain_error(etype, msg, line=line, where=where,\n                                       input_total=state.total_lines,\n                                       input_calls=state.calls)\n\n\ndef _format_error(e, etype, msg, line, text, where):\n    lines = []\n    if where == \"after\":\n        lines.append(\"Ошибка возникла, когда проверка вызвала ваш код:\")\n    elif where == \"before\":\n        lines.append(\"Ошибка в подготовительном коде задачи (сообщите автору урока):\")\n    if isinstance(e, SyntaxError):\n        if line is not None:\n            lines.append(f'  Файл \"{FILENAME_MAIN}\", строка {line}')\n            if text:\n                lines.append(\"    \" + text)\n        lines.append(f\"{etype}: {msg}\")\n    else:\n        frames = [fr for fr in traceback.extract_tb(e.__traceback__) if fr.filename == FILENAME_MAIN]\n        if frames:\n            lines.append(\"Traceback (последний вызов — внизу):\")\n            for fr in frames:\n                lines.append(f'  Файл \"{FILENAME_MAIN}\", строка {fr.lineno}, в {fr.name}')\n                if fr.line:\n                    lines.append(\"    \" + fr.line.strip())\n        lines.append(f\"{etype}: {msg}\" if msg else etype)\n    return \"\\n\".join(lines)\n\n\n# ----------------------------------------------------------------------------\n# Понятные объяснения ошибок\n# ----------------------------------------------------------------------------\n\ndef explain_error(etype, msg, line=None, where=None, input_total=None, input_calls=None):\n    \"\"\"Возвращает короткое объяснение ошибки по-русски (строка) или None.\"\"\"\n    m = msg or \"\"\n    ml = m.lower()\n    where_note = \"\"\n    if line is not None:\n        where_note = f\" (строка {line})\"\n\n    def q(s):\n        return f\"`{s}`\"\n\n    if etype == \"OutputLimitExceeded\":\n        return \"Программа вывела слишком много текста — почти наверняка бесконечный цикл. \" \\\n               \"Проверь условие while и то, что переменная-счётчик меняется.\"\n    if etype == \"KeyboardInterrupt\":\n        return \"Выполнение остановлено по лимиту времени. Похоже на бесконечный цикл: \" \\\n               \"проверь условие while и изменение счётчика внутри цикла.\"\n    if etype == \"EOFError\":\n        n = input_total if input_total is not None else \"?\"\n        k = input_calls if input_calls is not None else \"?\"\n        return f\"Программа вызвала input() {k}-й раз, а строк во входных данных всего {n}. \" \\\n               \"Читай ровно столько строк, сколько описано в условии; лишний input() — ошибка.\"\n    if etype == \"SyntaxError\":\n        if \"was never closed\" in ml:\n            return f\"Не закрыта скобка{where_note}: у каждой ( [ {{ должна быть пара ) ] }}.\"\n        if \"unterminated string\" in ml or \"eol while scanning\" in ml:\n            return f\"Не закрыта кавычка строки{where_note}: у текста должны быть кавычки с обеих сторон.\"\n        if \"expected ':'\" in ml:\n            return f\"Пропущено двоеточие{where_note}: после if / elif / else / for / while / def нужен символ `:`.\"\n        if \"maybe you meant '==' or ':='\" in ml or \"cannot assign to\" in ml:\n            return f\"В условии сравнение записывается как `==`, а `=` — это присваивание{where_note}.\"\n        if \"perhaps you forgot a comma\" in ml:\n            return f\"Похоже, пропущена запятая между элементами{where_note}.\"\n        if \"unmatched\" in ml or \"closing parenthesis\" in ml:\n            return f\"Лишняя или несогласованная закрывающая скобка{where_note}.\"\n        if \"invalid decimal literal\" in ml or \"invalid character\" in ml:\n            return f\"Недопустимый символ{where_note}: имя переменной не может начинаться с цифры, \" \\\n                   \"а в коде не должно быть «умных» кавычек « » “ ” или русских букв вне строк.\"\n        if \"'return' outside function\" in ml:\n            return \"`return` можно писать только внутри функции (внутри блока def).\"\n        if \"'break' outside loop\" in ml or \"'continue' not properly in loop\" in ml:\n            return \"`break` и `continue` работают только внутри цикла for / while.\"\n        if \"print\" in ml and \"missing parentheses\" in ml:\n            return \"В Python 3 print — это функция: пиши `print(...)` со скобками.\"\n        return f\"Синтаксическая ошибка{where_note}: Python не смог прочитать эту строку. \" \\\n               \"Проверь скобки, кавычки, двоеточия и лишние символы. \" \\\n               \"Часто ошибка на самом деле строкой выше.\"\n    if etype == \"IndentationError\":\n        if \"expected an indented block\" in ml:\n            return f\"После строки с двоеточием нужен отступ{where_note}: тело if / for / def \" \\\n                   \"сдвигается на 4 пробела.\"\n        if \"unexpected indent\" in ml:\n            return f\"Лишний отступ{where_note}: строка сдвинута, хотя блок не начинался.\"\n        if \"unindent does not match\" in ml:\n            return f\"Отступы не совпадают{where_note}: все строки одного блока должны иметь \" \\\n                   \"одинаковый сдвиг (используй 4 пробела).\"\n        return f\"Ошибка отступов{where_note}: проверь, что блоки сдвинуты ровно на 4 пробела.\"\n    if etype == \"TabError\":\n        return \"В файле смешаны табы и пробелы. Используй только пробелы (4 на уровень).\"\n    if etype == \"NameError\":\n        name = _between(m, \"name '\", \"'\")\n        hint = \"\"\n        if name in (\"true\", \"false\", \"none\"):\n            hint = \" В Python пишется с большой буквы: True, False, None.\"\n        elif name in (\"Print\", \"PRINT\", \"Input\", \"Len\", \"Range\", \"Int\", \"Str\"):\n            hint = \" Встроенные функции пишутся с маленькой буквы.\"\n        return f\"Имя {q(name)} не определено{where_note}: такая переменная или функция ещё не создана. \" \\\n               f\"Проверь опечатку и порядок строк — создать переменную нужно ДО использования.{hint}\"\n    if etype == \"UnboundLocalError\":\n        name = _between(m, \"'\", \"'\")\n        return f\"Переменная {q(name)} используется внутри функции до присваивания. \" \\\n               \"Внутри функции создаётся своя локальная переменная — передай значение параметром \" \\\n               \"или верни его через return.\"\n    if etype == \"TypeError\":\n        if \"can only concatenate str\" in ml or (\"unsupported operand\" in ml and \"str\" in ml):\n            return f\"Нельзя складывать строку и число{where_note}. Преобразуй: `int(...)` для расчёта \" \\\n                   \"или `str(...)` / f-строку для вывода.\"\n        if \"not supported between instances\" in ml:\n            return f\"Нельзя сравнивать значения разных типов{where_note} (например, строку и число). \" \\\n                   \"Данные из input() — всегда строка: примени int() или float().\"\n        if \"object is not subscriptable\" in ml:\n            return f\"К этому значению нельзя обращаться по индексу [ ]{where_note}: скорее всего, \" \\\n                   \"это число или None, а не список/строка.\"\n        if \"does not support item assignment\" in ml:\n            return f\"Этот тип нельзя менять по индексу{where_note}. Строки и кортежи неизменяемы — \" \\\n                   \"создай новое значение или используй список.\"\n        if \"object is not callable\" in ml:\n            return f\"Ты вызываешь как функцию то, что функцией не является{where_note}. Частая причина: \" \\\n                   \"переменная названа как функция (`print`, `len`, `sum`, `input`) и перекрыла её.\"\n        if \"object is not iterable\" in ml:\n            return f\"Перебирать циклом for можно список, строку, range и т. п., но не число{where_note}. \" \\\n                   \"Возможно, нужно `range(n)`.\"\n        if \"positional argument\" in ml or \"required positional\" in ml or \"takes\" in ml and \"given\" in ml:\n            return f\"Функция вызвана с неверным числом аргументов{where_note}: сравни def и вызов.\"\n        if \"must be str, not\" in ml:\n            return f\"Ожидалась строка, а передано число{where_note}: используй str(...) или f-строку.\"\n        if \"'nonetype'\" in ml:\n            return f\"Значение None{where_note}: обычно функция ничего не вернула (забыт return) \" \\\n                   \"или ты присвоил результат метода, который меняет объект на месте (.sort(), .append()).\"\n        if \"string indices must be integers\" in ml or \"list indices must be integers\" in ml:\n            return f\"Индекс должен быть целым числом{where_note}, а не строкой или float. \" \\\n                   \"Данные из input() — строка: примени int().\"\n        return f\"Ошибка типов{where_note}: операция не подходит для этих типов данных. \" \\\n               \"Проверь, что где нужно число — число (int/float), а где текст — строка.\"\n    if etype == \"ValueError\":\n        if \"invalid literal for int()\" in ml:\n            bad = _between(m, \": '\", \"'\")\n            return f\"int() не смог превратить {q(bad)} в целое число{where_note}. В строке есть не только \" \\\n                   \"цифры: пробелы, буквы, точка (для дробных нужен float()) или она пустая.\"\n        if \"could not convert string to float\" in ml:\n            return f\"float() не смог прочитать число{where_note}: проверь, что дробная часть отделена \" \\\n                   \"точкой, а не запятой, и нет лишних символов.\"\n        if \"not enough values to unpack\" in ml or \"too many values to unpack\" in ml:\n            return f\"Количество переменных слева от `=` не совпадает с количеством значений справа{where_note}.\"\n        if \"is not in list\" in ml:\n            return f\"list.remove(): такого элемента нет в списке{where_note}. Проверь через `in` перед удалением.\"\n        if \"substring not found\" in ml:\n            return f\"index(): подстрока не найдена{where_note}. Используй find() — он вернёт -1 вместо ошибки.\"\n        if \"math domain error\" in ml:\n            return f\"Математическая функция получила недопустимый аргумент{where_note} \" \\\n                   \"(например, корень из отрицательного числа).\"\n        return f\"Некорректное значение{where_note}: функция получила правильный тип, но неподходящее значение.\"\n    if etype == \"ZeroDivisionError\":\n        return f\"Деление на ноль{where_note}. Перед делением проверь делитель: `if b != 0:`.\"\n    if etype == \"IndexError\":\n        return f\"Индекс за пределами последовательности{where_note}. Индексы идут от 0 до len(x) - 1; \" \\\n               \"проверь границы цикла и пустые списки.\"\n    if etype == \"KeyError\":\n        return f\"В словаре нет ключа {m}{where_note}. Проверь наличие через `in` или используй \" \\\n               \"`.get(ключ, значение_по_умолчанию)`.\"\n    if etype == \"AttributeError\":\n        if \"'nonetype'\" in ml:\n            return f\"Обращение к None{where_note}: функция ничего не вернула (нет return) или методы \" \\\n                   \".sort() / .append() / .reverse() возвращают None — не присваивай их результат.\"\n        obj = _between(m, \"'\", \"'\")\n        attr = _between(m, \"attribute '\", \"'\")\n        return f\"У значения типа {q(obj)} нет метода или атрибута {q(attr)}{where_note}. \" \\\n               \"Проверь название (например, у списка метод append, а не push/add).\"\n    if etype == \"RecursionError\":\n        return \"Слишком глубокая рекурсия: функция вызывает сама себя без условия остановки.\"\n    if etype == \"ModuleNotFoundError\" or etype == \"ImportError\":\n        return f\"Модуль не найден{where_note}. В тренажёре доступна стандартная библиотека Python \" \\\n               \"(random, math, datetime, json, csv, os, pathlib и др.) — проверь имя модуля.\"\n    if etype == \"FileNotFoundError\":\n        return f\"Файл не найден{where_note}. Проверь имя файла (регистр букв, расширение) и режим \" \\\n               \"открытия: для чтения файл должен существовать заранее.\"\n    if etype == \"PermissionError\" or etype == \"IsADirectoryError\":\n        return f\"Нет доступа к файлу или это папка{where_note}.\"\n    if etype == \"OverflowError\":\n        return f\"Число слишком большое для этой операции{where_note}.\"\n    if etype == \"MemoryError\":\n        return \"Не хватило памяти — вероятно, список растёт бесконечно.\"\n    if etype == \"AssertionError\":\n        return f\"assert не выполнился{where_note}: условие оказалось ложным.\"\n    if etype == \"StopIteration\":\n        return f\"Итератор закончился{where_note}: next() вызван, когда элементов больше нет.\"\n    return None\n\n\ndef _between(s, left, right):\n    i = s.find(left)\n    if i < 0:\n        return \"?\"\n    j = s.find(right, i + len(left))\n    if j < 0:\n        return s[i + len(left):]\n    return s[i + len(left):j]\n\n\n# ----------------------------------------------------------------------------\n# Сравнение вывода\n# ----------------------------------------------------------------------------\n\ndef normalize_lines(text):\n    text = (text or \"\").replace(\"\\r\\n\", \"\\n\").replace(\"\\r\", \"\\n\")\n    lines = [ln.rstrip() for ln in text.split(\"\\n\")]\n    while lines and lines[-1] == \"\":\n        lines.pop()\n    return lines\n\n\ndef _num(s):\n    try:\n        return float(s.replace(\",\", \".\")) if s.count(\",\") == 1 and \".\" not in s else float(s)\n    except ValueError:\n        return None\n\n\ndef compare_output(expected, actual, mode=\"exact\"):\n    \"\"\"\n    mode = \"exact\"  — построчно; концевые пробелы строк и пустые строки в конце игнорируются.\n    mode = \"tokens\" — сравнение по «словам» (любые пробелы/переводы строк), числа с допуском 1e-6.\n    Возвращает (ok, описание_расхождения).\n    \"\"\"\n    if mode == \"tokens\":\n        et, at = (expected or \"\").split(), (actual or \"\").split()\n        if len(et) != len(at):\n            return False, f\"Ожидалось значений: {len(et)}, получено: {len(at)}\"\n        for i, (e, a) in enumerate(zip(et, at)):\n            en, an = _num(e), _num(a)\n            if en is not None and an is not None:\n                if abs(en - an) > 1e-6 * max(1.0, abs(en)):\n                    return False, f\"Значение №{i + 1}: ожидалось {e}, получено {a}\"\n            elif e != a:\n                return False, f\"Значение №{i + 1}: ожидалось {e!r}, получено {a!r}\"\n        return True, \"\"\n\n    exp, act = normalize_lines(expected), normalize_lines(actual)\n    if exp == act:\n        return True, \"\"\n    for i, (e, a) in enumerate(zip(exp, act)):\n        if e != a:\n            extra = \"\"\n            if e.strip() == a.strip():\n                extra = \" (отличаются пробелы в начале строки)\"\n            elif e.lower() == a.lower():\n                extra = \" (отличается регистр букв)\"\n            elif e.replace(\" \", \"\") == a.replace(\" \", \"\"):\n                extra = \" (отличаются пробелы)\"\n            return False, f\"Строка {i + 1}: ожидалось {e!r}, получено {a!r}{extra}\"\n    if len(exp) > len(act):\n        return False, f\"Не хватает строк вывода: ожидалось {len(exp)}, получено {len(act)}\"\n    return False, f\"Лишние строки вывода: ожидалось {len(exp)}, получено {len(act)}\"\n\n\n# ----------------------------------------------------------------------------\n# Статические проверки кода\n# ----------------------------------------------------------------------------\n\ndef _scan_tokens(code):\n    names, ops, has_fstring = set(), set(), False\n    try:\n        for tok in tokenize.generate_tokens(io.StringIO(code).readline):\n            tname = tokenize.tok_name.get(tok.type, \"\")\n            if tok.type == tokenize.NAME:\n                names.add(tok.string)\n            elif tok.type == tokenize.OP:\n                ops.add(tok.string)\n            elif tok.type == tokenize.STRING:\n                prefix = tok.string[:2].lower()\n                if \"f\" in prefix.rstrip(\"'\\\"\"):\n                    has_fstring = True\n            elif tname == \"FSTRING_START\":\n                has_fstring = True\n    except (tokenize.TokenError, SyntaxError, IndentationError):\n        pass\n    return names, ops, has_fstring\n\n\ndef _defined_names(code):\n    names = set()\n    try:\n        tree = ast.parse(code)\n    except SyntaxError:\n        return names\n    for node in ast.walk(tree):\n        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):\n            names.add(node.name)\n    return names\n\n\ndef run_checks(code, checks):\n    \"\"\"\n    checks = {\"must_use\": [...], \"must_not_use\": [...], \"must_define\": [...]}\n    Элементы must_use / must_not_use — имена, ключевые слова, операторы (\"for\", \"len\", \"//\", \"%\")\n    или специальное значение \"f-string\". Возвращает список сообщений о нарушениях (пустой = всё ок).\n    \"\"\"\n    if not checks:\n        return []\n    names, ops, has_f = _scan_tokens(code)\n\n    def used(item):\n        if item == \"f-string\":\n            return has_f\n        return item in names or item in ops\n\n    failed = []\n    missing = [x for x in checks.get(\"must_use\", []) if not used(x)]\n    if missing:\n        failed.append(\"В решении нужно использовать: \" + \", \".join(f\"`{x}`\" for x in missing))\n    forbidden = [x for x in checks.get(\"must_not_use\", []) if used(x)]\n    if forbidden:\n        failed.append(\"В этой задаче нельзя использовать: \" + \", \".join(f\"`{x}`\" for x in forbidden))\n    if checks.get(\"must_define\"):\n        defined = _defined_names(code)\n        nodef = [x for x in checks[\"must_define\"] if x not in defined]\n        if nodef:\n            failed.append(\"Нужно определить функцию или класс с именем: \" + \", \".join(f\"`{x}`\" for x in nodef))\n    return failed\n\n\n# ----------------------------------------------------------------------------\n# Проверка задачи целиком\n# ----------------------------------------------------------------------------\n\ndef check_task(code, task):\n    \"\"\"\n    task — словарь задачи из lesson.json (нужны поля tests, checks, compare).\n    Возвращает:\n      {\"passed\": bool, \"syntax_error\": {...}|None, \"checks_failed\": [...],\n       \"results\": [{\"index\", \"visible\", \"ok\", \"detail\", \"input\", \"expected\", \"stdout\",\n                    \"error\", \"error_type\", \"line\", \"friendly\"}]}\n    \"\"\"\n    out = {\"passed\": False, \"syntax_error\": None, \"checks_failed\": [], \"results\": []}\n    if not code or not code.strip():\n        out[\"checks_failed\"] = [\"Редактор пуст — напиши решение.\"]\n        return out\n\n    try:\n        compile(code, FILENAME_MAIN, \"exec\")\n    except SyntaxError as e:\n        etype = type(e).__name__\n        out[\"syntax_error\"] = {\n            \"error_type\": etype,\n            \"line\": e.lineno,\n            \"text\": (e.text or \"\").strip(),\n            \"error\": f\"{etype}: {e.msg} (строка {e.lineno})\",\n            \"friendly\": explain_error(etype, e.msg, line=e.lineno),\n        }\n        return out\n\n    out[\"checks_failed\"] = run_checks(code, task.get(\"checks\") or {})\n    mode = task.get(\"compare\", \"exact\")\n    all_ok = not out[\"checks_failed\"]\n\n    for i, t in enumerate(task.get(\"tests\", [])):\n        want = list((t.get(\"output_files\") or {}).keys())\n        r = run_program(\n            code, t.get(\"input\", \"\"),\n            code_before=t.get(\"code_before\", \"\"), code_after=t.get(\"code_after\", \"\"),\n            files=t.get(\"files\"), want_files=want, echo_prompts=False,\n        )\n        ok, detail = r[\"ok\"], \"\"\n        if not ok:\n            detail = r[\"friendly\"] or r[\"error\"]\n        else:\n            if t.get(\"output\") is not None:\n                ok, detail = compare_output(t[\"output\"], r[\"stdout\"], mode)\n            if ok:\n                for name, expected in (t.get(\"output_files\") or {}).items():\n                    got = r[\"files\"].get(name)\n                    if got is None:\n                        ok, detail = False, f\"Файл `{name}` не создан\"\n                        break\n                    ok, d = compare_output(expected, got, mode)\n                    if not ok:\n                        detail = f\"Файл `{name}`: {d}\"\n                        break\n        out[\"results\"].append({\n            \"index\": i, \"visible\": bool(t.get(\"visible\")), \"ok\": ok, \"detail\": detail,\n            \"input\": t.get(\"input\", \"\"), \"expected\": t.get(\"output\"), \"stdout\": r[\"stdout\"],\n            \"error\": r[\"error\"], \"error_type\": r[\"error_type\"], \"line\": r[\"line\"],\n            \"friendly\": r[\"friendly\"], \"files\": r[\"files\"],\n        })\n        all_ok = all_ok and ok\n    out[\"passed\"] = all_ok\n    return out\n\n\n# ----------------------------------------------------------------------------\n# JSON-обёртки (для вызова из JavaScript / подпроцессов)\n# ----------------------------------------------------------------------------\n\ndef run_program_json(code, stdin=\"\", options_json=\"{}\"):\n    opts = json.loads(options_json or \"{}\")\n    return json.dumps(run_program(code, stdin, **opts), ensure_ascii=False)\n\n\ndef check_task_json(code, task_json):\n    return json.dumps(check_task(code, json.loads(task_json)), ensure_ascii=False)\n",
 "plan": "================================================================================\n  PYTHON: ПЛАН ОБУЧЕНИЯ, ЧЕКЛИСТЫ И ЖУРНАЛ ПРОГРЕССА\n================================================================================\n\nФайл создан:           2026-09-05\nПоследнее обновление:  2026-09-05\nЦель:                  освоить Python и выйти на удалённую работу\nТекущий этап:          Этап 1 (основы) — почти завершён\nСледующий шаг:         закрыть чеклист этапа 1 (раздел 2) -> «Мостик» (раздел 3)\n                       -> первые проекты (раздел 4) -> выбор ветки (раздел 5)\n\nЧто это за файл:\n  - Единственный «источник правды» о том, где я нахожусь в обучении.\n  - Учебное веб-приложение с редактором сделано отдельно (не в этом репозитории).\n    (устарело с 2026-09-05: приложение переехало сюда — index.html + app/,\n    данные уроков в content/, сборка tools/build_site.py)\n    Здесь хранятся план, отметки о прогрессе и мои самостоятельные проекты.\n  - Отмечай пройденное: [ ] -> [x]. Каждое занятие — строка в дневнике (раздел 9).\n  - Правила внесения изменений в файл и репозиторий — раздел 10.\n\nСОДЕРЖАНИЕ\n   1. Честно о сроках и почему Python\n   2. ГДЕ Я СЕЙЧАС: чеклист этапа 1\n   3. ЧТО ДЕЛАТЬ ДАЛЬШЕ: «Мостик» между основами и веткой\n   4. Первые самостоятельные проекты (кладём в этот репозиторий)\n   5. Этап 2: выбор ветки (A / B / C) и рекомендация\n   6. Этап 3: портфолио и заказы\n   7. Ресурсы (бесплатные, на русском)\n   8. Как учиться, чтобы не сгореть + чего НЕ делать\n   9. Дневник прогресса\n  10. ИНСТРУКЦИЯ ДЛЯ БУДУЩИХ ИЗМЕНЕНИЙ (для меня и для ИИ-помощника)\n\n\n================================================================================\n  1. ЧЕСТНО О СРОКАХ И ПОЧЕМУ PYTHON\n================================================================================\n\nСроки (при 1–2 часах каждый день):\n  - 1.5–2 месяца   — свободно пишешь скрипты, понимаешь логику.\n  - 3–4 месяца     — умеешь один «сэндвич» (бэкенд ИЛИ автоматизация)\n                     -> можно брать мелкие заказы.\n  - 6–12 месяцев   — уровень для первой удалённой работы.\n\nНе гонись за «деньгами за 2 недели» — гонись за УМЕНИЕМ за 2 недели.\n\nПочему Python:\n  - Простой язык для входа, логика видна сразу.\n  - Огромный спрос: бэкенд, аналитика, автоматизация, боты, парсинг, ИИ.\n  - Первые заказы на фрилансе реально брать уже на раннем этапе.\n  - Удалённых вакансий больше, чем кажется.\n\n\n================================================================================\n  2. ГДЕ Я СЕЙЧАС: ЧЕКЛИСТ ЭТАПА 1 — ОСНОВЫ (1.5–2 месяца)\n================================================================================\n\nПравило отметки: [x] ставится только если могу написать это РУКАМИ, без\nподглядывания в конспект и без ИИ. «Понял, когда прочитал» — это ещё не [x].\n\nТемы:\n  [ ] Переменные, типы данных (int, float, str, bool), преобразование типов\n  [ ] Ввод/вывод: print(), input(), f-строки\n  [ ] Условия: if / elif / else, логические операторы and / or / not\n  [ ] Циклы: for, while, range(), break / continue\n  [ ] Функции: def, параметры, return, значения по умолчанию, область видимости\n  [ ] Списки: индексы, срезы, append / pop / sort / len, перебор, вложенные списки\n  [ ] Словари: ключ -> значение, get(), items(), перебор, словарь списков\n  [ ] Строки: split / join / strip / replace / upper / find, срезы, in\n  [ ] Числа: // % ** round() abs() min() max() sum()\n  [ ] Работа с файлами: open(), режимы r / w / a, with ... as, чтение построчно\n\nМини-задачи (каждая написана самостоятельно и доведена до рабочего состояния):\n  [ ] Калькулятор (4 действия, защита от деления на ноль)\n  [ ] Генератор паролей (длина и набор символов задаются)\n  [ ] Переводчик температуры (C <-> F, в обе стороны)\n  [ ] Игра «угадай число» (со счётчиком попыток и подсказками «больше/меньше»)\n\nЭкзамен «этап 1 закрыт» (30–40 минут, без подсказок):\n  Написать программу, которая читает текстовый файл со строками вида\n  «название;цена», считает общую сумму, находит самый дорогой товар и\n  записывает результат в другой файл. Ввод с ошибками (пустая строка,\n  цена не число) не должен ронять программу.\n  [ ] Сдал сам себе -> этап 1 закрыт, переходим к разделу 3.\n\n\n================================================================================\n  3. ЧТО ДЕЛАТЬ ДАЛЬШЕ: «МОСТИК» (2–4 недели)\n================================================================================\n\nЗачем: в списке этапа 1 нет вещей, без которых нельзя войти НИ В ОДНУ ветку\n(A, B или C). Их проходим сразу после основ, до выбора специализации.\n\n3.1. Рабочее место — САМОЕ ВАЖНОЕ, делать первой неделей\n  [ ] Установить Python 3.12+ с python.org (при установке галочка «Add to PATH»)\n  [ ] Установить VS Code + расширение «Python» (от Microsoft)\n  [ ] Запускать скрипты из терминала:  python main.py\n  [ ] pip: установить любую библиотеку, например  pip install requests\n  [ ] Виртуальное окружение:  python -m venv venv  и активация\n  [ ] Git из терминала на ЭТОМ репозитории: clone / add / commit / push\n      (команды — в разделе 10.3)\n  Почему: веб-редактор удобен для учёбы по темам, но заказы и работа — это\n  локальные файлы, сторонние библиотеки и терминал. Чем раньше привыкнешь,\n  тем меньше страха потом.\n\n3.2. Недостающие темы языка\n  [ ] Кортежи (tuple) и множества (set): чем отличаются от списка, когда что брать\n  [ ] Списковые включения (list comprehension), enumerate(), zip()\n  [ ] Ошибки и исключения: try / except / else / finally, чтение traceback\n  [ ] Модули и импорт: import, from ... import, свои модули, if __name__ == \"__main__\"\n  [ ] Стандартная библиотека: random, math, datetime, os, pathlib, json, csv\n  [ ] Основы ООП: class, __init__, self, методы, наследование (минимум —\n      чтобы читать чужой код и документацию библиотек)\n  [ ] *args / **kwargs, lambda, sorted(key=...)\n  [ ] Стиль кода PEP 8: осмысленные имена, отступы, комментарии, докстринги\n\n3.3. Мышление программиста (не темы, а привычки)\n  [ ] Читаю сообщение об ошибке САМ до того, как спросить ИИ\n  [ ] Разбиваю задачу на шаги (на бумаге / в комментариях) ДО написания кода\n  [ ] Умею найти нужное в docs.python.org и в документации библиотеки\n  [ ] ИИ — ревьюер («найди ошибки», «объясни, почему так»), а не автор кода за меня\n\nРесурс под этот раздел: Stepik «Поколение Python: курс для продвинутых»\n(бесплатный) — покрывает кортежи, множества, словари, модули, функции, файлы.\n\n\n================================================================================\n  4. ПЕРВЫЕ САМОСТОЯТЕЛЬНЫЕ ПРОЕКТЫ (2–3 недели, параллельно с «Мостиком»)\n================================================================================\n\nКаждый проект — отдельная папка  projects/NN_название/  с файлами:\n  main.py     — код\n  README.txt  — 5–10 строк: что делает, как запустить, чему научился, что не вышло\n\nПравила: один проект = 3–7 дней. Готово лучше, чем идеально. Коммит после\nкаждого работающего шага (не в конце). Порядок — от простого к сложному.\n\n  [ ] 01_todo               Список дел в консоли: добавить / показать / удалить /\n                            отметить выполненным, хранение в JSON-файле.\n                            Тренирует: списки, словари, функции, файлы, json.\n  [ ] 02_password_generator Генератор паролей с параметрами (длина, цифры,\n                            спецсимволы), сразу несколько штук.\n                            Тренирует: random, строки, модуль string.\n  [ ] 03_expenses           Учёт расходов: записи в CSV, сумма за месяц,\n                            топ-3 категории.\n                            Тренирует: csv, datetime, словари, сортировка.\n  [ ] 04_file_organizer     Раскладывает файлы из папки «Загрузки» по подпапкам\n                            по расширению (images / docs / archives ...).\n                            Тренирует: pathlib / os, исключения, ОСТОРОЖНОСТЬ\n                            (сначала тестировать на копии папки!).\n  [ ] 05_hangman            Игра «Виселица», слова берутся из текстового файла.\n                            Тренирует: циклы, строки, множества, логика.\n  [ ] 06_quiz               Викторина: вопросы в JSON, подсчёт очков,\n                            класс Question.\n                            Тренирует: ООП, json, структура программы.\n\nПосле 3–4 готовых проектов из этого списка -> раздел 5, выбор ветки.\n\n\n================================================================================\n  5. ЭТАП 2: ВЫБОР ВЕТКИ — ОДНОЙ\n================================================================================\n\nПосле основ выбрать ОДНУ. Не распыляться.\n\nВариант A — Автоматизация и скрипты (самый быстрый фриланс)\n  - Автообработка файлов (Excel, PDF, картинки).\n  - Почта, Telegram-боты.\n  - Парсинг сайтов (сбор данных).\n  - Старт заказов через 1–2 месяца. Идеально для первых денег.\n\nВариант B — Бэкенд-разработка (FastAPI / Django)\n  - Серверы, API, веб-приложения «за кулисами».\n  - Очень востребовано, хорошая удалёнка.\n  - Требует больше времени (3–5 мес. до первой работы).\n\nВариант C — Анализ данных\n  - Pandas, визуализация, таблицы и данные.\n  - Меньше «чистого кода», больше логики и таблиц.\n  - Путь длиннее, но область растёт.\n\n--------------------------------------------------------------------------------\nРЕКОМЕНДАЦИЯ (для цели «удалённая работа как можно раньше»):\n--------------------------------------------------------------------------------\n  Старт  -> Ветка A (автоматизация + парсинг + Telegram-боты).\n            Быстрее всего до первых заказов, результат виден сразу,\n            библиотеки простые, портфолио набирается за 1–2 месяца.\n  Потом  -> Ветка B (FastAPI -> базы данных -> Django).\n            У ботов и парсеров быстро возникает потребность в API и БД —\n            переход естественный. Удалённых вакансий больше всего у бэкенда.\n  Ветка C — если по ходу поймёшь, что копаться в таблицах и цифрах нравится\n            больше, чем строить программы. Переключиться нормально ПОСЛЕ\n            1–2 готовых проектов ветки A, а не вместо них.\n\nМой выбор ветки:  [ ] A   [ ] B   [ ] C     дата: __________\nПочему (2–3 предложения, обязательно): __________________________________\n\nВетка A — что учить, по порядку:\n  [ ] requests        — запросы к сайтам и API, работа с JSON-ответами\n  [ ] BeautifulSoup4  — разбор HTML (парсинг)\n  [ ] openpyxl        — Excel;  python-docx — Word;  pypdf — PDF\n  [ ] aiogram 3.x     — Telegram-боты (в РФ самый ходовой заказ)\n  [ ] sqlite3         — простая база данных для бота\n  [ ] schedule / cron — запуск по расписанию\n  [ ] Развёртывание бота на VPS, чтобы работал 24/7 (Linux-основы, ssh)\n  Проекты ветки A: парсер цен -> Excel; бот-напоминалка; бот погоды / курса\n  валют; массовая конвертация файлов; автоотчёт из CSV в Excel с графиком.\n  Книга ровно под ветку: Свейгарт «Автоматизация рутинных задач с помощью Python».\n\nВетка B — коротко, по порядку:\n  FastAPI -> pydantic -> SQLite / PostgreSQL + SQLAlchemy -> аутентификация\n  -> Docker -> Django (или остаться на FastAPI). Проект: API для своего\n  todo / expenses из раздела 4 + бот из ветки A как клиент этого API.\n\nВетка C — коротко, по порядку:\n  pandas -> matplotlib -> Jupyter -> SQL -> numpy -> основы статистики.\n  Проект: анализ своих же расходов из 03_expenses с графиками.\n\n\n================================================================================\n  6. ЭТАП 3: ПОРТФОЛИО И ЗАКАЗЫ\n================================================================================\n\n  [ ] 3–5 небольших ЗАКОНЧЕННЫХ проектов (скрипт, бот, парсер, мини-приложение)\n  [ ] Все на GitHub, у каждого README: что делает, скриншот / гифка, как запустить\n  [ ] Профиль GitHub заполнен (имя, описание, закреплённые репозитории)\n  [ ] Страница-портфолио (можно — README профиля на GitHub или простой сайт;\n      заготовка index.html в этом репозитории подойдёт)\n  [ ] Фриланс-биржи (Kwork, FL.ru, Хабр Фриланс) + Telegram-чаты\n      «Python подработка». Первые 2–3 заказа — дёшево, ради отзывов.\n  [ ] Когда есть портфолио — hh.ru, фильтр «удалённая работа», запросы\n      «junior python», «стажёр python». Отклик + короткое письмо + ссылки.\n  [ ] Тестовые задания делать честно и класть в GitHub — это тоже портфолио.\n\n\n================================================================================\n  7. РЕСУРСЫ (бесплатные, на русском)\n================================================================================\n\nЭтап 1 (основы):\n  - pythontutor.ru — пошаговый учебник с задачами (из исходного плана)\n  - learn.python.ru — интерактивный курс, часть бесплатно (из исходного плана)\n  - Stepik, «Поколение Python: курс для начинающих» — stepik.org/58852\n    Бесплатный, 8 модулей: ввод-вывод, условия, типы, циклы, строки, списки,\n    функции, мини-проект; 500+ задач с автопроверкой. Хорош, чтобы ЗАКРЫТЬ\n    этап 1 задачами.                                        (добавлено 2026-09-05)\n  - YouTube: «Python с нуля» (смотреть 1 канал, а не 5)\n\n«Мостик» и дальше:\n  - Stepik, «Поколение Python: курс для продвинутых» — бесплатный; кортежи,\n    множества, словари, модули, функции, файлы.               (добавлено 2026-09-05)\n  - Эл Свейгарт, «Автоматизация рутинных задач с помощью Python» (русское\n    издание, 2-е изд., 2021). Часть I — основы, часть II — ровно ветка A:\n    файлы, Excel, PDF, Word, парсинг, регулярные выражения. Оригинал бесплатно\n    на английском: automatetheboringstuff.com                 (добавлено 2026-09-05)\n  - docs.python.org/3/ — официальная документация (учись в ней искать)\n  - Codewars (codewars.com) — короткие задачи для ежедневной разминки,\n    уровни 8 kyu -> 6 kyu                                     (добавлено 2026-09-05)\n\nСообщество:\n  - Telegram-чаты по Python для новичков (спросить, когда застрял > 3 дней)\n  - Комментарии к задачам на Stepik — там разбирают типичные ошибки\n\n\n================================================================================\n  8. КАК УЧИТЬСЯ, ЧТОБЫ НЕ СГОРЕТЬ\n================================================================================\n\nДелать:\n  - Каждый день 1–2 часа, а не раз в неделю 6.\n  - Правило 50/50: половина — теория, половина — пишешь сам.\n  - Одна ветка одновременно. Выбрал — не отвлекайся.\n  - Готово лучше, чем идеально. Довёл до конца — это успех.\n  - Застрял на 3 дня — гугл / документация / чат. Не сидеть молча неделю.\n  - После каждой темы — одна маленькая программа.\n\nНЕ делать:\n  - Не начинать Django / FastAPI до «Мостика» (раздел 3) — будет каша.\n  - Не проходить 3 курса параллельно. Один курс + свои проекты.\n  - Не учиться ТОЛЬКО в браузерном редакторе — ставь Python локально (3.1).\n  - Не копировать код ИИ, не поняв каждую строку. ИИ объясняет и проверяет —\n    пишу я.\n  - Не бросать проект на 80%. Лучше маленький и законченный.\n  - Не покупать платные курсы, пока не пройдены бесплатные из раздела 7.\n\nОценка прогресса — каждые 2 недели, три вопроса (ответы — в дневник):\n  1. Что я вчера написал руками?\n  2. Могу объяснить, как работает моя программа?\n  3. Где застрял и как решил?\n\nЕсли через 3–4 недели ветки понял, что «не моё» — ок, менять ветку внутри\nPython можно. Но после месяца реальной практики, а не после 3 дней.\n\n\n================================================================================\n  9. ДНЕВНИК ПРОГРЕССА\n================================================================================\n\nФормат:  ДАТА | что сделал | где застрял | как решил / что спросить\nНовые записи добавлять СНИЗУ. Старые не удалять — это история.\n--------------------------------------------------------------------------------\n2026-09-05 | Создан этот файл. Этап 1 почти завершён (учусь в веб-редакторе\n           | с задачами и проверкой ошибок). Репозиторий подключён, чтобы\n           | ничего не потерять.\n           | Застрял: не понимал, что делать после тем этапа 1.\n           | Решено: план — закрыть чеклист раздела 2, поставить Python\n           | локально (3.1), начать проект 01_todo.\n--------------------------------------------------------------------------------\n2026-09-05 | Вечер: приложение с редактором переехало в репозиторий; 8 уроков\n           | «Мостика» и урок «Переменные» доведены, валидатор строгий чистый\n           | (29 задач / 117 тестов). Темы теперь открываются по порядку: решил\n           | все задачи — приложение само переводит на следующую тему. Добавлен\n           | запуск по своему вводу, эталонное решение после сдачи, экспорт и\n           | импорт прогресса, сборка одним файлом (pypath.html).\n           | Застрял: браузер упорно отдавал старые стили после правок.\n           | Решил: сборка вписывает версии ассетов ?v=хэш + кнопка жёсткой\n           | перезагрузки; кэш больше не залипает.\n--------------------------------------------------------------------------------\n\n\n================================================================================\n  10. ИНСТРУКЦИЯ ДЛЯ БУДУЩИХ ИЗМЕНЕНИЙ (для меня и для ИИ-помощника)\n================================================================================\n\n10.1. Структура репозитория (целевая)\n  /\n  ├── PYTHON_PLAN.txt        <- этот файл: план, чеклисты, дневник\n  ├── .gitignore             <- что НЕ попадает в git (venv, __pycache__, .env)\n  ├── projects/              <- самостоятельные проекты, по папке на проект\n  │   ├── 01_todo/\n  │   │   ├── main.py\n  │   │   └── README.txt     <- что делает, как запустить, чему научился\n  │   ├── 02_password_generator/\n  │   └── ...\n  ├── practice/              <- разовые упражнения и эксперименты (README не нужен)\n  └── index.html, css/       <- заготовка сайта; к Python пока не относится,\n                                пригодится для страницы-портфолио (раздел 6)\n\n  Имена папок и файлов: латиница, нижний регистр, подчёркивания:\n  правильно  projects/03_expenses/main.py     неправильно  Проекты/Расходы 2.py\n\n10.2. Правила изменения ЭТОГО файла\n  - Обновляй «Последнее обновление», «Текущий этап», «Следующий шаг» в шапке.\n  - [x] ставится только за то, что можешь написать руками без подсказок.\n  - Новую тему / ресурс / проект добавляй в нужный раздел с пометкой\n    (добавлено ГГГГ-ММ-ДД). Устаревшее — не удаляй, помечай (неактуально).\n  - Записи дневника (раздел 9) не удалять и не редактировать задним числом.\n  - Не переписывать план целиком «под настроение». Смена ветки в разделе 5 —\n    только после >= 1 месяца практики и записи в дневник «почему».\n  - Раз в 2 недели — запись «Оценка прогресса» с ответами на 3 вопроса (раздел 8).\n  - Формат файла: обычный текст, UTF-8, ширина строки до 80–90 символов,\n    заголовки разделов — как сейчас (линии из «=»). Разделы не перенумеровывать:\n    на номера есть ссылки внутри файла.\n\n10.3. Как сохранять в git (после КАЖДОГО занятия)\n  git status                                # что изменилось\n  git add .                                 # добавить всё (кроме .gitignore)\n  git commit -m \"todo: сохранение в json\"   # одна строка: ЧТО сделано\n  git push                                  # отправить на GitHub\n\n  Сообщение коммита — по-русски или по-английски, но конкретно:\n    плохо:   \"fix\", \"update\", \"изменения\"\n    хорошо:  \"expenses: считаю сумму за месяц\", \"plan: закрыл этап 1\"\n  Если git ругается на конфликт или «rejected» — не дёргать команды наугад,\n  скопировать сообщение целиком и спросить (ИИ / чат), приложив вывод git status.\n\n10.4. Что НИКОГДА не коммитить\n  - venv/ и .venv/           — виртуальное окружение (ставится заново за минуту)\n  - __pycache__/, *.pyc      — мусор интерпретатора\n  - .env                     — токены ботов, пароли, ключи API.\n                               Токен Telegram-бота в публичном git = бот угнан.\n                               Если случайно закоммитил — сразу перевыпустить токен.\n  - большие файлы данных (> 5 МБ), выгрузки, скачанные картинки\n  Всё это уже прописано в .gitignore. При добавлении нового типа мусора —\n  дописывать туда же.\n\n10.5. Правила для ИИ-помощника (скопировать в начало разговора)\n  ------------------------------------------------------------------------\n  Прочитай файл PYTHON_PLAN.txt в репозитории. Я учу Python по этому плану.\n  Мой текущий этап указан в шапке файла и в разделах 2–3.\n  Правила:\n  1. Не предлагай темы и библиотеки из следующих этапов, пока не закрыт текущий.\n  2. Не пиши код за меня. Давай подсказку, псевдокод или наводящий вопрос.\n     Полный код — только если я прямо прошу «покажи решение», и тогда\n     с построчным объяснением.\n  3. Если я показываю ошибку — сначала попроси меня самого прочитать traceback\n     и сказать, что я понял.\n  4. В конце сессии предложи: какие чекбоксы отметить и что записать\n     в дневник (раздел 9).\n  5. Если правишь PYTHON_PLAN.txt — соблюдай раздел 10.2: не удаляй историю,\n     не перенумеровывай разделы, ставь дату у добавлений.\n  ------------------------------------------------------------------------\n\n10.6. Про учебное веб-приложение с редактором\n  - (устарело с 2026-09-05) Сделано отдельно и в этом репозитории не хранится…\n  - Сейчас приложение живёт здесь: index.html + app/ (тёмный интерфейс, темы\n    открываются по порядку), один файл pypath.html — «всё включено» для флешки,\n    прогресс в браузере + экспорт/импорт .json. Запуск и сборка — README.md.\n    Контент и приложение дальше ведёт один ИИ-помощник (деление ушло в прошлое).\n  - Веб-редактор — для прохождения тем. Проекты из раздела 4 делать локально\n    в VS Code: установка библиотек, терминал и git — это часть обучения.\n\n10.7. Когда обновлять шапку «Текущий этап»\n  - «Этап 1 закрыт»            — сдан экзамен из раздела 2\n  - «Мостик»                   — идут разделы 3 и 4\n  - «Ветка A/B/C, месяц N»     — выбрана ветка, отмечено в разделе 5\n  - «Портфолио / поиск»        — идёт раздел 6\n",
 "stages": [
  {
   "id": "basics",
   "title": "Этап 1 — Основы Python",
   "description": "Фундамент: переменные, условия, циклы, функции, коллекции, строки, файлы.",
   "lessons": [
    {
     "file": "basics/01_variables.json",
     "data": {
      "id": "variables",
      "stage": "basics",
      "order": 1,
      "title": "Переменные и типы данных",
      "subtitle": "Как хранить числа и текст и не перепутать их",
      "minutes": 40,
      "version": 3,
      "goals": [
       "Создавать переменные и понимать, что в них лежит",
       "Различать int, float, str и bool",
       "Преобразовывать типы: int(), float(), str()",
       "Печатать результат через print() и f-строки"
      ],
      "theory": [
       {
        "type": "text",
        "text": "Переменная — это имя, к которому привязано значение. Знак `=` в Python не «равно», а «положить в»: справа вычисляется значение, слева — имя, под которым его сохранили."
       },
       {
        "type": "code",
        "code": "age = 25\nname = \"Анна\"\nprice = 199.9\nis_student = True\n\nprint(age)\nprint(name)",
        "output": "25\nАнна",
        "run_check": true
       },
       {
        "type": "list",
        "title": "Разберём первый пример по символам",
        "items": [
         "`age` — имя, которое ты придумал сам; через него программа обращается к значению.",
         "Знак `=` — не «равно», а «присвой»: читай строку справа налево — значение связали с именем.",
         "Что стоит после `=`, Python сначала вычисляет, а потом связывает результат с именем слева.",
         "Число `25` без кавычек — это сразу число (int); текст в кавычках — строка.",
         "`print(...)` — вызов: скобки означают «выполни функцию», то внутри скобок — данные для неё.",
         "Кавычки означают: «пиши символ в символ, ничего не вычисляй» — и наоборот, без кавычек Python ищет имя."
        ]
       },
       {
        "type": "text",
        "text": "У каждого значения есть тип. Четыре главных типа, с которых всё начинается:"
       },
       {
        "type": "table",
        "header": [
         "Тип",
         "Что это",
         "Примеры"
        ],
        "rows": [
         [
          "int",
          "целое число",
          "0, 42, -7"
         ],
         [
          "float",
          "дробное число (через точку!)",
          "3.14, -0.5, 2.0"
         ],
         [
          "str",
          "строка — любой текст в кавычках",
          "\"привет\", 'A', \"123\""
         ],
         [
          "bool",
          "логическое: истина или ложь",
          "True, False"
         ]
        ]
       },
       {
        "type": "text",
        "text": "Тип можно узнать функцией `type()`. Обрати внимание: `\"123\"` в кавычках — это строка, а не число. С ней нельзя считать."
       },
       {
        "type": "code",
        "code": "print(type(42))\nprint(type(\"42\"))\nprint(type(4.2))",
        "output": "<class 'int'>\n<class 'str'>\n<class 'float'>",
        "run_check": true
       },
       {
        "type": "warning",
        "text": "Всё, что возвращает input(), — ВСЕГДА строка, даже если пользователь ввёл цифры. Чтобы считать, строку нужно превратить в число: `int(input())` для целых, `float(input())` для дробных."
       },
       {
        "type": "code",
        "code": "a = \"5\"\nb = \"7\"\nprint(a + b)          # строки склеиваются\nprint(int(a) + int(b))  # числа складываются",
        "output": "57\n12",
        "run_check": true
       },
       {
        "type": "text",
        "text": "Преобразование типов: `int(x)`, `float(x)`, `str(x)`. Обратно в строку значение превращают, когда нужно склеить его с текстом. Удобнее всего — f-строка: перед кавычкой ставим букву `f`, а переменные пишем в фигурных скобках."
       },
       {
        "type": "text",
        "text": "int() принимает только «чистую» строку с целым: int(\"3.5\") — ошибка. Если в строке точка, бери сначала float(), а потом уже int(float(x)) — дробная часть отбрасывается, без округления."
       },
       {
        "type": "code",
        "code": "print(int(\"42\"))\nprint(float(\"3.5\"))\nprint(int(float(\"3.9\")))\nprint(str(7) + str(8))",
        "output": "42\n3.5\n3\n78",
        "run_check": true
       },
       {
        "type": "text",
        "text": "Связка `int(input())` из задач — это две функции в одной строке, читай её изнутри наружу: сначала `input()` ждёт, пока ученик напечатает строку, затем `int(...)` превращает её в число. Пустые скобки `()` после `input` — тоже часть вызова: «выполни, данных не нужно». Без `int()` числа нельзя складывать: `input()` возвращает строку, а строки, соединённые `+`, склеиваются — «2» + «3» даст «23», а не 5."
       },
       {
        "type": "code",
        "code": "name = \"Иван\"\nage = 30\nprint(f\"Меня зовут {name}, мне {age} лет\")\nprint(f\"Через год мне будет {age + 1}\")",
        "output": "Меня зовут Иван, мне 30 лет\nЧерез год мне будет 31",
        "run_check": true
       },
       {
        "type": "list",
        "title": "f-строка по символам",
        "items": [
         "Буква `f` перед кавычкой — флаг: «внутри ищи фигурные скобки, это не текст, а вставки».",
         "Всё, что вне `{}`, печатается символ в символ (пробелы и запятые — твои).",
         "`{name}` — вставь сюда значение переменной name.",
         "`{age + 1}` — внутри скобок может быть выражение: Python сначала вычислит его.",
         "`{total:.2f}` — после `:` идёт формат: `.2` — сколько знаков после точки, `f` — дробный вид."
        ]
       },
       {
        "type": "text",
        "text": "Дробные числа в f-строке можно форматировать прямо в фигурных скобках: `f\"{x:.2f}\"` — ровно два знака после точки (с округлением). Пригодится для денег."
       },
       {
        "type": "code",
        "code": "price = 199.9\ntotal = price * 3\nprint(f\"{total:.2f}\")\nprint(f\"{total:.0f}\")\nprint(f\"{3.14159:.1f}\")",
        "output": "599.70\n600\n3.1",
        "run_check": true
       },
       {
        "type": "text",
        "text": "Имена переменных: латинские буквы, цифры и подчёркивание, не начинаются с цифры. Пиши осмысленно и в нижнем регистре: `user_age`, а не `a` или `UserAge`. Регистр важен: `age` и `Age` — разные переменные."
       },
       {
        "type": "compare",
        "title": "Имена переменных",
        "bad": "a = 25\nb = \"Анна\"\nx1 = 199.9",
        "good": "age = 25\nname = \"Анна\"\nprice = 199.9"
       },
       {
        "type": "text",
        "text": "print() умеет печатать несколько значений через запятую — между ними автоматически ставится пробел. Параметр `sep` меняет разделитель, `end` — что печатать в конце вместо перевода строки."
       },
       {
        "type": "code",
        "code": "print(\"a\", \"b\", \"c\")\nprint(\"a\", \"b\", \"c\", sep=\"-\")\nprint(\"без переноса\", end=\" \")\nprint(\"строки\")",
        "output": "a b c\na-b-c\nбез переноса строки",
        "run_check": true
       },
       {
        "type": "text",
        "text": "`sep=` и `end=` — именованные аргументы: пишутся со своим именем и в любом порядке, потому что имя и говорит, за что этот параметр. `sep=\"-\"` — «разделитель между значениями — дефис», `end=\" \"` — «в конце вместо переноса строки поставь пробел». Равное здесь не присваивание переменной, а подпись: «это какой параметр»."
       },
       {
        "type": "table",
        "header": [
         "запись",
         "что значит"
        ],
        "rows": [
         [
          "`=`",
          "присвой: справа вычисли, слева — имя, которому досталось значение"
         ],
         [
          "`\"текст\"`",
          "строка, символ в символ; кавычки `'` и `\"` взаимозаменяемы"
         ],
         [
          "`имя`",
          "без кавычек — «дай значение, связанное с этим именем»"
         ],
         [
          "`func(x)`",
          "вызов: выполни функцию, передав ей x; `()` без данных тоже нужны"
         ],
         [
          "`,`",
          "разделитель аргументов: print вставит между ними пробел"
         ],
         [
          "`+`",
          "между числами — сумма, между строками — склейка"
         ],
         [
          "`#`",
          "комментарий: всё после решётки до конца строки для людей, Python его не видит"
         ],
         [
          "`f\"...\"`",
          "строка с вставками в `{}`"
         ],
         [
          "`{x:.2f}`",
          "вставь x, округлив до 2 знаков после точки"
         ]
        ]
       },
       {
        "type": "note",
        "text": "Частая ошибка новичка: `print(\"Сумма: \" + 5)` — TypeError, нельзя склеить строку и число. Правильно: `print(\"Сумма:\", 5)` или `print(f\"Сумма: {5}\")`."
       }
      ],
      "tasks": [
       {
        "id": "variables_t1",
        "title": "Приветствие",
        "difficulty": 1,
        "statement": "Программа читает одну строку — имя пользователя — и выводит приветствие в формате `Привет, ИМЯ!` (с запятой, пробелом и восклицательным знаком).",
        "input_format": "Одна строка — имя.",
        "output_format": "Одна строка: `Привет, ИМЯ!`",
        "examples": [
         {
          "input": "Анна",
          "output": "Привет, Анна!"
         }
        ],
        "hints": [
         "Прочитай имя через input() и сохрани в переменную.",
         "Собери строку через f-строку: f\"Привет, {name}!\"",
         "Проверь, что после запятой ровно один пробел, а в конце — восклицательный знак."
        ],
        "tests": [
         {
          "input": "Анна",
          "output": "Привет, Анна!",
          "visible": true
         },
         {
          "input": "Пётр",
          "output": "Привет, Пётр!"
         },
         {
          "input": "Мария Ивановна",
          "output": "Привет, Мария Ивановна!"
         },
         {
          "input": "Tom",
          "output": "Привет, Tom!"
         }
        ],
        "checks": {
         "must_use": [
          "input"
         ]
        },
        "solution": "name = input()\nprint(f\"Привет, {name}!\")",
        "wrong_solution": "name = input()\nprint(\"Привет,\", name)"
       },
       {
        "id": "variables_t2",
        "title": "Сумма двух чисел",
        "difficulty": 1,
        "statement": "Программа читает два целых числа, каждое в отдельной строке, и выводит их сумму. Помни: input() возвращает строку — числа нужно преобразовать.",
        "input_format": "Две строки, в каждой — целое число.",
        "output_format": "Одно число — сумма.",
        "examples": [
         {
          "input": "2\n3",
          "output": "5"
         }
        ],
        "hints": [
         "Прочитай два раза: a = input(), b = input().",
         "Преобразуй каждое в int() до сложения, иначе получится склейка строк.",
         "Можно короче: a = int(input())."
        ],
        "tests": [
         {
          "input": "2\n3",
          "output": "5",
          "visible": true
         },
         {
          "input": "10\n-4",
          "output": "6"
         },
         {
          "input": "0\n0",
          "output": "0"
         },
         {
          "input": "1000000\n1",
          "output": "1000001"
         }
        ],
        "checks": {
         "must_use": [
          "int",
          "input"
         ]
        },
        "solution": "a = int(input())\nb = int(input())\nprint(a + b)",
        "wrong_solution": "a = input()\nb = input()\nprint(a + b)"
       },
       {
        "id": "variables_t3",
        "title": "Карточка товара",
        "difficulty": 2,
        "statement": "Программа читает название товара, его цену (дробное число) и количество (целое). Выведи три строки: название, цену за штуку и итоговую стоимость — ровно в формате из примера. Итог — это цена, умноженная на количество, выведи его с двумя знаками после точки.",
        "input_format": "Три строки: название (строка), цена (float), количество (int).",
        "output_format": "Три строки:\nТовар: НАЗВАНИЕ\nЦена: ЦЕНА\nИтого: СУММА\nгде СУММА — число с двумя знаками после точки.",
        "examples": [
         {
          "input": "Кофе\n199.9\n3",
          "output": "Товар: Кофе\nЦена: 199.9\nИтого: 599.70"
         }
        ],
        "hints": [
         "Цену читай через float(input()), количество — через int(input()).",
         "Два знака после точки в f-строке: f\"{total:.2f}\".",
         "Цену выводи как есть (f\"{price}\"), форматировать нужно только итог."
        ],
        "tests": [
         {
          "input": "Кофе\n199.9\n3",
          "output": "Товар: Кофе\nЦена: 199.9\nИтого: 599.70",
          "visible": true
         },
         {
          "input": "Хлеб\n45.5\n2",
          "output": "Товар: Хлеб\nЦена: 45.5\nИтого: 91.00"
         },
         {
          "input": "Ручка\n10.0\n0",
          "output": "Товар: Ручка\nЦена: 10.0\nИтого: 0.00"
         },
         {
          "input": "Ноутбук Lenovo\n55990.99\n1",
          "output": "Товар: Ноутбук Lenovo\nЦена: 55990.99\nИтого: 55990.99"
         }
        ],
        "checks": {
         "must_use": [
          "float",
          "int",
          "input"
         ]
        },
        "solution": "name = input()\nprice = float(input())\ncount = int(input())\ntotal = price * count\nprint(f\"Товар: {name}\")\nprint(f\"Цена: {price}\")\nprint(f\"Итого: {total:.2f}\")",
        "wrong_solution": "name = input()\nprice = float(input())\ncount = int(input())\nprint(f\"Товар: {name}\")\nprint(f\"Цена: {price}\")\nprint(f\"Итого: {price * count}\")"
       }
      ],
      "summary": [
       "Переменная создаётся присваиванием: имя = значение.",
       "Типы: int, float, str, bool. Узнать тип — type(x).",
       "input() всегда возвращает строку; для расчётов — int() или float().",
       "f-строка: f\"текст {переменная}\" — лучший способ собрать вывод.",
       "Форматирование дробных: f\"{x:.2f}\"."
      ],
      "further": [
       "Официальная документация: docs.python.org/3/tutorial/introduction.html",
       "pythontutor.ru — раздел «Ввод-вывод, арифметика»"
      ]
     }
    }
   ]
  },
  {
   "id": "bridge",
   "title": "Мостик — от основ к специализации",
   "description": "Кортежи, множества, исключения, модули, стандартная библиотека, основы ООП.",
   "lessons": [
    {
     "file": "bridge/01_tuples_sets.json",
     "data": {
      "id": "tuples_sets",
      "stage": "bridge",
      "order": 1,
      "title": "Кортежи и множества",
      "subtitle": "Когда список — не лучший выбор",
      "minutes": 45,
      "version": 1,
      "goals": [
       "Выбирать list, tuple и set под задачу и объяснять выбор",
       "Создавать кортежи, распаковывать их и возвращать несколько значений из функции",
       "Удалять дубликаты и считать пересечения/объединения через множества",
       "Помнить, что порядок в множестве не гарантирован, и сортировать вывод"
      ],
      "theory": [
       {
        "type": "text",
        "text": "Список удобен, когда данные нужно менять. Но часто данные менять НЕ надо: координаты склада, расписание, набор уникальных тегов. Для этого есть кортеж (tuple) — «список, который нельзя изменить», и множество (set) — «коробка без дубликатов, где быстро ищется элемент»."
       },
       {
        "type": "text",
        "text": "Кортеж создаётся круглыми скобками через запятую. Работает всё привычное: индексы, `len()`, перебор. А вот присвоить элемент нельзя — и это плюс: значение защищено от случайной правки."
       },
       {
        "type": "code",
        "code": "point = (55.75, 37.61)\ndays = (\"Пн\", \"Вт\", \"Ср\", \"Чт\", \"Пт\", \"Сб\", \"Вс\")\n\nprint(point[0])\nprint(days[2])\nprint(len(point))",
        "output": "55.75\nСр\n2",
        "run_check": true
       },
       {
        "type": "warning",
        "text": "Кортеж из одного элемента требует запятой: `(1,)`. Без запятой `t = (1)` — это просто число 1, скобки здесь лишние. Запятая — главный синтаксис кортежа, скобки даже необязательны: `t = 1, 2` работает."
       },
       {
        "type": "code",
        "code": "single = (1,)\nfake = (1)\n\nprint(type(single))\nprint(type(fake))",
        "output": "<class 'tuple'>\n<class 'int'>",
        "run_check": true
       },
       {
        "type": "text",
        "text": "Распаковка (unpacking) — самый частый приём с кортежами: слева список переменных, справа кортеж, Python разложит значения по порядку. Так же функция «возвращает несколько значений» — на самом деле она возвращает кортеж."
       },
       {
        "type": "code",
        "code": "def rect(a, b):\n    return a * b, a + b  # кортеж (площадь, периметр)\n\n\narea, perim = rect(3, 4)\nprint(area, perim)",
        "output": "12 7",
        "run_check": true
       },
       {
        "type": "text",
        "text": "Множество (set) хранит только уникальные элементы и не запоминает порядок. Главное применение — убрать дубликаты и быстро проверять наличие через `in`."
       },
       {
        "type": "code",
        "code": "tags = [\"python\", \"sql\", \"python\", \"excel\"]\nunique = set(tags)\n\nprint(len(unique))\nprint(\"python\" in unique)\nprint(\"java\" in unique)",
        "output": "3\nTrue\nFalse",
        "run_check": true
       },
       {
        "type": "text",
        "text": "Элементы добавляют через `add()`, удаляют через `discard()` (молчит, если элемента нет) или `remove()` (падает с KeyError). Повторный `add` безвреден — дубликата не будет."
       },
       {
        "type": "code",
        "code": "visited = set()\nvisited.add(\"главная\")\nvisited.add(\"главная\")\nvisited.discard(\"корзина\")  # remove(\"корзина\") упал бы с KeyError\n\nprint(len(visited))\nprint(sorted(visited))",
        "output": "1\n['главная']",
        "run_check": true
       },
       {
        "type": "text",
        "text": "Множества считают «умную» математику: пересечение, объединение, разность. Данные для примеров взяты из жизни: кто из двух чатов есть в обоих чатах, а кто — только в одном."
       },
       {
        "type": "code",
        "code": "a = {\"Аня\", \"Боря\", \"Вера\"}\nb = {\"Боря\", \"Глеб\"}\n\nprint(sorted(a & b))\nprint(sorted(a | b))\nprint(sorted(a - b))",
        "output": "['Боря']\n['Аня', 'Боря', 'Вера', 'Глеб']\n['Аня', 'Вера']",
        "run_check": true
       },
       {
        "type": "table",
        "header": [
         "Операция",
         "Как записать",
         "Что получится"
        ],
        "rows": [
         [
          "пересечение",
          "a & b",
          "те, кто есть и там, и там"
         ],
         [
          "объединение",
          "a | b",
          "все без повторений"
         ],
         [
          "разность",
          "a - b",
          "те, кто есть в a, но нет в b"
         ],
         [
          "симметричная разность",
          "a ^ b",
          "кто есть только в одном из них"
         ]
        ]
       },
       {
        "type": "warning",
        "text": "В множестве нет порядка: `print(my_set)` выводит элементы как попало, и в другой запуск — иначе. Поэтому любой вывод множества для проверки или печати оформляй через `sorted()` или `\", \".join(sorted(...))`. Сами множества для вывода на экран новичку почти не нужны."
       },
       {
        "type": "text",
        "text": "Как выбирать структуру? Правило на пальцах:"
       },
       {
        "type": "list",
        "title": "list, tuple или set",
        "items": [
         "**list** — порядок важен, элементы будут меняться, дубликаты допустимы (корзина, список дел).",
         "**tuple** — набор фиксирован по смыслу: координаты, «точка» данных, несколько значений из функции.",
         "**set** — важны уникальность и проверка `in`: посещённые страницы, теги, общие элементы."
        ]
       },
       {
        "type": "text",
        "text": "Ещё одно полезное свойство кортежей: их можно использовать как ключ словаря (список — нельзя, он изменяемый). И обмен значениями без временной переменной: `a, b = b, a`."
       },
       {
        "type": "code",
        "code": "x = 1\ny = 2\nx, y = y, x\nprint(x, y)",
        "output": "2 1",
        "run_check": true
       },
       {
        "type": "note",
        "text": "Дубликаты с сохранением порядка: `list(set(...))` порядок теряет. Если порядок важен — используй `list(dict.fromkeys(items))`: словарь не допускает повторяющихся ключей и помнит порядок их вставки."
       }
      ],
      "tasks": [
       {
        "id": "tuples_sets_t1",
        "title": "Уникальные слова",
        "difficulty": 1,
        "statement": "Программа читает одну строку — слова через пробел (могут повторяться). Выведи две строки: количество уникальных слов и сами уникальные слова в алфавитном порядке через пробел. Регистр считается различающим: `Кот` и `кот` — два разных слова.",
        "input_format": "Одна строка со словами через пробел.",
        "output_format": "Первая строка — число уникальных слов. Вторая строка — эти слова в алфавитном порядке через пробел.",
        "examples": [
         {
          "input": "кот пёс кот волк пёс кот",
          "output": "3\nволк кот пёс"
         }
        ],
        "hints": [
         "Разбей строку на слова: input().split().",
         "Множество убирает дубликаты: unique = set(words).",
         "Чтобы вывести слова в алфавитном порядке: \" \".join(sorted(unique))."
        ],
        "tests": [
         {
          "input": "кот пёс кот волк пёс кот",
          "output": "3\nволк кот пёс",
          "visible": true
         },
         {
          "input": "да",
          "output": "1\nда"
         },
         {
          "input": "раз два три",
          "output": "3\nдва раз три"
         },
         {
          "input": "Кот кот",
          "output": "2\nКот кот"
         }
        ],
        "checks": {
         "must_use": [
          "set",
          "sorted"
         ]
        },
        "solution": "words = input().split()\nunique = sorted(set(words))\nprint(len(unique))\nprint(\" \".join(unique))",
        "wrong_solution": "words = input().split()\nprint(len(words))\nprint(\" \".join(sorted(set(words))))"
       },
       {
        "id": "tuples_sets_t2",
        "title": "Совместные покупки",
        "difficulty": 2,
        "statement": "Две строки — списки продуктов двух соседей по квартире (слова через пробел, повторы внутри строки возможны). Выведи две строки: 1) что есть в обоих списках; 2) что есть только в первом списке. В каждой строке — по алфавиту через пробел, а если строчка получилась пустой — выведи `нет`.",
        "input_format": "Две строки, в каждой — слова через пробел.",
        "output_format": "Две строки, в каждой слова через пробел по алфавиту или слово `нет`.",
        "examples": [
         {
          "input": "молоко хлеб яйца сыр\nхлеб масло молоко",
          "output": "молоко хлеб\nсыр яйца"
         }
        ],
        "hints": [
         "Преврати каждую строку в множество: a = set(input().split()). Дубликаты внутри строки исчезнут сами.",
         "Пересечение — `a & b`, разность — `a - b`.",
         "Сортируй перед печатью: sorted(inter) даст список; склей его через join. Если список пуст — печатай «нет»."
        ],
        "tests": [
         {
          "input": "молоко хлеб яйца сыр\nхлеб масло молоко",
          "output": "молоко хлеб\nсыр яйца",
          "visible": true
         },
         {
          "input": "чай кофе\nкакао сок",
          "output": "нет\nкофе чай"
         },
         {
          "input": "хлеб хлеб\nхлеб",
          "output": "хлеб\nнет"
         },
         {
          "input": "а б в\nв б а",
          "output": "а б в\nнет"
         }
        ],
        "checks": {
         "must_use": [
          "&",
          "-"
         ]
        },
        "solution": "a = set(input().split())\nb = set(input().split())\n\ncommon = sorted(a & b)\nonly_a = sorted(a - b)\nprint(\" \".join(common) if common else \"нет\")\nprint(\" \".join(only_a) if only_a else \"нет\")",
        "wrong_solution": "a = set(input().split())\nb = set(input().split())\n\nprint(\" \".join(sorted(a & b)) if a & b else \"нет\")\nprint(\" \".join(sorted(a)) if a else \"нет\")"
       },
       {
        "id": "tuples_sets_t3",
        "title": "Функция-анализатор",
        "difficulty": 3,
        "statement": "Определи функцию `analyze(words)`, которая принимает список слов и возвращает кортеж из трёх значений: (сколько всего слов, сколько уникальных, какое слово самое длинное). Если самых длинных несколько — бери первую встретившуюся. Для пустого списка верни (0, 0, \"\"). Печатать ничего не нужно: проверка вызовет `print(analyze(...))` сама и сравнит вывод с видом кортежа, например `(4, 3, 'олень')`.",
        "input_format": "Ввода нет.",
        "output_format": "Ничего печатать не нужно — только определить функцию. Возвращать нужно именно кортеж.",
        "examples": [
         {
          "input": "",
          "output": "print(analyze([\"кот\", \"пёс\", \"кот\", \"олень\"])) -> (4, 3, 'олень')"
         }
        ],
        "hints": [
         "Возврат нескольких значений — это кортеж: return count, unique_count, longest.",
         "Уникальные — через len(set(words)). Самое длинное ищи циклом: запоминай слово, длина которого строго больше текущей (тогда при равных длинах останется первое).",
         "Не забудь случай пустого списка: len(\"\") сравнивать удобно, начни longest с пустой строки."
        ],
        "tests": [
         {
          "code_after": "print(analyze([\"кот\", \"пёс\", \"кот\", \"олень\"]))",
          "output": "(4, 3, 'олень')",
          "visible": true
         },
         {
          "code_after": "print(analyze([]))",
          "output": "(0, 0, '')",
          "note": "граничный случай: пустой список"
         },
         {
          "code_after": "print(analyze([\"x\", \"yy\", \"zz\", \"w\"]))",
          "output": "(4, 4, 'yy')",
          "note": "при равной длине — первое"
         },
         {
          "code_after": "print(analyze([\"а\", \"а\", \"а\"]))",
          "output": "(3, 1, 'а')"
         }
        ],
        "checks": {
         "must_define": [
          "analyze"
         ],
         "must_use": [
          "set"
         ]
        },
        "solution": "def analyze(words):\n    count = len(words)\n    unique = len(set(words))\n    longest = \"\"\n    for w in words:\n        if len(w) > len(longest):\n            longest = w\n    return count, unique, longest",
        "wrong_solution": "def analyze(words):\n    count = len(words)\n    unique = len(set(words))\n    longest = \"\"\n    for w in words:\n        if len(w) >= len(longest):\n            longest = w\n    return [count, unique, longest]"
       }
      ],
      "summary": [
       "Кортеж — неизменяемый «список»; создаётся запятыми, один элемент — с запятой: (1,).",
       "Распаковка `a, b = pair` и возврат `return x, y` — стандартный способ вернуть из функции несколько значений.",
       "Множество убирает дубликаты, проверяет `in`, считает `& | - ^`.",
       "Порядка в множестве нет — для вывода всегда сортируй.",
       "list — менять, tuple — фиксировать, set — уникальность и поиск."
      ],
      "further": [
       "docs.python.org/3/tutorial/datastructures.html — разделы про sets и tuples",
       "Stepik «Поколение Python: курс для продвинутых», модуль «Кортежи» и «Множества»"
      ]
     }
    },
    {
     "file": "bridge/02_comprehensions.json",
     "data": {
      "id": "comprehensions",
      "stage": "bridge",
      "order": 2,
      "title": "Списковые включения, enumerate, zip",
      "subtitle": "Короткие строки вместо трёхэтажных циклов",
      "minutes": 50,
      "version": 1,
      "goals": [
       "Писать списковые включения с условием вместо цикла с append",
       "Строить словари через dict comprehension",
       "Нумеровать элементы enumerate() и проходиться по двум спискам zip()",
       "Сортировать и искать максимум по ключу: sorted(key=...), max(key=...)"
      ],
      "theory": [
       {
        "type": "text",
        "text": "Частая задача: взять список и сделать из него другой — каждый элемент преобразовать, часть отфильтровать. Классический цикл с `append` занимает четыре строки. Списковое включение (list comprehension) делает то же одной — и читается это обычно лучше."
       },
       {
        "type": "code",
        "code": "nums = [1, 2, 3, 4, 5]\n\nsquares_loop = []\nfor n in nums:\n    squares_loop.append(n ** 2)\n\nsquares = [n ** 2 for n in nums]\n\nprint(squares)\nprint(squares == squares_loop)",
        "output": "[1, 4, 9, 16, 25]\nTrue",
        "run_check": true
       },
       {
        "type": "text",
        "text": "Читай включение справа налево: «для каждого `n` из `nums` положить `n ** 2`». Условие (фильтр) дописывается в конце: `if` после `for` оставляет только подходящие элементы."
       },
       {
        "type": "code",
        "code": "prices = [100, 45, 250, 30, 80]\nbig = [p for p in prices if p >= 100]\n\nprint(big)",
        "output": "[100, 250]",
        "run_check": true
       },
       {
        "type": "text",
        "text": "Так же строятся словарь и множество: `dict comprehension` — «ключ: значение for ...», множество — фигурные скобки без двоеточия."
       },
       {
        "type": "code",
        "code": "words = [\"кот\", \"олень\", \"ёж\"]\nlengths = {w: len(w) for w in words}\nlong_set = {w for w in words if len(w) > 2}\n\nprint(lengths)",
        "output": "{'кот': 3, 'олень': 5, 'ёж': 2}",
        "run_check": true
       },
       {
        "type": "text",
        "text": "`enumerate()` нумерует элементы при переборе — вместо ручных счётчиков и `range(len(...))`. Параметр `start` задаёт, с какого числа начинать нумерацию."
       },
       {
        "type": "code",
        "code": "files = [\"report.pdf\", \"photo.jpg\", \"notes.txt\"]\nfor i, name in enumerate(files, start=1):\n    print(f\"{i}. {name}\")",
        "output": "1. report.pdf\n2. photo.jpg\n3. notes.txt",
        "run_check": true
       },
       {
        "type": "text",
        "text": "`zip()` проходит по двум (и более) последовательностям параллельно: на каждом шаге выдаёт кортеж из соседних элементов. Если длины разные, `zip` остановится на короткой. В связке `dict(zip(...))` из двух списков мгновенно получается словарь."
       },
       {
        "type": "code",
        "code": "names = [\"Аня\", \"Боря\", \"Вера\"]\nscores = [12, 9, 15]\ntable = dict(zip(names, scores))\n\nprint(table)",
        "output": "{'Аня': 12, 'Боря': 9, 'Вера': 15}",
        "run_check": true
       },
       {
        "type": "text",
        "text": "Сортировка по ключу: `sorted()` умеет сама доставать то, по чему сортировать. Аргумент `key` — функция, которая получает элемент и возвращает «вес» для сравнения. Обычно это `len` или короткая `lambda`. `lambda x: x[1]` — безымянная функция из одной строки, здесь она только как подсказка для `key`."
       },
       {
        "type": "code",
        "code": "words = [\"сыр\", \"молоко\", \"хлеб\"]\nprint(sorted(words, key=len))\nprint(sorted(words, key=len, reverse=True))",
        "output": "['сыр', 'хлеб', 'молоко']\n['молоко', 'хлеб', 'сыр']",
        "run_check": true
       },
       {
        "type": "code",
        "code": "team = [(\"Аня\", 42), (\"Боря\", 38), (\"Вера\", 45)]\n\nbest = max(team, key=lambda member: member[1])\nworst = min(team, key=lambda member: member[1])\nprint(best)\nprint(worst)",
        "output": "('Вера', 45)\n('Боря', 38)",
        "run_check": true
       },
       {
        "type": "warning",
        "text": "Не используй включение ради побочного эффекта: `[print(x) for x in items]` — плохой стиль, это цикл, замаскированный под выражение. Включение для того и существует, чтобы СОЗДАВАТЬ список. Если после `for` у тебя `append`, `print` или присваивание — пиши обычный цикл."
       },
       {
        "type": "table",
        "header": [
         "Запись",
         "Что строит"
        ],
        "rows": [
         [
          "[x * 2 for x in xs if x > 0]",
          "список"
         ],
         [
          "{x for x in xs}",
          "множество (уникальные)"
         ],
         [
          "{k: len(v) for k, v in d.items()}",
          "словарь"
         ]
        ]
       },
       {
        "type": "note",
        "text": "Если включение не читается с одного взгляда (два `for`, два `if`) — разбей на обычный цикл. Экономия строк не должна превращать код в шараду."
       }
      ],
      "tasks": [
       {
        "id": "comprehensions_t1",
        "title": "Квадраты чётных",
        "difficulty": 1,
        "statement": "Программа читает одну строку — целые числа через пробел. Выведи в одну строку квадраты только чётных чисел, в исходном порядке, через пробел. Ноль — чётное. Если чётных чисел нет, выведи пустую строку. Решается одним включением (числа тоже читай включением).",
        "input_format": "Одна строка с целыми числами через пробел.",
        "output_format": "Одна строка: квадраты чётных чисел через пробел (или пустая строка).",
        "examples": [
         {
          "input": "1 2 3 4 5 6",
          "output": "4 16 36"
         }
        ],
        "hints": [
         "Сначала числа: nums = [int(x) for x in input().split()].",
         "Потом квадраты с фильтром: [n ** 2 for n in nums if n % 2 == 0].",
         "Склей вывод: \" \".join(str(s) for s in squares). Пустой список даст пустую строку — так и надо."
        ],
        "tests": [
         {
          "input": "1 2 3 4 5 6",
          "output": "4 16 36",
          "visible": true
         },
         {
          "input": "7 9 11",
          "output": "",
          "note": "нет чётных — пустая строка"
         },
         {
          "input": "-4 -3 0",
          "output": "16 0"
         },
         {
          "input": "2",
          "output": "4"
         }
        ],
        "checks": {
         "must_use": [
          "for",
          "if"
         ],
         "must_not_use": [
          "append"
         ]
        },
        "solution": "nums = [int(x) for x in input().split()]\nsquares = [n ** 2 for n in nums if n % 2 == 0]\nprint(\" \".join(str(s) for s in squares))",
        "wrong_solution": "nums = [int(x) for x in input().split()]\nsquares = [n ** 2 for n in nums]\nprint(\" \".join(str(s) for s in squares))"
       },
       {
        "id": "comprehensions_t2",
        "title": "Меню по номерам",
        "difficulty": 2,
        "statement": "В первой строке — число N (0–20), дальше N строк — блюда. Выведи меню с нумерацией, начиная с 1, в формате `1) борщ`, и последнюю строку `всего: N`. Чтение блюд сделай списковым включением, нумерацию — через `enumerate` с параметром `start`.",
        "input_format": "Сначала строка с числом N, затем N строк с названиями блюд.",
        "output_format": "N строк вида `номер) блюдо`, затем строка `всего: N`.",
        "examples": [
         {
          "input": "3\nборщ\nпицца\nкомпот",
          "output": "1) борщ\n2) пицца\n3) компот\nвсего: 3"
         }
        ],
        "hints": [
         "Список блюд: dishes = [input() for _ in range(n)].",
         "enumerate(dishes, start=1) отдаёт пары (номер, блюдо) — номер начнётся с 1.",
         "Формат строки: f\"{i}) {dish}\"."
        ],
        "tests": [
         {
          "input": "3\nборщ\nпицца\nкомпот",
          "output": "1) борщ\n2) пицца\n3) компот\nвсего: 3",
          "visible": true
         },
         {
          "input": "1\nчай",
          "output": "1) чай\nвсего: 1"
         },
         {
          "input": "0",
          "output": "всего: 0",
          "note": "граничный случай: пустое меню"
         },
         {
          "input": "2\na\nb",
          "output": "1) a\n2) b\nвсего: 2"
         }
        ],
        "checks": {
         "must_use": [
          "enumerate"
         ]
        },
        "solution": "n = int(input())\ndishes = [input() for _ in range(n)]\nfor i, dish in enumerate(dishes, start=1):\n    print(f\"{i}) {dish}\")\nprint(f\"всего: {n}\")",
        "wrong_solution": "n = int(input())\ndishes = [input() for _ in range(n)]\nfor i, dish in enumerate(dishes):\n    print(f\"{i}) {dish}\")\nprint(f\"всего: {n}\")"
       },
       {
        "id": "comprehensions_t3",
        "title": "Частота слов",
        "difficulty": 3,
        "statement": "Программа читает одну строку — слова через пробел. Посчитай, сколько раз встретилось каждое слово, и выведи построчно в формате `слово: количество`, отсортировав слова по алфавиту. Словарь частот построй через dict comprehension (в виде `{w: words.count(w) for w in set(words)}`), перебор — по `sorted` ключам.",
        "input_format": "Одна строка со словами через пробел.",
        "output_format": "По строке на каждое уникальное слово: `слово: количество`, по алфавиту.",
        "examples": [
         {
          "input": "кот пёс кот кот волк",
          "output": "волк: 1\nкот: 3\nпёс: 1"
         }
        ],
        "hints": [
         "words.count(w) считает вхождения, а set(words) даёт только уникальные слова.",
         "counts = {w: words.count(w) for w in set(words)}.",
         "Не печатай словарь напрямую (в нём «случайный» порядок обхода множества): пройтись нужно по sorted(counts)."
        ],
        "tests": [
         {
          "input": "кот пёс кот кот волк",
          "output": "волк: 1\nкот: 3\nпёс: 1",
          "visible": true
         },
         {
          "input": "да да да",
          "output": "да: 3"
         },
         {
          "input": "раз",
          "output": "раз: 1"
         },
         {
          "input": "а б а б а",
          "output": "а: 3\nб: 2"
         }
        ],
        "checks": {
         "must_use": [
          "sorted",
          "for"
         ]
        },
        "solution": "words = input().split()\ncounts = {w: words.count(w) for w in set(words)}\nfor w in sorted(counts):\n    print(f\"{w}: {counts[w]}\")",
        "wrong_solution": "words = input().split()\ncounts = {w: words.count(w) for w in words}\nfor w in counts:\n    print(f\"{w}: {counts[w]}\")"
       }
      ],
      "summary": [
       "Включение `[выражение for x in xs if условие]` заменяет цикл с append.",
       "dict comprehension строит словарь, `{x for x in ...}` — множество.",
       "enumerate(start=1) — нумерация, zip — параллельный перебор, dict(zip(...)) — словарь из двух списков.",
       "sorted(key=...) и max/min(key=...) сортируют и ищут по «весу»; lambda здесь уместна как значение key.",
       "Включение ради печати — антипаттерн; сложное включение — разбивай циклом."
      ],
      "further": [
       "docs.python.org/3/tutorial/datastructures.html — раздел List Comprehensions",
       "Stepik «Поколение Python: курс для продвинутых», модуль «Генераторы списков»"
      ]
     }
    },
    {
     "file": "bridge/03_exceptions.json",
     "data": {
      "id": "exceptions",
      "stage": "bridge",
      "order": 3,
      "title": "Ошибки и исключения",
      "subtitle": "Читать traceback и жить спокойно",
      "minutes": 45,
      "version": 1,
      "goals": [
       "Читать traceback: находить тип ошибки и строку в своём коде",
       "Оборачивать рискованный код в try/except конкретными типами",
       "Использовать else, finally и понятное сообщение в except ... as e",
       "Генерировать свои ошибки через raise и не ловить всё голым except"
      ],
      "theory": [
       {
        "type": "text",
        "text": "Исключение (exception) — сигнал Python: «что-то пошло не так, я не могу продолжать». Это не страшно, а полезно: программа сама говорит, где сломалась. Умение читать это сообщение — навык, который экономит часы."
       },
       {
        "type": "code",
        "code": "Traceback (most recent call last):\n  File \"main.py\", line 2, in <module>\n    n = int(text)\nValueError: invalid literal for int() with base 10: 'abc'",
        "caption": "Так выглядит падение программы",
        "allow_invalid": true
       },
       {
        "type": "text",
        "text": "Traceback читают снизу вверх. Последняя строка — тип ошибки и сообщение: тут `ValueError`, `int()` не смог превратить `'abc'` в число. Строкой выше — место в твоём коде: файл `main.py`, строка 2. Сначала находим строку, потом читаем, о чём говорит тип."
       },
       {
        "type": "text",
        "text": "Конструкция `try / except` говорит: «попробуй опасный код; если вылетит такой-то тип — не падай, а сделай запасной план». В `except` всегда указывай конкретный тип."
       },
       {
        "type": "code",
        "code": "raw = input()\ntry:\n    n = int(raw)\n    print(n * 2)\nexcept ValueError:\n    print(\"это не число\")",
        "input": "abc",
        "output": "это не число",
        "run_check": true
       },
       {
        "type": "text",
        "text": "Блоков `except` может быть несколько — сработает первый подходящей «ширины». Так `int(\"abc\")` и `5 / 0` требуют разной реакции. Сообщение объекта ошибки доступно через `as e` — удобно, чтобы печатать причину."
       },
       {
        "type": "code",
        "code": "try:\n    a = int(input())\n    b = int(input())\n    print(a / b)\nexcept ValueError:\n    print(\"нужны числа\")\nexcept ZeroDivisionError:\n    print(\"на ноль делить нельзя\")",
        "input": "8\n0",
        "output": "на ноль делить нельзя",
        "run_check": true
       },
       {
        "type": "warning",
        "text": "Голый `except:` ловит всё подряд — и опечатку в имени переменной, и Ctrl+C. Программа начинает тихо прятать настоящие баги, и ты их никогда не найдёшь. Правило: лови конкретный тип (`except ValueError:`), максимум — кортеж конкретных типов."
       },
       {
        "type": "text",
        "text": "`else` выполняется, если в try ошибки НЕ было (логичнее держать «успешный» код там). `finally` выполняется всегда — ошибка или нет: обычно закрывать файлы, соединение, печатать «готово»."
       },
       {
        "type": "code",
        "code": "prices = {\"хлеб\": 45}\ntry:\n    p = prices[\"молоко\"]\nexcept KeyError:\n    p = 0\nelse:\n    print(\"ключ найден\")\nfinally:\n    print(\"финал — всегда\")\nprint(\"цена:\", p)",
        "output": "финал — всегда\nцена: 0",
        "run_check": true
       },
       {
        "type": "text",
        "text": "Исключение можно поднять самому — `raise`. Так функция сообщает вызывающему: «ты передал мне ерунду». Хорошее сообщение содержит суть: не `raise ValueError()`, а с текстом."
       },
       {
        "type": "code",
        "code": "def set_age(age):\n    if age < 0:\n        raise ValueError(\"возраст не может быть отрицательным\")\n    return age\n\n\nprint(set_age(25))",
        "output": "25",
        "run_check": true
       },
       {
        "type": "table",
        "header": [
         "Исключение",
         "Откуда берётся",
         "О чём думать"
        ],
        "rows": [
         [
          "ValueError",
          "int(\"abc\"), float(\"1,5\")",
          "значение неподходящее: пробелы, буквы, запятая вместо точки"
         ],
         [
          "KeyError",
          "d[\"нет_такого\"]",
          "ключа в словаре нет: проверь `in` или get()"
         ],
         [
          "IndexError",
          "[1, 2][5]",
          "индекс вне диапазона: смотри len() и пустые списки"
         ],
         [
          "ZeroDivisionError",
          "10 / 0",
          "делишь на ноль: проверь делитель"
         ],
         [
          "FileNotFoundError",
          "open(\"nope.txt\")",
          "файла нет: проверь имя, папку, режим 'w'/'r'"
         ]
        ]
       },
       {
        "type": "note",
        "text": "Алгоритм при падении: 1) прочитать последнюю строку (тип + сообщение); 2) найти в traceback номер своей строки в main.py; 3) воспроизвести на минимальных данных; и только потом — спрашивать. Половина ошибок решается пунктом 1 без гугла."
       }
      ],
      "tasks": [
       {
        "id": "exceptions_t1",
        "title": "Безопасный делитель",
        "difficulty": 1,
        "statement": "Программа читает два целых числа (по одному в строке) и печатает их целочастное деление `a // b`. Если что-то из введённого — не число, выведи `ошибка: не число`. Если делитель ноль — выведи `ошибка: на ноль нельзя`. Оформли через try и два разных except.",
        "input_format": "Две строки: делимое и делитель.",
        "output_format": "Одна строка: результат деления или сообщение об ошибке.",
        "examples": [
         {
          "input": "10\n3",
          "output": "3"
         }
        ],
        "hints": [
         "Весь рискованный код (оба int() и деление) положи внутрь try.",
         "int() падает с ValueError, деление на ноль — ZeroDivisionError. Нужны два блока except с разными сообщениями.",
         "Помни про floor-деление: -7 // 2 это -4, не -3."
        ],
        "tests": [
         {
          "input": "10\n3",
          "output": "3",
          "visible": true
         },
         {
          "input": "10\n0",
          "output": "ошибка: на ноль нельзя"
         },
         {
          "input": "abc\n5",
          "output": "ошибка: не число"
         },
         {
          "input": "-7\n2",
          "output": "-4"
         },
         {
          "input": "0\n7",
          "output": "0"
         }
        ],
        "checks": {
         "must_use": [
          "try",
          "except",
          "ValueError",
          "ZeroDivisionError"
         ]
        },
        "solution": "try:\n    a = int(input())\n    b = int(input())\n    print(a // b)\nexcept ValueError:\n    print(\"ошибка: не число\")\nexcept ZeroDivisionError:\n    print(\"ошибка: на ноль нельзя\")",
        "wrong_solution": "try:\n    a = int(input())\n    b = int(input())\n    print(a // b)\nexcept Exception:\n    print(\"ошибка\")"
       },
       {
        "id": "exceptions_t2",
        "title": "Ключ из конфига",
        "difficulty": 2,
        "statement": "Включи в программу словарь `config = {\"host\": \"localhost\", \"port\": \"8080\", \"debug\": \"off\"}`. Читай одну строку — ключ. Если ключ есть в словаре — напечатай его значение; если его нет — напечатай `нет ключа`. Обращение к словарю оформи через try/except KeyError; метод get() использовать нельзя.",
        "input_format": "Одна строка — искомый ключ.",
        "output_format": "Одна строка — значение или `нет ключа`.",
        "examples": [
         {
          "input": "host",
          "output": "localhost"
         }
        ],
        "hints": [
         "Ключ, которого нет: config[\"xxx\"] поднимает KeyError — его и лови.",
         "print(config[key]) внутри try, print(\"нет ключа\") в except KeyError.",
         "Регистр важен: ключа \"PORT\" в словаре нет."
        ],
        "tests": [
         {
          "input": "host",
          "output": "localhost",
          "visible": true
         },
         {
          "input": "port",
          "output": "8080"
         },
         {
          "input": "PORT",
          "output": "нет ключа",
          "note": "регистр важен"
         },
         {
          "input": "debug",
          "output": "off"
         }
        ],
        "checks": {
         "must_use": [
          "try",
          "except",
          "KeyError"
         ],
         "must_not_use": [
          "get"
         ]
        },
        "solution": "config = {\"host\": \"localhost\", \"port\": \"8080\", \"debug\": \"off\"}\nkey = input()\ntry:\n    print(config[key])\nexcept KeyError:\n    print(\"нет ключа\")",
        "wrong_solution": "config = {\"host\": \"localhost\", \"port\": \"8080\", \"debug\": \"off\"}\nprint(config.get(input(), \"нет ключа\"))"
       },
       {
        "id": "exceptions_t3",
        "title": "Надёжный парсер",
        "difficulty": 3,
        "statement": "В файле `data.txt` лежат строки вида `название;число`, по одной записи на строке. Файл мог «поехать»: встречаются строки без числа, мусор вроде `молоко;абв` и пустые строки. Программа читает файл и считает сумму хороших строк; каждую битую нужно пропустить, а не упасть. В конце выведи две строки: `сумма: S` и `пропущено: K`. Если файла нет — выведи `файла нет` и на этом закончи.",
        "input_format": "Ввода нет, данные в файле data.txt.",
        "output_format": "Две строки: `сумма: S` и `пропущено: K`. Если файла нет — одна строка `файла нет`.",
        "examples": [
         {
          "input": "",
          "output": "данные: 'кофе;150\\nчай;80\\nмолоко;абв\\n\\nсыр;200' -> сумма: 430\\nпропущено: 2"
         }
        ],
        "hints": [
         "Внешний try/except FileNotFoundError оборачивает open(), внутренний try — разбор одной строки.",
         "parts = line.split(\";\") — у битой строки не хватит частей (IndexError) или int() упадёт (ValueError): лови оба через except (ValueError, IndexError).",
         "int(\"150\\n\") работает — перевод строки в конце мешает int редко; split() на ';' оставь как есть."
        ],
        "tests": [
         {
          "files": {
           "data.txt": "кофе;150\nчай;80\nмолоко;абв\n\nсыр;200"
          },
          "output": "сумма: 430\nпропущено: 2",
          "visible": true
         },
         {
          "files": {
           "data.txt": "а;5\nб;-3\nв;1"
          },
          "output": "сумма: 3\nпропущено: 0"
         },
         {
          "files": {
           "data.txt": ""
          },
          "output": "сумма: 0\nпропущено: 0",
          "note": "граничный случай: пустой файл"
         },
         {
          "files": {},
          "output": "файла нет",
          "note": "граничный случай: файла нет вообще"
         }
        ],
        "checks": {
         "must_use": [
          "try",
          "except"
         ]
        },
        "solution": "total = 0\nbroken = 0\ntry:\n    with open(\"data.txt\", encoding=\"utf-8\") as f:\n        for line in f:\n            parts = line.split(\";\")\n            try:\n                total += int(parts[1])\n            except (ValueError, IndexError):\n                broken += 1\nexcept FileNotFoundError:\n    print(\"файла нет\")\nelse:\n    print(f\"сумма: {total}\")\n    print(f\"пропущено: {broken}\")",
        "wrong_solution": "total = 0\nbroken = 0\ntry:\n    with open(\"data.txt\", encoding=\"utf-8\") as f:\n        for line in f:\n            parts = line.split(\";\")\n            total += int(parts[1])\nexcept FileNotFoundError:\n    print(\"файла нет\")\nprint(f\"сумма: {total}\")\nprint(f\"пропущено: {broken}\")"
       },
       {
        "id": "exceptions_t4",
        "title": "Создатель пользователя",
        "difficulty": 3,
        "statement": "Определи функцию `create_user(name, age)`, которая возвращает словарь `{\"name\": name, \"age\": age}`, а на плохие данные поднимает `ValueError` с текстом: имя пустое — сообщение `имя пустое`; возраст меньше 0 или больше 150 — сообщение `возраст от 0 до 150`. Границы 0 и 150 разрешены. Саму функцию не вызывай: проверка сама прогонит список случаев в цикле `try/except ValueError as e` и напечатает либо `ИМЯ: ВОЗРАСТ`, либо `ошибка: ТЕКСТ`.",
        "input_format": "Ввода нет.",
        "output_format": "Ничего печатать не нужно — только определить функцию.",
        "examples": [
         {
          "input": "",
          "output": "для create_user(\"\", 20) проверка напечатает: ошибка: имя пустое"
         }
        ],
        "hints": [
         "Проверки в начале функции: if not name: raise ValueError(\"имя пустое\").",
         "Возраст: if age < 0 or age > 150: raise ValueError(\"возраст от 0 до 150\").",
         "Точный текст сообщения важен — проверка печатает e через `f\"ошибка: {e}\"`."
        ],
        "tests": [
         {
          "code_before": "cases = [(\"Аня\", 30), (\"\", 20), (\"Боря\", -1), (\"Вера\", 300)]\n",
          "code_after": "for name, age in cases:\n    try:\n        user = create_user(name, age)\n        print(f\"{user['name']}: {user['age']}\")\n    except ValueError as e:\n        print(f\"ошибка: {e}\")\n",
          "output": "Аня: 30\nошибка: имя пустое\nошибка: возраст от 0 до 150\nошибка: возраст от 0 до 150",
          "visible": true
         },
         {
          "code_before": "cases = [(\"Ким\", 150), (\"Лия\", 0)]\n",
          "code_after": "for name, age in cases:\n    try:\n        user = create_user(name, age)\n        print(f\"{user['name']}: {user['age']}\")\n    except ValueError as e:\n        print(f\"ошибка: {e}\")\n",
          "output": "Ким: 150\nЛия: 0",
          "note": "границы допустимы"
         },
         {
          "code_before": "cases = [(\"М\", 151)]\n",
          "code_after": "for name, age in cases:\n    try:\n        user = create_user(name, age)\n        print(f\"{user['name']}: {user['age']}\")\n    except ValueError as e:\n        print(f\"ошибка: {e}\")\n",
          "output": "ошибка: возраст от 0 до 150"
         },
         {
          "code_before": "cases = [(\"Н\", 5), (\"\", 5)]\n",
          "code_after": "for name, age in cases:\n    try:\n        user = create_user(name, age)\n        print(f\"{user['name']}: {user['age']}\")\n    except ValueError as e:\n        print(f\"ошибка: {e}\")\n",
          "output": "Н: 5\nошибка: имя пустое"
         }
        ],
        "checks": {
         "must_define": [
          "create_user"
         ],
         "must_use": [
          "raise",
          "return"
         ]
        },
        "solution": "def create_user(name, age):\n    if not name:\n        raise ValueError(\"имя пустое\")\n    if age < 0 or age > 150:\n        raise ValueError(\"возраст от 0 до 150\")\n    return {\"name\": name, \"age\": age}",
        "wrong_solution": "def create_user(name, age):\n    if not name or age < 0 or age > 150:\n        return None\n    return {\"name\": name, \"age\": age}"
       }
      ],
      "summary": [
       "Traceback читается снизу вверх: тип и сообщение — в конце, твоя строка — выше.",
       "try/except — не «чтобы не падало», а реакция на конкретный ожидаемый сбой.",
       "Голый except запрещён: он прячет баги, лови точные типы.",
       "else — если всё было хорошо, finally — всегда; причина ошибки доступна через as e.",
       "raise — способ функции сказать «эти данные мне не подходят» понятным текстом."
      ],
      "further": [
       "docs.python.org/3/tutorial/errors.html",
       "docs.python.org/3/library/exceptions.html — иерархия встроенных исключений"
      ]
     }
    },
    {
     "file": "bridge/04_modules.json",
     "data": {
      "id": "modules",
      "stage": "bridge",
      "order": 4,
      "title": "Модули и импорт",
      "subtitle": "Один файл — одна ответственность",
      "minutes": 40,
      "version": 1,
      "goals": [
       "Импортировать модули в трёх формах и выбирать уместную",
       "Разбивать программу на свои модули (.py-файлы рядом)",
       "Объяснять, зачем нужен if __name__ == \"__main__\"",
       "Искать содержимое модуля через dir(), help() и документацию"
      ],
      "theory": [
       {
        "type": "text",
        "text": "Когда программа растёт, складывать всё в один файл становится невозможно: не найти нужное, страшно что-то менять. Модуль (module) — это обычный файл `что-то.py` с функциями и константами, который другие файлы подключают словом `import`. Так устроен весь Python: `math`, `random`, `json` — тоже модули."
       },
       {
        "type": "text",
        "text": "Форма 1: `import имя` — импортируем весь модуль, обращаемся через точку. Имя всегда видно — откуда функция, понятно сразу."
       },
       {
        "type": "code",
        "code": "import math\n\nprint(math.sqrt(16))\nprint(math.ceil(4.1))\nprint(math.floor(4.9))",
        "output": "4.0\n5\n4",
        "run_check": true
       },
       {
        "type": "text",
        "text": "Форма 2: `from модуль import имя` — берём конкретные имена, пишем короче. Форма 3: алиас `as` — когда имя длинное или занято."
       },
       {
        "type": "code",
        "code": "from math import sqrt, pi\nimport datetime as dt\n\nprint(sqrt(25))\nprint(round(pi, 4))\nprint(dt.date(2026, 9, 5).strftime(\"%d.%m.%Y\"))",
        "output": "5.0\n3.1416\n05.09.2026",
        "run_check": true
       },
       {
        "type": "text",
        "text": "Свои модули — файлы рядом. Создаёшь `helpers.py` с функциями, а в `main.py` пишешь `import helpers`. Всё, что определено в модуле (функции, классы, константы), доступно через точку."
       },
       {
        "type": "code",
        "code": "# helpers.py\nVERSION = 2\n\n\ndef tidy(text):\n    return \" \".join(text.split())",
        "caption": "файл helpers.py — просто модуль"
       },
       {
        "type": "code",
        "code": "# main.py\nimport helpers\n\nprint(helpers.tidy(\"  лишние   пробелы \"))\nprint(helpers.VERSION)",
        "caption": "main.py использует helpers.py"
       },
       {
        "type": "warning",
        "text": "`from module import *` — запрещённый приём: непонятно, откуда взялось имя, можно случайно затереть свою переменную. Импорт должен быть явным: либо модуль целиком, либо конкретные имена по списку."
       },
       {
        "type": "text",
        "text": "Важное свойство Python: код модуля выполняется при импорте. Поэтому в модулях обычно только определения, а «запуск» прячут под защиту `if __name__ == \"__main__\":`. Этот код сработает, когда файл запустили напрямую (python helpers.py), но не сработает, когда файл просто импортировали."
       },
       {
        "type": "code",
        "code": "def shout(text):\n    return text.upper() + \"!\"\n\n\nif __name__ == \"__main__\":\n    print(shout(\"привет\"))",
        "output": "ПРИВЕТ!",
        "run_check": true
       },
       {
        "type": "text",
        "text": "Не знаешь, что умеет модуль, — не гадай, а посмотри. `dir(модуль)` — список имён, `help(модуль.функция)` — короткая справка прямо в терминале, а надёжнее всего — официальная документация."
       },
       {
        "type": "code",
        "code": "import math\n\nnames = [n for n in dir(math) if not n.startswith(\"_\")]\nprint(sorted(names)[:5])\nprint(\"sqrt\" in names)",
        "output": "['acos', 'acosh', 'asin', 'asinh', 'atan']\nTrue",
        "run_check": true
       },
       {
        "type": "table",
        "header": [
         "Запись",
         "Как обращаться",
         "Когда уместно"
        ],
        "rows": [
         [
          "import math",
          "math.sqrt(x)",
          "по умолчанию — самый явный вариант"
         ],
         [
          "from math import sqrt",
          "sqrt(x)",
          "одна-две функции используются часто"
         ],
         [
          "import datetime as dt",
          "dt.date(...)",
          "длинное имя, общепринятый алиас"
         ],
         [
          "from math import *",
          "—",
          "никогда"
         ]
        ]
       },
       {
        "type": "note",
        "text": "Справочник стандартной библиотеки: docs.python.org/3/library/index.html. Привычка искать ответ там, а не в случайных snippet'ах, — половина профессионализма."
       }
      ],
      "tasks": [
       {
        "id": "modules_t1",
        "title": "Чистим строку чужим модулем",
        "difficulty": 1,
        "statement": "Рядом с программой лежит файл `norm.py` с функцией `tidy(text)`, которая нормализует пробелы: оставляет между словами по одному пробелу и убирает края. Программа читает одну строку, вызывает `norm.tidy()` и печатает результат, а второй строкой — его длину. Свою функцию `def` писать нельзя — только импорт.",
        "input_format": "Одна строка текста.",
        "output_format": "Две строки: очищенный текст и его длина.",
        "examples": [
         {
          "input": "\"  привет   мир  \"",
          "output": "привет мир\n10"
         }
        ],
        "hints": [
         "import norm — и функция доступна как norm.tidy(...).",
         "Длину считай len() по результату, а не по исходной строке.",
         "Не пиши свою реализацию split/join: проверка запретит def."
        ],
        "tests": [
         {
          "input": "  привет   мир  ",
          "output": "привет мир\n10",
          "visible": true,
          "files": {
           "norm.py": "def tidy(text):\n    return ' '.join(text.split())\n"
          }
         },
         {
          "input": "один",
          "output": "один\n4",
          "files": {
           "norm.py": "def tidy(text):\n    return ' '.join(text.split())\n"
          }
         },
         {
          "input": "a\t\tb   c",
          "output": "a b c\n5",
          "files": {
           "norm.py": "def tidy(text):\n    return ' '.join(text.split())\n"
          }
         },
         {
          "input": "   ",
          "output": "\n0",
          "note": "граничный случай: только пробелы",
          "files": {
           "norm.py": "def tidy(text):\n    return ' '.join(text.split())\n"
          }
         }
        ],
        "checks": {
         "must_use": [
          "import"
         ],
         "must_not_use": [
          "def"
         ]
        },
        "solution": "import norm\n\nline = input()\nclean = norm.tidy(line)\nprint(clean)\nprint(len(clean))",
        "wrong_solution": "line = input()\nclean = \" \".join(line.split())\nprint(clean)\nprint(len(line))",
        "note": "в тестах файл norm.py кладётся автоматически (поле files)"
       },
       {
        "id": "modules_t2",
        "title": "Фильтр из модуля",
        "difficulty": 2,
        "statement": "В файле `grades.py` уже определена функция `above(scores, boundary)` — возвращает список элементов `scores`, строго больших `boundary`. Импортируй её формой `from grades import above`. Программа читает первую строку — оценки через пробел (целые), вторую — границу; печатает отфильтрованные оценки (по одной на строку, в исходном порядке), а затем `всего: K`.",
        "input_format": "Строка 1 — целые числа через пробел. Строка 2 — целая граница.",
        "output_format": "Отфильтрованные числа построчно, затем строка `всего: K`.",
        "examples": [
         {
          "input": "3 5 7\n5",
          "output": "7\nвсего: 1"
         }
        ],
        "hints": [
         "from grades import above — дальше вызывай просто above(...).",
         "Числа читай списком: [int(x) for x in input().split()].",
         "Пустой результат допустим — тогда сразу строка \"всего: 0\"."
        ],
        "tests": [
         {
          "input": "3 5 7\n5",
          "output": "7\nвсего: 1",
          "visible": true,
          "files": {
           "grades.py": "def above(scores, boundary):\n    return [s for s in scores if s > boundary]\n"
          }
         },
         {
          "input": "10 4 8 10\n9",
          "output": "10\n10\nвсего: 2",
          "files": {
           "grades.py": "def above(scores, boundary):\n    return [s for s in scores if s > boundary]\n"
          }
         },
         {
          "input": "1 2\n10",
          "output": "всего: 0",
          "note": "граничный случай: пусто",
          "files": {
           "grades.py": "def above(scores, boundary):\n    return [s for s in scores if s > boundary]\n"
          }
         },
         {
          "input": "-5 0 5\n-6",
          "output": "-5\n0\n5\nвсего: 3",
          "files": {
           "grades.py": "def above(scores, boundary):\n    return [s for s in scores if s > boundary]\n"
          }
         }
        ],
        "checks": {
         "must_use": [
          "above"
         ]
        },
        "solution": "from grades import above\n\nscores = [int(x) for x in input().split()]\nboundary = int(input())\ngood = above(scores, boundary)\nfor s in good:\n    print(s)\nprint(f\"всего: {len(good)}\")",
        "wrong_solution": "from grades import above\n\nscores = [int(x) for x in input().split()]\nboundary = int(input())\nfor s in scores:\n    if s > boundary:\n        print(s)\nprint(f\"всего: {len(scores)}\")"
       },
       {
        "id": "modules_t3",
        "title": "Калькулятор с интерфейсом",
        "difficulty": 2,
        "statement": "Модуль `calc.py` умеет два действия: `plus(a, b)` и `minus(a, b)`. Программа читает три строки: число a, число b, знак операции (`+` или `-`). Импортируй модуль целиком (`import calc`) и выведи результат нужной функции; для любого другого знака выведи `не знаю`.",
        "input_format": "Три строки: целое a, целое b, символ операции.",
        "output_format": "Одна строка — результат или `не знаю`.",
        "examples": [
         {
          "input": "3\n5\n+",
          "output": "8"
         }
        ],
        "hints": [
         "import calc, затем calc.plus(a, b) / calc.minus(a, b).",
         "Ветка else закрывает все прочие знаки.",
         "Числа целые — int(input())."
        ],
        "tests": [
         {
          "input": "3\n5\n+",
          "output": "8",
          "visible": true,
          "files": {
           "calc.py": "def plus(a, b):\n    return a + b\n\n\ndef minus(a, b):\n    return a - b\n"
          }
         },
         {
          "input": "10\n4\n-",
          "output": "6",
          "files": {
           "calc.py": "def plus(a, b):\n    return a + b\n\n\ndef minus(a, b):\n    return a - b\n"
          }
         },
         {
          "input": "1\n1\n*",
          "output": "не знаю",
          "note": "неизвестная операция",
          "files": {
           "calc.py": "def plus(a, b):\n    return a + b\n\n\ndef minus(a, b):\n    return a - b\n"
          }
         },
         {
          "input": "0\n-5\n+",
          "output": "-5",
          "files": {
           "calc.py": "def plus(a, b):\n    return a + b\n\n\ndef minus(a, b):\n    return a - b\n"
          }
         }
        ],
        "checks": {
         "must_use": [
          "calc"
         ]
        },
        "solution": "import calc\n\na = int(input())\nb = int(input())\nsign = input()\nif sign == \"+\":\n    print(calc.plus(a, b))\nelif sign == \"-\":\n    print(calc.minus(a, b))\nelse:\n    print(\"не знаю\")",
        "wrong_solution": "import calc\n\na = int(input())\nb = int(input())\nsign = input()\nif sign == \"+\":\n    print(calc.minus(a, b))\nelif sign == \"-\":\n    print(calc.plus(a, b))\nelse:\n    print(\"не знаю\")"
       },
       {
        "id": "modules_t4",
        "title": "Модуль, который болтает",
        "difficulty": 3,
        "statement": "Рядом лежит `greeter.py`: при импорте он печатает свою строку, а потом определяет `hello()`, возвращающую строку-приветствие (тексты могут быть другими!). Напиши программу: импортируй модуль, напечатай строку, которую вернул `hello()`, и вторым числом — её длину. Ничего не зашивай руками: длину считай `len()`. Помни про порядок: строка модуля напечатается раньше твоей, ведь импорт выполняется первой строкой.",
        "input_format": "Ввода нет.",
        "output_format": "Две строки после строки, которую напечатал сам модуль: текст приветствия и его длина.",
        "examples": [
         {
          "input": "",
          "output": "при greeter.py с 'print(\"загрузка модуля\")' и hello() -> 'привет':\nзагрузка модуля\nпривет\n6"
         }
        ],
        "hints": [
         "result = greeter.hello(); print(result); print(len(result)).",
         "Не пытайся угадать текст — тесты подсовывают разные модули, работай только через len().",
         "Функция возвращает (return), а не печатает — печать у тебя."
        ],
        "tests": [
         {
          "files": {
           "greeter.py": "print('загрузка модуля')\n\n\ndef hello():\n    return 'привет'\n"
          },
          "output": "загрузка модуля\nпривет\n6",
          "visible": true
         },
         {
          "files": {
           "greeter.py": "print('gru')\n\n\ndef hello():\n    return 'здравствуй'\n"
          },
          "output": "gru\nздравствуй\n10"
         },
         {
          "files": {
           "greeter.py": "print('модуль загружен: v2')\n\n\ndef hello():\n    return 'привет всем'\n"
          },
          "output": "модуль загружен: v2\nпривет всем\n11"
         },
         {
          "files": {
           "greeter.py": "print('hi')\n\n\ndef hello():\n    return 'хай'\n"
          },
          "output": "hi\nхай\n3"
         }
        ],
        "checks": {
         "must_use": [
          "import",
          "len"
         ]
        },
        "solution": "import greeter\n\nresult = greeter.hello()\nprint(result)\nprint(len(result))",
        "wrong_solution": "import greeter\n\nprint(greeter.hello())"
       }
      ],
      "summary": [
       "Модуль — файл .py; import выполняет его код и даёт доступ к именам.",
       "Формы: import math / from math import sqrt / import ... as — выбирай явность.",
       "Код модуля исполняется при импорте; «самозапуск» прячут под if __name__ == \"__main__\".",
       "Знакомство с модулем: dir(), help(), docs.python.org/3/library/.",
       "import * не используется — никогда."
      ],
      "further": [
       "docs.python.org/3/tutorial/modules.html",
       "Stepik «Поколение Python: курс для продвинутых», модуль «Модули»"
      ]
     }
    },
    {
     "file": "bridge/05_stdlib.json",
     "data": {
      "id": "stdlib",
      "stage": "bridge",
      "order": 5,
      "title": "Стандартная библиотека",
      "subtitle": "random, math, datetime, pathlib, time",
      "minutes": 50,
      "version": 1,
      "goals": [
       "Генерировать случайности воспроизводимо: seed, randint, choice, shuffle",
       "Брать из math корни, pi и правильное округление ceil/floor",
       "Считать даты через date, timedelta, strptime и strftime",
       "Разбирать пути через pathlib: name, suffix, iterdir"
      ],
      "theory": [
       {
        "type": "text",
        "text": "«Батарейки в комплекте»: Python идёт с большой библиотекой готовых модулей — ставить через pip ничего не нужно. Разберём пятерку тех, что нужны в любой ветке: random, math, datetime, pathlib, time."
       },
       {
        "type": "text",
        "text": "Модуль `random` — случайные числа и выбор. `randint(a, b)` — целое от a до b включительно, `choice(seq)` — случайный элемент, `shuffle(list)` — перемешивание на месте. Для воспроизводимости (тесты, отладка) ставят `random.seed(число)` — после сида вся «случайность» повторяется от запуска к запуску."
       },
       {
        "type": "code",
        "code": "import random\n\nrandom.seed(7)\nprint(random.randint(1, 6))\nprint(random.randint(1, 6))\nprint(random.choice([\"камень\", \"ножницы\", \"бумага\"]))",
        "output": "3\n2\nножницы",
        "run_check": true
       },
       {
        "type": "code",
        "code": "import random\n\ncards = [\"туз\", \"король\", \"дама\", \"валет\"]\nrandom.shuffle(cards)\nprint(cards)  # каждый раз новый порядок",
        "caption": "shuffle меняет сам список, ничего не возвращает"
       },
       {
        "type": "text",
        "text": "Модуль `math` — честная математика: `sqrt` (корень), `pi`, `floor` (в меньшую сторону) и `ceil` (в большую). Последний часто спасает в задачах «сколько упаковок нужно»."
       },
       {
        "type": "code",
        "code": "import math\n\nprint(math.sqrt(144))\nprint(math.ceil(10 / 3))\nprint(math.floor(10 / 3))\nprint(round(math.pi, 4))",
        "output": "12.0\n4\n3\n3.1416",
        "run_check": true
       },
       {
        "type": "text",
        "text": "`datetime`: дата — объект `date(year, month, day)`, с ним складывается `timedelta` — «промежуток». Форматирование: `strftime` — дата → строка по шаблону, `strptime` — строка → дата. Шаблоны: `%d` день, `%m` месяц, `%Y` год."
       },
       {
        "type": "code",
        "code": "from datetime import date, timedelta\n\nstart = date(2026, 9, 5)\ndeadline = start + timedelta(days=14)\nprint(deadline.strftime(\"%d.%m.%Y\"))\nprint(deadline.weekday())  # 0=пн ... 5=сб, 6=вс",
        "output": "19.09.2026\n5",
        "run_check": true
       },
       {
        "type": "code",
        "code": "from datetime import datetime\n\nbirthday = datetime.strptime(\"12.06.1990\", \"%d.%m.%Y\")\nprint(birthday.year)\nprint(birthday.strftime(\"%d.%m.%Y\"))",
        "output": "1990\n12.06.1990",
        "run_check": true
       },
       {
        "type": "text",
        "text": "`pathlib.Path` — объект «путь к файлу» вместо возни со строками и `os.path`. Он сам разберёт имя на части и спросит, существует ли файл. А `Path(\".\").iterdir()` перечислит содержимое папки."
       },
       {
        "type": "code",
        "code": "from pathlib import Path\n\np = Path(\"downloads/report.pdf\")\nprint(p.name)\nprint(p.suffix)\nprint(p.stem)\nprint(Path(\"заметки.txt\").exists())",
        "output": "report.pdf\n.pdf\nreport\nFalse",
        "run_check": true
       },
       {
        "type": "text",
        "text": "Ещё пара полезностей: `time.perf_counter()` — секунды для замеров «сколько работало», а `dir(модуль)` и `help()` покажут, что внутри незнакомой библиотеки. Полная витрина стандартной библиотеки — в docs.python.org/3/library/, там есть буквально всё: от архивов до работы с почтой."
       },
       {
        "type": "warning",
        "text": "`random.random()` и `datetime.now()` дают каждый раз новый результат — автопроверка на них ломается. Хочешь тестируемую случайность — зафиксируй `random.seed(...)`; даты в задачах передавай явно (date(2026, 9, 5)), а не бери «сегодня»."
       },
       {
        "type": "table",
        "header": [
         "Модуль",
         "Берут, когда нужно"
        ],
        "rows": [
         [
          "random",
          "кости, рандомная выдача, перемешать колоду"
         ],
         [
          "math",
          "корни, pi, округление вверх/вниз"
         ],
         [
          "datetime",
          "дедлайны, сколько дней прошло, парсить дату из строки"
         ],
         [
          "pathlib",
          "разобрать имя файла, проверить существование, обойти папку"
         ],
         [
          "time",
          "замерить длительность, поставить паузу sleep()"
         ]
        ]
       }
      ],
      "tasks": [
       {
        "id": "stdlib_t1",
        "title": "Гипотенуза",
        "difficulty": 1,
        "statement": "Программа читает два целых катета (по строке на каждый) и печатает гипотенузу. Возьми корень из суммы квадратов через `math.sqrt()` и округли до 2 знаков `round(x, 2)` — печатай ровно то, что вернул round: для 5.0 вывод будет `5.0`, а не `5.00`.",
        "input_format": "Две строки — целые катеты.",
        "output_format": "Одно число — округлённый до 2 знаков результат round().",
        "examples": [
         {
          "input": "3\n4",
          "output": "5.0"
         }
        ],
        "hints": [
         "c = math.sqrt(a * a + b * b)",
         "Именно round(c, 2), а не f\"{c:.2f}\" — формат добавит лишние нули.",
         "Не забудь import math."
        ],
        "tests": [
         {
          "input": "3\n4",
          "output": "5.0",
          "visible": true
         },
         {
          "input": "1\n1",
          "output": "1.41"
         },
         {
          "input": "5\n12",
          "output": "13.0"
         },
         {
          "input": "0\n0",
          "output": "0.0",
          "note": "граничный случай: нулевой треугольник"
         }
        ],
        "checks": {
         "must_use": [
          "math",
          "sqrt"
         ]
        },
        "solution": "import math\n\na = int(input())\nb = int(input())\nprint(round(math.sqrt(a * a + b * b), 2))",
        "wrong_solution": "import math\n\na = int(input())\nb = int(input())\nprint(round(math.sqrt(a * a + b * b), 3))"
       },
       {
        "id": "stdlib_t2",
        "title": "Сколько до субботы",
        "difficulty": 2,
        "statement": "Программа читает дату в формате `ДД.ММ.ГГГГ` (например, 05.09.2026). Выведи две строки: `это ДЕНЬ` — название дня недели по-русски в нижнем регистре (понедельник…воскресенье), и `до субботы: N` — сколько дней осталось до ближайшей субботы. Сегодня суббота — 0, воскресенье — 6. Разбирай дату через `datetime.strptime`.",
        "input_format": "Одна строка — дата в формате ДД.ММ.ГГГГ.",
        "output_format": "Две строки: `это ...` и `до субботы: ...`.",
        "examples": [
         {
          "input": "05.09.2026",
          "output": "это суббота\nдо субботы: 0"
         }
        ],
        "hints": [
         "d = datetime.strptime(input(), \"%d.%m.%Y\"); номер дня даёт d.weekday(): 0=понедельник, 5=суббота, 6=воскресенье.",
         "Названия удобно хранить списком-константой и брать names[d.weekday()].",
         "Дни до субботы: (5 - wd) % 7 — остаток от вычитания сам обрабатывает воскресенье и саму субботу."
        ],
        "tests": [
         {
          "input": "05.09.2026",
          "output": "это суббота\nдо субботы: 0",
          "visible": true
         },
         {
          "input": "04.09.2026",
          "output": "это пятница\nдо субботы: 1"
         },
         {
          "input": "06.09.2026",
          "output": "это воскресенье\nдо субботы: 6",
          "note": "граничный случай: воскресенье"
         },
         {
          "input": "07.09.2026",
          "output": "это понедельник\nдо субботы: 5"
         }
        ],
        "checks": {
         "must_use": [
          "datetime",
          "strptime"
         ]
        },
        "solution": "from datetime import datetime\n\nnames = [\"понедельник\", \"вторник\", \"среда\", \"четверг\", \"пятница\",\n         \"суббота\", \"воскресенье\"]\nd = datetime.strptime(input(), \"%d.%m.%Y\")\nwd = d.weekday()\nprint(f\"это {names[wd]}\")\nprint(f\"до субботы: {(5 - wd) % 7}\")",
        "wrong_solution": "from datetime import datetime\n\nnames = [\"понедельник\", \"вторник\", \"среда\", \"четверг\", \"пятница\",\n         \"суббота\", \"воскресенье\"]\nd = datetime.strptime(input(), \"%d.%m.%Y\")\nwd = d.weekday()\nprint(f\"это {names[wd]}\")\nprint(f\"до субботы: {5 - wd}\")"
       },
       {
        "id": "stdlib_t3",
        "title": "Инспектор папки",
        "difficulty": 3,
        "statement": "В рабочей папке лежат файлы (в тесте их подсовывает проверка). Программа ничего не читает через input(): обойди текущую папку через `Path(\".\").iterdir()` и напечатай построчно каждый файл в формате `имя (расширение)`, где расширение — из `suffix` (с точкой); у файла без расширения выведи `имя (без расширения)`. Порядок — по алфавиту (сортировка по имени!). Последней строкой — `всего: N`. Формат расширения для двойных: у `a.tar.gz` суффикс `.gz`.",
        "input_format": "Ввода нет — данные лежат в рабочей папке.",
        "output_format": "Построчно `имя (расширение)` по алфавиту имён, затем `всего: N`.",
        "examples": [
         {
          "input": "",
          "output": "для файлов a.txt, b.csv, notes.md:\na.txt (.txt)\nb.csv (.csv)\nnotes.md (.md)\nвсего: 3"
         }
        ],
        "hints": [
         "files = sorted(Path(\".\").iterdir(), key=lambda p: p.name) — сортируй именно по имени, обход папки сам по себе неупорядочен.",
         "У каждого Path есть готовые .name и .suffix; пустая строка суффикса — ложь, удобно: p.suffix or \"без расширения\".",
         "len(files) для итоговой строки."
        ],
        "tests": [
         {
          "files": {
           "a.txt": "1",
           "b.csv": "2",
           "notes.md": "3"
          },
          "output": "a.txt (.txt)\nb.csv (.csv)\nnotes.md (.md)\nвсего: 3",
          "visible": true
         },
         {
          "files": {
           "README": "x"
          },
          "output": "README (без расширения)\nвсего: 1"
         },
         {
          "files": {},
          "output": "всего: 0",
          "note": "граничный случай: пустая папка"
         },
         {
          "files": {
           "a.tar.gz": "1"
          },
          "output": "a.tar.gz (.gz)\nвсего: 1",
          "note": "двойное расширение: берётся последнее"
         }
        ],
        "checks": {
         "must_use": [
          "Path",
          "iterdir"
         ]
        },
        "solution": "from pathlib import Path\n\nfiles = sorted(Path(\".\").iterdir(), key=lambda p: p.name)\nfor p in files:\n    suffix = p.suffix or \"без расширения\"\n    print(f\"{p.name} ({suffix})\")\nprint(f\"всего: {len(files)}\")",
        "wrong_solution": "from pathlib import Path\n\nfiles = sorted(Path(\".\").iterdir(), key=lambda p: p.suffix)\nfor p in files:\n    suffix = p.suffix or \"без расширения\"\n    print(f\"{p.name} ({suffix})\")\nprint(f\"всего: {len(files)}\")"
       }
      ],
      "summary": [
       "random: randint/choice/shuffle; для тестируемости фиксируй random.seed(N).",
       "math: sqrt, pi, floor/ceil — округление «в пол» и «в потолок».",
       "datetime: strptime разбирает строку, strftime собирает обратно; разница дат — timedelta.",
       "pathlib: .name, .suffix, .stem, .exists(), обход папки через iterdir (с самодельной сортировкой!).",
       "time.perf_counter() — замеры; docs.python.org/3/library — за всем остальным."
      ],
      "further": [
       "docs.python.org/3/library/random.html",
       "docs.python.org/3/library/datetime.html — шпаргалка по %-кодам strftime"
      ]
     }
    },
    {
     "file": "bridge/06_json_csv.json",
     "data": {
      "id": "json_csv",
      "stage": "bridge",
      "order": 6,
      "title": "JSON и CSV",
      "subtitle": "Как данные живут в файлах",
      "minutes": 50,
      "version": 1,
      "goals": [
       "Сохранять и читать словари/списки через json.dumps/loads и json.dump/load",
       "Читать и писать CSV через csv.reader/DictReader и csv.writer",
       "Помнить про encoding=\"utf-8\", ensure_ascii=False и newline=\"\"",
       "Собирать цепочку «прочитали CSV → посчитали → записали JSON»"
      ],
      "theory": [
       {
        "type": "text",
        "text": "Данные должны переживать перезапуск программы. Два формата, которые покрывают 90% бытовых задач: JSON — текстовое «дерево» из словарей и списков (его любят API и конфиги), CSV — таблица «одна строка = одна запись, значения через запятую» (его любит Excel). В Python для обоих есть стандартные модули: `json` и `csv`."
       },
       {
        "type": "text",
        "text": "Модуль `json`: `dumps` превращает объект в строку (s = string), `loads` — обратно. По умолчанию кириллица превращается в `\\u043f`-последовательности; человекочитаемость возвращает `ensure_ascii=False`, а красота — `indent=2`."
       },
       {
        "type": "code",
        "code": "import json\n\nuser = {\"name\": \"Аня\", \"age\": 30, \"tags\": [\"python\", \"csv\"]}\ntext = json.dumps(user, ensure_ascii=False)\nprint(text)\nback = json.loads(text)\nprint(back[\"name\"])",
        "output": "{\"name\": \"Аня\", \"age\": 30, \"tags\": [\"python\", \"csv\"]}\nАня",
        "run_check": true
       },
       {
        "type": "text",
        "text": "Для файлов есть те же функции без последней «s»: `json.dump(obj, f)` пишет, `json.load(f)` читает. JSON хранит типы: числа останутся числами, вложенные словари — словарями. Даты и свои классы — нет, только строки."
       },
       {
        "type": "code",
        "code": "import json\n\ndata = {\"city\": \"Казань\", \"temp\": 18.5}\nwith open(\"weather.json\", \"w\", encoding=\"utf-8\") as f:\n    json.dump(data, f, ensure_ascii=False, indent=2)\n\nwith open(\"weather.json\", encoding=\"utf-8\") as f:\n    loaded = json.load(f)\nprint(loaded[\"temp\"])",
        "output": "18.5",
        "run_check": true
       },
       {
        "type": "text",
        "text": "CSV разбирать вручную `split(\";\")` — плохая идея: запятые внутри значений, кавычки... Для этого есть модуль `csv`. `csv.reader` отдаёт построчно списки строк; `csv.DictReader` — словари по заголовку файла. Обращайся к полям по имени — читается лучше."
       },
       {
        "type": "code",
        "code": "import csv\n\nwith open(\"prices.csv\", \"w\", encoding=\"utf-8\") as f:\n    f.write(\"товар,цена\\nкофе,150\\nчай,80\\n\")\n\nwith open(\"prices.csv\", encoding=\"utf-8\", newline=\"\") as f:\n    for row in csv.DictReader(f):\n        print(row[\"товар\"], int(row[\"цена\"]) * 2)",
        "output": "кофе 300\nчай 160",
        "run_check": true
       },
       {
        "type": "text",
        "text": "Писать CSV — `csv.writer.writerow([...])`. При открытии файла на запись всегда ставь `newline=\"\"`, иначе на Windows в файл закрадываются пустые строки между записями."
       },
       {
        "type": "code",
        "code": "import csv\n\nrows = [[\"товар\", \"кол-во\"], [\"хлеб\", 2], [\"сыр\", 3]]\nwith open(\"cart.csv\", \"w\", encoding=\"utf-8\", newline=\"\") as f:\n    writer = csv.writer(f)\n    for row in rows:\n        writer.writerow(row)\nprint(open(\"cart.csv\", encoding=\"utf-8\").read().strip())",
        "output": "товар,кол-во\r\nхлеб,2\r\nсыр,3",
        "run_check": true
       },
       {
        "type": "warning",
        "text": "csv и json при чтении не угадывают типы: все значения из csv — строки, даже «150». Считай сам: `int(row[\"цена\"])`, `float(...)`. И наоборот: если в JSON положить дату `datetime`, dump упадёт — храни даты строками (\"2026-09-05\")."
       },
       {
        "type": "table",
        "header": [
         "Операция",
         "Запись"
        ],
        "rows": [
         [
          "объект → строка",
          "json.dumps(obj, ensure_ascii=False, indent=2)"
         ],
         [
          "объект → файл",
          "json.dump(obj, f, ensure_ascii=False, indent=2)"
         ],
         [
          "CSV-файл → строки-списки",
          "csv.reader(f, delimiter=';')"
         ],
         [
          "CSV-файл → строки-словари",
          "csv.DictReader(f)"
         ],
         [
          "список списков → CSV",
          "csv.writer(f).writerow(row)"
         ]
        ]
       },
       {
        "type": "note",
        "text": "Классический рабочий цикл: CSV на входе → считаешь в словаре → результат пишешь JSON. Открыл файл на чтение — итерируйся по нему; открыл на запись (`\"w\"`) — файл будет перезаписан с нуля, `\"a\"` — дозапись в конец."
       }
      ],
      "tasks": [
       {
        "id": "json_csv_t1",
        "title": "Настройки в JSON",
        "difficulty": 1,
        "statement": "Первая строка — число N, следующие N строк — записи вида `ключ=значение` (в значении могут встречаться `=` и пробелы; сама строка — ровно один ключ слева от первого `=`). Собери словарь и сохрани его в файл `settings.json` через `json.dump` с `ensure_ascii=False` и `indent=2`. Ничего не печатай.",
        "input_format": "N+1 строк: число записей, затем пары ключ=значение.",
        "output_format": "Файл settings.json. Вывод на экран — пустой.",
        "examples": [
         {
          "input": "2\ntheme=dark\nlang=ru",
          "output": "settings.json:\n{\n  \"theme\": \"dark\",\n  \"lang\": \"ru\"\n}"
         }
        ],
        "hints": [
         "Разбивай строку так, чтобы не сломать значение: key, value = line.split(\"=\", 1).",
         "json.dump(settings, f, ensure_ascii=False, indent=2) — без ensure_ascii кириллица уедет в \\u-последовательности.",
         "N=0: словарь пустой, в файле должно быть {}, и это тоже dump, а не ручная запись."
        ],
        "tests": [
         {
          "input": "2\ntheme=dark\nlang=ru",
          "output": "",
          "visible": true,
          "output_files": {
           "settings.json": "{\n  \"theme\": \"dark\",\n  \"lang\": \"ru\"\n}"
          }
         },
         {
          "input": "0",
          "output": "",
          "output_files": {
           "settings.json": "{}"
          },
          "note": "граничный случай: ноль записей"
         },
         {
          "input": "1\nurl=http://site/?a=b",
          "output": "",
          "output_files": {
           "settings.json": "{\n  \"url\": \"http://site/?a=b\"\n}"
          },
          "note": "значение содержит ="
         },
         {
          "input": "1\nрежим=тест",
          "output": "",
          "output_files": {
           "settings.json": "{\n  \"режим\": \"тест\"\n}"
          },
          "note": "кириллица должна остаться читаемой"
         }
        ],
        "checks": {
         "must_use": [
          "json",
          "dump"
         ]
        },
        "solution": "import json\n\nn = int(input())\nsettings = {}\nfor _ in range(n):\n    key, value = input().split(\"=\", 1)\n    settings[key] = value\nwith open(\"settings.json\", \"w\", encoding=\"utf-8\") as f:\n    json.dump(settings, f, ensure_ascii=False, indent=2)",
        "wrong_solution": "import json\n\nn = int(input())\nsettings = {}\nfor _ in range(n):\n    key, value = input().split(\"=\", 1)\n    settings[key] = value\nwith open(\"settings.json\", \"w\", encoding=\"utf-8\") as f:\n    json.dump(settings, f)"
       },
       {
        "id": "json_csv_t2",
        "title": "Товары из CSV",
        "difficulty": 2,
        "statement": "В файле `data.csv` — цены товаров в формате `товар;цена;кол` (разделитель — точка с запятой, первая строка — заголовок; цена — дробное число). Для каждой строки напечатай `товар x кол = сумма`, где сумма = цена × количество с двумя знаками после точки. Последней строкой — `итого: S` (сумма всех строк, тоже два знака). Читай через `csv.reader` с delimiter=';'.",
        "input_format": "Ввода нет, данные в файле data.csv.",
        "output_format": "Строк по числу записей + строка `итого: S`, суммы через ':.2f'.",
        "examples": [
         {
          "input": "",
          "output": "для 'товар;цена;кол\\nхлеб;45.5;2\\nмолоко;89.9;1\\n':\nхлеб x 2 = 91.00\nмолоко x 1 = 89.90\nитого: 180.90"
         }
        ],
        "hints": [
         "reader = csv.reader(f, delimiter=\";\"); заголовок пропусти: next(reader).",
         "Цены из CSV — строки! float(price) и int(qty) перед умножением.",
         "Копи итог в переменную total и форматируй всё через :.2f."
        ],
        "tests": [
         {
          "files": {
           "data.csv": "товар;цена;кол\nхлеб;45.5;2\nмолоко;89.9;1\n"
          },
          "output": "хлеб x 2 = 91.00\nмолоко x 1 = 89.90\nитого: 180.90",
          "visible": true
         },
         {
          "files": {
           "data.csv": "товар;цена;кол\n"
          },
          "output": "итого: 0.00",
          "note": "граничный случай: только заголовок"
         },
         {
          "files": {
           "data.csv": "товар;цена;кол\nсыр;199.99;3\n"
          },
          "output": "сыр x 3 = 599.97\nитого: 599.97"
         },
         {
          "files": {
           "data.csv": "товар;цена;кол\nвода;50;10\n"
          },
          "output": "вода x 10 = 500.00\nитого: 500.00"
         }
        ],
        "checks": {
         "must_use": [
          "csv"
         ]
        },
        "solution": "import csv\n\ntotal = 0.0\nwith open(\"data.csv\", encoding=\"utf-8\", newline=\"\") as f:\n    reader = csv.reader(f, delimiter=\";\")\n    next(reader)\n    for name, price, qty in reader:\n        s = float(price) * int(qty)\n        total += s\n        print(f\"{name} x {qty} = {s:.2f}\")\nprint(f\"итого: {total:.2f}\")",
        "wrong_solution": "import csv\n\ntotal = 0.0\nwith open(\"data.csv\", encoding=\"utf-8\", newline=\"\") as f:\n    reader = csv.reader(f, delimiter=\";\")\n    for name, price, qty in reader:\n        s = float(price) * int(qty)\n        total += s\n        print(f\"{name} x {qty} = {s:.2f}\")\nprint(f\"итого: {total:.2f}\")"
       },
       {
        "id": "json_csv_t3",
        "title": "Итоги продаж в JSON",
        "difficulty": 3,
        "statement": "В файле `sales.csv` строки вида `товар;количество;цена` (первая строка — заголовок; количество — целое, цена — дробное; одинаковые товары могут повторяться). Посчитай выручку по каждому товару (сумма «количество × цена» по всем его строкам) и запиши результат в `report.json` как словарь {товар: выручка}, отсортированный по названию товара, с отступом 2 и кириллицей как есть. Выручку округли до 2 знаков. Ничего не печатай.",
        "input_format": "Ввода нет. Данные — в файле sales.csv в рабочей папке.",
        "output_format": "Файл report.json.",
        "examples": [
         {
          "input": "sales.csv:\nтовар;количество;цена\nКофе;2;150\nЧай;1;80\nКофе;1;150",
          "output": "report.json:\n{\n  \"Кофе\": 450.0,\n  \"Чай\": 80.0\n}"
         }
        ],
        "hints": [
         "csv.reader(f, delimiter=';'), первую строку пропусти через next(reader).",
         "Копи суммы в словаре: totals[name] = totals.get(name, 0) + qty * price.",
         "json.dump(dict(sorted(totals.items())), f, ensure_ascii=False, indent=2)."
        ],
        "tests": [
         {
          "files": {
           "sales.csv": "товар;количество;цена\nКофе;2;150\nЧай;1;80\nКофе;1;150\n"
          },
          "output_files": {
           "report.json": "{\n  \"Кофе\": 450.0,\n  \"Чай\": 80.0\n}"
          },
          "output": "",
          "visible": true
         },
         {
          "files": {
           "sales.csv": "товар;количество;цена\n"
          },
          "output_files": {
           "report.json": "{}"
          },
          "output": ""
         },
         {
          "files": {
           "sales.csv": "товар;количество;цена\nБулка;3;33.33\n"
          },
          "output_files": {
           "report.json": "{\n  \"Булка\": 99.99\n}"
          },
          "output": ""
         },
         {
          "files": {
           "sales.csv": "товар;количество;цена\nЧай;2;80\nКофе;1;150\nЧай;1;80\n"
          },
          "output_files": {
           "report.json": "{\n  \"Кофе\": 150.0,\n  \"Чай\": 240.0\n}"
          },
          "output": "",
          "note": "сортировка по названию, не по сумме"
         }
        ],
        "checks": {
         "must_use": [
          "csv",
          "json"
         ]
        },
        "solution": "import csv\nimport json\n\ntotals = {}\nwith open(\"sales.csv\", encoding=\"utf-8\", newline=\"\") as f:\n    reader = csv.reader(f, delimiter=\";\")\n    next(reader)\n    for name, qty, price in reader:\n        totals[name] = totals.get(name, 0) + int(qty) * float(price)\n\nresult = {k: round(v, 2) for k, v in sorted(totals.items())}\nwith open(\"report.json\", \"w\", encoding=\"utf-8\") as f:\n    json.dump(result, f, ensure_ascii=False, indent=2)",
        "wrong_solution": "import csv\nimport json\n\ntotals = {}\nwith open(\"sales.csv\", encoding=\"utf-8\") as f:\n    reader = csv.reader(f, delimiter=\";\")\n    next(reader)\n    for name, qty, price in reader:\n        totals[name] = int(qty) * float(price)\nwith open(\"report.json\", \"w\", encoding=\"utf-8\") as f:\n    json.dump(totals, f, ensure_ascii=False, indent=2)"
       }
      ],
      "summary": [
       "json.dump(s)/load(s): dumps/loads — строка, dump/load — файл; ensure_ascii=False и indent=2 для читаемости.",
       "csv.reader/DictReader читают, csv.writer/DictWriter пишут; разделитель задавай явно (delimiter=';').",
       "Файлы с текстом — только с encoding=\"utf-8\"; CSV на запись — ещё и newline=\"\".",
       "CSV отдаёт строки: превращай в int/float сам; JSON типы помнит, но даты и свои классы — нет.",
       "Паттерн дня: CSV → словарь-агрегатор → отсортированный JSON."
      ],
      "further": [
       "docs.python.org/3/library/json.html",
       "docs.python.org/3/library/csv.html"
      ]
     }
    },
    {
     "file": "bridge/07_oop_basics.json",
     "data": {
      "id": "oop_basics",
      "stage": "bridge",
      "order": 7,
      "title": "Основы ООП",
      "subtitle": "Читать чужой код с классами — уже победа",
      "minutes": 55,
      "version": 1,
      "goals": [
       "Объяснять словами: класс, объект, атрибут, метод",
       "Писать простые классы с __init__, self и методами",
       "Задавать человеческий вид объекта через __str__",
       "Понимать наследование и super().__init__ при чтении чужого кода"
      ],
      "theory": [
       {
        "type": "text",
        "text": "Класс (class) — это «чертёж»: он описывает, какие данные хранит объект и что умеет с ними делать. Пока что ты носил данные в связках «словарь + отдельные функции». Класс объединяет их в одном месте: у товара есть и цена, и способ посчитать скидку. Твоя цель на этом этапе — уверенно ПИСАТЬ простые классы и ЧИТАТЬ чужие: на них построен почти весь реальный код."
       },
       {
        "type": "code",
        "code": "class Product:\n    def __init__(self, name, price):\n        self.name = name\n        self.price = price\n\n    def cost(self, qty):\n        return self.price * qty\n\n\nbread = Product(\"Хлеб\", 45)\nprint(bread.name)\nprint(bread.cost(3))",
        "output": "Хлеб\n135",
        "run_check": true
       },
       {
        "type": "text",
        "text": "`Product(\"Хлеб\", 45)` создаёт объект (экземпляр) класса. `__init__` — метод-конструктор: вызывается автоматически при создании и принимает данные. Присваивание `self.name = name` сохраняет значение ВНУТРЬ объекта — без self переменная жила бы только время работы метода и исчезла бы."
       },
       {
        "type": "warning",
        "text": "Первый параметр метода — это сам объект. По соглашению его называют `self` и не передают явно: когда пишешь `bread.cost(3)`, Python незаметно вызывает `Product.cost(bread, 3)`. Забыл self в def — получишь TypeError: takes 1 positional argument but 2 were given. Само имя self — не закон, но нарушать соглашение нельзя: его читают все."
       },
       {
        "type": "text",
        "text": "Объектов одного класса может быть сколько угодно — данные у каждого свои. Методы читают и меняют именно «свой» объект через self."
       },
       {
        "type": "code",
        "code": "class Account:\n    def __init__(self, owner, balance=0):\n        self.owner = owner\n        self.balance = balance\n\n    def add(self, money):\n        self.balance += money\n\n\na = Account(\"Аня\", 100)\nb = Account(\"Борис\")\na.add(50)\nprint(a.balance, b.balance)",
        "output": "150 0",
        "run_check": true
       },
       {
        "type": "text",
        "text": "Магический метод `__str__` отвечает на вопрос «как объект выглядит в print()». Без него будет `Account object at 0x7f...` — программисты называют это «шум». Возвращай из __str__ человекочитаемую строку."
       },
       {
        "type": "code",
        "code": "class Dog:\n    def __init__(self, name, breed):\n        self.name = name\n        self.breed = breed\n\n    def __str__(self):\n        return f\"Собака {self.name} ({self.breed})\"\n\n\nprint(Dog(\"Рекс\", \"овчарка\"))",
        "output": "Собака Рекс (овчарка)",
        "run_check": true
       },
       {
        "type": "text",
        "text": "Наследование (inheritance): новый класс берёт всё у существующего и добавляет своё. Скобки `Puppy(Dog)` означают «как Dog, но лучше». `super().__init__(...)` — обращение к родителю: не переписывать его конструктор руками, а доверить ему общее и дописать своё. Переопределение метода (у Puppy свой __str__) заменяет родительскую версию."
       },
       {
        "type": "code",
        "code": "class Dog:\n    def __init__(self, name, breed):\n        self.name = name\n        self.breed = breed\n\n    def voice(self):\n        return \"гав\"\n\n\nclass Puppy(Dog):\n    def __init__(self, name, breed, months):\n        super().__init__(name, breed)\n        self.months = months\n\n    def voice(self):\n        return \"тяв\"\n\n\nrex = Puppy(\"Джесси\", \"лабрадор\", 4)\nprint(rex.voice(), rex.months, rex.breed)",
        "output": "тяв 4 лабрадор",
        "run_check": true
       },
       {
        "type": "table",
        "header": [
         "Термин",
         "По-русски",
         "В коде"
        ],
        "rows": [
         [
          "класс (class)",
          "чертёж объекта",
          "class Product:"
         ],
         [
          "объект (экземпляр)",
          "конкретная штука по чертежу",
          "bread = Product(...)"
         ],
         [
          "атрибут",
          "данные внутри объекта",
          "self.price"
         ],
         [
          "метод",
          "функция внутри объекта",
          "def cost(self, qty)"
         ],
         [
          "__init__",
          "создание и настройка объекта",
          "вызывается сам при Product(...)"
         ],
         [
          "self",
          "сам объект внутри метода",
          "self.name = name"
         ]
        ]
       },
       {
        "type": "compare",
        "title": "Словарь+функции против класса",
        "bad": "cat = {\"name\": \"Барсик\", \"age\": 3}\n\n\ndef cat_say(cat):\n    return f\"{cat['name']} говорит: мяу\"\n\n\nprint(cat_say(cat))",
        "good": "class Cat:\n    def __init__(self, name, age):\n        self.name = name\n        self.age = age\n\n    def say(self):\n        return f\"{self.name} говорит: мяу\"\n\n\nprint(Cat(\"Барсик\", 3).say())"
       },
       {
        "type": "note",
        "text": "Зачем «просто данные» тащить в класс? Потому что вместе с данными живёт логика: данные и операции рядом не разъедутся и не перепутаются. Но класс ради класса — зло: три числа удобнее сложить обычным кортежем. Класс нужен, когда появляется поведение."
       },
       {
        "type": "text",
        "text": "Глубокие темы (property, магические методы кроме __str__, метаклассы) — потом. Сейчас достаточно свободно читать определения класса, понимать, кто кому родитель, и писать свой класс из 5–10 строк без страхов."
       }
      ],
      "tasks": [
       {
        "id": "oop_basics_t1",
        "title": "Карточка пользователя",
        "difficulty": 1,
        "statement": "Определи класс `User` с конструктором `__init__(self, name, email)` (поля сохранить в атрибуты name и email) и методом `info()`, который ВОЗВРАЩАЕТ строку вида `Аня <anya@mail.ru>` — имя, пробел, email в угловых скобках. Печатать ничего не нужно: проверка сама создаст объекты и вызовет методы через print().",
        "input_format": "Ввода нет.",
        "output_format": "Ничего не печатать. Определить класс User.",
        "examples": [
         {
          "input": "",
          "output": "print(User(\"Аня\", \"anya@mail.ru\").info()) -> Аня <anya@mail.ru>"
         }
        ],
        "hints": [
         "В __init__ обязательно self: def __init__(self, name, email):",
         "info(self) возвращает, а не печатает: return f\"{self.name} <{self.email}>\".",
         "Методы пишутся с отступом внутри класса, на одном уровне с __init__."
        ],
        "tests": [
         {
          "code_after": "print(User(\"Аня\", \"anya@mail.ru\").info())",
          "output": "Аня <anya@mail.ru>",
          "visible": true
         },
         {
          "code_after": "u = User(\"Борис\", \"\")\nprint(u.info())",
          "output": "Борис <>",
          "note": "граничный случай: пустой email"
         },
         {
          "code_after": "v = User(\"Вера\", \"v@ya.ru\")\nprint(v.name, \"-\", v.email)",
          "output": "Вера - v@ya.ru",
          "note": "проверка атрибутов"
         },
         {
          "code_after": "a = User(\"А\", \"a@a\")\nb = User(\"Б\", \"b@b\")\nprint(a.email, b.name)",
          "output": "a@a Б"
         }
        ],
        "checks": {
         "must_define": [
          "User"
         ]
        },
        "solution": "class User:\n    def __init__(self, name, email):\n        self.name = name\n        self.email = email\n\n    def info(self):\n        return f\"{self.name} <{self.email}>\"",
        "wrong_solution": "class User:\n    def __init__(self, name, email):\n        self.name = name\n        self.email = email\n\n    def info(self):\n        return f\"{self.name} ({self.email})\""
       },
       {
        "id": "oop_basics_t2",
        "title": "Банковский счёт",
        "difficulty": 2,
        "statement": "Определи класс `BankAccount`: конструктор `__init__(self, owner, balance=0)` (баланс по умолчанию 0); метод `deposit(self, money)` — пополняет; `withdraw(self, money)` — снимает и возвращает True, но если денег не хватает (money > balance), баланс НЕ меняет и возвращает False; `__str__` — строка `Владелец: N руб.`. Проверка сама построит счёт, погоняет операции и напечатает результаты через print().",
        "input_format": "Ввода нет.",
        "output_format": "Ничего не печатать. Определить класс BankAccount.",
        "examples": [
         {
          "input": "",
          "output": "acc = BankAccount(\"Аня\", 100); acc.deposit(50)\nprint(acc.withdraw(200), acc.withdraw(30), acc) -> False True Аня: 120 руб."
         }
        ],
        "hints": [
         "withdraw: сначала проверка if money > self.balance: return False, только потом списание.",
         "return внутри if прерывает метод — остаток не тронется, если ставить проверку ДО списания.",
         "__str__ возвращает f-строку: деньги целые — печатать их как int, без .0."
        ],
        "tests": [
         {
          "code_after": "acc = BankAccount(\"Аня\", 100)\nacc.deposit(50)\nprint(acc.withdraw(200))\nprint(acc.withdraw(30))\nprint(acc)",
          "output": "False\nTrue\nАня: 120 руб.",
          "visible": true
         },
         {
          "code_before": "",
          "code_after": "a = BankAccount(\"Борис\")\na.deposit(10)\nprint(a.balance)\nprint(a.withdraw(10))",
          "output": "10\nTrue",
          "note": "balance по умолчанию 0"
         },
         {
          "code_before": "",
          "code_after": "b = BankAccount(\"В\", 50)\nprint(b.withdraw(50), b.balance)",
          "output": "True 0",
          "note": "сняли ровно всё — это не 'нехватка'"
         }
        ],
        "checks": {
         "must_define": [
          "BankAccount"
         ]
        },
        "solution": "class BankAccount:\n    def __init__(self, owner, balance=0):\n        self.owner = owner\n        self.balance = balance\n\n    def deposit(self, money):\n        self.balance += money\n\n    def withdraw(self, money):\n        if money > self.balance:\n            return False\n        self.balance -= money\n        return True\n\n    def __str__(self):\n        return f\"{self.owner}: {self.balance} руб.\"",
        "wrong_solution": "class BankAccount:\n    def __init__(self, owner, balance=0):\n        self.owner = owner\n        self.balance = balance\n\n    def deposit(self, money):\n        self.balance += money\n\n    def withdraw(self, money):\n        self.balance -= money\n        if self.balance < 0:\n            return False\n        return True\n\n    def __str__(self):\n        return f\"{self.owner}: {self.balance} руб.\""
       },
       {
        "id": "oop_basics_t3",
        "title": "Заказы с доставкой",
        "difficulty": 3,
        "statement": "Первая строка — число N заказов. Дальше N строк вида `номер,сумма` (сумма — целое число рублей). Определи класс `Order` с полями num и total и методом `to_pay()`: возвращает сумму к оплате; если total меньше 1000, добавь 200 за доставку, иначе доставка бесплатная. Программа печатает по заказу в строку: `Заказ НОМЕР: S руб.` (S — to_pay()), а последней строкой `Всего к оплате: G руб.` — сумму всех S. Обход и печать — через список объектов Order, не через словарь.",
        "input_format": "Строка 1 — N (0–100). Строки 2..N+1 — `номер,сумма`.",
        "output_format": "N строк `Заказ ...: ... руб.` и финальная `Всего к оплате: ... руб.`.",
        "examples": [
         {
          "input": "2\nA1,1500\nB2,900",
          "output": "Заказ A1: 1500 руб.\nЗаказ B2: 1100 руб.\nВсего к оплате: 2600 руб."
         }
        ],
        "hints": [
         "to_pay: if self.total < 1000: return self.total + 200 / else return self.total. Строго меньше: 1000 уже бесплатно.",
         "Читай в список объектов: orders.append(Order(num, int(total))).",
         "Копируй S в переменную grand по ходу печати, иначе придётся вызывать to_pay() дважды."
        ],
        "tests": [
         {
          "input": "2\nA1,1500\nB2,900",
          "output": "Заказ A1: 1500 руб.\nЗаказ B2: 1100 руб.\nВсего к оплате: 2600 руб.",
          "visible": true
         },
         {
          "input": "1\nC3,1000",
          "output": "Заказ C3: 1000 руб.\nВсего к оплате: 1000 руб.",
          "note": "ровно 1000 — доставка бесплатна"
         },
         {
          "input": "0",
          "output": "Всего к оплате: 0 руб.",
          "note": "граничный случай: нет заказов"
         },
         {
          "input": "3\nX,0\nY,800\nZ,2000",
          "output": "Заказ X: 200 руб.\nЗаказ Y: 1000 руб.\nЗаказ Z: 2000 руб.\nВсего к оплате: 3200 руб."
         }
        ],
        "checks": {
         "must_use": [
          "class",
          "def"
         ]
        },
        "solution": "class Order:\n    def __init__(self, num, total):\n        self.num = num\n        self.total = total\n\n    def to_pay(self):\n        if self.total < 1000:\n            return self.total + 200\n        return self.total\n\n\nn = int(input())\norders = []\nfor _ in range(n):\n    num, amount = input().split(\",\")\n    orders.append(Order(num, int(amount)))\n\ngrand = 0\nfor o in orders:\n    pay = o.to_pay()\n    grand += pay\n    print(f\"Заказ {o.num}: {pay} руб.\")\nprint(f\"Всего к оплате: {grand} руб.\")",
        "wrong_solution": "class Order:\n    def __init__(self, num, total):\n        self.num = num\n        self.total = total\n\n    def to_pay(self):\n        if self.total <= 1000:\n            return self.total + 200\n        return self.total\n\n\nn = int(input())\norders = []\nfor _ in range(n):\n    num, amount = input().split(\",\")\n    orders.append(Order(num, int(amount)))\n\ngrand = 0\nfor o in orders:\n    pay = o.to_pay()\n    grand += pay\n    print(f\"Заказ {o.num}: {pay} руб.\")\nprint(f\"Всего к оплате: {grand} руб.\")"
       }
      ],
      "summary": [
       "Класс — чертёж, объект — экземпляр; __init__ вызывается автоматически при создании.",
       "Данные живут в атрибутах (self.что), поведение — в методах; self — сам объект, его не передают.",
       "__str__ делает print(obj) человекочитаемым.",
       "Наследование: class Child(Parent) + super().__init__(...) — переиспользуем и переопределяем.",
       "Не бери класс, если хватает функций и словаря; бери, когда данные и поведение должны жить вместе."
      ],
      "further": [
       "docs.python.org/3/tutorial/classes.html",
       "Stepik «Поколение Python: курс для продвинутых», модуль «Классы»"
      ]
     }
    },
    {
     "file": "bridge/08_functions_advanced.json",
     "data": {
      "id": "functions_advanced",
      "stage": "bridge",
      "order": 8,
      "title": "Функции: продвинуто и стиль",
      "subtitle": "*args, kwargs, докстринги и PEP 8",
      "minutes": 50,
      "version": 1,
      "goals": [
       "Принимать любое количество аргументов через *args и **kwargs",
       "Вызывать функции по именам параметров и помнить про значения по умолчанию",
       "Обходить ловушку изменяемого значения по умолчанию (def f(x=[]))",
       "Писать докстринги, аннотации и код, который не стыдно показать (PEP 8)"
      ],
      "theory": [
       {
        "type": "text",
        "text": "Хорошая функция должна быть удобна в вызове. Иногда аргументов фиксированное число, а иногда — сколько дали. Для этого есть звёздочки: `*args` собирает позиционные аргументы в кортеж, `**kwargs` — именованные в словарь."
       },
       {
        "type": "code",
        "code": "def total(*numbers):\n    return sum(numbers)\n\n\nprint(total(1, 2, 3))\nprint(total())",
        "output": "6\n0",
        "run_check": true
       },
       {
        "type": "code",
        "code": "def user_info(**fields):\n    for key, value in fields.items():\n        print(f\"{key}: {value}\")\n\n\nuser_info(name=\"Аня\", city=\"Казань\")",
        "output": "name: Аня\ncity: Казань",
        "run_check": true
       },
       {
        "type": "text",
        "text": "Аргументы по имени в ВЫЗОВЕ — второй половины нет в звёздочках: `f(city=\"Сочи\")`. Это не только красота: порядок не важен, а код вызова читается как предложение. Значения по умолчанию позволяют опускать второстепенное."
       },
       {
        "type": "code",
        "code": "def delivery(city, days=3, express=False):\n    label = \"экспресс\" if express else \"обычная\"\n    print(f\"{city}: {days} дн., {label}\")\n\n\ndelivery(\"Сочи\", express=True)\ndelivery(\"Псков\", 5)",
        "output": "Сочи: 3 дн., экспресс\nПсков: 5 дн., обычная",
        "run_check": true
       },
       {
        "type": "warning",
        "text": "Значение по умолчанию вычисляется ОДИН раз — при определении функции. Список в параметре (`def f(items=[])`) живёт между вызовами: в него складывается со второго вызова, и «чистый» список оказывается чужим. Признак ошибки: второй вызов функции ведёт себя не так, как первый."
       },
       {
        "type": "code",
        "code": "def add(item, basket=[]):\n    basket.append(item)\n    return basket\n\n\nprint(add(\"хлеб\"))\nprint(add(\"молоко\"))  # список из прошлого вызова не испарился!",
        "output": "['хлеб']\n['хлеб', 'молоко']",
        "run_check": true
       },
       {
        "type": "text",
        "text": "Лекарство от этой ловушки — `None` в параметре и создание списка ВНУТРИ функции."
       },
       {
        "type": "code",
        "code": "def add(item, basket=None):\n    if basket is None:\n        basket = []\n    basket.append(item)\n    return basket\n\n\nprint(add(\"хлеб\"))\nprint(add(\"молоко\"))",
        "output": "['хлеб']\n['молоко']",
        "run_check": true
       },
       {
        "type": "text",
        "text": "Докстринг — первая строка внутри функции в тройных кавычках: что функция делает. Его видно через help(). Аннотации типов (`x: int`, `-> float`) — подсказка человеку и редактору; Python их НЕ проверяет, но по ним читают твой код."
       },
       {
        "type": "code",
        "code": "def celsius_to_fahrenheit(c: float) -> float:\n    \"\"\"Переводит температуру из Цельсия в Фаренгейт.\"\"\"\n    return c * 9 / 5 + 32\n\n\nprint(celsius_to_fahrenheit(100))\nprint(celsius_to_fahrenheit.__doc__)",
        "output": "212.0\nПереводит температуру из Цельсия в Фаренгейт.",
        "run_check": true
       },
       {
        "type": "list",
        "title": "PEP 8, минимум который реально используется",
        "items": [
         "отступы — 4 пробела; табы не мешать с пробелами;",
         "функции и переменные — `snake_case`, константы — `UPPER_CASE`, классы — `CamelCase`;",
         "пробелы вокруг `=` и операторов, но не внутри скобок: `f(a, b)`, не `f( a,b )`;",
         "длина строки — 79 символов (на практике часто 88), переноси внутри скобок;",
         "между функциями — 2 пустые строки, внутри класса между методами — 1;",
         "комментарий объясняет ПОЧЕМУ, а не ЧТО: `# 200 = тариф доставки, руб`."
        ]
       },
       {
        "type": "compare",
        "title": "Одна функция — одно дело",
        "bad": "def process(path):\n    # читает файл, чистит данные,\n    # печатает отчёт и сохраняет результат\n    ...",
        "good": "def load(path):\n    ...\n\n\ndef clean(rows):\n    ...\n\n\ndef save_report(rows, path):\n    ..."
       },
       {
        "type": "note",
        "text": "Если описание функции начинается со слова «и» («считает И сохраняет») — это две функции. Разделение видно по длине: функция, которая не помещается на экран с комментариями, почти всегда склеена из нескольких дел."
       }
      ],
      "tasks": [
       {
        "id": "functions_advanced_t1",
        "title": "Приветствие с параметром",
        "difficulty": 1,
        "statement": "Определи функцию `greet(name, greeting=\"Привет\")`, которая возвращает строку `greeting, name!` (запятая, пробел, восклицательный в конце). Именно возвращает — не печатает. Проверка вызовет функцию с одним аргументом, с двумя позиционными и только по именам.",
        "input_format": "Ввода нет.",
        "output_format": "Ничего печатать не нужно — только определить функцию.",
        "examples": [
         {
          "input": "",
          "output": "print(greet(\"Аня\")) -> Привет, Аня!"
         }
        ],
        "hints": [
         "Значение по умолчанию пишется в def: greeting=\"Привет\".",
         "f-строка: return f\"{greeting}, {name}!\".",
         "Вызов greet(name=\"Глеб\", greeting=\"Привет\") должен работать — параметры обычные, именованный вызов умеет Python."
        ],
        "tests": [
         {
          "code_after": "print(greet(\"Аня\"))",
          "output": "Привет, Аня!",
          "visible": true
         },
         {
          "code_after": "print(greet(\"Борис\", \"Доброе утро\"))",
          "output": "Доброе утро, Борис!"
         },
         {
          "code_after": "print(greet(\"Вера\", greeting=\"Спокойной ночи\"))",
          "output": "Спокойной ночи, Вера!",
          "note": "только именованный"
         },
         {
          "code_after": "print(greet(name=\"Глеб\"))",
          "output": "Привет, Глеб!"
         }
        ],
        "checks": {
         "must_define": [
          "greet"
         ]
        },
        "solution": "def greet(name, greeting=\"Привет\"):\n    \"\"\"Возвращает приветствие: greeting, name!\"\"\"\n    return f\"{greeting}, {name}!\"",
        "wrong_solution": "def greet(name, greeting=\"Здравствуй\"):\n    return f\"{greeting}, {name}!\""
       },
       {
        "id": "functions_advanced_t2",
        "title": "Среднее любого числа аргументов",
        "difficulty": 2,
        "statement": "Определи функцию `average(*numbers)`, которая принимает любое количество чисел и возвращает их среднее арифметическое (float). Если чисел не передано — возвращает 0.0. Саму функцию вызывать не нужно: проверка вызовет её сама.",
        "input_format": "Ввода нет.",
        "output_format": "Ничего печатать не нужно — только определить функцию.",
        "examples": [
         {
          "input": "",
          "output": "average(2, 4) -> 3.0"
         }
        ],
        "hints": [
         "Звёздочка в параметре собирает все аргументы в кортеж: def average(*numbers).",
         "Проверь пустой кортеж до деления: if not numbers: return 0.0.",
         "sum(numbers) / len(numbers)."
        ],
        "tests": [
         {
          "code_after": "print(average(2, 4))",
          "output": "3.0",
          "visible": true
         },
         {
          "code_after": "print(average(10))",
          "output": "10.0"
         },
         {
          "code_after": "print(average())",
          "output": "0.0",
          "note": "пустой вызов"
         },
         {
          "code_after": "print(round(average(1, 2, 2), 2))",
          "output": "1.67"
         },
         {
          "code_after": "print(average(-3, 3))",
          "output": "0.0"
         }
        ],
        "checks": {
         "must_define": [
          "average"
         ],
         "must_use": [
          "*"
         ]
        },
        "solution": "def average(*numbers):\n    if not numbers:\n        return 0.0\n    return sum(numbers) / len(numbers)",
        "wrong_solution": "def average(*numbers):\n    return sum(numbers) / len(numbers)"
       },
       {
        "id": "functions_advanced_t3",
        "title": "Конструктор отчётов",
        "difficulty": 3,
        "statement": "Определи функцию `make_report(title, *rows, footer=None, indent=\"  \")`. Она ВОЗВРАЩАЕТ одну строку текста: сначала title, затем каждая строка из rows с префиксом indent, последней строкой — footer, а если footer не передан — символ `—` (тире). Разделитель строк — перевод строки \\n. Индент по умолчанию — два пробела. Проверка вызовет make_report с разным набором именованных аргументов и напечатает результат через print().",
        "input_format": "Ввода нет.",
        "output_format": "Ничего печатать не нужно — только определить функцию, возвращающую строку.",
        "examples": [
         {
          "input": "",
          "output": "print(make_report(\"Отчёт\", \"a\", \"b\")) ->\nОтчёт\n  a\n  b\n—"
         }
        ],
        "hints": [
         "Порядок параметров: сначала обычный title, затем *rows, затем только именованные с дефолтами (Python требует: после *args без дефолтных позиционных уже нет).",
         "Собери список строк: lines = [title], потом lines.append(indent + row), потом footer if footer is not None else \"—\".",
         "Отдай результат: return \"\\n\".join(lines)."
        ],
        "tests": [
         {
          "code_after": "print(make_report(\"Отчёт\", \"a\", \"b\"))",
          "output": "Отчёт\n  a\n  b\n—",
          "visible": true
         },
         {
          "code_after": "print(make_report(\"Топ\", \"x\", footer=\"Итого: 1\"))",
          "output": "Топ\n  x\nИтого: 1",
          "note": "footer только по имени"
         },
         {
          "code_after": "print(make_report(\"Пусто\"))",
          "output": "Пусто\n—",
          "note": "граничный случай: нет строк отчёта"
         },
         {
          "code_after": "print(make_report(\"Ш\", \"y\", indent=\">>\"))",
          "output": "Ш\n>>y\n—",
          "note": "свой отступ"
         }
        ],
        "checks": {
         "must_define": [
          "make_report"
         ],
         "must_use": [
          "*"
         ]
        },
        "solution": "def make_report(title, *rows, footer=None, indent=\"  \"):\n    lines = [title]\n    for row in rows:\n        lines.append(indent + row)\n    lines.append(footer if footer is not None else \"—\")\n    return \"\\n\".join(lines)",
        "wrong_solution": "def make_report(title, *rows, footer=None, indent=\"  \"):\n    lines = [title]\n    for row in rows:\n        lines.append(row)\n    lines.append(footer if footer is not None else \"—\")\n    return \"\\n\".join(lines)"
       }
      ],
      "summary": [
       "*args — кортеж лишних позиционных, **kwargs — словарь именованных; после * — только дефолтные-именованные.",
       "Вызов по именам (f(city=\"Сочи\")) читается сам и освобождает от порядка аргументов.",
       "Никогда не список/словарь как значение по умолчанию — ставь None и создавай внутри.",
       "Докстринг — первая строка функции; аннотации x: int, -> float — подсказка, которую Python не проверяет.",
       "PEP 8 — не эстетика: чужой код читают люди, а функция делает одно дело."
      ],
      "further": [
       "PEP 8 (pycodestyle): docs.python.org/3/tutorial/appendix.html",
       "PEP 257 — соглашение о докстрингах"
      ]
     }
    }
   ]
  }
 ]
};
