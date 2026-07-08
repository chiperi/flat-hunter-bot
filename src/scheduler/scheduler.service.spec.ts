import { SchedulerService } from './scheduler.service';
import { Listing } from '../sources/listing.interface';
import { SearchProfile } from '../search-profiles/search-profile.model';

const profile = (over: Partial<SearchProfile> = {}): SearchProfile => ({
  id: 'p1',
  userId: 1,
  chatId: 1,
  source: 'olx',
  name: 'n',
  criteria: { city: 'Київ', ownerOnly: false },
  paused: false,
  primed: true,
  createdAt: 0,
  ...over,
});

const listing = (over: Partial<Listing> = {}): Listing => ({
  id: '1',
  title: 'F',
  price: 10000,
  currency: 'грн',
  area: 45,
  city: 'Київ',
  district: 'Центр',
  url: 'u',
  isBusiness: false,
  source: 'olx',
  sourceLabel: 'OLX',
  ...over,
});

const build = () => {
  const config = { get: jest.fn().mockReturnValue({ intervalMs: 1000, jitterMs: 100 }) };
  const profiles = { listAll: jest.fn(), update: jest.fn().mockResolvedValue(undefined) };
  const seen = {
    seed: jest.fn().mockResolvedValue(undefined),
    getAll: jest.fn().mockResolvedValue(new Map()),
    markSeen: jest.fn().mockResolvedValue(undefined),
  };
  const telegram = {
    notifyNewListing: jest.fn().mockResolvedValue(undefined),
    notifyPriceChange: jest.fn().mockResolvedValue(undefined),
  };
  const sources = {
    has: jest.fn().mockReturnValue(true),
    fetchOne: jest.fn().mockResolvedValue([]),
    count: 1,
  };
  const scheduler = new SchedulerService(
    config as any,
    profiles as any,
    seen as any,
    telegram as any,
    sources as any,
  );
  return { scheduler, config, profiles, seen, telegram, sources };
};

describe('SchedulerService.runCycle', () => {
  it('does nothing when there are no active profiles', async () => {
    const { scheduler, profiles, sources } = build();
    profiles.listAll.mockResolvedValue([profile({ paused: true })]);
    await scheduler.runCycle();
    expect(sources.fetchOne).not.toHaveBeenCalled();
  });

  it('primes a fresh profile silently', async () => {
    const { scheduler, profiles, seen, telegram, sources } = build();
    profiles.listAll.mockResolvedValue([profile({ primed: false })]);
    sources.fetchOne.mockResolvedValue([listing({ id: '1' })]);
    await scheduler.runCycle();
    expect(seen.seed).toHaveBeenCalledWith('p1', [{ id: 'olx:1', price: 10000 }]);
    expect(profiles.update).toHaveBeenCalled();
    expect(telegram.notifyNewListing).not.toHaveBeenCalled();
  });

  it('notifies + marks seen for a new listing', async () => {
    const { scheduler, profiles, seen, telegram, sources } = build();
    profiles.listAll.mockResolvedValue([profile()]);
    sources.fetchOne.mockResolvedValue([listing({ id: '1', price: 10000 })]);
    seen.getAll.mockResolvedValue(new Map());
    await scheduler.runCycle();
    expect(telegram.notifyNewListing).toHaveBeenCalledTimes(1);
    expect(seen.markSeen).toHaveBeenCalledWith('p1', 'olx:1', 10000);
  });

  it('notifies on a price change', async () => {
    const { scheduler, profiles, seen, telegram, sources } = build();
    profiles.listAll.mockResolvedValue([profile()]);
    sources.fetchOne.mockResolvedValue([listing({ id: '1', price: 10000 })]);
    seen.getAll.mockResolvedValue(new Map([['olx:1', 9000]]));
    await scheduler.runCycle();
    expect(telegram.notifyPriceChange).toHaveBeenCalledWith(expect.anything(), expect.anything(), 9000);
    expect(telegram.notifyNewListing).not.toHaveBeenCalled();
  });

  it('stays silent for a seen, unchanged listing', async () => {
    const { scheduler, profiles, seen, telegram, sources } = build();
    profiles.listAll.mockResolvedValue([profile()]);
    sources.fetchOne.mockResolvedValue([listing({ id: '1', price: 10000 })]);
    seen.getAll.mockResolvedValue(new Map([['olx:1', 10000]]));
    await scheduler.runCycle();
    expect(telegram.notifyNewListing).not.toHaveBeenCalled();
    expect(telegram.notifyPriceChange).not.toHaveBeenCalled();
  });

  it('dedupes identical searches to one fetch', async () => {
    const { scheduler, profiles, sources } = build();
    profiles.listAll.mockResolvedValue([
      profile({ id: 'p1' }),
      profile({ id: 'p2' }),
    ]);
    await scheduler.runCycle();
    expect(sources.fetchOne).toHaveBeenCalledTimes(1);
  });

  it('does not mark seen when the notification fails', async () => {
    const { scheduler, profiles, seen, telegram, sources } = build();
    profiles.listAll.mockResolvedValue([profile()]);
    sources.fetchOne.mockResolvedValue([listing({ id: '1' })]);
    seen.getAll.mockResolvedValue(new Map());
    telegram.notifyNewListing.mockRejectedValue(new Error('blocked'));
    await expect(scheduler.runCycle()).resolves.toBeUndefined();
    expect(seen.markSeen).not.toHaveBeenCalled();
  });

  it('skips listings outside the criteria', async () => {
    const { scheduler, profiles, sources, telegram } = build();
    profiles.listAll.mockResolvedValue([profile({ criteria: { city: 'Київ', priceMax: 5000, ownerOnly: false } })]);
    sources.fetchOne.mockResolvedValue([listing({ id: '1', price: 99999 })]);
    await scheduler.runCycle();
    expect(telegram.notifyNewListing).not.toHaveBeenCalled();
  });
});

describe('SchedulerService lifecycle', () => {
  afterEach(() => jest.useRealTimers());

  it('schedules a first tick on init and clears on destroy', () => {
    jest.useFakeTimers();
    const setSpy = jest.spyOn(global, 'setTimeout');
    const { scheduler } = build();
    scheduler.onModuleInit();
    expect(setSpy).toHaveBeenCalled();
    scheduler.onModuleDestroy();
  });

  it('tick runs a cycle then reschedules; overlap is skipped', async () => {
    jest.useFakeTimers();
    const { scheduler, profiles } = build();
    profiles.listAll.mockResolvedValue([]);
    await (scheduler as any).tick();
    expect(profiles.listAll).toHaveBeenCalledTimes(1);

    (scheduler as any).running = true;
    await (scheduler as any).tick(); // overlap → returns early
    expect(profiles.listAll).toHaveBeenCalledTimes(1);
    scheduler.onModuleDestroy();
  });
});
