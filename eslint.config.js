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
