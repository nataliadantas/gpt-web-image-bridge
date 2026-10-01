#!/usr/bin/env node
/**
 * gptimg.js — 网页版 ChatGPT 生图桥接程序
 *
 * 用法：
 *   node gptimg.js login                      首次登录（打开浏览器，人工登录后回车保存会话）
 *   node gptimg.js setproject [项目URL]        配置"生图"项目（所有生图对话收进该项目）
 *   node gptimg.js setapikey [key]            为 serve 服务设置 API Key（缺省自动生成随机 key）
 *   node gptimg.js gen "提示词" [选项]         生成图片，stdout 输出 JSON
 *   node gptimg.js serve [--port 3777]        常驻 HTTP 服务（推荐，含 OpenAI 兼容接口）
 *   node gptimg.js quota                      查看最近 3 小时已通过本程序生成了多少张图
 *   node gptimg.js doctor                     检查登录态与浏览器环境
 *
 * gen 选项：
 *   --out 文件名        输出文件名（默认自动生成，保存在 output/ 下，仅 n=1 时生效）
 *   --timeout 秒数      默认 240
 *   --n 数量           一次批量生成（1~10，串行）
 *   --ratio 比例       如 16:9 / 2:3 / 1:1，附加到提示词约束宽高比
 *   --wait            触发限额时排队等待恢复后自动重试
 *   --headless         尝试无头模式（可能触发 Cloudflare 验证，默认关闭）
 */
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

// 优先使用 patchright（反检测补丁版 Playwright），未安装则回退 playwright
let chromium, DRIVER = 'playwright';
try {
  ({ chromium } = await import('patchright'));
  DRIVER = 'patchright';
} catch {
  ({ chromium } = await import('playwright'));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(__dirname, '.chrome-profile'); // 持久化登录态
const OUTPUT_DIR = path.join(__dirname, 'output');
const HISTORY_FILE = path.join(OUTPUT_DIR, 'history.jsonl');
const DEFAULT_CHAT_URL = 'https://chatgpt.com/';
const CONFIG_FILE = path.join(__dirname, 'config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
}

// 生图入口：配置了"生图"项目的 URL 后，所有生图对话都收进该项目，不污染项目外的对话
function chatUrl() {
  return loadConfig().project_url || DEFAULT_CHAT_URL;
}
const DEFAULT_TIMEOUT_MS = 240_000;
const VERSION = '0.2.0';
const DEFAULT_QUOTA_MAX_WAIT_MS = 3.4 * 3600_000;

// ---------- 浏览器 ----------

// 上次异常退出可能留下残留 Chrome 进程，占用 .chrome-profile 导致无法启动——清理之
function killProfileZombies() {
  if (process.platform !== 'win32') return Promise.resolve();
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'chrome*' -and $_.CommandLine -like '*chrome-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  return new Promise((resolve) => execFile('powershell', ['-NoProfile', '-Command', script], { timeout: 30_000 }, () => resolve()));
}

// serve 常驻服务是否在运行（运行中则不能再起第二个浏览器，会抢配置文件锁）
async function serveInstanceRunning() {
  try {
    const r = await fetch('http://127.0.0.1:3777/health', { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch { return false; }
}

async function launchContext({ headless = false } = {}) {
  const opts = {
    headless,
    viewport: headless ? { width: 1280, height: 900 } : null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  };
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, { channel: 'chrome', ...opts });
  } catch (e) {
    console.error('[warn] 系统 Chrome 通道启动失败：' + String(e.message || e).split('\n')[0]);
    if (await serveInstanceRunning()) {
      throw new Error('检测到生图服务(serve)正在运行并占用浏览器，请直接通过服务调用生图，不用单独启动。');
    }
    console.error('[warn] 清理残留的浏览器进程后重试...');
    await killProfileZombies();
    await new Promise((r) => setTimeout(r, 1500));
    try {
      return await chromium.launchPersistentContext(PROFILE_DIR, { channel: 'chrome', ...opts });
    } catch (e2) {
      console.error('[warn] 重试仍失败，改用 Playwright 自带 Chromium：' + String(e2.message || e2).split('\n')[0]);
      return await chromium.launchPersistentContext(PROFILE_DIR, opts);
    }
  }
}

// ---------- 页面元素 ----------

// 网络抖动（如代理切节点导致 ERR_NETWORK_CHANGED）时自动重试
async function gotoWithRetry(page, url, { attempts = 3, waitUntil = 'domcontentloaded', timeout = 60_000 } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await page.goto(url, { waitUntil, timeout });
    } catch (e) {
      const msg = String(e.message || e);
      if (i >= attempts || !/ERR_NETWORK_CHANGED|ERR_CONNECTION|ERR_TIMED_OUT|ERR_ABORTED/i.test(msg)) throw e;
      console.error(`[warn] 页面加载失败，3 秒后重试（${i}/${attempts - 1}）：${msg.split('\n')[0]}`);
      await page.waitForTimeout(3000);
    }
  }
}

