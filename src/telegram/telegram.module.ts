import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegrafModule } from 'nestjs-telegraf';
import { session } from 'telegraf';
import { AppConfig } from '../config/configuration';
import { SearchProfilesModule } from '../search-profiles/search-profiles.module';
import { createAllowlistMiddleware } from './allowlist.middleware';
import { NewSearchWizard } from './newsearch.wizard';
import { TelegramService } from './telegram.service';
import { TelegramUpdate } from './telegram.update';

@Module({
  imports: [
    SearchProfilesModule,
    TelegrafModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const { botToken, allowedUserIds } = config.get('telegram', { infer: true });
        return {
          token: botToken,
          // Order matters: allowlist gates everything first, then session must
          // be established before the (auto-registered) scenes/stage middleware
          // and wizard steps run. Long polling is the default — no webhook.
          middlewares: [createAllowlistMiddleware(allowedUserIds), session()],
        };
      },
    }),
  ],
  providers: [TelegramUpdate, NewSearchWizard, TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
