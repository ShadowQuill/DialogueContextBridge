// 真机端到端验证：用编译后的真实插件在 DSH 形态宿主桩上跑通完整闭环，
// 抓取命令实际产出的卡片 Markdown，并渲染成 HTML 预览（用于人工核对"卡片好不好看"）。
// 不引入任何新依赖：Markdown→HTML 走自带精简渲染器（覆盖本插件输出用到的子集）。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';

const OUT_DIR = '/tmp/dcb-e2e';

// ---------- 宿主桩（与 tests/dsh-host.test.ts 同形） ----------
function createDshMockHost(messages) {
  const capturedCommands = [];
  const services = {};
  const injectCalls = [];
  const agent = {
    id: 'conv-cur',
    session: { deriveMessages: () => messages },
    inject: (message) => {
      const msg = message;
      injectCalls.push({
        text: (msg.content || []).map((b) => b.text ?? '').join(''),
        source: msg.source,
      });
    },
  };
  const host = {
    services,
    capturedCommands,
    injectCalls,
    commands: { register: (def) => { capturedCommands.push(def); return () => undefined; } },
    set: (name, value) => { services[name] = value; },
    provide: (name, value) => { services[name] = value; return () => undefined; },
    effect: (execute) => { host.disposeEffect = execute(); return () => undefined; },
    inject: () => () => undefined,
  };
  return { host, agent, injectCalls };
}

const SAMPLE_MESSAGES = [
  { id: 'm1', role: 'user', content: '我们要为长周期项目加一个对话上下文桥接功能，决定采用三层快照架构（verbatim/summary/preference）。', createdAt: 1_700_000_000_000 },
  { id: 'm2', role: 'assistant', content: '好的，我会按三层组织快照，保证零丢失移植；代码用 TypeScript，框架用 Cordis。', createdAt: 1_700_000_000_100 },
  { id: 'm3', role: 'user', content: '存储用 SQLite + FTS5 做全文检索，配置经设置面板热改。', createdAt: 1_700_000_000_200 },
];

function makeConfig(tmpDir) {
  return {
    dataDir: tmpDir,
    maxTokens: 4096,
    maxBulletsPerSection: 6,
    maxHistoryMessages: 400,
    autoSave: false,
    searchLimit: 10,
    encryption: { enabled: false, passphrase: '', indexPlaintext: false },
    summary: { mode: 'extractive', provider: 'deepseek', model: '', maxTokens: 1024, temperature: 0.2 },
    logLevel: 'silent',
    merge: { policy: 'newWins' },
    versioning: { enabled: false },
  };
}

async function run(host, agent, name, rawInput, args, options) {
  const cmd = host.capturedCommands.find((c) => c.name === name);
  if (!cmd) throw new Error(`命令未注册: ${name}`);
  const parts = [rawInput, ...args];
  for (const [k, v] of Object.entries(options || {})) {
    if (v === true) parts.push(`--${k}`);
    else if (v !== false && v != null) parts.push(`--${k}`, String(v));
  }
  const full = parts.join(' ').trim();
  const result = await cmd.handler({ agent, rawInput: full });
  if (result && result.kind === 'error') throw new Error(`命令失败: ${result.text}`);
  return result?.text ?? '';
}

// ---------- 精简 Markdown→HTML（覆盖本插件输出子集） ----------
function inlineMd(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function renderMarkdown(md) {
  const lines = md.split('\n');
  const html = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // fenced code
    if (line.trim().startsWith('```')) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { buf.push(lines[i]); i++; }
      i++; // skip closing ```
      html.push(`<pre><code>${buf.map((l) => escapeHtml(l)).join('\n')}</code></pre>`);
      continue;
    }
    // blockquote (card header band)
    if (line.startsWith('>')) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      html.push(`<blockquote>${inlineMd(buf.join('<br>'))}</blockquote>`);
      continue;
    }
    // table
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|')) { rows.push(splitRow(lines[i])); i++; }
      html.push(
        '<table><thead><tr>' +
          header.map((c) => `<th>${inlineMd(c)}</th>`).join('') +
          '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + r.map((c) => `<td>${inlineMd(c)}</td>`).join('') + '</tr>').join('') +
          '</tbody></table>',
      );
      continue;
    }
    // heading
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { html.push(`<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`); i++; continue; }
    // list item (▸ or -)
    if (/^\s*[▸-]\s+/.test(line)) {
      const buf = [line];
      i++;
      while (i < lines.length && /^\s*[▸-]\s+/.test(lines[i])) { buf.push(lines[i]); i++; }
      html.push('<ul>' + buf.map((l) => `<li>${inlineMd(l.replace(/^\s*[▸-]\s+/, ''))}</li>`).join('') + '</ul>');
      continue;
    }
    // blank
    if (line.trim() === '') { i++; continue; }
    // paragraph
    html.push(`<p>${inlineMd(line)}</p>`);
    i++;
  }
  return html.join('\n');
}