// 选择器多 fallback：data-testid 优先，退化到 aria-label（中英文 UI 文案均覆盖）
const COMPOSER_SEL = '#prompt-textarea, div[contenteditable="true"], form textarea';
const STOP_SEL = 'button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="停止"]';
const SEND_SEL = 'button[data-testid="send-button"], #composer-submit-button, button[aria-label*="Send" i], button[aria-label*="发送"]';

// 能力探测：报告当前页面实际命中了哪些元素（健康检查时用于判断前端是否改版）
async function probeCapabilities(page) {
  return page.evaluate(({ c, s, st }) => ({
    composer: !!document.querySelector(c),
    send: !!document.querySelector(s),
    stop: !!document.querySelector(st),
  }), { c: COMPOSER_SEL, s: SEND_SEL, st: STOP_SEL });
}

async function waitForComposer(page, timeoutMs = 30_000) {
  try {
    await page.waitForSelector(COMPOSER_SEL, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

// 取最后一条对话里的大图（排除头像等小图标），src 不在 baseline 里才算"新图"
function latestImageSrc(page, baseline) {
  return page.evaluate((baselineList) => {
    const arts = document.querySelectorAll('article[data-testid^="conversation-turn"], article');
    const scope = arts.length ? arts[arts.length - 1] : document;
    const imgs = [...scope.querySelectorAll('img')].filter((el) =>
      el.naturalWidth >= 256 && el.src && !el.src.startsWith('data:') && !baselineList.includes(el.src)
    );
    const el = imgs[imgs.length - 1];
    return el ? el.currentSrc || el.src : null;
  }, baseline);
}

// 检测限额 / 报错文案
function detectError(page) {
  return page.evaluate(() => {
    const patterns = /usage cap|reached.*(limit|cap)|too many requests|try again later|rate limit|已达.{0,6}上限|使用次数|稍后.*再试|出了点问题|something went wrong/i;
    const nodes = [...document.querySelectorAll('[role="alert"], .toast, article')].slice(-3);
    for (const n of nodes) {
      const t = (n.innerText || '').trim();
      if (t && patterns.test(t) && !n.querySelector('img')) return t.slice(0, 300);
    }
    return null;
  });
}

async function snapshotImageSrcs(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('img')].map((el) => el.currentSrc || el.src).filter(Boolean)
  );
}

// ---------- 生图核心流程 ----------

async function generateOnPage(page, prompt, timeoutMs = DEFAULT_TIMEOUT_MS) {
  await gotoWithRetry(page, chatUrl());
  if (!(await waitForComposer(page))) {
    throw new Error('NOT_LOGGED_IN: 未找到输入框。请先运行: node gptimg.js login （也可能被 Cloudflare 拦截，用 login 命令过一次人机验证）');
  }

  const baseline = await snapshotImageSrcs(page);

  const composer = page.locator(COMPOSER_SEL).first();
  await composer.click();
  await page.keyboard.insertText(prompt);
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');

  // 兜底：3 秒后输入框仍有文字，改点发送按钮
  await page.waitForTimeout(3000);
  const left = await composer.innerText().catch(() => '');
  if (left.trim()) {
    const btn = page.locator(SEND_SEL).first();
    if (await btn.isEnabled().catch(() => false)) await btn.click();
  }

  const deadline = Date.now() + timeoutMs;
  let lastSrc = null;
  let stableCount = 0;

  while (Date.now() < deadline) {
    const err = await detectError(page);
    if (err) throw new Error('CHATGPT_ERROR: ' + err);

    const generating = (await page.locator(STOP_SEL).count()) > 0;
    const src = await latestImageSrc(page, baseline);

    if (src) {
      if (generating) {
        // 还在流式刷新（半截图），持续跟踪最新 src
        lastSrc = src;
        stableCount = 0;
      } else if (src === lastSrc) {
        stableCount += 1;
        if (stableCount >= 2) return src; // 停止生成且 src 连续稳定，视为完成
      } else {
        lastSrc = src;
        stableCount = 0;
      }
    }
    await page.waitForTimeout(1500);
  }
  throw new Error(`TIMEOUT: ${Math.round(timeoutMs / 1000)} 秒内未生成完成`);
}

async function saveImage(context, page, src, prompt, outName) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const slug = (prompt.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40)) || 'image';
  const ts = new Date().toISOString().replace(/[:T]/g, '').slice(0, 14);
  const name = outName ? (outName.endsWith('.png') ? outName : outName + '.png') : `${ts}_${slug}.png`;
  const outPath = path.join(OUTPUT_DIR, name);

  if (/^https?:/i.test(src)) {
    const resp = await context.request.get(src, { timeout: 120_000 });
    if (!resp.ok()) throw new Error(`下载图片失败: HTTP ${resp.status()}`);
    fs.writeFileSync(outPath, await resp.body());
  } else {
    // blob: 等页面内 URL，走 canvas 转 base64
    const dataUrl = await page.evaluate(async (imgSrc) => {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('img load failed'));
        i.src = imgSrc;
      });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/png');
    }, src);
    fs.writeFileSync(outPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
  }
  return outPath;
}

