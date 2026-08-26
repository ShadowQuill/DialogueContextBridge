/**
 * Conventional Commits 校验配置。
 * 允许的 type 与本项目 CONTRIBUTING.md 保持一致。
 */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'],
    ],
    'scope-enum': [
      1,
      'always',
      ['core', 'storage', 'security', 'commands', 'dsh', 'config', 'docs', 'deps', 'release'],
    ],
    'subject-case': [0],
    'header-max-length': [2, 'always', 100],
  },
};
