/**
 * Workspace-wide ESLint config for bakin-bits-official.
 *
 * Each plugin is independent — there's no cross-plugin imports
 * permitted, and the only Bakin-side import target is `@bakin/sdk/*`.
 * The `no-restricted-imports` rule below is the enforcement mechanism;
 * plugins that need core APIs go through SDK exports.
 */
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['plugins/**/*.{ts,tsx}'],
    rules: {
      // Plugins MUST NOT reach past the SDK. Direct imports of bakin
      // internals (`@/core/*`, `@bakin/core/*`, other plugin packages)
      // break under hot reload and won't resolve when the plugin is
      // installed into a real Bakin instance.
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['@/*', '@bakin/core/*', '@bakin/tasks/*', '@bakin/messaging/*', '@bakin/projects/*', '@bakin/workflows/*', '@bakin/team/*', '@bakin/health/*', '@bakin/memory/*', '@bakin/assets/*', '@bakin/schedule/*', '@bakin/models/*'],
            message: 'Plugins may only import from `@bakin/sdk/*`. Cross-plugin imports break under hot reload and at runtime.',
          },
        ],
      }],
    },
  },
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
    ],
  },
)
