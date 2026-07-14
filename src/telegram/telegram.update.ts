import { Logger } from '@nestjs/common';
import { Action, Command, Ctx, Help, Start, Update } from 'nestjs-telegraf';
import { Markup, Scenes } from 'telegraf';
import { SearchProfilesService } from '../search-profiles/search-profiles.service';
import { SearchProfile } from '../search-profiles/search-profile.model';
import { NEWSEARCH_SCENE } from './newsearch.wizard';
import { describeProfile, HELP, NO_SEARCHES, WELCOME } from './telegram.copy';

/**
 * All bot commands + inline-button callbacks. Access is already gated by the
 * global allowlist middleware, so handlers can assume an authorized user.
 */
@Update()
export class TelegramUpdate {
  private readonly logger = new Logger(TelegramUpdate.name);

  constructor(private readonly profiles: SearchProfilesService) {}

  @Start()
  async onStart(@Ctx() ctx: Scenes.SceneContext) {
    await ctx.reply(WELCOME, { parse_mode: 'HTML' });
  }

  @Help()
  async onHelp(@Ctx() ctx: Scenes.SceneContext) {
    await ctx.reply(HELP, { parse_mode: 'HTML' });
  }

  @Command('newsearch')
  async onNewSearch(@Ctx() ctx: Scenes.SceneContext) {
    await ctx.scene.enter(NEWSEARCH_SCENE);
  }

  @Command('mysearches')
  async onMySearches(@Ctx() ctx: Scenes.SceneContext) {
    const userId = ctx.from?.id;
    if (!userId) return;
    const list = await this.profiles.listByUser(userId);
    if (list.length === 0) {
      await ctx.reply(NO_SEARCHES);
      return;
    }
    await ctx.reply(`У вас <b>${list.length}</b> пошук(ів):`, { parse_mode: 'HTML' });
    // One message per profile so each carries its own manage buttons and can be
    // edited independently when toggled/deleted. Isolate each send so one failed
    // reply (blocked bot, bad markup) doesn't abort the rest of the list.
    for (const p of list) {
      try {
        await ctx.reply(describeProfile(p), {
          parse_mode: 'HTML',
          ...this.profileKeyboard(p),
        });
      } catch (err) {
        this.logger.warn(`mysearches: failed to send profile ${p.id}: ${(err as Error).message}`);
      }
    }
  }

  @Command('pause')
  async onPause(@Ctx() ctx: Scenes.SceneContext) {
    await this.handleToggleCommand(ctx, true);
  }

  @Command('resume')
  async onResume(@Ctx() ctx: Scenes.SceneContext) {
    await this.handleToggleCommand(ctx, false);
  }

