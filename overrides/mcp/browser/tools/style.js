"use strict";

const fs = require("fs");
const path = require("path");
const { z } = require("playwright-core/lib/mcpBundle");
const { outputDir: outputDirForClient } = require("../config");
const { defineTabTool } = require("./tool");

const STYLE_PRESETS = {
  typography: [
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "line-height",
    "letter-spacing",
    "text-transform",
    "text-decoration",
    "text-align",
    "color"
  ],
  box: [
    "display",
    "position",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "border-top-width",
    "border-right-width",
    "border-bottom-width",
    "border-left-width",
    "border-top-style",
    "border-right-style",
    "border-bottom-style",
    "border-left-style",
    "border-top-color",
    "border-right-color",
    "border-bottom-color",
    "border-left-color",
    "background-color",
    "background",
    "box-shadow",
    "opacity",
    "overflow",
    "overflow-x",
    "overflow-y"
  ],
  layout: [
    "width",
    "height",
    "min-width",
    "min-height",
    "max-width",
    "max-height",
    "flex",
    "flex-direction",
    "flex-wrap",
    "justify-content",
    "align-items",
    "align-content",
    "align-self",
    "gap",
    "row-gap",
    "column-gap",
    "grid-template-columns",
    "grid-template-rows",
    "grid-auto-flow",
    "grid-auto-columns",
    "grid-auto-rows"
  ],
  codeblock: [
    "font-family",
    "font-size",
    "line-height",
    "white-space",
    "tab-size",
    "overflow-x",
    "background-color",
    "border-radius",
    "color"
  ]
};

function unique(list) {
  return [...new Set(list)];
}

function resolveMaybeRelative(context, inputPath) {
  if (path.isAbsolute(inputPath))
    return inputPath;
  const cwdPath = path.resolve(process.cwd(), inputPath);
  if (fs.existsSync(cwdPath))
    return cwdPath;
  const outDir = outputDirForClient(context.config, context.options.clientInfo);
  return path.resolve(outDir, inputPath);
}

function resolveProperties(params) {
  const presets = params.preset ? STYLE_PRESETS[params.preset] || [] : [];
  const combined = unique([...(params.properties || []), ...presets]);
  if (combined.length)
    return combined;
  return STYLE_PRESETS.typography;
}

async function collectForTarget(tab, target, props, includeLayout, includeText) {
  const { locator } = await tab.refLocator({ ref: target.ref, element: target.element });
  return await locator.evaluate((el, options) => {
    const computed = window.getComputedStyle(el);
    const styles = {};
    for (const prop of options.props)
      styles[prop] = computed.getPropertyValue(prop);
    const rect = el.getBoundingClientRect();
    const layout = {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      scrollWidth: el.scrollWidth,
      scrollHeight: el.scrollHeight,
      clientWidth: el.clientWidth,
      clientHeight: el.clientHeight
    };
    return {
      tag: el.tagName,
      id: el.id || null,
      className: typeof el.className === "string" ? el.className : null,
      text: options.includeText ? (el.textContent || "").trim().slice(0, 200) : null,
      styles,
      layout: options.includeLayout ? layout : void 0
    };
  }, { props, includeLayout, includeText });
}

function diffStyleSnapshots(expected, actual) {
  const diffs = [];
  const expectedByRef = new Map((expected.targets || []).map((t) => [t.ref, t]));
  const actualByRef = new Map((actual.targets || []).map((t) => [t.ref, t]));
  for (const [ref, expectedTarget] of expectedByRef.entries()) {
    const actualTarget = actualByRef.get(ref);
    if (!actualTarget) {
      diffs.push({ ref, type: "missing", message: "Target missing in current snapshot" });
      continue;
    }
    const expectedStyles = expectedTarget.styles || {};
    const actualStyles = actualTarget.styles || {};
    for (const key of Object.keys(expectedStyles)) {
      if (expectedStyles[key] !== actualStyles[key]) {
        diffs.push({ ref, type: "style", property: key, expected: expectedStyles[key], actual: actualStyles[key] });
      }
    }
  }
  for (const [ref] of actualByRef.entries()) {
    if (!expectedByRef.has(ref))
      diffs.push({ ref, type: "extra", message: "Target missing in baseline snapshot" });
  }
  return diffs;
}

