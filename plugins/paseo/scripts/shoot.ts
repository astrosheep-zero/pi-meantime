// Screenshot a local HTML file with the cached Playwright chromium.
// Usage: node scripts/shoot.ts <htmlFile> <outPng> [width]
import { chromium } from "playwright-core";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { homedir } from "node:os";

const [html, out, widthArg] = process.argv.slice(2);
if (!html || !out) throw new Error("usage: node scripts/shoot.ts <html> <out.png> [width]");

const executablePath = `${homedir()}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: Number(widthArg ?? 920), height: 800 }, deviceScaleFactor: 2 });
await page.goto(pathToFileURL(resolve(html)).href);
await page.waitForTimeout(300);
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log(out);
