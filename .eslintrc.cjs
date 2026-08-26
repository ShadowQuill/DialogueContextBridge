/**
 * ESLint 配置（Airbnb 风格 + @typescript-eslint v8）。
 *
 * 说明：package.json 中声明了 `"type": "module"`，因此配置文件必须使用 `.cjs`
 * 扩展名，否则 ESLint 8 无法以 CommonJS 方式加载它。
 *
 * 关于 `eslint-config-airbnb-typescript`：
 * 该共享配置没有 8.x 版本，且它引用的 `@typescript-eslint/no-throw-literal` 与
 * `@typescript-eslint/lines-between-class-members` 两条规则已在 @typescript-eslint v8
 * 中移除（前者改为 ESLint core 的 `no-throw-literal`，后者本就是 core 规则）。直接
 * `extends` 它会导致 `Definition for rule ... was not found`。因此这里改用官方推荐的
 * 组合——`airbnb-base`（纯 JS 风格）+ `plugin:@typescript-eslint/recommended`（TS 风格），
 * 并手动补回 airbnb-typescript 原本替我们打开的几条 TS 感知规则。这同时彻底摆脱了
 * 对 `airbnb-typescript@18` 锁死 `^7` 的 peer 依赖。
 */
module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: ['./tsconfig.json'],
  },
  plugins: ['@typescript-eslint', 'import'],
  extends: [
    'airbnb-base',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  settings: {
    'import/resolver': {
      typescript: { alwaysTryTypes: true, project: './tsconfig.json' },
    },
  },
  rules: {
    // 项目采用函数式风格，用工厂函数替代 class。
    'no-restricted-syntax': [
      'error',
      {
        selector: 'ClassDeclaration',
        message: '本项目优先使用函数式编程，请用工厂函数替代 class。',
      },
    ],

    // Node 侧插件允许 devDependencies 出现在测试与配置文件中。
    'import/no-extraneous-dependencies': [
      'error',
      { devDependencies: ['tests/**/*.ts', '*.config.ts', '.*.cjs'] },
    ],
    'import/prefer-default-export': 'off',
    'import/extensions': ['error', 'ignorePackages', { ts: 'never' }],

    // Cordis/DSH 约定：`export const Config = Schema.object(...)` 与
    // `export type Config = ReturnType<typeof Config>` 同名校验器 + 类型推导，
    // 二者分属不同声明空间，是合法且惯用的写法，关闭该规则以免误报。
    '@typescript-eslint/no-redeclare': 'off',

    // JSDoc 是强约定，但注释内容由 review 保证，这里只做基础风格约束。
    'no-void': ['error', { allowAsStatement: true }],
    'no-underscore-dangle': 'off',
    'no-console': ['error', { allow: ['warn', 'error'] }],
    '@typescript-eslint/consistent-type-imports': [
      'error',
      { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
    ],
    '@typescript-eslint/explicit-module-boundary-types': 'warn',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

    // —— 以下三条是 airbnb-typescript/base 原本替我们打开的 TS 感知规则，
    //    升级到 v8 后需手动补回（否则与 airbnb-base 的 base 版规则重复/缺失）。——
    // 用 TS 感知版取代 airbnb-base 的 `no-unused-vars`（后者看不懂 import type）。
    'no-unused-vars': 'off',
    // 同理，TS 感知版不会把「类型别名在定义前被引用」误报为未定义。
    'no-use-before-define': 'off',
    '@typescript-eslint/no-use-before-define': ['error', { functions: false }],
    // airbnb-typescript 的 lines-between-class-members 在 v8 已并入 core；本项目禁止 class
    // （见 no-restricted-syntax），该规则不会触发，关闭以免与 core schema 版本耦合。
    'lines-between-class-members': 'off',
    // airbnb-typescript 的 no-throw-literal 在 v8 已并入 core，用 core 名启用。
    'no-throw-literal': 'error',
    // TS 增强的 no-shadow，用于捕获类型与值同名遮蔽（配合 src/dsh/types.ts 的别名写法）。
    'no-shadow': 'off',
    '@typescript-eslint/no-shadow': ['error'],
  },
  overrides: [
    {
      files: ['tests/**/*.ts'],
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off',
      },
    },
  ],
  ignorePatterns: ['lib/', 'coverage/', 'node_modules/', '*.cjs'],
};
