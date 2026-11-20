import orm from '../entity/orm';
import email from '../entity/email';
import settingService from './setting-service';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
dayjs.extend(utc);
dayjs.extend(timezone);
import { eq } from 'drizzle-orm';
import jwtUtils from '../utils/jwt-utils';
import emailTextTemplate from '../template/email-text';
import emailHtmlTemplate from '../template/email-html';
import domainUtils from '../utils/domain-uitls';
import proxyService from './proxy-service';

// ==================== 文本清洗 ====================

const NAMED_ENTITIES = {
	amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
	nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
	zwj: '', zwnj: '', shy: '',
	mdash: '—', ndash: '–', hellip: '…',
	copy: '©', reg: '®', trade: '™',
	middot: '·', bull: '•', laquo: '«', raquo: '»',
	ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’'
};

// 单遍解码：&amp;lt; 只解一层；孤立代理区换成替换字符
function decodeEntities(text) {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, ent) => {
		if (ent[0] === '#') {
			const code = /^#x/i.test(ent) ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
			if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
			if (code >= 0xd800 && code <= 0xdfff) return '\uFFFD';
			try {
				return String.fromCodePoint(code);
			} catch {
				return whole;
			}
		}
		return NAMED_ENTITIES[ent.toLowerCase()] ?? whole;
	});
}

// HTML → 纯文本
function htmlToPlain(html) {
	let text = html;

	text = text.replace(/<!--[\s\S]*?-->/g, '');
	text = text.replace(/<![^>]*>/g, '');
	text = text.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '');
	text = text.replace(/<(style|script|title|noscript|svg|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
	text = text.replace(/<img\b[^>]*\/?>/gi, '');

	// 链接：文字 (地址)；纯图片链接丢掉，不泄漏追踪地址
	text = text.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (full, inner) => {
		const m = full.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
		const href = ((m && (m[1] ?? m[2] ?? m[3])) || '').trim();
		const label = decodeEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

		if (!href || href.startsWith('#') || /^(javascript|data|vbscript):/i.test(href)) {
			return label;
		}

		const shown = decodeEntities(href);
		const bare = shown.replace(/^mailto:/i, '');

		if (!label) return '';
		if (label.includes(shown) || label.includes(bare)) return label;
		return `${label} (${shown})`;
	});

	// 表格：按行聚合，不误伤正文里的 markdown 表格
	text = text.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (full, inner) => {
		const cells = inner
			.split(/<\/(?:td|th)\s*>/i)
			.map(c => c.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
		while (cells.length && !cells[cells.length - 1]) cells.pop();
		return cells.length ? '\n' + cells.join(' | ') : '';
	});
	text = text.replace(/<\/(td|th)>/gi, ' | ');
	text = text.replace(/<\/tr>/gi, '\n');

	text = text.replace(/<li\b[^>]*>/gi, '\n• ');
	text = text.replace(/<\/(ul|ol)>/gi, '\n');
	text = text.replace(/<\/(p|div|h[1-6]|blockquote|pre|section|article|header|footer|table|tbody|thead)>/gi, '\n');
	text = text.replace(/<br\s*\/?>/gi, '\n');
	text = text.replace(/<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>/gi, '');

	return decodeEntities(text);
}

// 空白整理（不动 NBSP，保住缩进）
function tidyText(text) {
	text = text.replace(/[\u200B-\u200F\uFEFF\u034F\u00AD]/g, '');
	text = text.replace(/[ \t]+$/gm, '');
	text = text.replace(/[ \t]{2,}/g, ' ');
	text = text.split('\n').map(line => line.replace(/^[ \t]+|[ \t]+$/g, '')).join('\n');
	text = text.replace(/\n{3,}/g, '\n\n');
	return text.trim();
}

