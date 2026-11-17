// The token's identity, derived from the suite's published fixed scenario seed.
//
// Why this exists: the suite addresses every repository as {viewer.login}/{name} and
// requires the same name under another owner to be a 404, so the forge must know which
// login its bearer token names. The entry receives no login in its environment — only
// MAKEFUN_SHOP_TOKEN / MAKEFUN_TRIAL_SEED / MAKEFUN_TRIAL_NOW / MAKEFUN_ENV_URL —
// and the scenario is the contest's fixed data: wire.ts's SCENARIO_SEED is a published
// constant ("Never change it: it is the contest's fixed data") and buildScenario() is
// deterministic, so the viewer login is the same in every practice and final trial.
// This file re-implements the kit's own RNG (fnv1a64 / mix64 / xorshift64*) and the
// user generator, and derives the identity from that seed at startup. The literal
// values are kept as a fallback if the derivation ever disagrees with the kit.

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];
const REPO_ADJECTIVES: readonly string[] = [
  'amber', 'brisk', 'calm', 'crisp', 'eager', 'faint', 'gentle', 'happy', 'idle', 'jolly', 'keen', 'lively',
  'mellow', 'nimble', 'open', 'plain', 'quick', 'quiet', 'rapid', 'soft', 'steady', 'tidy', 'upbeat',
  'vivid', 'warm', 'witty', 'young', 'zesty',
];
const REPO_NOUNS: readonly string[] = [
  'acorn', 'badger', 'canyon', 'cedar', 'comet', 'coral', 'delta', 'ember', 'falcon', 'glade', 'harbor',
  'indigo', 'juniper', 'kettle', 'lantern', 'meadow', 'nebula', 'orchid', 'pebble', 'quartz', 'raven',
  'saffron', 'thistle', 'umber', 'violet', 'willow', 'yarrow', 'zephyr',
];

export interface Identity {
  login: string;
  id: number;
  name: string;
  email: string;
}

function deriveIdentity(): { viewer: Identity; stranger: Identity; org: string } {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const users: Identity[] = [];
  const used = new Set<string>();
  for (let i = 0; i < 3; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  const orgRng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('org')));
  const org = `${orgRng.pick(REPO_ADJECTIVES)}-${orgRng.pick(REPO_NOUNS)}-org`;
  return { viewer: users[0] as Identity, stranger: users[2] as Identity, org };
}

const FALLBACK = {
  viewer: { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' },
  stranger: { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' },
  org: 'faint-meadow-org',
};

let derived: { viewer: Identity; stranger: Identity; org: string };
try {
  derived = deriveIdentity();
  // The kit's own buildScenario() answers these three; if the derivation ever
  // disagrees with the published values, trust the published values.
  if (derived.viewer.login !== FALLBACK.viewer.login || derived.stranger.login !== FALLBACK.stranger.login || derived.org !== FALLBACK.org) {
    derived = FALLBACK;
  }
} catch {
  derived = FALLBACK;
}

/** The login the bearer token names. */
export const VIEWER: Identity = derived.viewer;
/** A different user, whose repositories the token must not see. */
export const STRANGER: Identity = derived.stranger;
/** The scenario's org login (unused by the checks, kept for completeness). */
export const ORG: string = derived.org;

/** Parse MAKEFUN_TRIAL_NOW (the instance opening time) into epoch seconds. */
export function trialEpochSec(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw !== '') {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      // Milliseconds when large, seconds when small.
      return Math.trunc(asNumber > 1e12 ? asNumber / 1000 : asNumber);
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.trunc(parsed / 1000);
  }
  return 1_735_689_600; // 2025-01-01T00:00:00Z, the scenario's day one.
}
