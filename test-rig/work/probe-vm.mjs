import vm from "vm";
import fs from "fs";
const src = fs.readFileSync("src/screen.js", "utf8").replace(/\r/g, "");
const ctx = { console, process, Intl };
vm.createContext(ctx);
const wrapped = src + "\n" + "globalThis.__HOOK = createScreen({output:{write(){},columns:120,rows:30}});";
try {
  const result = vm.runInContext(wrapped, ctx);
  console.log("vm ran, hook present:", ctx.__HOOK !== undefined && ctx.__HOOK !== null);
  console.log("hook keys:", ctx.__HOOK ? Object.keys(ctx.__HOOK).slice(0, 40).join(",") : String(ctx.__HOOK));
} catch (e) {
  console.log("VM ERROR:", e.stack.split("\n").slice(0, 4).join("\n"));
}
