import { TelegramService } from './telegram.service';
import { Listing } from '../sources/listing.interface';
import { SearchProfile } from '../search-profiles/search-profile.model';

const profile: SearchProfile = {
  id: 'p1',
  userId: 7,
  chatId: 55,
  name: 'Мій пошук',
  criteria: { city: 'Київ', ownerOnly: false },
  paused: false,
  primed: true,
  createdAt: 0,
};

const listing = (over: Partial<Listing> = {}): Listing => ({
  id: '1',
  title: 'Затишна квартира',
  price: 12000,
  currency: 'грн',
  area: 45,
  city: 'Київ',
  district: 'Центр',
  url: 'https://olx.ua/1',
  imageUrl: 'https://img/1.jpg',
  isBusiness: false,
  source: 'olx',
  sourceLabel: 'OLX',
  ...over,
});

const makeBot = () => ({
  telegram: {
    sendMessage: jest.fn().mockResolvedValue(undefined),
    sendPhoto: jest.fn().mockResolvedValue(undefined),
    setMyCommands: jest.fn().mockResolvedValue(undefined),
  },
});

describe('TelegramService', () => {
  it('registers the command menu on bootstrap', async () => {
    const bot = makeBot();
    await new TelegramService(bot as any).onApplicationBootstrap();
    expect(bot.telegram.setMyCommands).toHaveBeenCalled();
  });

  it('swallows setMyCommands failures', async () => {
    const bot = makeBot();
    bot.telegram.setMyCommands.mockRejectedValueOnce(new Error('x'));
    await expect(new TelegramService(bot as any).onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it('sends a new-listing photo with a rich caption to the profile chat', async () => {
    const bot = makeBot();
    await new TelegramService(bot as any).notifyNewListing(profile, listing());
    expect(bot.telegram.sendPhoto).toHaveBeenCalled();
    const [chatId, , extra] = bot.telegram.sendPhoto.mock.calls[0];
    expect(chatId).toBe(55);
    expect(extra.caption).toContain('Нове оголошення');
    expect(extra.caption).toContain('OLX');
    expect(extra.caption).toContain('12'); // formatted price
  });

  it('falls back to a text message when the photo fails', async () => {
    const bot = makeBot();
    bot.telegram.sendPhoto.mockRejectedValueOnce(new Error('bad image'));
    await new TelegramService(bot as any).notifyNewListing(profile, listing());
    expect(bot.telegram.sendMessage).toHaveBeenCalled();
  });

  it('sends a text message when there is no image', async () => {
    const bot = makeBot();
    await new TelegramService(bot as any).notifyNewListing(profile, listing({ imageUrl: undefined }));
    expect(bot.telegram.sendPhoto).not.toHaveBeenCalled();
    expect(bot.telegram.sendMessage).toHaveBeenCalled();
  });

  it('formats a price-change caption (old → new)', async () => {
    const bot = makeBot();
    await new TelegramService(bot as any).notifyPriceChange(
      profile,
      listing({ price: 9000, imageUrl: undefined }),
      12000,
    );
    const caption = bot.telegram.sendMessage.mock.calls.pop()![1];
    expect(caption).toContain('Зміна ціни');
  });

  it('renders "Ціна договірна" for a null price', async () => {
    const bot = makeBot();
    await new TelegramService(bot as any).notifyNewListing(
      profile,
      listing({ price: null, imageUrl: undefined }),
    );
    expect(bot.telegram.sendMessage.mock.calls.pop()![1]).toContain('Ціна договірна');
  });

  it('sendText posts a plain HTML message', async () => {
    const bot = makeBot();
    await new TelegramService(bot as any).sendText(5, 'hi');
    expect(bot.telegram.sendMessage).toHaveBeenCalledWith(5, 'hi', { parse_mode: 'HTML' });
  });
});
