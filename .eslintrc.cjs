/**
 * ESLint 配置（Airbnb TypeScript 风格指南）。
 *
 * 说明：package.json 中声明了 `"type": "module"`，因此配置文件必须使用 `.cjs`
 * 扩展名，否则 ESLint 8 无法以 CommonJS 方式加载它。
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
    'airbnb-typescript/base',
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