function diffLayoutSnapshots(expected, actual) {
  const diffs = [];
  const expectedByRef = new Map((expected.targets || []).map((t) => [t.ref, t]));
  const actualByRef = new Map((actual.targets || []).map((t) => [t.ref, t]));
  for (const [ref, expectedTarget] of expectedByRef.entries()) {
    const actualTarget = actualByRef.get(ref);
    if (!actualTarget) {
      diffs.push({ ref, type: "missing", message: "Target missing in current snapshot" });
      continue;
    }
    const expectedLayout = expectedTarget.layout || {};
    const actualLayout = actualTarget.layout || {};
    for (const key of Object.keys(expectedLayout)) {
      if (expectedLayout[key] !== actualLayout[key]) {
        diffs.push({ ref, type: "layout", property: key, expected: expectedLayout[key], actual: actualLayout[key] });
      }
    }
  }
  for (const [ref] of actualByRef.entries()) {
    if (!expectedByRef.has(ref))
      diffs.push({ ref, type: "extra", message: "Target missing in baseline snapshot" });
  }
  return diffs;
}

const targetSchema = z.object({
  element: z.string().describe("Human-readable element description"),
  ref: z.string().describe("Exact target element reference")
});

const styleSnapshot = defineTabTool({
  capability: "styles",
  schema: {
    name: "browser_style_snapshot",
    title: "Style snapshot",
    description: "Capture computed style snapshot for specific elements",
    inputSchema: z.object({
      targets: z.array(targetSchema).describe("Elements to capture styles for"),
      properties: z.array(z.string()).optional().describe("CSS properties to capture"),
      preset: z.enum(["typography", "box", "layout", "codeblock"]).optional().describe("Preset property group"),
      includeLayout: z.boolean().optional().describe("Include layout metrics in snapshot"),
      includeText: z.boolean().optional().describe("Include truncated text content"),
      filename: z.string().optional().describe("File name to save snapshot to")
    }),
    type: "readOnly"
  },
  handle: async (tab, params, response) => {
    const props = resolveProperties(params);
    const targets = [];
    for (const target of params.targets)
      targets.push({ ref: target.ref, element: target.element, ...(await collectForTarget(tab, target, props, params.includeLayout === true, params.includeText === true)) });
    const snapshot = {
      createdAt: new Date().toISOString(),
      url: tab.page.url(),
      properties: props,
      targets
    };
    const payload = JSON.stringify(snapshot, null, 2);
    if (params.filename) {
      const fileName = await response.addFile(params.filename, { origin: "llm", reason: "Style snapshot" });
      await fs.promises.writeFile(fileName, payload, "utf8");
      response.addResult(`Saved style snapshot to ${fileName}`);
    } else {
      response.addResult(payload);
    }
  }
});

const styleDiff = defineTabTool({
  capability: "styles",
  schema: {
    name: "browser_style_diff",
    title: "Style snapshot diff",
    description: "Compare computed style snapshot against baseline",
    inputSchema: z.object({
      baselinePath: z.string().describe("Path to baseline style snapshot JSON"),
      targets: z.array(targetSchema).describe("Elements to capture styles for"),
      properties: z.array(z.string()).optional().describe("CSS properties to capture"),
      preset: z.enum(["typography", "box", "layout", "codeblock"]).optional().describe("Preset property group"),
      includeLayout: z.boolean().optional().describe("Include layout metrics in snapshot"),
      includeText: z.boolean().optional().describe("Include truncated text content"),
      diffPath: z.string().optional().describe("File path to save diff JSON"),
      failOnDiff: z.boolean().optional().describe("Whether to fail when diff is detected (default true)"),
      maxDiffs: z.number().optional().describe("Maximum diffs to include in response")
    }),
    type: "assertion"
  },
  handle: async (tab, params, response) => {
    const props = resolveProperties(params);
    const targets = [];
    for (const target of params.targets)
      targets.push({ ref: target.ref, element: target.element, ...(await collectForTarget(tab, target, props, params.includeLayout === true, params.includeText === true)) });
    const snapshot = {
      createdAt: new Date().toISOString(),
      url: tab.page.url(),
      properties: props,
      targets
    };
    const baselinePath = resolveMaybeRelative(tab.context, params.baselinePath);
    const baselineRaw = await fs.promises.readFile(baselinePath, "utf8");
    const baseline = JSON.parse(baselineRaw);
    const diffs = diffStyleSnapshots(baseline, snapshot);
    if (!diffs.length) {
      response.addResult("Style snapshot matches baseline.");
      return;
    }
    if (params.diffPath) {
      const diffFile = await response.addFile(params.diffPath, { origin: "llm", reason: "Style snapshot diff" });
      await fs.promises.writeFile(diffFile, JSON.stringify(diffs, null, 2), "utf8");
    }
    const maxDiffs = params.maxDiffs || 20;
    const excerpt = diffs.slice(0, maxDiffs).map((d) => JSON.stringify(d)).join("\n");
    const message = `Style snapshot differs from baseline (${diffs.length} changes).\n${excerpt}`;
    if (params.failOnDiff !== false)
      response.addError(message);
    else
      response.addResult(message);
  }
});

