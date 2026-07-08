import { TelegramUpdate } from './telegram.update';
import { SearchProfile } from '../search-profiles/search-profile.model';

const profile = (over: Partial<SearchProfile> = {}): SearchProfile => ({
  id: 'a1',
  userId: 1,
  chatId: 1,
  name: 'n',
  criteria: { city: 'Київ', ownerOnly: false },
  paused: false,
  primed: true,
  createdAt: 0,
  ...over,
});

const makeCtx = (over: Record<string, any> = {}) => ({
  reply: jest.fn().mockResolvedValue(undefined),
  answerCbQuery: jest.fn().mockResolvedValue(undefined),
  editMessageText: jest.fn().mockResolvedValue(undefined),
  editMessageReplyMarkup: jest.fn().mockResolvedValue(undefined),
  scene: { enter: jest.fn().mockResolvedValue(undefined) },
  from: { id: 1 },
  chat: { id: 1 },
  message: { text: '' },
  ...over,
});

const build = () => {
  const profiles = {
    get: jest.fn(),
    listByUser: jest.fn(),
    setPaused: jest.fn(),
    delete: jest.fn(),
    forgetUser: jest.fn(),
  };
  return { update: new TelegramUpdate(profiles as any), profiles };
};

describe('TelegramUpdate commands', () => {
  it('/start and /help greet', async () => {
    const { update } = build();
    const ctx = makeCtx();
    await update.onStart(ctx as any);
    await update.onHelp(ctx as any);
    expect(ctx.reply).toHaveBeenCalledTimes(2);
  });

  it('/newsearch enters the scene', async () => {
    const { update } = build();
    const ctx = makeCtx();
    await update.onNewSearch(ctx as any);
    expect(ctx.scene.enter).toHaveBeenCalledWith('newsearch');
  });

  it('/mysearches with no profiles says so', async () => {
    const { update, profiles } = build();
    profiles.listByUser.mockResolvedValue([]);
    const ctx = makeCtx();
    await update.onMySearches(ctx as any);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
  });

  it('/mysearches lists a message per profile', async () => {
    const { update, profiles } = build();
    profiles.listByUser.mockResolvedValue([profile({ id: 'a' }), profile({ id: 'b' })]);
    const ctx = makeCtx();
    await update.onMySearches(ctx as any);
    // 1 header + 2 profiles
    expect(ctx.reply).toHaveBeenCalledTimes(3);
  });

  it('/pause without an id shows a hint', async () => {
    const { update } = build();
    const ctx = makeCtx({ message: { text: '/pause' } });
    await update.onPause(ctx as any);
    expect(ctx.reply.mock.calls[0][0]).toContain('id');
  });

  it('/pause <id> pauses an owned profile', async () => {
    const { update, profiles } = build();
    profiles.setPaused.mockResolvedValue(profile({ paused: true, name: 'X' }));
    const ctx = makeCtx({ message: { text: '/pause a1' } });
    await update.onPause(ctx as any);
    expect(profiles.setPaused).toHaveBeenCalledWith('a1', 1, true);
    expect(ctx.reply.mock.calls[0][0]).toContain('Призупинено');
  });

  it('/pause reports a missing profile', async () => {
    const { update, profiles } = build();
    profiles.setPaused.mockResolvedValue(null);
    const ctx = makeCtx({ message: { text: '/pause zzz' } });
    await update.onPause(ctx as any);
    expect(ctx.reply.mock.calls[0][0]).toContain('не знайдено');
  });

  it('/forgetme asks for confirmation', async () => {
    const { update } = build();
    const ctx = makeCtx();
    await update.onForgetMe(ctx as any);
    expect(ctx.reply.mock.calls[0][0]).toContain('видалить');
  });
});

describe('TelegramUpdate actions', () => {
  it('pause action toggles + re-renders', async () => {
    const { update, profiles } = build();
    profiles.setPaused.mockResolvedValue(profile({ paused: true }));
    const ctx = makeCtx({ match: ['pause:a1', 'a1'] });
    await update.onPauseAction(ctx as any);
    expect(profiles.setPaused).toHaveBeenCalledWith('a1', 1, true);
    expect(ctx.editMessageText).toHaveBeenCalled();
  });

  it('delete prompt is refused while the search is running', async () => {
    const { update, profiles } = build();
    profiles.get.mockResolvedValue(profile({ paused: false }));
    const ctx = makeCtx({ match: ['del:a1', 'a1'] });
    await update.onDeletePrompt(ctx as any);
    expect(ctx.answerCbQuery).toHaveBeenCalledWith(expect.stringContaining('призупиніть'), {
      show_alert: true,
    });
    expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled();
  });

  it('delete prompt shows a confirm keyboard when paused', async () => {
    const { update, profiles } = build();
    profiles.get.mockResolvedValue(profile({ paused: true }));
    const ctx = makeCtx({ match: ['del:a1', 'a1'] });
    await update.onDeletePrompt(ctx as any);
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalled();
  });

  it('delete confirm deletes a paused profile', async () => {
    const { update, profiles } = build();
    profiles.get.mockResolvedValue(profile({ paused: true }));
    profiles.delete.mockResolvedValue(true);
    const ctx = makeCtx({ match: ['delyes:a1', 'a1'] });
    await update.onDeleteConfirm(ctx as any);
    expect(profiles.delete).toHaveBeenCalledWith('a1', 1);
    expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('видалено'));
  });

  it('delete confirm is blocked if the profile was resumed', async () => {
    const { update, profiles } = build();
    profiles.get.mockResolvedValue(profile({ paused: false }));
    const ctx = makeCtx({ match: ['delyes:a1', 'a1'] });
    await update.onDeleteConfirm(ctx as any);
    expect(profiles.delete).not.toHaveBeenCalled();
  });

  it('delete cancel re-renders the profile', async () => {
    const { update, profiles } = build();
    profiles.get.mockResolvedValue(profile({ paused: true }));
    const ctx = makeCtx({ match: ['delno:a1', 'a1'] });
    await update.onDeleteCancel(ctx as any);
    expect(ctx.answerCbQuery).toHaveBeenCalledWith('Скасовано');
    expect(ctx.editMessageText).toHaveBeenCalled();
  });

  it('forgetme:yes wipes and reports the count', async () => {
    const { update, profiles } = build();
    profiles.forgetUser.mockResolvedValue(3);
    const ctx = makeCtx();
    await update.onForgetConfirm(ctx as any);
    expect(profiles.forgetUser).toHaveBeenCalledWith(1);
    expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('3'));
  });

  it('forgetme:no cancels', async () => {
    const { update } = build();
    const ctx = makeCtx();
    await update.onForgetCancel(ctx as any);
    expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('Скасовано'));
  });

  it('an action on a foreign profile is rejected', async () => {
    const { update, profiles } = build();
    profiles.get.mockResolvedValue(profile({ userId: 999, paused: true }));
    const ctx = makeCtx({ match: ['del:a1', 'a1'] });
    await update.onDeletePrompt(ctx as any);
    expect(ctx.answerCbQuery).toHaveBeenCalledWith('Пошук не знайдено');
  });
});
