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
                const { r2Domain } = await settingService.query(c);
                return emailHtmlTemplate(emailRow.content || '', r2Domain)
            } else {
                return emailTextTemplate(emailRow.text || '')
            }

        } else {
            return emailTextTemplate('The email does not exist')
        }

    },

    async sendEmailToBot(c, email) {

        const { tgBotToken, tgChatId, customDomain, tgMsgTo, tgMsgFrom, tgMsgText } = await settingService.query(c);

        const tgChatIds = tgChatId.split(',');

        const jwtToken = await jwtUtils.generateToken(c, { emailId: email.emailId })

        const webAppUrl = customDomain ? `${domainUtils.toOssDomain(customDomain)}/api/telegram/getEmail/${jwtToken}` : 'https://www.cloudflare.com/404'

        // 生成完整消息内容
        let fullText = emailMsgTemplate(email, tgMsgTo, tgMsgFrom, tgMsgText) || "No Content";

        // ✂️ 强制截断消息，保留前 4000 个字符，防止 4096 限制导致的 400 错误
        if (fullText.length > 4000) {
            fullText = fullText.substring(0, 4000) + "\n... (消息太长已截断)";
        }

        await Promise.all(tgChatIds.map(async chatId => {
            try {
                const res = await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        chat_id: chatId,
                        // parse_mode: 'HTML', // ❌ 已移除，防止格式错误
                        text: fullText,       // ✅ 发送处理后的纯文本
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    {
                                        text: '查看',
                                        web_app: { url: webAppUrl }
                                    }
                                ]
                            ]
                        }
                    })
                });

                // 🔍 增强日志：打印具体错误原因
                if (!res.ok) {
                    const errorData = await res.json();
                    console.error(`转发 Telegram 失败: chatId=${chatId}, 状态码=${res.status}, 原因=${errorData.description}`);
                }
            } catch (e) {
                console.error(`转发 Telegram 异常: chatId=${chatId}`, e.message);
            }
        }));

    }

}

export default telegramService;
