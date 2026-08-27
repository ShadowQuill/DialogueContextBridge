import { describe, expect, it } from 'vitest';
import { actionList, card, flag, kvTable, snapshotTable } from '../src/commands/card';

describe('card 渲染助手', () => {
  it('card 渲染标题带（无 Markdown 标记），并拼接待正文', () => {
    const out = card({ icon: '🌉', title: '总览', subtitle: '副标题', body: '内容' });
    expect(out).toContain('🌉 总览');
    expect(out).toContain('  副标题');
    expect(out.endsWith('内容')).toBe(true);
  });

  it('card 无副标题时只有一行标题带', () => {
    const out = card({ title: '仅标题' });
    expect(out).toBe('仅标题');
  });

  it('kvTable 生成「· 字段  值」两列清单', () => {
    const out = kvTable([
      ['模式', 'inject'],
      ['Token 估算', '412'],
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toBe('· 模式  inject');
    expect(lines[1]).toBe('· Token 估算  412');
  });

  it('kvTable 空行返回占位文案', () => {
    expect(kvTable([])).toBe('（无）');
  });

  it('snapshotTable 渲染每条快照一个缩进区块', () => {
    const out = snapshotTable([
      { id: 'snap_a1', title: '项目设计', tokens: 412, status: '🔒 加密' },
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toBe('▸ snap_a1');
    expect(lines[1]).toBe('    项目设计 · 412 tokens · 🔒 加密');
  });

  it('snapshotTable 缺省状态显示为 —', () => {
    const out = snapshotTable([{ id: 's', title: 't', tokens: 1 }]);
    expect(out).toContain('t · 1 tokens · —');
  });

  it('actionList 渲染「标签 → 命令」清单', () => {
    const out = actionList([
      ['一键引入', '/dcb <id>'],
      ['合并引入', '/import <id> --mode merge'],
    ]);
    expect(out).toContain('▸ 一键引入  →  /dcb <id>');
    expect(out).toContain('▸ 合并引入  →  /import <id> --mode merge');
  });

  it('flag 渲染开关状态徽标', () => {
    expect(flag(true)).toBe('🟢 开');
    expect(flag(false)).toBe('⚪ 关');
    expect(flag(true, '启用', '停用')).toBe('🟢 启用');
  });
});
