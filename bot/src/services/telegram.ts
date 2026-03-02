import axios from 'axios';
import { config } from '../config';
import { logger } from '../logger';

class TelegramService {
  async send(text: string): Promise<void> {
    if (!config.telegramToken || !config.telegramChatId) return;
    try {
      await axios.post(
        `https://api.telegram.org/bot${config.telegramToken}/sendMessage`,
        { chat_id: config.telegramChatId, text, parse_mode: 'HTML' },
        { timeout: 8000 }
      );
    } catch (err) {
      logger.error(`Telegram send failed: ${err}`);
    }
  }
}

export const telegram = new TelegramService();