// 去掉引用历史；误判时保留原文
function stripQuoted(text) {
	const kept = [];

	for (const line of text.split('\n')) {
		const t = line.replace(/^\u00A0+/, '').trim();

		if (t.startsWith('>')) continue;

		// 引用头必须同时像「地址/日期」才删，避免误删「他在信中写道：」这类正文
		if (/(写道|wrote)\s*[：:]\s*$/i.test(t) && (/@/.test(t) || /\d/.test(t))) continue;

		kept.push(line);
	}

	const result = tidyText(kept.join('\n'));

	return result && /[\p{L}\p{N}]/u.test(result) ? result : text;
}

// 邮件对象 → 干净纯文本（尖括号里的 URL 保留，交给 buildMessage 配对成链接）
function formatEmailBody(emailData) {
	const plainText = typeof emailData.text === 'string' ? emailData.text : '';
	const hasPlainText = plainText.trim().length > 0;

	let body;

	if (hasPlainText) {
		body = decodeEntities(plainText.replace(/\r\n?/g, '\n'));
	} else if (typeof emailData.content === 'string' && emailData.content.trim()) {
		body = htmlToPlain(emailData.content.replace(/\r\n?/g, '\n'));
	} else {
		body = '';
	}

	// 保护行首缩进：换成 NBSP，避免被 tidyText / stripQuoted 的 trim 吃掉
	body = body.replace(/^([ \t]+)/gm, m => '\u00A0'.repeat(m.length));

	const cleaned = stripQuoted(tidyText(body));

	return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : '';
}

// ==================== Telegram 格式化 ====================

