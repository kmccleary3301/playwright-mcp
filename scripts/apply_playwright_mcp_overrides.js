#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const overridesRoot = path.join(repoRoot, 'overrides', 'mcp');
const playwrightMcpRoot = path.join(repoRoot, 'node_modules', 'playwright', 'lib', 'mcp');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyTree(srcDir, destDir) {
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyTree(src, dest);
      continue;
    }
    if (entry.isFile())
      copyFile(src, dest);
  }
}

function applyOverrides() {
  if (!fs.existsSync(playwrightMcpRoot)) {
    console.error('Playwright MCP root not found:', playwrightMcpRoot);
    process.exit(1);
  }

  if (!fs.existsSync(overridesRoot)) {
    console.error('Overrides root not found:', overridesRoot);
    process.exit(1);
  }

  copyTree(overridesRoot, playwrightMcpRoot);

  patchToolsRegistry(path.join(playwrightMcpRoot, 'browser', 'tools.js'));
  patchProgramCaps(path.join(playwrightMcpRoot, 'program.js'));
}

function patchToolsRegistry(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');

  const importLines = [
    'var import_diff = __toESM(require("./tools/diff"));',
    'var import_perf = __toESM(require("./tools/perf"));',
    'var import_screenshotDiff = __toESM(require("./tools/screenshotDiff"));',
    'var import_scenario = __toESM(require("./tools/scenario"));',
    'var import_style = __toESM(require("./tools/style"));'
  ];

  const importAnchor = 'const browserTools = [';
  if (!content.includes(importLines[0])) {
    content = content.replace(importAnchor, importLines.join('\n') + '\n' + importAnchor);
  }

  const toolLines = [
    '  ...import_diff.default,',
    '  ...import_perf.default,',
    '  ...import_screenshotDiff.default,',
    '  ...import_scenario.default,',
    '  ...import_style.default,'
  ];

  const arrayEnd = '\n];';
  if (!content.includes(toolLines[0])) {
    content = content.replace(arrayEnd, '\n' + toolLines.join('\n') + arrayEnd);
  }

  fs.writeFileSync(filePath, content, 'utf8');
}

function patchProgramCaps(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  const oldText = 'possible values: vision, pdf.';
  const newText = 'possible values: vision, pdf, testing, tracing, diffs, styles, scenarios, perf.';
  if (content.includes(oldText))
    content = content.replace(oldText, newText);
  fs.writeFileSync(filePath, content, 'utf8');
}

applyOverrides();
