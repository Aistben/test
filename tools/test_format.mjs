/*
 * tools/test_format.mjs — проверка «🪄 Автоотступы» (app/format.js) без браузера:
 *   node tools/test_format.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const win = {};
new Function("window", readFileSync(path.join(ROOT, "app/format.js"), "utf8"))(win);
const F = win.PyFmt.autoIndent;

let fails = 0;
const check = (name, src, want) => {
  const got = F(src);
  const ok = got === want;
  console.log((ok ? "  PASS" : "  FAIL") + " — " + name);
  if (!ok) {
    console.log("  --- получено ---\n" + got + "\n  --- ожидалось ---\n" + want);
    fails++;
  }
};

check("плоские отступы if/else → выровнены",
`age = int(input())
if age >= 18:
print("Доступ разрешён")
else:
print("Доступ запрещён")`,
`age = int(input())
if age >= 18:
    print("Доступ разрешён")
else:
    print("Доступ запрещён")`);

check("вложенный if внутри if",
`if a:
if b:
print(1)
else:
print(2)`,
`if a:
    if b:
        print(1)
    else:
        print(2)`);

check("elif выравнивается на уровень if",
`if n < 0:
print("минус")
elif n == 0:
print("ноль")
else:
print("плюс")`,
`if n < 0:
    print("минус")
elif n == 0:
    print("ноль")
else:
    print("плюс")`);

check("табы → 4 пробела",
`if a:
\tprint(1)`,
`if a:
    print(1)`);

check("комментарий не открывает блок",
`print("x")  # вот так:
print(1)`,
`print("x")  # вот так:
print(1)`);

check("строка с двоеточием не открывает блок",
`s = "капитан: очевидность"
print(1)`,
`s = "капитан: очевидность"
print(1)`);

check("многострочные скобки не трогаем",
`total = (199.9 * 3 +
         45.5)
print(total)`,
`total = (199.9 * 3 +
         45.5)
print(total)`);

check("тройная строка не трогается",
`text = """Первая строка
  вторая с отступом
третья
"""
print(text)`,
`text = """Первая строка
  вторая с отступом
третья
"""
print(text)`);

check("хвостовые пробелы убираются",
`print(1)   
print(2)\t`,
`print(1)
print(2)`);

check("for + if внутри",
`for i in range(3):
if i == 2:
print("два")`,
`for i in range(3):
    if i == 2:
        print("два")`);

check("пустой файл не падает", "", "");

check("однострочный if без тела руками",
`if a: print(1)
print(2)`,
`if a: print(1)
print(2)`);

console.log(fails ? `\nПРОВАЛ: ${fails}` : "\nВСЁ ЗЕЛЁНОЕ");
process.exit(fails ? 1 : 0);