function recordHistory(prompt, imgPath, elapsedSec) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.appendFileSync(HISTORY_FILE, JSON.stringify({
    ts: new Date().toISOString(), prompt: prompt.slice(0, 200), path: imgPath, elapsed_sec: elapsedSec,
  }) + '\n');
}

export function countRecent(hours = 3) {
  if (!fs.existsSync(HISTORY_FILE)) return { used: 0, since: null };
  const cutoff = Date.now() - hours * 3600_000;
  let used = 0;
  for (const line of fs.readFileSync(HISTORY_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (new Date(rec.ts).getTime() >= cutoff) used++;
    } catch { /* 忽略坏行 */ }
  }
  return { used, since: new Date(cutoff).toISOString() };
}

// 登录态失效时：把浏览器窗口顶到最前，等人工重新登录/过人机验证，完成后自动继续
async function interactiveRelogin(page, { timeoutMs = 300_000 } = {}) {
  console.error('[需要人工介入] 登录态失效，请在弹出的浏览器窗口中重新登录或通过人机验证（5 分钟内有效）...');
  await page.bringToFront().catch(() => {});
  await gotoWithRetry(page, DEFAULT_CHAT_URL).catch(() => {});
  const ok = await waitForComposer(page, timeoutMs);
  if (!ok) throw new Error('RELOGIN_TIMEOUT: 等待重新登录超时，请重试');
  console.error('[已恢复] 检测到登录，继续刚才的生图任务。');
}

// 生图 + 掉线自动重登重试（仅 headed 模式可人工介入；无头模式直接报错）
async function generateWithRelogin(page, prompt, timeoutMs, { headless = false } = {}) {
  try {
    return await generateOnPage(page, prompt, timeoutMs);
  } catch (e) {
    if (headless || !/NOT_LOGGED_IN/.test(String(e.message))) throw e;
    await interactiveRelogin(page);
    return await generateOnPage(page, prompt, timeoutMs);
  }
}

// ---------- 限额感知 ----------

