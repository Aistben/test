"use strict";
/* app/format.js — «🪄 Автоотступы»: лёгкий выравниватель учебного Python-кода.
 *
 * Это НЕ полноценный форматтер (black/autopep8), а безопасная эвристика
 * для маленьких учебных программ:
 *   - табы превращает в 4 пробела;
 *   - хвостовые пробелы убирает;
 *   - глубину считает по строкам, оканчивающимся на «:»
 *     (if/for/while/def/class/with/try/match...);
 *   - слова-сдвигатели (else/elif/except/finally/case) сначала убавляют
 *     отступ, потом снова открывают блок своим «:»;
 *   - строки внутри тройных кавычек и продолжения выражений в скобках
 *     НЕ трогает (оставляет как написано).
 *
 * Экспорт: window.PyFmt = { autoIndent }.
 */
window.PyFmt = (function () {

  var DEDENT_RX = /^(else:\s*$|finally:\s*$|elif\s|elif\b.*:$|except\b|case\b)/;
  var TRIPLES = ['"""', "'''"];

  // строка без «хвостового» комментария (# ...) и без литералов строк
  function codePart(s) {
    var t = s.startsWith("#") ? "" : s.replace(/\s+#.*$/, "");
    return t;
  }
  function stripStrings(s) {
    return s
      .replace(/"[^"\\\n]*(\\.[^"\\\n]*)*"/g, '""')
      .replace(/'[^'\\\n]*(\\.[^'\\\n]*)*'/g, "''");
  }
  function parenBalance(s) {
    var open = (s.match(/[([{]/g) || []).length;
    var close = (s.match(/[)\]}]/g) || []).length;
    return open - close;
  }
  function countTriple(s, mark) {
    var n = 0, i = s.indexOf(mark);
    while (i >= 0) { n++; i = s.indexOf(mark, i + mark.length); }
    return n;
  }

  function autoIndent(src) {
    var depth = 0;
    var parens = 0;
    var inTriple = null;
    var lines = String(src).replace(/\t/g, "    ").split("\n");

    return lines.map(function (raw) {
      var noTail = raw.replace(/\s+$/, "");
      var trimmed = noTail.trim();

      // внутри тройной строки: не трогаем, ищем только закрывающие кавычки
      if (inTriple) {
        if (countTriple(trimmed, inTriple) % 2 === 1) inTriple = null;
        return noTail;
      }
      if (!trimmed) return "";

      // запоминаем, открылась ли тройная строка (нечётное число маркеров)
      for (var k = 0; k < TRIPLES.length; k++) {
        if (countTriple(trimmed, TRIPLES[k]) % 2 === 1) { inTriple = TRIPLES[k]; break; }
      }

      var code = codePart(trimmed);
      var bare = stripStrings(code);

      // продолжение выражения в скобках — оставляем как написал ученик
      if (parens > 0) {
        parens = Math.max(0, parens + parenBalance(bare));
        return noTail;
      }

      var out;
      if (DEDENT_RX.test(code)) {
        depth = Math.max(0, depth - 1);
        out = "    ".repeat(depth) + trimmed;
      } else {
        out = "    ".repeat(depth) + trimmed;
      }
      if (/:$/.test(code) && !trimmed.startsWith("#")) depth += 1;
      parens = Math.max(0, parenBalance(bare));
      return out;
    }).join("\n");
  }

  return { autoIndent: autoIndent };
})();
