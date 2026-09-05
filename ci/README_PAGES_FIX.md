# Почему сайт не открывался через Pages — и как починить

## Диагноз

Сайт `https://aistben.github.io/test/` перестал открываться не из-за кода.
Файлы в `main` полностью рабочие (проверено локально: `index.html`, `app/app.css`,
`app/data.js`, `app/core.js`, `app/app.js`, `content/index.json` — все отдают 200).

Причина — **лишняя ветка `dev` перезаписала опубликованный сайт**.

Хронология деплоев (`gh api repos/Aistben/test/deployments`):

```
6280951283  dev    8aa138a  12:27:38   <-- ПОСЛЕДНИЙ, он и опубликован
6280949653  main   c14a360  12:27:30   <-- стал "inactive"
6280792572  main   c14a360  12:10:46
... ещё 9 деплоев из main
```

Деплой из `dev` пришёл на 8 секунд позже деплоя из `main` и вытеснил его —
статус деплоя из `main` буквально стал `inactive`.

А в ветке `dev` лежит совсем другой, пустой проект:

```
dev/
  .gitignore
  css/
  index.html   <-- <title>Document</title>, в body только пустой <header>
```

Поэтому по адресу Pages отдавалась пустая заглушка из `dev`, а не тренажёр.

## Почему «через кнопку Visit скопировать и вставить — работает»

Это то же самое подтверждение диагноза, а не отдельный баг. Кнопка Visit и
ручной переход ведут на один и тот же URL — разница только в **кэше**:

- вкладка, открытая по кнопке, показывала свежий ответ Pages (пустышку из `dev`);
- вставленный вручную адрес открывался из HTTP-кэша браузера/CDN, где ещё
  лежала прошлая, нормальная версия из `main`.

Как только кэш истекал, «рабочий» вариант тоже ломался. Никакой магии в
копировании ссылки нет.

## Что уже сделано

Проверено и подтверждено через GitHub API; содержимое `main` признано исправным.

Удалить старые деплои и переключить Pages через API из этой сессии не вышло —
токен агента их не имеет:

```
DELETE /repos/Aistben/test/deployments/<id>   -> 403 Resource not accessible by integration
PUT    /repos/Aistben/test/pages              -> 403 Resource not accessible by integration
```

Пуш файла `.github/workflows/*.yml` тоже отклонён:
`refusing to allow a GitHub App to create or update workflow ... without 'workflows' permission`.

Поэтому готовый workflow лежит здесь: **`ci/deploy-pages.yml`**.

## Что нужно сделать вам (3 шага, ~2 минуты)

### Шаг 1. Включить единый деплой

Скопируйте файл на его рабочее место и запушьте в `main`:

```bash
mkdir -p .github/workflows
cp ci/deploy-pages.yml .github/workflows/deploy-pages.yml
git add .github/workflows/deploy-pages.yml
git commit -m "ci: единый деплой Pages только из main"
git push origin main
```

### Шаг 2. Переключить Pages на Actions

`Settings` → `Pages` → `Build and deployment` → `Source`: выбрать
**GitHub Actions** (сейчас стоит legacy «Deploy from a branch: main /»).

После этого сайт сможет публиковать **только** workflow из `main`.

### Шаг 3. Убрать источник проблемы — ветку `dev`

Ветка `dev` содержит чужой пустой проект и не нужна:

```bash
git push origin --delete dev
```

## Почему это больше не повторится

`ci/deploy-pages.yml` устроен так, что второй деплой физически невозможен:

- `on.push.branches: [main]` — ни одна другая ветка не запускает публикацию;
- `concurrency.group: pages` + `cancel-in-progress: true` — параллельные
  деплои не гонятся друг с другом, гонка `main` vs `dev` исключена;
- `touch .nojekyll` — Jekyll не обрабатывает сайт (важно, папки `app/`,
  `content/` отдаются как есть);
- публикуется весь корень репозитория (`path: .`).

## Проверка после деплоя

```bash
curl -sI https://aistben.github.io/test/ | head -1          # 200
curl -s  https://aistben.github.io/test/ | grep -o '<title>.*</title>'
# ожидаем: Python: Основы и Мостик — тренажёр
# если видите "Document" — значит всё ещё отдаётся ветка dev
```

Открывайте страницу с жёстким обновлением (Ctrl+Shift+R), чтобы не поймать
старый кэш.
