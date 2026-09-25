// Copyright 2026 The Wazo Authors  (see the AUTHORS file)
// SPDX-License-Identifier: GPL-3.0-or-later

const js = require("@eslint/js");

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      globals: {
        __ENV: "readonly",
        __ITER: "readonly",
        __VU: "readonly",
        console: "readonly",
        open: "readonly",
      },
    },
  },
];