// 从报错文案判断是否限额，并解析恢复时间（返回毫秒；不是限额返回 null）
function quotaWaitMs(errText) {
  if (!/usage cap|reached.{0,20}(limit|cap)|rate limit|too many|已达.{0,6}上限|使用.{0,6}上限/i.test(errText)) return null;
  // 解析 "try again at 3:05 PM" / "at 15:05" / "3:05 PM"
  const m = errText.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    if (/pm/i.test(m[3]) && h < 12) h += 12;
    if (/am/i.test(m[3]) && h === 12) h = 0;
    const t = new Date();
    t.setHours(h, minute, 30, 0);
    let wait = t.getTime() - Date.now();
    if (wait < 0) wait += 24 * 3600_000;
    if (wait <= 12 * 3600_000) return wait;
  }
  // 解析不出具体时间，默认 15 分钟后重试
  return 15 * 60_000;
}

// 生图（掉线自动重登）+ 限额自动排队等待恢复
async function generateWithQuotaWait(page, prompt, timeoutMs, { headless = false, waitQuota = true, maxWaitMs = DEFAULT_QUOTA_MAX_WAIT_MS } = {}) {
  for (;;) {
    try {
      return await generateWithRelogin(page, prompt, timeoutMs, { headless });
    } catch (e) {
      const waitMs = quotaWaitMs(String(e.message || e));
      if (!waitQuota || !waitMs || waitMs > maxWaitMs) throw e;
      console.error(`[限额] 触发使用上限，等待 ${Math.ceil(waitMs / 60000)} 分钟后自动重试...`);
      await new Promise((r) => setTimeout(r, waitMs + 5000));
    }
  }
}

// ---------- 参数处理 ----------

function sizeToRatio(size) {
  return ({ '1024x1024': '1:1', '1536x1024': '3:2', '1024x1536': '2:3' }[String(size || '')] || null);
}

function withAspectRatio(prompt, ratio) {
  if (!ratio || ratio === 'auto') return prompt;
  return `${prompt}\n（请严格按 ${ratio} 的宽高比生成）`;
}

// ---------- 子命令 ----------

async function cmdLogin() {
  console.log('即将打开浏览器，请在窗口中完成 ChatGPT 登录（如出现人机验证也一并完成）。');
  console.log('登录成功、能看到输入框后，回到这里按回车保存并关闭。\n');
  const context = await launchContext({ headless: false });
  const page = context.pages()[0] || (await context.newPage());
  await gotoWithRetry(page, DEFAULT_CHAT_URL, { attempts: 4 });
  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('完成登录后按回车...', () => { rl.close(); resolve(); });
  });
  const logged = await waitForComposer(page, 3000);
  console.log(logged ? '✓ 检测到输入框，登录态已保存。' : '⚠ 未检测到输入框，可能还未登录成功，请重试。');
  await context.close();
  if (!loadConfig().project_url) {
    console.log('\n下一步：在 chatgpt.com 左侧"项目"里新建一个名为「生图」的项目，然后运行:');
    console.log('  node gptimg.js setproject          # 自动从侧边栏抓取项目地址');
    console.log('  node gptimg.js setproject "<项目URL>"   # 或手动粘贴项目页地址');
  }
}

// 配置生图项目：所有生图对话都收进这个项目，不污染其他对话
async function cmdSetProject(flags) {
  const urlArg = flags._[0];
  if (urlArg) {
    if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(urlArg)) die('URL 必须是 chatgpt.com 的链接');
    saveConfig({ ...loadConfig(), project_url: urlArg.split('?')[0] });
    console.log(JSON.stringify({ ok: true, project_url: urlArg.split('?')[0] }));
    return;
  }
  console.log('未提供 URL，尝试从侧边栏自动查找名为「生图」的项目...');
  const context = await launchContext({ headless: false });
  try {
    const page = context.pages()[0] || (await context.newPage());
    await gotoWithRetry(page, DEFAULT_CHAT_URL);
    if (!(await waitForComposer(page))) die('未登录，请先运行 node gptimg.js login');
    await page.waitForTimeout(3000); // 等侧边栏渲染
    const found = await page.evaluate(() => {
      const links = [...document.querySelectorAll('a[href*="/g/g-p-"]')];
      const hit = links.find((a) => (a.innerText || '').includes('生图'));
      return hit ? { href: hit.href, name: (hit.innerText || '').trim().slice(0, 50) } : null;
    });
    if (!found) {
      console.log('未在侧边栏找到名为「生图」的项目。请先在 chatgpt.com 左侧"项目"中新建该项目，');
      console.log('打开项目页后复制地址栏 URL，再运行: node gptimg.js setproject "<项目URL>"');
      process.exitCode = 1;
      return;
    }
    const cfg = { ...loadConfig(), project_url: found.href.split('?')[0] };
    saveConfig(cfg);
    console.log(JSON.stringify({ ok: true, project_name: found.name, project_url: cfg.project_url }));
  } finally {
    await context.close().catch(() => {});
  }
}

