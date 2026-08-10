import { describe, expect, it } from 'vitest';
import {
  checkPassword, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH,
} from '../shared/constants/credentials.js';

/**
 * The password rule, tested at its edges.
 *
 * The case that gave this file its reason to exist is the first one: before the
 * validation of August 2026, the literal string "password" was an acceptable
 * password for an account holding a laboratory's quality records.
 */
describe('password policy', () => {
  it('refuses the passwords people actually choose', () => {
    for (const bad of ['password', 'Password1234', 'passw0rd1234', 'qwertyuiop12', 'letmein12345']) {
      const verdict = checkPassword(bad);
      expect(verdict.ok, `expected "${bad}" to be refused`).toBe(false);
      expect(verdict.error).toBeTruthy();
    }
  });

  it('refuses anything shorter than the stated minimum', () => {
    expect(checkPassword('a'.repeat(MIN_PASSWORD_LENGTH - 1)).ok).toBe(false);
    expect(checkPassword('Sh0rt!').ok).toBe(false);
    expect(checkPassword('').ok).toBe(false);
  });

  it('refuses a password long enough to make bcrypt the bottleneck', () => {
    expect(checkPassword('x'.repeat(MAX_PASSWORD_LENGTH + 1)).ok).toBe(false);
  });

  it('refuses runs and repeats', () => {
    expect(checkPassword('brilliantaaa-lab').ok).toBe(false);   // aaa
    expect(checkPassword('quality-abcd-lab').ok).toBe(false);   // abcd
    expect(checkPassword('theatre-3456-run').ok).toBe(false);   // 3456
  });

  it('refuses a password containing the person’s own name or username', () => {
    expect(checkPassword('kwame-mensah-lab', { username: 'kwame' }).ok).toBe(false);
    expect(checkPassword('the-mensah-bench', { fullName: 'Kwame Mensah' }).ok).toBe(false);
  });

  it('accepts a memorable phrase', () => {
    for (const good of ['blue heron tuesday', 'seventeen wet umbrellas', 'the fridge in bay two']) {
      const verdict = checkPassword(good, { username: 'kwame', fullName: 'Kwame Mensah' });
      expect(verdict.ok, `expected "${good}" to be accepted: ${verdict.error}`).toBe(true);
    }
  });

  it('refuses leading or trailing whitespace rather than silently trimming it', () => {
    expect(checkPassword(' blue heron tuesday').ok).toBe(false);
    expect(checkPassword('blue heron tuesday ').ok).toBe(false);
  });
});
