import { describe, expect, it } from 'vitest';
import { actionList, card, flag, kvTable, snapshotTable } from '../src/commands/card';

describe('card 渲染助手', () => {
  it('card 用引用块渲染标题带，并拼接待正文', () => {
    const out = card({ icon: '🌉', title: '总览', subtitle: '副标题', body: '内容' });
    expect(out).toContain('> 🌉 **总览**');
    expect(out).toContain('> 副标题');
    expect(out).toContain('');
    expect(out.endsWith('内容')).toBe(true);
  });

  it('card 无副标题时只有一行标题带', () => {
    const out = card({ title: '仅标题' });
    expect(out).toContain('> **仅标题**');
    expect(out).not.toContain('> \n');
  });

  it('kvTable 生成 GFM 两列表（含表头与分隔行）', () => {
    const out = kvTable([
      ['模式', 'inject'],
      ['Token 估算', '412'],
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toBe('| 字段 | 值 |');
    expect(lines[1]).toBe('| --- | --- |');
    expect(lines[2]).toBe('| 模式 | inject |');
    expect(lines[3]).toBe('| Token 估算 | 412 |');
  });

  it('kvTable 空行返回占位文案', () => {
    expect(kvTable([])).toBe('_（无）_');
  });

  it('snapshotTable 渲染四列快照清单', () => {
    const out = snapshotTable([
      { id: 'snap_a1', title: '项目设计', tokens: 412, status: '🔒 加密' },
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toBe('| 快照 ID | 标题 | Tokens | 状态 |');
    expect(lines[1]).toBe('| --- | --- | --- | --- |');
    expect(lines[2]).toBe('| `snap_a1` | 项目设计 | 412 | 🔒 加密 |');
  });

  it('snapshotTable 缺省状态显示为 —', () => {
    const out = snapshotTable([{ id: 's', title: 't', tokens: 1 }]);
    expect(out).toContain('| `s` | t | 1 | — |');
  });

  it('actionList 渲染可点击命令清单', () => {
    const out = actionList([
      ['一键引入', '/dcb <id>'],
      ['合并引入', '/import <id> --mode merge'],
    ]);
    expect(out).toContain('▸ **一键引入**： `/dcb <id>`');
    expect(out).toContain('▸ **合并引入**： `/import <id> --mode merge`');
  });

  it('flag 渲染开关状态徽标', () => {
    expect(flag(true)).toBe('🟢 开');
    expect(flag(false)).toBe('⚪ 关');
    expect(flag(true, '启用', '停用')).toBe('🟢 启用');
  });
});
