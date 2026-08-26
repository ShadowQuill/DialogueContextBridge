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
  external: ['better-sqlite3', 'cordis'],
});
