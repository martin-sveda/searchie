import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import MarkdownIt from 'markdown-it';

/** Sanitizing markdown renderer (R7.24): raw HTML is never passed through; code is highlighted locally. */

const LANGUAGES = { bash, c, cpp, csharp, css, diff, go, java, javascript, json, markdown, powershell, python, rust, sql, typescript, xml, yaml };
for (const [name, lang] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, lang);
hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' });
hljs.registerAliases(['html', 'svg'], { languageName: 'xml' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['cs'], { languageName: 'csharp' });
hljs.registerAliases(['ps1', 'pwsh'], { languageName: 'powershell' });
hljs.registerAliases(['jsonc'], { languageName: 'json' });

const md = new MarkdownIt({
  html: false,
  linkify: false,
  breaks: false,
  highlight(code, lang): string {
    const language = lang.trim().toLowerCase();
    if (!language || !hljs.getLanguage(language)) return '';
    try {
      // hljs escapes the code itself; markdown-it escapes when '' is returned.
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    } catch {
      return '';
    }
  },
});
md.disable('image');
/** Only http(s), file and in-page links become anchors; anything else (javascript:, data:, vscode: …) stays text. */
md.validateLink = (url: string): boolean => /^(https?:|file:|#)/i.test(url.trim());

export function renderMarkdown(text: string): string {
  return md.render(text);
}
