"use strict";

const fs = require("fs");
const path = require("path");
const { z } = require("playwright-core/lib/mcpBundle");
const { defineTabTool } = require("./tool");
const { dateAsFileName } = require("./utils");

function parseKeyValue(line) {
  const match = line.match(/^\s*-\s*([^:]+):\s*(.*)$/);
  if (!match)
    return null;
  return { key: match[1].trim(), value: match[2].trim() };
}

function stripQuotes(value) {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))
    return value.slice(1, -1);
  return value;
}

function parseArgs(text) {
  const args = {};
  const regex = /(\w+)=("[^"]*"|'[^']*'|\S+)/g;
  let match;
  while ((match = regex.exec(text))) {
    args[match[1]] = stripQuotes(match[2]);
  }
  return args;
}

function parseSteps(markdown) {
  const lines = markdown.split(/\r?\n/);
  let section = "";
  const setup = {};
  const steps = [];
  for (const line of lines) {
    if (line.trim().startsWith("## ")) {
      section = line.trim().slice(3).toLowerCase();
      continue;
    }
    if (section === "setup") {
      const kv = parseKeyValue(line);
      if (kv)
        setup[kv.key] = kv.value;
      continue;
    }
    if (section === "steps") {
      const stepMatch = line.match(/^\s*(?:\d+\.|-)\s+(.*)$/);
      if (stepMatch)
        steps.push(stepMatch[1].trim());
    }
  }
  return { setup, steps };
}

function parseScenarioFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  return parseSteps(content);
}

function resolveLocator(tab, args) {
  if (args.ref && args.element)
    return tab.refLocator({ ref: args.ref, element: args.element }).then(({ locator }) => locator);
  if (args.role)
    return Promise.resolve(tab.page.getByRole(args.role, { name: args.name || args.accessibleName }));
  if (args.text)
    return Promise.resolve(tab.page.getByText(args.text));
  throw new Error("Unable to resolve locator (requires role/name, text, or ref/element)");
}

async function runStep(tab, step, setup, artifacts, mode, response) {
  const [commandRaw, ...rest] = step.split(/\s+/);
  const command = commandRaw.toLowerCase();
  const restText = rest.join(" ");

  if (command === "goto") {
    const target = stripQuotes(restText);
    const url = setup.baseUrl && target.startsWith("/") ? setup.baseUrl.replace(/\/$/, "") + target : target;
    await tab.navigate(url);
    return { action: "goto", detail: url };
  }

  if (command === "wait") {
    const waitArgs = parseArgs(restText);
    const ms = waitArgs.ms ? Number(waitArgs.ms) : Number(stripQuotes(restText));
    if (!Number.isFinite(ms))
      throw new Error(`Invalid wait duration: ${restText}`);
    await tab.page.waitForTimeout(ms);
    return { action: "wait", detail: ms };
  }

  if (command === "click") {
    const args = parseArgs(restText);
    const locator = await resolveLocator(tab, args);
    await tab.waitForCompletion(async () => {
      await locator.click();
    });
    return { action: "click", detail: args.role || args.text || args.element || "element" };
  }

  if (command === "fill") {
    const args = parseArgs(restText);
    const locator = await resolveLocator(tab, args);
    if (!args.value)
      throw new Error("fill requires value=...");
    await tab.waitForCompletion(async () => {
      await locator.fill(args.value);
    });
    return { action: "fill", detail: args.role || args.text || args.element || "element" };
  }

  if (command === "select") {
    const args = parseArgs(restText);
    const locator = await resolveLocator(tab, args);
    if (!args.value)
      throw new Error("select requires value=...");
    await tab.waitForCompletion(async () => {
      await locator.selectOption(args.value);
    });
    return { action: "select", detail: args.value };
  }

  if (command === "expect") {
    const args = parseArgs(restText);
    const locator = await resolveLocator(tab, args);
    const count = await locator.count();
    if (!count)
      throw new Error("Expected element not found");
    const visible = await locator.first().isVisible();
    if (!visible)
      throw new Error("Expected element not visible");
    return { action: "expect", detail: args.role || args.text || args.element || "element" };
  }

  if (command === "snapshot") {
    const labelMatch = restText.match(/"([^"]+)"|'([^']+)'/);
    const label = labelMatch ? (labelMatch[1] || labelMatch[2]) : "snapshot";
    const snapshot = await tab.page._snapshotForAI({ track: "response" });
    const fileName = await response.addFile(`${label.replace(/\s+/g, "-")}-${dateAsFileName("yaml")}`, { origin: "llm", reason: `ARIA snapshot: ${label}` });
    fs.writeFileSync(fileName, snapshot.full, "utf8");
    artifacts.files.push({ title: `ARIA snapshot: ${label}`, path: fileName });
    return { action: "snapshot", detail: label };
  }

  throw new Error(`Unknown command: ${command}`);
}