  @Command('forgetme')
  async onForgetMe(@Ctx() ctx: Scenes.SceneContext) {
    await ctx.reply(
      '⚠️ Це <b>видалить усі</b> ваші пошуки та збережені дані. Продовжити?',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('🗑 Так, видалити все', 'forgetme:yes'),
            Markup.button.callback('Скасувати', 'forgetme:no'),
          ],
        ]),
      },
    );
  }

  // --- inline button callbacks -------------------------------------------

  @Action(/^pause:(.+)$/)
  async onPauseAction(@Ctx() ctx: Scenes.SceneContext) {
    await this.toggleViaAction(ctx, true);
  }

  @Action(/^resume:(.+)$/)
  async onResumeAction(@Ctx() ctx: Scenes.SceneContext) {
    await this.toggleViaAction(ctx, false);
  }

  @Action(/^del:(.+)$/)
  async onDeletePrompt(@Ctx() ctx: Scenes.SceneContext) {
    const id = this.matchId(ctx);
    const userId = ctx.from?.id;
    if (!id || !userId) return;
    const profile = await this.profiles.get(id);
    if (!profile || profile.userId !== userId) {
      await ctx.answerCbQuery('Пошук не знайдено');
      return;
    }
    // A search must be paused before it can be deleted (also guards a stale
    // delete button on an old message for a since-resumed search).
    if (!profile.paused) {
      await ctx.answerCbQuery('Спершу призупиніть пошук, потім видаляйте', { show_alert: true });
      await this.rerenderProfile(ctx, profile);
      return;
    }
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup(
      Markup.inlineKeyboard([
        [
          Markup.button.callback('🗑 Так, видалити', `delyes:${id}`),
          Markup.button.callback('↩️ Ні', `delno:${id}`),
        ],
      ]).reply_markup,
    );
  }

  @Action(/^delyes:(.+)$/)
  async onDeleteConfirm(@Ctx() ctx: Scenes.SceneContext) {
    const id = this.matchId(ctx);
    const userId = ctx.from?.id;
    if (!id || !userId) return;
    const profile = await this.profiles.get(id);
    if (!profile || profile.userId !== userId) {
      await ctx.answerCbQuery('Не знайдено');
      await ctx.editMessageText('Пошук не знайдено.');
      return;
    }
    // Re-check in case the search was resumed between the prompt and confirm.
    if (!profile.paused) {
      await ctx.answerCbQuery('Спершу призупиніть пошук', { show_alert: true });
      await this.rerenderProfile(ctx, profile);
      return;
    }
    const ok = await this.profiles.delete(id, userId);
    await ctx.answerCbQuery(ok ? 'Видалено' : 'Не знайдено');
    await ctx.editMessageText(ok ? '🗑 Пошук видалено.' : 'Пошук не знайдено.');
  }

  @Action(/^delno:(.+)$/)
  async onDeleteCancel(@Ctx() ctx: Scenes.SceneContext) {
    const id = this.matchId(ctx);
    const userId = ctx.from?.id;
    if (!id || !userId) return;
    const profile = await this.profiles.get(id);
    await ctx.answerCbQuery('Скасовано');
    if (profile && profile.userId === userId) {
      await this.rerenderProfile(ctx, profile);
    }
  }

  @Action('forgetme:yes')
  async onForgetConfirm(@Ctx() ctx: Scenes.SceneContext) {
    const userId = ctx.from?.id;
    if (!userId) return;
    const count = await this.profiles.forgetUser(userId);
    await ctx.answerCbQuery('Готово');
    await ctx.editMessageText(`🧹 Видалено ${count} пошук(ів). Усі ваші дані стерто.`);
  }

  @Action('forgetme:no')
  async onForgetCancel(@Ctx() ctx: Scenes.SceneContext) {
    await ctx.answerCbQuery();
    await ctx.editMessageText('Скасовано. Ваші дані на місці.');
  }

  // --- helpers ------------------------------------------------------------

  /**
   * Context-aware actions:
   *   - running  → the only allowed action is to pause it;
   *   - paused   → the full context (resume + delete).
   * So a search must be stopped before it can be deleted.
   */
  private profileKeyboard(p: SearchProfile) {
    if (!p.paused) {
      return Markup.inlineKeyboard([
        [Markup.button.callback('⏸ Призупинити', `pause:${p.id}`)],
      ]);
    }
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('▶️ Відновити', `resume:${p.id}`),
        Markup.button.callback('🗑 Видалити', `del:${p.id}`),
      ],
    ]);
  }

  private matchId(ctx: Scenes.SceneContext): string | undefined {
    // `match` is attached by the action (callback_query) middleware; it isn't on
    // the base SceneContext type, hence the cast.
    const match = (ctx as unknown as { match?: RegExpMatchArray }).match;
    return match?.[1];
  }

  /** Read the argument of a "/cmd arg" text command. */
  private commandArg(ctx: Scenes.SceneContext): string | undefined {
    const text = (ctx.message as { text?: string } | undefined)?.text ?? '';
    const parts = text.trim().split(/\s+/);
    return parts.length > 1 ? parts[1] : undefined;
  }

  private async handleToggleCommand(ctx: Scenes.SceneContext, paused: boolean) {
    const userId = ctx.from?.id;
    const id = this.commandArg(ctx);
    if (!userId) return;
    if (!id) {
      await ctx.reply(
        `Вкажіть id пошуку, напр. <code>/${paused ? 'pause' : 'resume'} a1b2c3d4</code>. ` +
          'Список id — /mysearches',
        { parse_mode: 'HTML' },
      );
      return;
    }
    const profile = await this.profiles.setPaused(id, userId, paused);
    if (!profile) {
      await ctx.reply('Пошук із таким id не знайдено серед ваших.');
      return;
    }
    await ctx.reply(
      `${paused ? '⏸ Призупинено' : '▶️ Відновлено'}: <b>${profile.name}</b>`,
      { parse_mode: 'HTML' },
    );
  }

  private async toggleViaAction(ctx: Scenes.SceneContext, paused: boolean) {
    const id = this.matchId(ctx);
    const userId = ctx.from?.id;
    if (!id || !userId) return;
    const profile = await this.profiles.setPaused(id, userId, paused);
    if (!profile) {
      await ctx.answerCbQuery('Пошук не знайдено');
      return;
    }
    await ctx.answerCbQuery(paused ? 'Призупинено' : 'Відновлено');
    await this.rerenderProfile(ctx, profile);
  }

  private async rerenderProfile(ctx: Scenes.SceneContext, profile: SearchProfile) {
    try {
      await ctx.editMessageText(describeProfile(profile), {
        parse_mode: 'HTML',
        ...this.profileKeyboard(profile),
      });
    } catch (err) {
      // e.g. "message is not modified" — harmless.
      this.logger.debug(`rerender skipped: ${(err as Error).message}`);
    }
  }
}
