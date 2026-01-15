// Root ESLint flat config for app (Cloudflare Worker + SSR JSX) and server-client (Node)
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    name: "base-rules",
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    name: "ignores",
    ignores: ["node_modules/**", "external_repos/**", "app/public/**", "**/dist/**", "**/build/**", "**/*.min.js", "**/.wrangler/**"],
  },
  {
    name: "app-worker",
    files: ["app/src/**/*.{ts,tsx,js,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.es2024,
        ...globals.serviceworker,
      },
    },
    rules: {
      "no-console": "off",
    },
  },
  {
    name: "server-client-node",
    files: ["server-client/**/*.{ts,tsx,js,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.es2024,
        ...globals.node,
      },
    },
    rules: {
      "no-console": "off",
    },
  },
  {
    name: "tests",
    files: ["**/*.test.{ts,tsx,js,jsx}"],
    languageOptions: {
      globals: {
        ...globals.vitest,
      },
    },
  },
  // Disable formatting-related rules; Prettier owns formatting
  prettier,
];