function escapeTg(text = '') {
	return String(text)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function linkify(text) {
	return text.replace(/(?:https?:\/\/|www\.)[^\s\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF"'<>()\[\]{}]+/g, (match) => {
		const trailing = match.match(/[.,;:!?]+$/);
		const urlPart = trailing ? match.slice(0, -trailing[0].length) : match;
		if (!urlPart) return match;
		const href = urlPart.startsWith('www.') ? 'http://' + urlPart : urlPart;
		return `<a href="${href.replace(/"/g, '%22')}">${urlPart}</a>` + (trailing ? trailing[0] : '');
	});
}

// 已转义文本里的 &lt; &gt; 不能被卷进链接
function autoLink(text) {
	if (!text) return text;
	return text
		.split(/(&lt;|&gt;)/)
		.map(seg => (seg === '&lt;' || seg === '&gt;' ? seg : linkify(seg)))
		.join('');
}

// 「文字 + <URL>」配对成可点链接；没有文字的尖括号 URL 删掉
function extractBracketedLinks(text) {
	const links = [];

	const withLabel = text.replace(/([^\n<>]{1,120})[ \t]*\n?[ \t]*<((?:https?:\/\/|www\.)[^<>\s]+)>/gi, (match, label, url) => {
		const cleanLabel = label.trim();
		if (!cleanLabel) return match;
		const href = (url.startsWith('www.') ? 'http://' + url : url)
			.replace(/"/g, '%22')
			.replace(/&/g, '&amp;');
		links.push({ href, label: cleanLabel });
		return `\u0001${links.length - 1}\u0001`;
	});

	const withoutBare = withLabel.replace(/<((?:https?:\/\/|www\.)[^<>\s]+)>/gi, '');

	return { text: withoutBare, links };
}

const TRUNC_SUFFIX = '\n...(消息太长已截断)';
const SELF_CLOSING = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);

// 截断并补齐未闭合标签
function truncateHtml(html, max) {
	if (!html || html.length <= max) return html || '';

	const RESERVE = 64;
	let cut = html.slice(0, Math.max(0, max - TRUNC_SUFFIX.length - RESERVE));

	const lt = cut.lastIndexOf('<');
	if (lt > cut.lastIndexOf('>')) {
		cut = cut.slice(0, lt);
	}

	const stack = [];
	const re = /<(\/?)([a-z][a-z0-9]*)[^<>]*>/gi;
	let m;
	while ((m = re.exec(cut)) !== null) {
		const name = m[2].toLowerCase();
		if (m[1] === '/') {
			const i = stack.lastIndexOf(name);
			if (i >= 0) stack.length = i;
		} else if (!SELF_CLOSING.has(name) && !/\/\s*>$/.test(m[0])) {
			stack.push(name);
		}
	}

	return cut + stack.reverse().map(t => `</${t}>`).join('') + TRUNC_SUFFIX;
}

const ZW = '\u200B';

// 自己拼消息，绕开模板的 formatText（它会删掉 NBSP 和行首空白）
function buildMessage(emailData, tgMsgTo, tgMsgFrom, tgMsgText) {
	const subject = (emailData.subject || '').trim() || '(无主题)';

	let msg = `<b>${escapeTg(subject)}</b>`;

	if (tgMsgFrom === 'only-name') {
		msg += `\n\nFrom${ZW}：${escapeTg(emailData.name || '')}`;
	}

	if (tgMsgFrom === 'show') {
		msg += `\n\nFrom${ZW}：${escapeTg(emailData.name || '')}  &lt;${escapeTg(emailData.sendEmail || '')}&gt;`;
	}

	if (tgMsgTo === 'show') {
		msg += `\nTo：${ZW}${escapeTg(emailData.toEmail || '')}`;
	}

	if (tgMsgText === 'show') {
		const body = formatEmailBody(emailData);
		if (body) {
			const { text, links } = extractBracketedLinks(body);
			let rendered = autoLink(escapeTg(text));

			rendered = rendered.replace(/\u0001(\d+)\u0001/g, (m, i) => {
				const link = links[Number(i)];
				return link ? `<a href="${link.href}">${escapeTg(link.label)}</a>` : '';
			});

			msg += `\n\n${rendered}`;
		}
	}

	return truncateHtml(msg, 4000);
}

// ==================== 服务 ====================

const telegramService = {

	async getEmailContent(c, params) {

		const { token } = params

		const result = await jwtUtils.verifyToken(c, token);

		if (!result) {
			return emailTextTemplate('Access denied')
		}

		const emailRow = await orm(c).select().from(email).where(eq(email.emailId, result.emailId)).get();

		if (emailRow) {

			if (emailRow.content) {
				const html = await proxyService.rewriteHtml(c, emailRow.content);
				return emailHtmlTemplate(html || '')
			} else {
				return emailTextTemplate(emailRow.text || '')
			}

		} else {
			return emailTextTemplate('The email does not exist')
		}

	},

	async sendEmailToBot(c, emailData) {

		try {

			const { tgBotToken, tgChatId, customDomain, tgMsgTo, tgMsgFrom, tgMsgText } = await settingService.query(c);

			const tgChatIds = [...new Set(String(tgChatId || '').split(',').map(s => s.trim()).filter(Boolean))];
			if (!tgChatIds.length) return;

			const jwtToken = await jwtUtils.generateToken(c, { emailId: emailData.emailId });

			const baseUrl = customDomain ? String(domainUtils.toOssDomain(customDomain)).replace(/\/+$/, '') : '';
			const webAppUrl = baseUrl ? `${baseUrl}/api/telegram/getEmail/${jwtToken}` : 'https://www.cloudflare.com/404';

			const fullText = buildMessage(emailData, tgMsgTo, tgMsgFrom, tgMsgText);

			await Promise.all(tgChatIds.map(async chatId => {
				try {
					const res = await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							chat_id: chatId,
							parse_mode: 'HTML',
							text: fullText,
							reply_markup: {
								inline_keyboard: [
									[
										{
											text: '查看原信',
											url: webAppUrl
										}
									]
								]
							}
						})
					});

					if (!res.ok) {
						console.error(`转发 Telegram 失败: chatId=${chatId}, 状态码=${res.status}, 原因=${await res.text()}`);
					}
				} catch (e) {
					console.error(`转发 Telegram 异常: chatId=${chatId}`, e.message);
				}
			}));

		} catch (e) {
			console.error('Telegram 推送准备阶段失败:', e?.message);
		}

	}
};

export default telegramService;
