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
import verifyUtils from '../utils/verify-utils';
import domainUtils from "../utils/domain-uitls";

// --- 0. 正则表达式定义 (使用 new RegExp 避开构建工具解析 bug) ---
// 注意：字符串里的反斜杠需要双写 (\\)
const REGEX_HEAD = new RegExp('<head[\\s\\S]*?<\\/head>', 'gi');
const REGEX_STYLE = new RegExp('<style[\\s\\S]*?<\\/style>', 'gi');
const REGEX_SCRIPT = new RegExp('<script[\\s\\S]*?<\\/script>', 'gi');
const REGEX_COMMENT = new RegExp('', 'g'); // 修复构建报错的核心
const REGEX_TAGS = new RegExp('<[^>]+>', 'g');
const REGEX_LINK = new RegExp('<a\\s+[^>]*>([\\s\\S]*?)<\\/a>', 'gi');
const REGEX_HREF = new RegExp('href\\s*=\\s*(?:["\']?)([^"\'\\s>]+)', 'i'); // 修复 href 提取
const REGEX_SPACES = new RegExp('[ \\t]+', 'g');
const REGEX_NEWLINES = new RegExp('(\\n\\s*){3,}', 'g');
const REGEX_TD = new RegExp('<\\/(td|th)>', 'gi');
const REGEX_BLOCKS = new RegExp('<\\/(tr|p|div|h[1-6]|li|blockquote|pre)>', 'gi');
const REGEX_BR = new RegExp('<br\\s*\\/?>', 'gi');

// 🧹 1. 智能清洗函数 V8 (最终稳定版)
function smartClean(html) {
    if (!html) return "";

    let text = html;

    // Step 0: 强力去污 (去除 Head, 注释, 样式, 脚本)
    text = text.replace(REGEX_HEAD, "");
    text = text.replace(REGEX_COMMENT, "");
    text = text.replace(REGEX_STYLE, "");
    text = text.replace(REGEX_SCRIPT, "");

    // Step 1: 链接显形 (将 <a href="...">text</a> 转换为 "text (url)")
    text = text.replace(REGEX_LINK, (fullTag, content) => {
        const hrefMatch = fullTag.match(REGEX_HREF);
        const cleanContent = content.replace(/[\r\n]+/g, '').trim();

        if (hrefMatch && hrefMatch[1] && !hrefMatch[1].startsWith('#') && !hrefMatch[1].startsWith('javascript')) {
            const url = hrefMatch[1];
            // 如果文字本身就是链接，不重复显示
            if (cleanContent.includes(url)) {
                return ` ${cleanContent} `;
            }
            return ` ${cleanContent} (${url}) `;
        }
        return ` ${cleanContent} `;
    });

    // Step 2: 排版修复 (表格单元格转空格)
    text = text.replace(REGEX_TD, "  "); 

    // Step 3: 块级换行 (段落结束转换行)
    text = text.replace(REGEX_BLOCKS, "\n");
    text = text.replace(REGEX_BR, "\n");

    // Step 4: 脱壳 (去除剩余所有标签)
    text = text.replace(REGEX_TAGS, "");

    // Step 5: 实体解码
    text = text
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#039;/gi, "'")
        .replace(/&copy;/gi, "©")
        .replace(/&reg;/gi, "®")
        .replace(/&trade;/gi, "™");

    // Step 6: 最终整容 (压缩空格和空行)
    text = text.replace(REGEX_SPACES, " ");
    text = text.replace(REGEX_NEWLINES, "\n\n");
    
    // Step 7: 逐行清理 (去首尾空格，过滤空行)
    text = text.split('\n').map(line => line.trim()).filter(line => line.length > 0).join('\n');

    // Step 8: 安全转义 (Telegram 要求)
    return text.trim()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// 🔗 2. 链接激活函数
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

    async getEmailContent(c, params) {
        const { token } = params
        const result = await jwtUtils.verifyToken(c, token);
        if (!result) return emailTextTemplate('Access denied');
        
        const emailRow = await orm(c).select().from(email).where(eq(email.emailId, result.emailId)).get();
        if (emailRow) {
            if (emailRow.content) {
                const { r2Domain } = await settingService.query(c);
                return emailHtmlTemplate(emailRow.content || '', r2Domain)
            } else {
                let safeText = smartClean(emailRow.text || '');
                safeText = autoLink(safeText);
                return emailTextTemplate(safeText);
            }
        } else {
            return emailTextTemplate('The email does not exist')
        }
    },

    async sendEmailToBot(c, emailData) {

        const { tgBotToken, tgChatId, customDomain, tgMsgTo, tgMsgFrom, tgMsgText } = await settingService.query(c);
        const tgChatIds = tgChatId.split(',');
        const jwtToken = await jwtUtils.generateToken(c, { emailId: emailData.emailId })
        const webAppUrl = customDomain ? `${domainUtils.toOssDomain(customDomain)}/api/telegram/getEmail/${jwtToken}` : 'https://www.cloudflare.com/404'

        // 🛡️ 数据清洗
        const safeEmail = { ...emailData };

        // 优先使用 html 字段进行清洗
        const rawBody = safeEmail.html || safeEmail.text || "";
        safeEmail.text = smartClean(rawBody);
        
        if (safeEmail.subject) safeEmail.subject = smartClean(safeEmail.subject);

        // 📝 生成消息
        let fullText = emailMsgTemplate(safeEmail, tgMsgTo, tgMsgFrom, tgMsgText) || "No Content";

        // 🔗 激活链接
        fullText = autoLink(fullText);

        // ✂️ 截断
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

export default telegramService
