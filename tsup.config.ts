import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm', 'cjs'],
  target: 'node18',
  platform: 'node',
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  // better-sqlite3 是原生模块，必须保持外部依赖。
  // 宿主（dsh）在运行时注入的 cordis fork 与各 dsh 子包也需保持外部，
  // 否则会与宿主实例产生两份独立的 cordis，导致插件无法挂载。
  external: [
    'better-sqlite3',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-commands',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-settings',
  ],
});
