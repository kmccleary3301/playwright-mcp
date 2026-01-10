"use strict";

const fs = require("fs");
const path = require("path");
const { PNG } = require("playwright-core/lib/utilsBundle");
const { compare } = require("playwright-core/lib/server/utils/image_tools/compare");
const { z } = require("playwright-core/lib/mcpBundle");
const { outputDir: outputDirForClient } = require("../config");
const { defineTabTool } = require("./tool");
const { dateAsFileName } = require("./utils");

function resolveMaybeRelative(context, inputPath) {
  if (path.isAbsolute(inputPath))
    return inputPath;
  const cwdPath = path.resolve(process.cwd(), inputPath);
  if (fs.existsSync(cwdPath))
    return cwdPath;
  const outDir = outputDirForClient(context.config, context.options.clientInfo);
  return path.resolve(outDir, inputPath);
}

async function withTemporaryStyle(page, css, callback) {
  const tag = await page.addStyleTag({ content: css });
  try {
    return await callback();
  } finally {
    await tag.evaluate((node) => node.remove()).catch(() => {});
  }
}

const screenshotDiff = defineTabTool({
  capability: "diffs",
  schema: {
    name: "browser_screenshot_diff",
    title: "Screenshot diff",
    description: "Compare a screenshot against a baseline image",
    inputSchema: z.object({
      baselinePath: z.string().describe("Path to baseline PNG image"),
      element: z.string().optional().describe("Human-readable element description"),
      ref: z.string().optional().describe("Exact target element reference"),
      fullPage: z.boolean().optional().describe("Capture full page screenshot (ignored for element screenshots)"),
      threshold: z.number().optional().describe("Max color delta threshold (default 1.0)"),
      diffPath: z.string().optional().describe("File path to save diff image"),
      currentPath: z.string().optional().describe("File path to save current screenshot"),
      highlight: z.boolean().optional().describe("Highlight target element before screenshot"),
      disableAnimations: z.boolean().optional().describe("Disable CSS animations/transitions before screenshot"),
      failOnDiff: z.boolean().optional().describe("Whether to fail when diff is detected (default true)")
    }),
    type: "assertion"
  },
  handle: async (tab, params, response) => {
    if (!!params.element !== !!params.ref)
      throw new Error("Both element and ref must be provided or neither.");
    const baselinePath = resolveMaybeRelative(tab.context, params.baselinePath);
    const baselineBuffer = fs.readFileSync(baselinePath);
    const expected = PNG.sync.read(baselineBuffer);

    const fileType = "png";
    const options = {
      type: fileType,
      fullPage: params.fullPage === true && !params.ref
    };

    const capture = async () => {
      if (params.ref) {
        const { locator } = await tab.refLocator({ ref: params.ref, element: params.element || "" });
        return await locator.screenshot(options);
      }
      return await tab.page.screenshot(options);
    };

    const highlightCSS = "[data-mcp-highlight=\"true\"]{outline:2px solid #ff3b30 !important;outline-offset:2px !important;}";
    let buffer;
    if (params.disableAnimations) {
      buffer = await withTemporaryStyle(tab.page, "*{animation:none !important;transition:none !important;}", async () => {
        if (params.highlight && params.ref) {
          const { locator } = await tab.refLocator({ ref: params.ref, element: params.element || "" });
          await locator.evaluate((el) => el.setAttribute("data-mcp-highlight", "true"));
          return await withTemporaryStyle(tab.page, highlightCSS, async () => {
            const image = await capture();
            await locator.evaluate((el) => el.removeAttribute("data-mcp-highlight"));
            return image;
          });
        }
        return await capture();
      });
    } else if (params.highlight && params.ref) {
      const { locator } = await tab.refLocator({ ref: params.ref, element: params.element || "" });
      buffer = await withTemporaryStyle(tab.page, highlightCSS, async () => {
        await locator.evaluate((el) => el.setAttribute("data-mcp-highlight", "true"));
        const image = await capture();
        await locator.evaluate((el) => el.removeAttribute("data-mcp-highlight"));
        return image;
      });
    } else {
      buffer = await capture();
    }

    const actual = PNG.sync.read(buffer);
    if (expected.width !== actual.width || expected.height !== actual.height) {
      const message = `Screenshot size mismatch. Expected ${expected.width}x${expected.height}, got ${actual.width}x${actual.height}.`;
      if (params.currentPath) {
        const currentFile = await response.addFile(params.currentPath, { origin: "llm", reason: "Current screenshot" });
        fs.writeFileSync(currentFile, buffer);
      }
      response.addError(message);
      return;
    }

    const diffImage = new PNG({ width: expected.width, height: expected.height });
    const diffPixels = compare(actual.data, expected.data, diffImage.data, expected.width, expected.height, {
      maxColorDeltaE94: params.threshold ?? 1.0
    });
    const totalPixels = expected.width * expected.height;
    const diffPercent = (diffPixels / totalPixels) * 100;

    if (params.currentPath) {
      const currentFile = await response.addFile(params.currentPath, { origin: "llm", reason: "Current screenshot" });
      fs.writeFileSync(currentFile, buffer);
    }

    if (diffPixels === 0) {
      response.addResult("Screenshot matches baseline.");
      return;
    }

    if (params.diffPath) {
      const diffFile = await response.addFile(params.diffPath, { origin: "llm", reason: "Screenshot diff" });
      fs.writeFileSync(diffFile, PNG.sync.write(diffImage));
    }

    const message = `Screenshot differs from baseline: ${diffPixels} pixels (${diffPercent.toFixed(2)}%).`;
    if (params.failOnDiff !== false)
      response.addError(message);
    else
      response.addResult(message);
  }
});

module.exports = [screenshotDiff];
