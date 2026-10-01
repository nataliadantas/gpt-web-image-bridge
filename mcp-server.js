#!/usr/bin/env node
/**
 * mcp-server.js — 把"网页版 ChatGPT 生图"封装成 MCP 工具，供 Codex / 其他 agent 调用。
 *
 * 策略：优先连接本地常驻服务（node gptimg.js serve，速度快）；
 *       服务没开则退化为一次性 CLI 调用（每次要启动浏览器，慢 10~20 秒）。
 *
 * 暴露的工具：
 *   generate_image(prompt, aspect_ratio?, timeout_sec?)  → { ok, path, elapsed_sec }
 *   quota_info()                                         → 最近 3 小时通过本程序生成的图片数
 */
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_URL = process.env.GPTIMG_SERVER || 'http://127.0.0.1:3777';

async function viaServer(prompt, timeoutSec, ratio) {
  const health = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(1500) }).catch(() => null);
  if (!health || !health.ok) return null;
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.GPTIMG_API_KEY) headers.Authorization = `Bearer ${process.env.GPTIMG_API_KEY}`;
  const resp = await fetch(`${SERVER_URL}/generate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt, timeout: timeoutSec, aspect_ratio: ratio || undefined, wait: false }),
    signal: AbortSignal.timeout((timeoutSec + 60) * 1000),
  });
  return await resp.json();
}

async function viaCli(prompt, timeoutSec, ratio) {
  const args = [path.join(__dirname, 'gptimg.js'), 'gen', prompt, '--timeout', String(timeoutSec)];
  if (ratio) args.push('--ratio', ratio);
  try {
    const { stdout } = await execFileP(
      process.execPath,
      args,
      { timeout: (timeoutSec + 90) * 1000, maxBuffer: 1024 * 1024, cwd: __dirname }
    );
    const line = stdout.trim().split('\n').pop();
    return JSON.parse(line);
  } catch (e) {
    const m = String(e.stdout || '').trim().split('\n').pop();
    if (m && m.startsWith('{')) return JSON.parse(m);
    return { ok: false, error: String(e.message || e) };
  }
}

function textResult(obj, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], isError };
}

const server = new McpServer({ name: 'gpt-web-image', version: '0.1.0' });

server.registerTool(
  'generate_image',
  {
    title: '网页版 ChatGPT 生图',
    description:
      '通过用户已登录的网页版 ChatGPT 生成一张图片（额度：每 3 小时约 50 张）。' +
      '返回本地保存的图片绝对路径。生成需要 30~120 秒，请勿频繁重试。' +
      '若返回 error_kind 为 rate_limit，请按 retry_after 秒数稍后再重试。',
    inputSchema: {
      prompt: z.string().describe('图片提示词，中英文均可'),
      aspect_ratio: z.enum(['1:1', '3:2', '2:3', '16:9', '9:16']).optional().describe('宽高比，默认由模型决定'),
      timeout_sec: z.number().min(30).max(600).optional().describe('超时秒数，默认 240'),
    },
  },
  async ({ prompt, aspect_ratio, timeout_sec }) => {
    const timeoutSec = timeout_sec || 240;
    const result = (await viaServer(prompt, timeoutSec, aspect_ratio)) ?? (await viaCli(prompt, timeoutSec, aspect_ratio));
    if (result?.ok) return textResult(result);
    return textResult(result ?? { ok: false, error: '生图失败，无返回' }, true);
  }
);

server.registerTool(
  'quota_info',
  {
    title: '查询生图额度使用情况',
    description: '返回最近 3 小时内通过本程序生成的图片数量（基于本地历史记录，仅供参考）。',
    inputSchema: {},
  },
  async () => {
    const history = path.join(__dirname, 'output', 'history.jsonl');
    let used = 0;
    const cutoff = Date.now() - 3 * 3600_000;
    if (fs.existsSync(history)) {
      for (const line of fs.readFileSync(history, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { if (new Date(JSON.parse(line).ts).getTime() >= cutoff) used++; } catch { /* 忽略坏行 */ }
      }
    }
    return textResult({ ok: true, used_last_3h: used, assumed_limit_per_3h: 50 });
  }
);

await server.connect(new StdioServerTransport());
