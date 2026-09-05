#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_site.py — собирает данные тренажёра в один файл app/data.js.

Берёт:
  - content/index.json и все подключённые уроки (теория, задачи, тесты);
  - engine/py/harness.py  — «прогонщик» кода (тот же, что у валидатора);
  - PYTHON_PLAN.txt       — план обучения (вкладка «План»).

После изменения любого урока / harness'а / плана — перезапусти:
    python3 tools/build_site.py
и обнови страницу в браузере. Работает без npm и сети (сеть нужна браузеру
только для первого скачивания Pyodide с CDN).
"""

import json
import os
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "app")
OUT = os.path.join(OUT_DIR, "data.js")

PYODIDE_VERSION = "0.26.4"
PYODIDE_CDN = f"https://cdn.jsdelivr.net/pyodide/v{PYODIDE_VERSION}/full/"


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def stamp_assets():
    """Версия = хэш содержимого файлов приложения; вписывает ?v=... в index.html,
    чтобы браузер не показывал устаревший кэш app.css/app.js/data.js."""
    import hashlib
    import re

    h = hashlib.sha256()
    for p in ("app/app.css", "app/app.js", "app/data.js"):
        with open(os.path.join(ROOT, p), "rb") as f:
            h.update(f.read())
    ver = h.hexdigest()[:10]

    path = os.path.join(ROOT, "index.html")
    html = read(path)
    html = re.sub(r'(<link rel="stylesheet" href="app/app\.css)(?:\?v=[0-9a-f]+)?(")',
                  rf"\1?v={ver}\2", html)
    html = re.sub(r'(<script src="app/(?:data|app)\.js)(?:\?v=[0-9a-f]+)?(")',
                  rf"\1?v={ver}\2", html)
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    return ver



def main():
    index = json.loads(read(os.path.join(ROOT, "content", "index.json")))
    stages = []
    n_lessons = 0
    for stage in index.get("stages", []):
        lessons = []
        for rel in stage.get("lessons", []):
            path = os.path.join(ROOT, "content", rel)
            if not os.path.exists(path):
                print(f"пропущен (нет файла): {rel}")
                continue
            lessons.append({"file": rel, "data": json.loads(read(path))})
            n_lessons += 1
        stages.append({
            "id": stage["id"],
            "title": stage["title"],
            "description": stage.get("description", ""),
            "lessons": lessons,
        })

    payload = {
        "built": time.strftime("%Y-%m-%d %H:%M"),
        "pyodide": {"version": PYODIDE_VERSION, "cdn": PYODIDE_CDN},
        "harness": read(os.path.join(ROOT, "engine", "py", "harness.py")),
        "plan": read(os.path.join(ROOT, "PYTHON_PLAN.txt")),
        "stages": stages,
    }

    js = "window.PY_TRAINER_DATA = " + json.dumps(
        payload, ensure_ascii=False, indent=1
    ).replace("</", "<\\/") + ";\n"

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(js)

    ver = stamp_assets()
    size = len(js.encode("utf-8")) // 1024
    print(f"data.js: {size} КБ, уроков: {n_lessons}, этап(ов): {len(stages)}, версия ассетов: {ver}")


if __name__ == "__main__":
    main()
