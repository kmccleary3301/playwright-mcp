"use strict";

const { z } = require("playwright-core/lib/mcpBundle");
const { defineTabTool } = require("./tool");

const collectLongTasks = defineTabTool({
  capability: "perf",
  schema: {
    name: "browser_collect_longtasks",
    title: "Collect long tasks",
    description: "Collect long task entries over a duration (in ms)",
    inputSchema: z.object({
      durationMs: z.number().optional().describe("Duration to observe long tasks, in ms (default 1000)")
    }),
    type: "readOnly"
  },
  handle: async (tab, params, response) => {
    const duration = params.durationMs || 1000;
    const entries = await tab.page.evaluate(async (durationMs) => {
      if (typeof PerformanceObserver === "undefined")
        return { supported: false, entries: [] };
      const collected = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          collected.push({
            startTime: entry.startTime,
            duration: entry.duration,
            name: entry.name,
            attribution: entry.attribution || []
          });
      });
      try {
        observer.observe({ entryTypes: ["longtask"] });
      } catch (e) {
        return { supported: false, entries: [] };
      }
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      observer.disconnect();
      return { supported: true, entries: collected };
    }, duration);

    if (!entries.supported) {
      response.addResult("Long task API not supported in this context.");
      return;
    }

    let totalBlockingTime = 0;
    let maxDuration = 0;
    for (const entry of entries.entries) {
      if (entry.duration > maxDuration)
        maxDuration = entry.duration;
      if (entry.duration > 50)
        totalBlockingTime += entry.duration - 50;
    }

    response.addResult(
      JSON.stringify({
        durationMs: duration,
        count: entries.entries.length,
        totalBlockingTimeMs: Number(totalBlockingTime.toFixed(2)),
        maxDurationMs: Number(maxDuration.toFixed(2)),
        entries: entries.entries
      }, null, 2)
    );
  }
});

module.exports = [collectLongTasks];