function splitRow(row) {
  return row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- 主流程 ----------
async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dcb-e2e-'));
  const { host, agent, injectCalls } = createDshMockHost(SAMPLE_MESSAGES);
  apply(host, makeConfig(tmpDir));

  const service = host.services.dcb;
  const saved = await service.compileAndSave({
    conversationId: 'conv-src',
    messages: SAMPLE_MESSAGES,
    title: 'DSH 契约验证快照',
  });
  const id = saved.snapshotId;

  const steps = [];
  steps.push(['/compile 预览（不落库）', await run(host, agent, 'compile', '', [], { title: '桥接评审' })]);
  steps.push(['/save 落库卡片', await run(host, agent, 'save', '', [], {})]);
  steps.push(['/dcb 记忆库总览卡片', await run(host, agent, 'dcb', '', [], {})]);
  steps.push(['/dcb <id> 一键引入卡片', await run(host, agent, 'dcb', '', [id], {})]);
  steps.push(['/dcb-save 一键导出卡片', await run(host, agent, 'dcb-save', '', [], { title: '导出演示' })]);
  steps.push(['/import <id> --mode merge --dry-run 预览', await run(host, agent, 'import', '', [id], { mode: 'merge', dryRun: true })]);
  steps.push(['/import <id> --mode merge 实际融合', await run(host, agent, 'import', '', [id], { mode: 'merge', policy: 'newWins' })]);
  steps.push(['/snapshot-search 上下文桥接', await run(host, agent, 'snapshot-search', '上下文桥接', [], {})]);

  mkdirSync(OUT_DIR, { recursive: true });
  const cards = steps
    .map(
      ([label, md], idx) => `
      <section class="msg">
        <div class="role">${label}</div>
        <div class="bubble">${renderMarkdown(md)}</div>
      </section>`,
    )
    .join('\n');

  const page = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DialogueContextBridge · 真机卡片预览</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; background:#f5f6f8; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; color:#1f2329; }
  .wrap { max-width: 820px; margin: 0 auto; padding: 24px 16px 60px; }
  h1.title { font-size: 18px; margin: 8px 0 4px; }
  .sub { color:#8a9099; font-size: 13px; margin-bottom: 20px; }
  .msg { display:flex; flex-direction:column; align-items:flex-start; margin: 14px 0; }
  .role { font-size: 12px; color:#8a9099; margin: 0 0 4px 2px; }
  .bubble { background:#fff; border:1px solid #e6e8eb; border-radius: 12px; padding: 14px 16px; max-width: 100%; width:100%; box-sizing:border-box; box-shadow: 0 1px 2px rgba(0,0,0,.03); line-height:1.65; font-size:14px; }
  .bubble blockquote { margin:0 0 10px; padding: 8px 12px; border-left: 4px solid #4c6ef5; background:#f0f4ff; border-radius: 6px; color:#2b3a67; font-weight:600; }
  .bubble blockquote br { content:""; }
  .bubble table { border-collapse: collapse; width:100%; margin: 8px 0; font-size: 13px; }
  .bubble th, .bubble td { border:1px solid #e6e8eb; padding: 6px 10px; text-align:left; }
  .bubble th { background:#f7f8fa; font-weight:600; }
  .bubble tr:nth-child(even) td { background:#fbfcfd; }
  .bubble code { background:#f0f1f3; padding: 1px 5px; border-radius: 4px; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12.5px; }
  .bubble pre { background:#0f1115; color:#e6e6e6; padding: 12px; border-radius: 8px; overflow:auto; }
  .bubble pre code { background:none; color:inherit; padding:0; }
  .bubble ul { margin: 6px 0; padding-left: 18px; }
  .bubble li { margin: 3px 0; }
  .bubble p { margin: 6px 0; }
  .bubble h1,.bubble h2,.bubble h3 { margin: 10px 0 6px; }
</style></head>
<body><div class="wrap">
  <h1 class="title">DialogueContextBridge · 真机端到端卡片预览</h1>
  <div class="sub">在真实 dsh 宿主桩（真实插件逻辑 + 真实 SQLite 数据库 + 真实命令注册）上跑通 /compile → /save → /dcb → /import 闭环后，命令实际产出的卡片 Markdown 渲染效果。快照 id：<code>${id}</code></div>
  ${cards}
</div></body></html>`;

  writeFileSync(join(OUT_DIR, 'index.html'), page);
  steps.forEach(([label, md], idx) => writeFileSync(join(OUT_DIR, `step-${idx + 1}.md`), `# ${label}\n\n${md}`));

  console.log('注入次数(agent.inject 调用):', injectCalls.length);
  console.log('快照 id:', id);
  console.log('步骤数:', steps.length);
  console.log('预览已写入:', join(OUT_DIR, 'index.html'));
  console.log('注入来源示例:', JSON.stringify(injectCalls[0]?.source));
  rmSync(tmpDir, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
