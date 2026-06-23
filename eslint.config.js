import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      '.output/**',
      '.wxt/**',
      'node_modules/**',
      'dist/**',
      // Debug/dev-only scripts that hit external services with real creds —
      // not shipped code; kept out of lint to avoid noise.
      'scripts/**',
    ],
  },
  {
    languageOptions: {
      globals: {
        // WXT auto-imports
        defineBackground: 'readonly',
        defineContentScript: 'readonly',
        defineConfig: 'readonly',
        browser: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
);