// 为 serve 服务设置 API Key（写入 config.json）
async function cmdSetApiKey(flags) {
  const key = flags._[0] || crypto.randomBytes(24).toString('hex');
  saveConfig({ ...loadConfig(), api_key: key });
  console.log(JSON.stringify({ ok: true, api_key: key, hint: '已保存到 config.json。调用时带请求头: Authorization: Bearer <key>' }, null, 2));
}

function warnIfNoProject() {
  if (!loadConfig().project_url) {
    console.error('[提示] 未配置生图项目，对话会进入普通历史记录。建议运行: node gptimg.js setproject');
  }
}

async function cmdGen(flags) {
  const prompt = flags._[0];
  if (!prompt) die('缺少提示词。用法: node gptimg.js gen "一只在月球上的猫" [--n 2] [--ratio 16:9] [--wait]');
  warnIfNoProject();
  const timeoutMs = Math.max(30, Number(flags.timeout) || 240) * 1000;
  const n = Math.min(10, Math.max(1, Number(flags.n) || 1));
  const ratio = flags.ratio || null;
  const waitQuota = !!flags.wait;
  const t0 = Date.now();
  const context = await launchContext({ headless: !!flags.headless });
  try {
    const page = context.pages()[0] || (await context.newPage());
    const paths = [];
    for (let i = 0; i < n; i++) {
      const src = await generateWithQuotaWait(page, withAspectRatio(prompt, ratio), timeoutMs, { headless: !!flags.headless, waitQuota });
      const imgPath = await saveImage(context, page, src, prompt, (flags.out && n === 1) ? flags.out : null);
      recordHistory(prompt, imgPath, Math.round((Date.now() - t0) / 1000));
      paths.push(imgPath);
    }
    console.log(JSON.stringify({ ok: true, paths, path: paths[0], elapsed_sec: Math.round((Date.now() - t0) / 1000) }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e.message || e) }));
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
}

