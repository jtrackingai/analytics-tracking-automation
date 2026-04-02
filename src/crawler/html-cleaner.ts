import { Page } from 'playwright';

export const HTML_MAX_LENGTH = 8000;

/**
 * Runs entirely in the browser context. Clones the DOM, strips noise,
 * cleans attributes/classes, deduplicates siblings, truncates text,
 * and returns a compact HTML string suitable for LLM selector analysis.
 */
export async function extractCleanedHtml(page: Page, maxLength: number = HTML_MAX_LENGTH): Promise<string> {
  return page.evaluate((maxLen: number) => {
    const clone = document.body.cloneNode(true) as HTMLElement;

    // ── Layer 1: Remove noise tags ───────────────────────────────────────

    ['script', 'style', 'meta', 'link', 'template', 'noscript'].forEach(tag => {
      clone.querySelectorAll(tag).forEach(el => el.remove());
    });

    const cw = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
    const cmts: Node[] = [];
    while (cw.nextNode()) cmts.push(cw.currentNode);
    cmts.forEach(c => c.parentNode?.removeChild(c));

    clone.querySelectorAll('svg, picture').forEach(el => { el.innerHTML = ''; });
    clone.querySelectorAll('br').forEach(el => el.replaceWith(' '));

    // ── Layer 2: Attribute stripping + class/id cleaning ─────────────────

    const keepAttrs = new Set([
      'class', 'id', 'type', 'name', 'href', 'role', 'aria-label', 'alt',
      'value', 'data-testid', 'data-tracking', 'action', 'method',
      'placeholder', 'for', 'src',
    ]);

    const frameworkRe = [
      /:/,
      /^[a-z]{1,3}[A-Za-z0-9_-]{8,}$/,
      /^\d+$/,
      /^[a-z]$/,
      /^(active|hidden|visible|disabled|selected|open|closed|show|hide|fade|in|out|collapsed|expanded)/,
      /^(w|h|p|m|px|py|mx|my|pt|pb|pl|pr|mt|mb|ml|mr|gap|flex|grid|col|row|text|bg|border|rounded|shadow|font|leading|tracking|opacity|z|top|left|right|bottom|absolute|relative|fixed|sticky|block|inline|overflow)-/,
    ];

    clone.querySelectorAll('*').forEach(el => {
      const rm: string[] = [];
      for (const a of Array.from(el.attributes)) {
        if (!keepAttrs.has(a.name) && !a.name.startsWith('data-test')) rm.push(a.name);
      }
      rm.forEach(a => el.removeAttribute(a));

      if (el.classList.length > 0) {
        const kept = Array.from(el.classList)
          .filter(c => !frameworkRe.some(r => r.test(c)))
          .slice(0, 3);
        if (kept.length === 0) el.removeAttribute('class');
        else el.setAttribute('class', kept.join(' '));
      }

      const id = el.getAttribute('id');
      if (id && (id.length > 40 || /^[a-z]{1,3}[A-Za-z0-9_-]{8,}$/.test(id) || id.startsWith('-'))) {
        el.removeAttribute('id');
      }

      if (el.tagName === 'A') {
        const href = el.getAttribute('href');
        if (href) {
          try {
            const u = new URL(href, window.location.origin);
            if (u.hostname === window.location.hostname) {
              el.setAttribute('href', u.pathname);
            } else {
              el.setAttribute('href', u.origin + u.pathname);
            }
          } catch { /* keep original */ }
        }
      }
    });

    // ── Layer 3: Truncate text + remove empty nodes ──────────────────────

    const tw = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    while (tw.nextNode()) texts.push(tw.currentNode as Text);
    for (const n of texts) {
      const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
      n.textContent = t.length > 60 ? t.substring(0, 50) + '…' : t;
    }

    (function pruneEmpty(el: Element) {
      for (const ch of Array.from(el.children)) pruneEmpty(ch);
      const selfClose = ['img', 'input', 'hr', 'video', 'source'].includes(el.tagName.toLowerCase());
      const hasText = (el.textContent || '').trim().length > 0;
      const meaningful = el.hasAttribute('id') || el.hasAttribute('role') ||
        el.hasAttribute('data-testid') || el.hasAttribute('aria-label');
      if (el.children.length === 0 && !hasText && !selfClose && !meaningful) el.remove();
    })(clone);

    // ── Layer 4: Sibling dedup (keep first 3 per structural group) ───────

    (function dedup(parent: Element) {
      const kids = Array.from(parent.children);
      if (kids.length > 3) {
        const groups = new Map<string, Element[]>();
        for (const ch of kids) {
          const key = `${ch.tagName}|${ch.getAttribute('class') || ''}`;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key)!.push(ch);
        }
        for (const [, g] of groups) {
          if (g.length > 3) {
            const keptHrefs = new Set(g.slice(0, 3).map(e =>
              (e.querySelector('a[href]') as HTMLAnchorElement)?.href?.[0] || ''));
            for (let i = 3; i < g.length; i++) {
              const linkChar = (g[i].querySelector('a[href]') as HTMLAnchorElement)?.href?.[0];
              if (linkChar && !keptHrefs.has(linkChar)) {
                g[2].remove();
                keptHrefs.add(linkChar);
              } else {
                g[i].remove();
              }
            }
          }
        }
      }
      for (const ch of Array.from(parent.children)) dedup(ch);
    })(clone);

    // ── Serialize + minify ───────────────────────────────────────────────

    let html = clone.innerHTML.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();
    if (html.length > maxLen) html = html.substring(0, maxLen) + '<!-- truncated -->';
    return html;
  }, maxLength);
}
