function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInline(value) {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, '<strong style="color:#176f45;font-weight:700;">$1</strong>')
    .replace(/__([^_]+)__/g, '<strong style="color:#176f45;font-weight:700;">$1</strong>')
    .replace(/`([^`]+)`/g, '<span style="padding:2px 5px;border-radius:4px;color:#286548;background:#e5f3e9;">$1</span>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<span style="color:#27835a;text-decoration:underline;">$1</span>');
}

function markdownToRichText(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const output = ['<div style="color:#4f6658;font-size:15px;line-height:1.78;word-break:break-word;">'];
  let paragraph = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    output.push(`<p style="margin:0 0 12px;">${renderInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  }

  lines.forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      return;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      const size = heading[1].length === 1 ? 20 : (heading[1].length === 2 ? 18 : 16);
      const marginTop = heading[1].length === 1 ? 2 : 15;
      output.push(`<div style="margin:${marginTop}px 0 8px;color:#234c35;font-size:${size}px;line-height:1.45;font-weight:700;">${renderInline(heading[2])}</div>`);
      return;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flushParagraph();
      output.push('<div style="height:1px;margin:14px 0;background:#dce9e0;"></div>');
      return;
    }
    const unordered = /^[-*+]\s+(.+)$/.exec(line);
    if (unordered) {
      flushParagraph();
      output.push(`<div style="margin:0 0 8px;padding-left:16px;"><span style="color:#35a76b;font-weight:700;">•</span><span style="margin-left:8px;">${renderInline(unordered[1])}</span></div>`);
      return;
    }
    const ordered = /^(\d+)[.)]\s+(.+)$/.exec(line);
    if (ordered) {
      flushParagraph();
      output.push(`<div style="margin:0 0 8px;padding-left:8px;"><span style="color:#27835a;font-weight:700;">${ordered[1]}.</span><span style="margin-left:8px;">${renderInline(ordered[2])}</span></div>`);
      return;
    }
    const quote = /^>\s?(.+)$/.exec(line);
    if (quote) {
      flushParagraph();
      output.push(`<div style="margin:10px 0;padding:9px 12px;border-left:3px solid #4fc184;color:#557164;background:#edf8f1;">${renderInline(quote[1])}</div>`);
      return;
    }
    paragraph.push(line);
  });
  flushParagraph();
  output.push('</div>');
  return output.join('');
}

function markdownToPlainText(markdown) {
  return String(markdown || '')
    .replace(/\r\n?/g, '\n')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*(\d+)[.)]\s+/gm, '$1. ')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { markdownToRichText, markdownToPlainText };
