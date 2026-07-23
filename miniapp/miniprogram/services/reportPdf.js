const PAGE_WIDTH = 1120;
const PAGE_HEIGHT = 1584;
const CONTENT_LEFT = 82;
const CONTENT_RIGHT = PAGE_WIDTH - 82;
const CONTENT_TOP = 210;
const CONTENT_BOTTOM = PAGE_HEIGHT - 92;

const STYLE = {
  section: { font: 'bold 34px sans-serif', color: '#234c35', lineHeight: 52, gap: 24 },
  subheading: { font: 'bold 29px sans-serif', color: '#28764d', lineHeight: 46, gap: 16 },
  accent: { font: 'bold 29px sans-serif', color: '#178653', lineHeight: 45, gap: 10 },
  body: { font: '27px sans-serif', color: '#4f6357', lineHeight: 43, gap: 7 },
  small: { font: '23px sans-serif', color: '#7c8c83', lineHeight: 37, gap: 6 }
};

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function canvasNode(page) {
  return new Promise((resolve, reject) => {
    wx.createSelectorQuery().in(page).select('#reportExportCanvas').fields({ node: true, size: true }).exec((result) => {
      const item = result && result[0];
      if (!item || !item.node) reject(new Error('PDF 导出画布初始化失败'));
      else resolve(item.node);
    });
  });
}

function canvasToJpeg(canvas, page) {
  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({
      canvas,
      fileType: 'jpg',
      quality: 0.92,
      destWidth: PAGE_WIDTH,
      destHeight: PAGE_HEIGHT,
      success: (result) => resolve(result.tempFilePath),
      fail: (error) => reject(new Error(error.errMsg || '报告页面生成失败'))
    }, page);
  });
}

function readBinary(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      success: (result) => resolve(new Uint8Array(result.data)),
      fail: (error) => reject(new Error(error.errMsg || '报告页面读取失败'))
    });
  });
}

function writeBinary(filePath, bytes) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().writeFile({
      filePath,
      data: bytes.buffer,
      success: resolve,
      fail: (error) => reject(new Error(error.errMsg || 'PDF 文件写入失败'))
    });
  });
}

function safeText(value, fallback) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  return text || fallback || '暂无';
}

function markdownTokens(markdown) {
  const tokens = [];
  String(markdown || '').replace(/\r\n?/g, '\n').split('\n').forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line || /^(-{3,}|\*{3,}|_{3,})$/.test(line)) return;
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      tokens.push({ text: heading[2].replace(/\*\*/g, ''), style: heading[1].length <= 2 ? 'section' : 'subheading' });
      return;
    }
    const bullet = /^[-*+]\s+(.+)$/.exec(line);
    const ordered = /^(\d+)[.)]\s+(.+)$/.exec(line);
    const text = bullet ? `• ${bullet[1]}` : (ordered ? `${ordered[1]}. ${ordered[2]}` : line.replace(/^>\s?/, ''));
    tokens.push({ text: text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1'), style: bullet || ordered ? 'body' : 'body' });
  });
  return tokens;
}

function reportTokens(report) {
  const tokens = [
    { text: '报告概览', style: 'section' },
    { text: `${safeText(report.type, '坐姿报告')} · ${safeText(report.sourceText, '系统生成')} · ${safeText(report.generatedText, '规则生成')}`, style: 'small' },
    { text: `报告周期：${safeText(report.periodText)}    生成时间：${safeText(report.createdAtText)}`, style: 'body' },
    { text: `标准坐姿 ${safeText(report.normalPercent, '0')}%    有效坐姿 ${safeText(report.effectiveTimeText)}    提醒 ${safeText(report.reminderCount, '0')} 次`, style: 'accent' },
    { text: '姿态时长分布', style: 'section' }
  ];
  (report.postureBreakdown || []).forEach((item) => {
    tokens.push({ text: `${safeText(item.name)}：${safeText(item.durationText)}，占比 ${safeText(item.percent, '0')}%`, style: item.normal ? 'accent' : 'body' });
  });
  tokens.push(
    { text: '姿态变化趋势', style: 'section' },
    { text: `${safeText(report.trendLabel)}：${safeText(report.trendText)}`, style: 'body' },
    { text: `前半段非标准 ${safeText(report.firstHalfPercent)}    后半段 ${safeText(report.secondHalfPercent)}`, style: 'small' },
    { text: '数据说明', style: 'section' },
    { text: `分析记录：${safeText(report.recordCount, '0')} 条    压力不对称指数：${safeText(report.pai, '0.0000')}`, style: 'body' },
    { text: `非标准坐姿：${safeText(report.poorTimeText)}    最长连续异常：${safeText(report.longestAbnormalText)}`, style: 'body' },
    { text: `提醒高峰：${safeText(report.reminderPeakText)}    数据范围：${safeText(report.dataRangeText)}`, style: 'body' },
    { text: '坐姿行为分析与建议', style: 'section' }
  );
  markdownTokens(report.advice || report.advicePlain).forEach((item) => tokens.push(item));
  tokens.push({ text: '本报告仅用于坐姿行为风险提示和筛查参考，不作为医学诊断。', style: 'small' });
  return tokens;
}