const runScenario = defineTabTool({
  capability: "scenarios",
  schema: {
    name: "browser_run_scenario",
    title: "Run scenario",
    description: "Run a Markdown scenario file with deterministic steps",
    inputSchema: z.object({
      file: z.string().describe("Path to scenario markdown file"),
      mode: z.enum(["spec", "debug"]).optional().describe("Execution mode (spec or debug)"),
      baseUrl: z.string().optional().describe("Base URL override")
    }),
    type: "action"
  },
  handle: async (tab, params, response) => {
    const filePath = path.isAbsolute(params.file) ? params.file : path.resolve(process.cwd(), params.file);
    if (!fs.existsSync(filePath))
      throw new Error(`Scenario file not found: ${filePath}`);

    const { setup, steps } = parseScenarioFile(filePath);
    if (params.baseUrl)
      setup.baseUrl = params.baseUrl;

    const artifacts = {
      files: [],
      outputFile: (name) => name
    };

    const summary = {
      file: filePath,
      status: "passed",
      steps: [],
      failedStep: null,
      error: null,
      artifacts: []
    };

    artifacts.outputFile = (name) => {
      const safeName = name.replace(/[^a-zA-Z0-9_.-]/g, "-");
      return path.resolve(tab.context.config.outputDir || process.cwd(), safeName);
    };

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      try {
        const result = await runStep(tab, step, setup, artifacts, params.mode || "spec", response);
        summary.steps.push({ index: i + 1, step, result });
      } catch (error) {
        summary.status = "failed";
        summary.failedStep = { index: i + 1, step };
        summary.error = error instanceof Error ? error.message : String(error);
        const screenshotPath = await response.addFile(`scenario-failure-${dateAsFileName("png")}`, { origin: "llm", reason: "Scenario failure screenshot" });
        const ariaPath = await response.addFile(`scenario-failure-${dateAsFileName("yaml")}`, { origin: "llm", reason: "Scenario failure ARIA snapshot" });
        const buffer = await tab.page.screenshot({ type: "png", fullPage: true });
        fs.writeFileSync(screenshotPath, buffer);
        const snapshot = await tab.page._snapshotForAI({ track: "response" });
        fs.writeFileSync(ariaPath, snapshot.full, "utf8");
        summary.artifacts.push({ type: "screenshot", path: screenshotPath });
        summary.artifacts.push({ type: "aria", path: ariaPath });
        break;
      }
    }

    for (const file of artifacts.files)
      summary.artifacts.push({ type: "file", title: file.title, path: file.path });

    const summaryPath = await response.addFile(`scenario-summary-${dateAsFileName("json")}`, { origin: "llm", reason: "Scenario summary" });
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");

    if (summary.status === "passed") {
      response.addResult(`Scenario passed. Summary: ${summaryPath}`);
    } else {
      response.addError(`Scenario failed at step ${summary.failedStep.index}: ${summary.failedStep.step}. Summary: ${summaryPath}`);
    }
  }
});

module.exports = [runScenario];