const layoutSnapshot = defineTabTool({
  capability: "styles",
  schema: {
    name: "browser_layout_snapshot",
    title: "Layout snapshot",
    description: "Capture layout metrics for specific elements",
    inputSchema: z.object({
      targets: z.array(targetSchema).describe("Elements to capture layout for"),
      includeText: z.boolean().optional().describe("Include truncated text content"),
      filename: z.string().optional().describe("File name to save snapshot to")
    }),
    type: "readOnly"
  },
  handle: async (tab, params, response) => {
    const targets = [];
    for (const target of params.targets) {
      const { locator } = await tab.refLocator({ ref: target.ref, element: target.element });
      const payload = await locator.evaluate((el, options) => {
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          id: el.id || null,
          className: typeof el.className === "string" ? el.className : null,
          text: options.includeText ? (el.textContent || "").trim().slice(0, 200) : null,
          layout: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
            scrollWidth: el.scrollWidth,
            scrollHeight: el.scrollHeight,
            clientWidth: el.clientWidth,
            clientHeight: el.clientHeight
          }
        };
      }, { includeText: params.includeText === true });
      targets.push({ ref: target.ref, element: target.element, ...payload });
    }
    const snapshot = {
      createdAt: new Date().toISOString(),
      url: tab.page.url(),
      targets
    };
    const payload = JSON.stringify(snapshot, null, 2);
    if (params.filename) {
      const fileName = await response.addFile(params.filename, { origin: "llm", reason: "Layout snapshot" });
      await fs.promises.writeFile(fileName, payload, "utf8");
      response.addResult(`Saved layout snapshot to ${fileName}`);
    } else {
      response.addResult(payload);
    }
  }
});

const layoutDiff = defineTabTool({
  capability: "styles",
  schema: {
    name: "browser_layout_diff",
    title: "Layout snapshot diff",
    description: "Compare layout snapshot against baseline",
    inputSchema: z.object({
      baselinePath: z.string().describe("Path to baseline layout snapshot JSON"),
      targets: z.array(targetSchema).describe("Elements to capture layout for"),
      includeText: z.boolean().optional().describe("Include truncated text content"),
      diffPath: z.string().optional().describe("File path to save diff JSON"),
      failOnDiff: z.boolean().optional().describe("Whether to fail when diff is detected (default true)"),
      maxDiffs: z.number().optional().describe("Maximum diffs to include in response")
    }),
    type: "assertion"
  },
  handle: async (tab, params, response) => {
    const targets = [];
    for (const target of params.targets) {
      const { locator } = await tab.refLocator({ ref: target.ref, element: target.element });
      const payload = await locator.evaluate((el, options) => {
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          id: el.id || null,
          className: typeof el.className === "string" ? el.className : null,
          text: options.includeText ? (el.textContent || "").trim().slice(0, 200) : null,
          layout: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
            scrollWidth: el.scrollWidth,
            scrollHeight: el.scrollHeight,
            clientWidth: el.clientWidth,
            clientHeight: el.clientHeight
          }
        };
      }, { includeText: params.includeText === true });
      targets.push({ ref: target.ref, element: target.element, ...payload });
    }
    const snapshot = {
      createdAt: new Date().toISOString(),
      url: tab.page.url(),
      targets
    };
    const baselinePath = resolveMaybeRelative(tab.context, params.baselinePath);
    const baselineRaw = await fs.promises.readFile(baselinePath, "utf8");
    const baseline = JSON.parse(baselineRaw);
    const diffs = diffLayoutSnapshots(baseline, snapshot);
    if (!diffs.length) {
      response.addResult("Layout snapshot matches baseline.");
      return;
    }
    if (params.diffPath) {
      const diffFile = await response.addFile(params.diffPath, { origin: "llm", reason: "Layout snapshot diff" });
      await fs.promises.writeFile(diffFile, JSON.stringify(diffs, null, 2), "utf8");
    }
    const maxDiffs = params.maxDiffs || 20;
    const excerpt = diffs.slice(0, maxDiffs).map((d) => JSON.stringify(d)).join("\n");
    const message = `Layout snapshot differs from baseline (${diffs.length} changes).\n${excerpt}`;
    if (params.failOnDiff !== false)
      response.addError(message);
    else
      response.addResult(message);
  }
});

module.exports = [styleSnapshot, styleDiff, layoutSnapshot, layoutDiff];
