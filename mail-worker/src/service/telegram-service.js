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
import emailMsgTemplate from '../template/email-msg';
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

// 单遍解码：&amp;lt; 只解一层
function decodeEntities(text) {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, ent) => {
		if (ent[0] === '#') {
			const code = /^#x/i.test(ent) ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
			if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
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

	// 注释、Outlook 条件注释
	text = text.replace(/<!--[\s\S]*?-->/g, '');

	// head 整块、不可见节点
	text = text.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '');
	text = text.replace(/<(style|script|title|noscript|svg|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

	// 图片（基本都是跟踪像素）
	text = text.replace(/<img\b[^>]*\/?>/gi, '');

	// 保护 <pre> 缩进：行首空格换 NBSP，避免被后续空白压缩吃掉
	text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (full, inner) => {
		const protectedInner = inner.replace(/^([ \t]+)/gm, m => '\u00A0'.repeat(m.length));
		return '\n' + protectedInner + '\n';
	});

	// 链接：文字 (地址)
	text = text.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (full, inner) => {
		const m = full.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
		const href = ((m && (m[1] ?? m[2] ?? m[3])) || '').trim();
		const label = decodeEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

		if (!href || href.startsWith('#') || /^(javascript|data|vbscript):/i.test(href)) {
			return label;
		}

		const shown = decodeEntities(href);
		const bare = shown.replace(/^mailto:/i, '');

		if (!label) return shown;
		if (label.includes(shown) || label.includes(bare)) return label;
		return `${label} (${shown})`;
	});

	// 表格：单元格分隔、行换行
	text = text.replace(/<\/(td|th)>/gi, ' | ');
	text = text.replace(/<\/tr>/gi, '\n');

	// 列表
	text = text.replace(/<li\b[^>]*>/gi, '\n• ');
	text = text.replace(/<\/(ul|ol)>/gi, '\n');

	// 块级换行
	text = text.replace(/<\/(p|div|h[1-6]|blockquote|pre|section|article|header|footer|table|tbody|thead)>/gi, '\n');
	text = text.replace(/<br\s*\/?>/gi, '\n');

	// 只删字母开头的标签，纯文本里的 < 100 元 >、<a@b.com> 保留
	text = text.replace(/<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>/gi, '');

	return decodeEntities(text);
}

// 空白整理
function tidyText(text) {
	text = text.replace(/[ \t]+$/gm, '');
	text = text.replace(/[ \t]{2,}/g, ' ');
	text = text.split('\n').map(line => line.replace(/^[ \t]+|[ \t]+$/g, '')).join('\n');
	// 表格行尾多余的竖线：'您好 | 优惠 50% |' -> '您好 | 优惠 50%'
	text = text.replace(/[ \t]*\|$/gm, '');
	text = text.replace(/\n{3,}/g, '\n\n');
	return text.trim();
}

// 去掉引用历史；全删完为空则保留原文
function stripQuoted(text) {
	const kept = [];

	for (const line of text.split('\n')) {
		const t = line.trim();
		if (t.startsWith('>')) continue;
		// 引用头：任何以「写道：」「wrote:」结尾的行
		if (/(写道|wrote)\s*[：:]\s*$/i.test(t)) continue;
		kept.push(line);
	}

	const result = tidyText(kept.join('\n'));

	return result || text;
}

// 对外入口：邮件对象 → 干净的纯文本
function formatEmailBody(emailData) {
	const plainText = typeof emailData.text === 'string' ? emailData.text : '';
	const hasPlainText = plainText.trim().length > 0;

	let body;

	if (hasPlainText) {
		// 纯文本邮件：只解一次实体，不动标签字样
		body = decodeEntities(plainText.replace(/\r\n?/g, '\n'));
	} else if (typeof emailData.content === 'string' && emailData.content.trim()) {
		body = htmlToPlain(emailData.content.replace(/\r\n?/g, '\n'));
	} else {
		body = '';
	}

	body = stripQuoted(tidyText(body));

	// 裸 & 转义，已是实体的跳过（Telegram HTML 模式要求）
	return body.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/gi, '&amp;');
}

// ==================== 链接与截断 ====================

function autoLink(text) {
	if (!text) return text;
	return text.replace(/(?:https?:\/\/|www\.)[^\s\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF"'<>()\[\]{}]+/g, (match) => {
		const trailing = match.match(/[.,;:!?]+$/);
		const urlPart = trailing ? match.slice(0, -trailing[0].length) : match;
		if (!urlPart) return match;
		const href = urlPart.startsWith('www.') ? 'http://' + urlPart : urlPart;
		return `<a href="${href.replace(/"/g, '%22')}">${urlPart}</a>` + (trailing ? trailing[0] : '');
	});
}

const TRUNC_SUFFIX = '\n...(消息太长已截断)';

// 在 autoLink 之后调用，截断并补齐未闭合标签
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
		if (m[1] === '/') {
			const i = stack.lastIndexOf(m[2].toLowerCase());
			if (i >= 0) stack.length = i;
		} else {
			stack.push(m[2].toLowerCase());
		}
	}

	return cut + stack.reverse().map(t => `</${t}>`).join('') + TRUNC_SUFFIX;
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

			const safeEmail = { ...emailData };
			safeEmail.subject = (emailData.subject || '').slice(0, 300);
			safeEmail.text = formatEmailBody(emailData) || 'No Content';

			let fullText = autoLink(emailMsgTemplate(safeEmail, tgMsgTo, tgMsgFrom, tgMsgText) || '');
			fullText = truncateHtml(fullText, 4000);

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
