/* Быстрый смоук-тест загрузки приложения: имитируем минимальный DOM,
   грузим core.js + data.js + app.js и проверяем, что первичный render()
   проходит без исключений. Это НЕ полный браузерный тест, а страховка
   от «белого экрана» после правок. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeEl(tag) {
  const el = {
    tagName: (tag || "div").toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    classList: {
      add() {}, remove() {}, toggle() {}, contains() { return false; },
    },
    set className(v) { this._cn = v; },
    get className() { return this._cn || ""; },
    set innerHTML(v) { this._html = v; if (v === "") this.children = []; },
    get innerHTML() { return this._html || ""; },
    textContent: "",
    value: "",
    disabled: false,
    spellcheck: false,
    id: "",
    title: "",
    rows: 0,
    placeholder: "",
    open: false,
    isConnected: true,
    firstChild: null,
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { this.children.push(c); this.firstChild = this.children[0]; return c; },
    append(...cs) { cs.forEach((c) => this.appendChild(c)); },
    insertBefore(c, ref) { this.children.unshift(c); this.firstChild = this.children[0]; return c; },
    replaceWith() {},
    remove() {},
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    querySelectorAllDeep() { return []; },
    scrollIntoView() {},
    focus() {},
    click() {},
    cloneNode() { return makeEl(tag); },
    set onclick(f) {}, set onchange(f) {}, set onerror(f) {}, set onload(f) {},
    set htmlFor(v) {},
  };
  return el;
}

const byId = { "#sidebar": makeEl("aside"), "#main": makeEl("main"), "#burger": makeEl("button") };

const documentStub = {
  createElement: (tag) => makeEl(tag),
  querySelector: (sel) => byId[sel] || null,
  querySelectorAll: () => [],
  body: makeEl("body"),
  head: makeEl("head"),
};
documentStub.body.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };

const windowStub = {
  document: documentStub,
  localStorageMem: {},
  addEventListener() {},
  scrollTo() {},
  location: { reload() {} },
  confirm: () => false,
  setTimeout: global.setTimeout,
  clearTimeout: global.clearTimeout,
};
const localStorageStub = {
  _m: {},
  getItem(k) { return this._m[k] ?? null; },
  setItem(k, v) { this._m[k] = String(v); },
  removeItem(k) { delete this._m[k]; },
};

const g = globalThis;
g.window = windowStub;
g.document = documentStub;
g.localStorage = localStorageStub;
g.location = windowStub.location;

let failed = false;
for (const f of ["app/core.js", "app/data.js", "app/format.js", "app/app.js"]) {
  const src = readFileSync(path.join(ROOT, f), "utf8");
  try {
    // app.js заканчивается render() + ensurePy() — любые исключения всплывут здесь
    new Function(src)();
    console.log("ЗАГРУЗКА OK:", f);
  } catch (e) {
    failed = true;
    console.log("УПАЛО:", f, "→", e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n") : e);
    break;
  }
}
console.log(failed ? "\nСМОУК: ПРОВАЛ" : "\nСМОУК: ОК — первичный рендер без исключений");
process.exit(failed ? 1 : 0);
