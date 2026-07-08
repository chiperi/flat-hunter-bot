import { SearchProfilesService } from './search-profiles.service';
import { SearchProfile } from './search-profile.model';

const makeRepos = () => ({
  profiles: {
    save: jest.fn().mockResolvedValue(undefined),
    get: jest.fn(),
    delete: jest.fn().mockResolvedValue(undefined),
    listByUser: jest.fn(),
    listAll: jest.fn(),
    listIdsByUser: jest.fn(),
  },
  seen: { clear: jest.fn().mockResolvedValue(undefined) },
});

const build = () => {
  const repos = makeRepos();
  const service = new SearchProfilesService(repos.profiles as any, repos.seen as any);
  return { service, ...repos };
};

describe('SearchProfilesService', () => {
  it('upsertForSource() mints an 8-hex id and saves a source-scoped profile', async () => {
    const { service, profiles } = build();
    profiles.listByUser.mockResolvedValue([]);
    const p = await service.upsertForSource(5, 9, 'domria', { city: 'Київ', ownerOnly: true });
    expect(p.id).toMatch(/^[0-9a-f]{8}$/);
    expect(p).toMatchObject({ userId: 5, chatId: 9, source: 'domria', name: 'Київ', primed: false });
    expect(profiles.save).toHaveBeenCalledWith(p);
  });

  it('upsertForSource() honours an explicit name', async () => {
    const { service, profiles } = build();
    profiles.listByUser.mockResolvedValue([]);
    const p = await service.upsertForSource(1, 1, 'olx', { city: 'Київ', ownerOnly: false }, 'Гараж');
    expect(p.name).toBe('Гараж');
  });

  it('never adds a second filter for the same site (one-per-site block)', async () => {
    const { service, profiles } = build();
    const existing = { id: 'keep', userId: 1, source: 'domria', criteria: {}, primed: true, name: 'x' };
    profiles.listByUser.mockResolvedValue([existing]);
    const p = await service.upsertForSource(1, 1, 'domria', { city: 'Львів', ownerOnly: false });
    expect(p.id).toBe('keep'); // reused the existing profile, not a new one
  });

  it('findByUserAndSource() returns the matching site filter', async () => {
    const { service, profiles } = build();
    profiles.listByUser.mockResolvedValue([
      { id: 'a', source: 'olx' },
      { id: 'b', source: 'domria' },
    ]);
    expect((await service.findByUserAndSource(1, 'domria'))?.id).toBe('b');
    expect(await service.findByUserAndSource(1, 'lun')).toBeNull();
  });

  it('upsertForSource() creates when no filter exists for the site', async () => {
    const { service, profiles } = build();
    profiles.listByUser.mockResolvedValue([]);
    const p = await service.upsertForSource(1, 1, 'domria', { city: 'Київ', ownerOnly: false });
    expect(p.source).toBe('domria');
    expect(profiles.save).toHaveBeenCalled();
  });

  it('upsertForSource() overwrites the existing filter and re-primes', async () => {
    const { service, profiles } = build();
    const existing = {
      id: 'x',
      userId: 1,
      source: 'domria',
      criteria: { city: 'Old', ownerOnly: false },
      primed: true,
      name: 'old',
    };
    profiles.listByUser.mockResolvedValue([existing]);
    const p = await service.upsertForSource(1, 1, 'domria', { city: 'Київ', ownerOnly: false });
    expect(p.id).toBe('x');
    expect(p.criteria.city).toBe('Київ');
    expect(p.primed).toBe(false);
  });

  it('setPaused() returns null for a missing or foreign profile', async () => {
    const { service, profiles } = build();
    profiles.get.mockResolvedValueOnce(null);
    expect(await service.setPaused('x', 1, true)).toBeNull();
    profiles.get.mockResolvedValueOnce({ id: 'x', userId: 2 } as SearchProfile);
    expect(await service.setPaused('x', 1, true)).toBeNull();
  });

  it('setPaused() toggles and persists an owned profile', async () => {
    const { service, profiles } = build();
    const prof = { id: 'x', userId: 1, paused: false } as SearchProfile;
    profiles.get.mockResolvedValue(prof);
    const r = await service.setPaused('x', 1, true);
    expect(r?.paused).toBe(true);
    expect(profiles.save).toHaveBeenCalledWith(prof);
  });

  it('delete() guards ownership and clears seen state', async () => {
    const { service, profiles, seen } = build();
    profiles.get.mockResolvedValueOnce(null);
    expect(await service.delete('x', 1)).toBe(false);

    const prof = { id: 'x', userId: 1 } as SearchProfile;
    profiles.get.mockResolvedValue(prof);
    expect(await service.delete('x', 1)).toBe(true);
    expect(profiles.delete).toHaveBeenCalledWith(prof);
    expect(seen.clear).toHaveBeenCalledWith('x');
  });

  it('forgetUser() removes every profile + seen hash and returns the count', async () => {
    const { service, profiles, seen } = build();
    profiles.listIdsByUser.mockResolvedValue(['a', 'b']);
    profiles.get.mockImplementation((id: string) => Promise.resolve({ id, userId: 1 }));
    const n = await service.forgetUser(1);
    expect(n).toBe(2);
    expect(profiles.delete).toHaveBeenCalledTimes(2);
    expect(seen.clear).toHaveBeenCalledTimes(2);
  });

  it('exposes simple pass-throughs', async () => {
    const { service, profiles } = build();
    profiles.get.mockResolvedValue({ id: 'x' });
    profiles.listByUser.mockResolvedValue([{ id: 'x' }]);
    profiles.listAll.mockResolvedValue([{ id: 'x' }]);
    await expect(service.get('x')).resolves.toEqual({ id: 'x' });
    await expect(service.listByUser(1)).resolves.toHaveLength(1);
    await expect(service.listAll()).resolves.toHaveLength(1);
    await service.update({ id: 'x' } as SearchProfile);
    expect(profiles.save).toHaveBeenCalled();
  });
});
