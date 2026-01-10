/* eslint-disable no-console */
'use strict';

/**
 * Playwright MCP extension: add `browser_markdown` tool.
 *
 * This is loaded via NODE_OPTIONS=--require so it must:
 * - avoid throwing at top-level (or it will break server startup)
 * - be defensive about optional dependencies
 */

(function registerPlaywrightMarkdownTool() {
  try {
    const toolsModule = require('playwright/lib/mcp/browser/tools');
    const { z } = require('playwright-core/lib/mcpBundle');
    const fs = require('fs');

    const TOOL_NAME = 'browser_markdown';

    const alreadyRegistered = Array.isArray(toolsModule.browserTools) &&
      toolsModule.browserTools.some((t) => t && t.schema && t.schema.name === TOOL_NAME);
    if (alreadyRegistered)
      return;

    async function convertHtmlToMarkdown({ html, url, title, onlyMainContent, maxChars }) {
      let JSDOM;
      let Readability;
      let TurndownService;
      let turndownPluginGfm;

      try {
        ({ JSDOM } = require('jsdom'));
        ({ Readability } = require('@mozilla/readability'));
        TurndownService = require('turndown');
        turndownPluginGfm = require('turndown-plugin-gfm');
      } catch (e) {
        // Hard fallback: return a very rough text extraction.
        const text = String(html || '')
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (maxChars > 0 && text.length > maxChars)
          return text.slice(0, maxChars) + '\n\n…(truncated)';
        return text;
      }

      const dom = new JSDOM(html, { url: url || undefined });
      const document = dom.window.document;

      // Strip common non-content tags early to reduce noise in output.
      for (const el of Array.from(document.querySelectorAll('script,style,noscript'))) {
        try {
          el.remove();
        } catch {
          // ignore
        }
      }

      // Absolutize links/images so Markdown is self-contained outside the browser.
      const base = url || document.baseURI || undefined;
      if (base) {
        for (const a of Array.from(document.querySelectorAll('a[href]'))) {
          const href = a.getAttribute('href');
          if (!href)
            continue;
          try {
            a.setAttribute('href', new URL(href, base).toString());
          } catch {
            // ignore
          }
        }
        for (const img of Array.from(document.querySelectorAll('img[src]'))) {
          const src = img.getAttribute('src');
          if (!src || src.startsWith('data:image'))
            continue;
          try {
            img.setAttribute('src', new URL(src, base).toString());
          } catch {
            // ignore
          }
        }
      }

      let contentHtml = '';
      let extractedTitle = '';

      if (onlyMainContent) {
        try {
          const reader = new Readability(document);
          const article = reader.parse();
          if (article && typeof article.content === 'string') {
            contentHtml = article.content;
            extractedTitle = typeof article.title === 'string' ? article.title : '';
          }
        } catch {
          // ignore and fall back
        }
      }

      if (!contentHtml) {
        const body = document.querySelector('body');
        contentHtml = body ? body.innerHTML : document.documentElement.outerHTML;
      }

      const turndown = new TurndownService({
        headingStyle: 'atx',
        bulletListMarker: '-',
        codeBlockStyle: 'fenced',
        emDelimiter: '*',
        strongDelimiter: '**',
      });

      // Optional GFM extras (tables/strikethrough/taskList).
      if (turndownPluginGfm) {
        if (typeof turndownPluginGfm.gfm === 'function')
          turndown.use(turndownPluginGfm.gfm);
        else if (typeof turndownPluginGfm === 'function')
          turndown.use(turndownPluginGfm);
      }

      // Preserve links that wrap a single image: `[![alt](src)](href)`.
      turndown.addRule('linkWithImage', {
        filter: (node) => {
          if (!node || node.nodeName !== 'A')
            return false;
          const href = node.getAttribute && node.getAttribute('href');
          if (!href)
            return false;
          const imgs = node.querySelectorAll ? node.querySelectorAll('img') : [];
          if (!imgs || imgs.length !== 1)
            return false;
          // If there's meaningful text as well, let the default link rule handle it.
          const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
          return text.length === 0;
        },
        replacement: (content, node) => {
          const href = node.getAttribute('href');
          const img = node.querySelector('img');
          const src = img && img.getAttribute ? img.getAttribute('src') : '';
          const alt = img && img.getAttribute ? (img.getAttribute('alt') || '').trim() : '';
          if (!href || !src)
            return '';
          const imgMd = `![${alt} ](${src})`.replace(' ]', alt ? ']' : ']');
          return `[${imgMd}](${href})`;
        },
      });

      let markdown = turndown.turndown(contentHtml);

      markdown = String(markdown || '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      const finalTitle = extractedTitle || title || '';
      if (finalTitle && !markdown.startsWith('# ')) {
        markdown = `# ${finalTitle}\n\n${markdown}`.trim();
      }

      if (maxChars > 0 && markdown.length > maxChars)
        markdown = markdown.slice(0, maxChars) + '\n\n…(truncated)';

      return markdown;
    }

    const markdownTool = {
      capability: 'core',
      schema: {
        name: TOOL_NAME,
        title: 'Page markdown',
        description: 'Convert the current page to Markdown from the live Playwright page state (useful after clicks/logins).',
        inputSchema: z.object({
          filename: z.string().optional().describe('Save markdown to a file (in the output dir) instead of returning it.'),
          onlyMainContent: z.boolean().optional().describe('Attempt to extract main content before converting (default: true).'),
          maxChars: z.number().int().positive().optional().describe('Truncate the returned markdown to this many characters.'),
        }),
        type: 'readOnly',
      },
      handle: async (context, params, response) => {
        const tab = await context.ensureTab();
        const page = tab.page;

        const onlyMainContent = params.onlyMainContent !== false;
        const maxChars = typeof params.maxChars === 'number' && params.maxChars > 0 ? Math.floor(params.maxChars) : 0;

        const url = page.url();
        let title = '';
        try {
          title = await page.title();
        } catch {
          // ignore
        }

        let html = '';
        try {
          html = await page.content();
        } catch (e) {
          response.addError(`Failed to read page HTML: ${String(e)}`);
          return;
        }

        let markdown;
        try {
          markdown = await convertHtmlToMarkdown({ html, url, title, onlyMainContent, maxChars });
        } catch (e) {
          response.addError(`Failed to convert HTML to markdown: ${String(e)}`);
          return;
        }

        if (params.filename) {
          const fileName = await response.addFile(params.filename, { origin: 'llm', reason: 'Saved markdown' });
          await fs.promises.writeFile(fileName, markdown, 'utf-8');
          response.setIncludeMetaOnly();
          return;
        }

        response.addResult(markdown);
      },
    };

    toolsModule.browserTools.push(markdownTool);
  } catch (e) {
    // Don't break Playwright MCP if the patch fails to load.
    console.error('[playwright-mcp-plus] Failed to register browser_markdown tool:', e && e.stack ? e.stack : String(e));
  }
})();