async function cmdServe(flags) {
  warnIfNoProject();
  const port = Number(flags.port) || 3777;
  const host = flags.host || '127.0.0.1';
  const headless = !!flags.headless;
  const apiKey = process.env.GPTIMG_API_KEY || loadConfig().api_key || null;
  if (!apiKey) console.error('[warn] 未配置 API Key，/generate 与 /v1 接口无鉴权（监听 127.0.0.1 时风险可控）。配置: node gptimg.js setapikey');

  let context = null;
  let page = null;
  const ensurePage = async () => {
    if (page && !page.isClosed()) return;
    if (!context) context = await launchContext({ headless });
    try {
      page = context.pages()[0] || (await context.newPage());
    } catch {
      // 整个浏览器进程已退出（如窗口被关闭），自动重启
      context = await launchContext({ headless });
      page = context.pages()[0] || (await context.newPage());
    }
  };
  await ensurePage();

  // 串行队列：同一时间只生成一张
  let queue = Promise.resolve();

  // 空闲保活：每 30 分钟刷新一次页面，降低 Cloudflare / 会话掉线概率
  setInterval(() => {
    queue = queue.then(async () => {
      try {
        if (page && !page.isClosed()) await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
      } catch { /* 忽略保活失败 */ }
    });
  }, 30 * 60 * 1000).unref();

  const readBody = (req) => new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => resolve(d));
  });

  const authed = (req) => {
    if (!apiKey) return true;
    return (req.headers.authorization || '') === `Bearer ${apiKey}`;
  };

  const server = http.createServer(async (req, res) => {
    const send = (obj, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    const url = new URL(req.url, `http://${host}`);
    const p = url.pathname;

    // 图片静态访问：GET /output/<文件名>
    if (req.method === 'GET' && p.startsWith('/output/')) {
      const base = path.basename(decodeURIComponent(p.slice('/output/'.length)));
      const file = path.join(OUTPUT_DIR, base);
      const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
      const type = types[path.extname(base).toLowerCase()];
      if (!type || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': type });
      return fs.createReadStream(file).pipe(res);
    }

    if (req.method === 'GET' && p === '/health') {
      let caps = null;
      if (page && !page.isClosed() && page.url().includes('chatgpt.com')) {
        try { caps = await probeCapabilities(page); } catch { /* 页面可能在跳转中 */ }
      }
      return send({
        ok: true, version: VERSION, driver: DRIVER,
        page_alive: !!(page && !page.isClosed()),
        capabilities: caps,
        project_configured: !!loadConfig().project_url,
        api_key_enabled: !!apiKey,
      });
    }
    if (req.method === 'GET' && p === '/quota') {
      return send({ ok: true, last_3h: countRecent(3).used });
    }

    // 排障：当前页面状态 + 截图（受 API Key 保护）
    if (req.method === 'GET' && p === '/debug/pageinfo') {
      if (!authed(req)) return send({ ok: false, error_kind: 'auth', error: '未授权' }, 401);
      const info = { ok: true, url: page && !page.isClosed() ? page.url() : null };
      if (page && !page.isClosed()) {
        info.title = await page.title().catch(() => null);
        info.capabilities = await probeCapabilities(page).catch(() => null);
        info.last_article_text = await page.evaluate(() => {
          const a = [...document.querySelectorAll('article')];
          return a.length ? (a[a.length - 1].innerText || '').slice(0, 600) : null;
        }).catch(() => null);
        info.big_img_count = await page.evaluate(() =>
          [...document.querySelectorAll('img')].filter((i) => i.naturalWidth >= 256).length
        ).catch(() => null);
        const dir = path.join(OUTPUT_DIR, 'debug');
        fs.mkdirSync(dir, { recursive: true });
        info.screenshot = path.join(dir, `page_${Date.now()}.png`);
        await page.screenshot({ path: info.screenshot }).catch(() => { info.screenshot = null; });
      }
      return send(info);
    }

    const isGen = req.method === 'POST' && (p === '/generate' || p === '/v1/images/generations');
    if (!isGen) return send({ ok: false, error: 'not found' }, 404);
    if (!authed(req)) return send({ ok: false, error_kind: 'auth', should_retry: false, error: '未授权：需要请求头 Authorization: Bearer <api-key>' }, 401);

    const openai = p.startsWith('/v1/');
    let payload;
    try { payload = JSON.parse((await readBody(req)) || '{}'); } catch { return send({ ok: false, error: '请求体必须是 JSON' }, 400); }
    const prompt = String(payload.prompt || '').trim();
    if (!prompt) return send({ ok: false, error: '缺少 prompt' }, 400);
    const timeoutMs = Math.max(30, Number(payload.timeout) || 240) * 1000;
    const n = Math.min(10, Math.max(1, Number(payload.n) || 1));
    const ratio = payload.aspect_ratio || sizeToRatio(payload.size) || null;
    const waitQuota = payload.wait !== false; // 默认排队等待限额恢复
    const responseFormat = payload.response_format === 'b64_json' ? 'b64_json' : 'url';

    queue = queue.then(async () => {
      const t0 = Date.now();
      try {
        await ensurePage();
        const paths = [];
        for (let i = 0; i < n; i++) {
          const src = await generateWithQuotaWait(page, withAspectRatio(prompt, ratio), timeoutMs, { headless, waitQuota });
          const imgPath = await saveImage(context, page, src, prompt, (payload.out && n === 1) ? payload.out : null);
          recordHistory(prompt, imgPath, Math.round((Date.now() - t0) / 1000));
          paths.push(imgPath);
        }
        const elapsed = Math.round((Date.now() - t0) / 1000);
        if (openai) {
          const data = await Promise.all(paths.map(async (ip) => responseFormat === 'b64_json'
            ? { b64_json: (await fs.promises.readFile(ip)).toString('base64') }
            : { url: `http://${host}:${port}/output/${encodeURIComponent(path.basename(ip))}`, local_path: ip }));
          return send({ created: Math.floor(Date.now() / 1000), data });
        }
        send({ ok: true, paths, path: paths[0], elapsed_sec: elapsed });
      } catch (e) {
        const msg = String(e.message || e);
        const qms = quotaWaitMs(msg);
        if (qms) {
          const retryAfter = Math.ceil(qms / 1000);
          if (openai) return send({ error: { message: msg, type: 'rate_limit_error', code: 'rate_limit_exceeded', retry_after: retryAfter } }, 429);
          return send({ ok: false, error_kind: 'rate_limit', should_retry: true, retry_after: retryAfter, error: msg }, 429);
        }
        if (openai) return send({ error: { message: msg, type: 'server_error' } }, 500);
        send({ ok: false, error_kind: 'error', should_retry: false, error: msg }, 500);
      }
    });
  });

  server.listen(port, host, () => {
    console.log(`生图服务已启动: http://${host}:${port}（driver: ${DRIVER}${apiKey ? '，已启用 API Key' : ''}）`);
    console.log('  POST /generate                {"prompt":"...","n":2,"aspect_ratio":"16:9","wait":true}');
    console.log('  POST /v1/images/generations   OpenAI 兼容（prompt / size / n / response_format）');
    console.log('  GET  /output/<文件>  图片访问    GET /health  /quota');
    console.log('浏览器窗口请保持打开，Ctrl+C 退出服务。');
  });
}

function cmdQuota() {
  const { used, since } = countRecent(3);
  console.log(JSON.stringify({ ok: true, used_last_3h: used, since }, null, 2));
}

async function cmdDoctor() {
  const out = { ok: true, checks: {} };
  out.checks.node = process.version;
  out.checks.driver = DRIVER;
  out.checks.version = VERSION;
  out.checks.profile_dir = fs.existsSync(PROFILE_DIR) ? 'exists' : 'missing (还未 login)';
  out.checks.output_dir = OUTPUT_DIR;
  try {
    const context = await launchContext({ headless: false });
    const page = context.pages()[0] || (await context.newPage());
    await gotoWithRetry(page, chatUrl());
    out.checks.project_url = loadConfig().project_url || '未配置（对话会进入普通历史记录，建议运行 node gptimg.js setproject）';
    out.checks.login = (await waitForComposer(page, 20_000)) ? 'ok' : '未登录或被拦截，请运行 node gptimg.js login';
    await context.close();
  } catch (e) {
    out.ok = false;
    out.checks.browser = String(e.message || e);
  }
  console.log(JSON.stringify(out, null, 2));
}

// ---------- 入口 ----------

function die(msg) {
  console.error(msg);
  process.exit(1);
}

const [, , cmd, ...rest] = process.argv;
const flags = { _: [] };
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    if (i + 1 < rest.length && !rest[i + 1].startsWith('--')) flags[key] = rest[++i];
    else flags[key] = true;
  } else flags._.push(a);
}

const commands = {
  login: () => cmdLogin(),
  setproject: () => cmdSetProject(flags),
  setapikey: () => cmdSetApiKey(flags),
  gen: () => cmdGen(flags),
  serve: () => cmdServe(flags),
  quota: () => cmdQuota(),
  doctor: () => cmdDoctor(),
};

if (!commands[cmd]) {
  console.log('用法: node gptimg.js <login|setproject|setapikey|gen|serve|quota|doctor> [选项]');
  process.exit(cmd ? 1 : 0);
}
commands[cmd]();
