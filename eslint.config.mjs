// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import globals from "globals";

const directDefects = {
  rules: {
    "no-constant-binary-expression": "error",
    "no-constant-condition": ["error", { checkLoops: false }],
    "no-dupe-else-if": "error",
    "no-dupe-keys": "error",
    "no-duplicate-case": "error",
    "no-func-assign": "error",
    "no-import-assign": "error",
    "no-unreachable": "error",
    "no-unsafe-finally": "error",
    "no-unused-vars": ["error", {
      vars: "all",
      args: "after-used",
      argsIgnorePattern: "^_",
      caughtErrors: "none",
      ignoreRestSiblings: true,
    }],
  },
};

const meshBrowserGlobals = {
  Terminal: "readonly",
  FitAddon: "readonly",
  marked: "readonly",
  DOMPurify: "readonly",
  mermaid: "readonly",
  monaco: "readonly",
};

export default [
  // Generated collector bundle: validate its TypeScript inputs and build freshness.
  { ignores: ["node_modules/**", "static/vendor/**", "tools/project-observation.mjs"] },
  {
    files: ["eslint.config.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    ...directDefects,
  },
  {
    files: ["static/app.js", "static/mesh-frame-history.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: { ...globals.browser, ...meshBrowserGlobals },
    },
    ...directDefects,
  },
  {
    files: ["static/sw.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: { ...globals.serviceworker },
    },
    ...directDefects,
  },
  {
    files: ["static/**/*.mjs", "tools/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
    },
    ...directDefects,
  },
];
