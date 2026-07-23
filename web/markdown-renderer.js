(function exposeSpineGuardMarkdown(global) {
  const inlineToken = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_)/g;

  function appendInline(parent, value) {
    const text = String(value || "");
    let cursor = 0;
    let match;

    while ((match = inlineToken.exec(text))) {
      if (match.index > cursor) parent.append(document.createTextNode(text.slice(cursor, match.index)));
      const token = match[0];
      let element;
      let content;

      if (token.startsWith("**") || token.startsWith("__")) {
        element = document.createElement("strong");
        content = token.slice(2, -2);
      } else if (token.startsWith("~~")) {
        element = document.createElement("del");
        content = token.slice(2, -2);
      } else if (token.startsWith("`")) {
        element = document.createElement("code");
        content = token.slice(1, -1);
      } else {
        element = document.createElement("em");
        content = token.slice(1, -1);
      }

      element.textContent = content;
      parent.append(element);
      cursor = match.index + token.length;
    }

    if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
    inlineToken.lastIndex = 0;
  }

  function isBlockStart(line) {
    return /^(#{1,6})\s+/.test(line)
      || /^\s*([-+*]|\d+\.)\s+/.test(line)
      || /^\s*>\s?/.test(line)
      || /^\s*(```|~~~)/.test(line)
      || /^\s*((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})\s*$/.test(line);
  }

  function appendList(fragment, lines, start) {
    const first = lines[start].match(/^(\s*)([-+*]|\d+\.)\s+(.+)$/);
    const ordered = /\d+\./.test(first[2]);
    const list = document.createElement(ordered ? "ol" : "ul");
    let index = start;

    while (index < lines.length) {
      const match = lines[index].match(/^(\s*)([-+*]|\d+\.)\s+(.+)$/);
      if (!match || /\d+\./.test(match[2]) !== ordered) break;
      const item = document.createElement("li");
      appendInline(item, match[3]);
      if (match[1].length > 0) item.classList.add("nested-item");
      list.append(item);
      index += 1;
    }

    fragment.append(list);
    return index;
  }

  function renderInto(container, markdown) {
    if (!container) return;
    const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
    const fragment = document.createDocumentFragment();
    let index = 0;

    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        index += 1;
        continue;
      }

      const fence = line.match(/^\s*(```|~~~)(.*)$/);
      if (fence) {
        const marker = fence[1];
        const codeLines = [];
        index += 1;
        while (index < lines.length && !lines[index].trim().startsWith(marker)) {
          codeLines.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = codeLines.join("\n");
        pre.append(code);
        fragment.append(pre);
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        const level = Math.min(4, heading[1].length + 1);
        const element = document.createElement(`h${level}`);
        appendInline(element, heading[2]);
        fragment.append(element);
        index += 1;
        continue;
      }

      if (/^\s*((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})\s*$/.test(line)) {
        fragment.append(document.createElement("hr"));
        index += 1;
        continue;
      }

      if (/^\s*([-+*]|\d+\.)\s+/.test(line)) {
        index = appendList(fragment, lines, index);
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        const quote = document.createElement("blockquote");
        while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
          const row = document.createElement("p");
          appendInline(row, lines[index].replace(/^\s*>\s?/, ""));
          quote.append(row);
          index += 1;
        }
        fragment.append(quote);
        continue;
      }

      const paragraph = document.createElement("p");
      let hasLine = false;
      while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
        if (hasLine) paragraph.append(document.createElement("br"));
        appendInline(paragraph, lines[index]);
        hasLine = true;
        index += 1;
      }
      if (hasLine) fragment.append(paragraph);
      else index += 1;
    }

    container.replaceChildren(fragment);
  }

  global.SpineGuardMarkdown = { renderInto };
})(window);
