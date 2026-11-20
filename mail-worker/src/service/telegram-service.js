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

// 你 2.5 原版的清洗函数
function smartClean(html) {
    if (!html) return "";

    let text = html;

    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');

    text = text.replace(/<a\s+[^>]*>([\s\S]*?)<\/a>/gi, (fullTag, content) => {
        const hrefMatch = fullTag.match(/href\s*=\s*(?:["']?)([^"'\s>]+)/i);
        const cleanContent = content.replace(/[\r\n]+/g, '').trim();

        if (hrefMatch && hrefMatch[1] && !hrefMatch[1].startsWith('#') && !hrefMatch[1].startsWith('javascript')) {
            const url = hrefMatch[1];
            if (cleanContent.includes(url)) {
                return ` ${cleanContent} `;
            }
            return ` ${cleanContent} (${url}) `;
        }
        return ` ${cleanContent} `;
    });

    text = text.replace(/<\/(td|th)>/gi, ' | ');
    text = text.replace(/<\/(tr|p|div|h[1-6]|li|blockquote)>/gi, '\n');
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<[^>]+>/g, '');

    text = text
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#039;/gi, "'");

    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/(\n\s*){3,}/g, '\n\n');
    text = text.split('\n').map(line => line.trim()).join('\n');

    return text.trim()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// 你 2.5 原版的链接函数
function autoLink(text) {
    if (!text) return text;
    return text.replace(/((https?:\/\/|www\.)[^\s\u4e00-\u9fa5\uFF00-\uFFEF"<>)]+)/g, (match) => {
        let href = match;
        if (match.startsWith('www.')) {
            href = 'http://' + match;
        }
        return `<a href="${href}">${match}</a>`;
    });
}

const telegramService = {

    // 保留 3.6 的图片代理版本
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

    // 你 2.5 原版，一字未改
    async sendEmailToBot(c, emailData) {

        const { tgBotToken, tgChatId, customDomain, tgMsgTo, tgMsgFrom, tgMsgText } = await settingService.query(c);
        const tgChatIds = tgChatId.split(',');
        const jwtToken = await jwtUtils.generateToken(c, { emailId: emailData.emailId })
        const webAppUrl = customDomain ? `${domainUtils.toOssDomain(customDomain)}/api/telegram/getEmail/${jwtToken}` : 'https://www.cloudflare.com/404'

        const safeEmail = { ...emailData };

        const rawBody = safeEmail.html || safeEmail.text || "";
        safeEmail.text = smartClean(rawBody);

        if (safeEmail.subject) safeEmail.subject = smartClean(safeEmail.subject);

        let fullText = emailMsgTemplate(safeEmail, tgMsgTo, tgMsgFrom, tgMsgText) || "No Content";

        fullText = autoLink(fullText);

        if (fullText.length > 4000) {
            fullText = fullText.substring(0, 4000) + "\n... (消息太长已截断)";
        }

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
                            inline_keyboard: [[{ text: '查看原信', url: webAppUrl }]]
                        }
                    })
                });

                if (!res.ok) {
                    const errorData = await res.json();
                    console.error(`转发 Telegram 失败: chatId=${chatId}, 状态码=${res.status}, 原因=${errorData.description}`);
                }
            } catch (e) {
                console.error(`转发 Telegram 异常: chatId=${chatId}`, e.message);
            }
        }));
    }
};

export default telegramService;
