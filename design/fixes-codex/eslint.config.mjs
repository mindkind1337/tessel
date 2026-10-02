import js from '@eslint/js'
import globals from 'globals'
import pluginVue from 'eslint-plugin-vue'
import prettier from 'eslint-config-prettier'

export default [
  { ignores: ['out/**', 'dist/**', 'node_modules/**'] },

  js.configs.recommended,
  ...pluginVue.configs['flat/recommended'],

  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      // Both processes live in this repo: main/preload use Node globals,
      // the renderer uses browser globals.
      globals: { ...globals.node, ...globals.browser }
    },
    rules: {
      // Single-file components like App.vue / SplitNode.vue are fine.
      'vue/multi-word-component-names': 'off',
      // The `node` prop is the shared reactive layout-tree model passed down
      // the recursive SplitNode/TerminalPane tree. Mutating it in place
      // (divider sizes, per-pane broadcast flag) is the intended design.
      'vue/no-mutating-props': 'off',
      // We intentionally swallow errors when a PTY is already gone.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
    }
  },

  // Keep ESLint and Prettier from fighting over formatting.
  prettier
]