function wrapText(context, text, maxWidth) {
  const lines = [];
  let current = '';
  String(text || '').split('').forEach((character) => {
    const candidate = current + character;
    if (current && context.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = character;
    } else current = candidate;
  });
  if (current || !lines.length) lines.push(current);
  return lines;
}

function paginate(context, tokens) {
  const pages = [[]];
  let y = CONTENT_TOP;
  tokens.forEach((token) => {
    const style = STYLE[token.style] || STYLE.body;
    context.font = style.font;
    const lines = wrapText(context, token.text, CONTENT_RIGHT - CONTENT_LEFT);
    if (y + style.gap + style.lineHeight > CONTENT_BOTTOM) {
      pages.push([]);
      y = CONTENT_TOP;
    } else y += style.gap;
    lines.forEach((line) => {
      if (y + style.lineHeight > CONTENT_BOTTOM) {
        pages.push([]);
        y = CONTENT_TOP;
      }
      pages[pages.length - 1].push({ text: line, y, style: token.style });
      y += style.lineHeight;
    });
  });
  return pages;
}

function paintPage(context, report, lines, pageNumber, pageCount) {
  context.clearRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
  context.fillStyle = '#f4f8f5';
  context.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
  const gradient = context.createLinearGradient(0, 0, PAGE_WIDTH, 0);
  gradient.addColorStop(0, '#145d43');
  gradient.addColorStop(1, '#2cab68');
  context.fillStyle = gradient;
  context.fillRect(0, 0, PAGE_WIDTH, 158);
  context.fillStyle = '#ffffff';
  context.font = 'bold 45px sans-serif';
  context.fillText('SpineGuard 坐姿健康报告', CONTENT_LEFT, 72);
  context.fillStyle = 'rgba(255,255,255,.78)';
  context.font = '24px sans-serif';
  context.fillText(`${safeText(report.type)} · ${safeText(report.periodText)}`, CONTENT_LEFT, 118);
  lines.forEach((line) => {
    const style = STYLE[line.style] || STYLE.body;
    context.font = style.font;
    context.fillStyle = style.color;
    context.fillText(line.text, CONTENT_LEFT, line.y);
  });
  context.fillStyle = '#9aa79f';
  context.font = '21px sans-serif';
  context.fillText(`第 ${pageNumber} / ${pageCount} 页`, PAGE_WIDTH - 190, PAGE_HEIGHT - 42);
}

function asciiBytes(value) {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) bytes[index] = value.charCodeAt(index) & 255;
  return bytes;
}

function concatBytes(chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  chunks.forEach((chunk) => { output.set(chunk, offset); offset += chunk.length; });
  return output;
}

function pdfFromJpegs(images) {
  const chunks = [];
  const offsets = [0];
  let length = 0;
  function append(chunk) { chunks.push(chunk); length += chunk.length; }
  function text(value) { append(asciiBytes(value)); }
  function object(number, bodyChunks) {
    offsets[number] = length;
    text(`${number} 0 obj\n`);
    bodyChunks.forEach(append);
    text('\nendobj\n');
  }

  text('%PDF-1.4\n');
  const kids = images.map((_, index) => `${3 + index * 3} 0 R`).join(' ');
  object(1, [asciiBytes('<< /Type /Catalog /Pages 2 0 R >>')]);
  object(2, [asciiBytes(`<< /Type /Pages /Count ${images.length} /Kids [${kids}] >>`)]);
  images.forEach((image, index) => {
    const pageObject = 3 + index * 3;
    const contentObject = pageObject + 1;
    const imageObject = pageObject + 2;
    const stream = asciiBytes('q\n595.28 0 0 841.89 0 0 cm\n/Im0 Do\nQ');
    object(pageObject, [asciiBytes(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 ${imageObject} 0 R >> >> /Contents ${contentObject} 0 R >>`)]);
    object(contentObject, [asciiBytes(`<< /Length ${stream.length} >>\nstream\n`), stream, asciiBytes('\nendstream')]);
    object(imageObject, [asciiBytes(`<< /Type /XObject /Subtype /Image /Width ${PAGE_WIDTH} /Height ${PAGE_HEIGHT} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`), image, asciiBytes('\nendstream')]);
  });
  const xrefOffset = length;
  const objectCount = 2 + images.length * 3;
  text(`xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`);
  for (let number = 1; number <= objectCount; number += 1) text(`${String(offsets[number]).padStart(10, '0')} 00000 n \n`);
  text(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  return concatBytes(chunks);
}

async function exportReport(page, report) {
  if (!report) throw new Error('暂无可导出的报告');
  const canvas = await canvasNode(page);
  canvas.width = PAGE_WIDTH;
  canvas.height = PAGE_HEIGHT;
  const context = canvas.getContext('2d');
  const pages = paginate(context, reportTokens(report));
  const images = [];
  for (let index = 0; index < pages.length; index += 1) {
    paintPage(context, report, pages[index], index + 1, pages.length);
    await delay(40);
    const imagePath = await canvasToJpeg(canvas, page);
    images.push(await readBinary(imagePath));
  }
  const pdf = pdfFromJpegs(images);
  const reportId = String(report.reportId || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = `${wx.env.USER_DATA_PATH}/SpineGuard_report_${reportId}.pdf`;
  await writeBinary(filePath, pdf);
  return filePath;
}

module.exports = { exportReport, pdfFromJpegs };
