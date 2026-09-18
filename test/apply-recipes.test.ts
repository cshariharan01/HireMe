import './setup-db';
import { describe, it, expect, beforeEach } from 'vitest';
import db from '@/lib/db';
import {
  getRecipe,
  recordApplyAttempt,
  listRecipes,
  normalizeHost,
  DEFAULT_REVEAL_LABELS,
} from '@/lib/apply/recipes';

/**
 * Per-employer apply "memory". A host's recipe must accumulate gates across attempts (login /
 * CAPTCHA are OR-merged and never unset), must adopt labels that were observed to work, and must
 * never touch OTHER hosts' rows.
 */
describe('apply recipes (per-employer memory)', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM apply_recipes').run();
  });

  it('returns a default recipe for an unknown host', () => {
    const recipe = getRecipe('mycareer.accenture.com');
    expect(recipe.host).toBe('mycareer.accenture.com');
    expect(recipe.attempts).toBe(0);
    expect(recipe.revealLabels).toEqual(DEFAULT_REVEAL_LABELS);
    expect(recipe.loginRequired).toBe(false);
    expect(recipe.captchaGated).toBe(false);
    expect(recipe.lastOutcome).toBeNull();
  });

  it('normalizes hostnames (www stripped, scheme ignored)', () => {
    expect(normalizeHost('https://www.mycareer.accenture.com/jobs/1')).toBe('mycareer.accenture.com');
    expect(normalizeHost('WWW.EXAMPLE.COM')).toBe('example.com');
  });

  it('records the reveal labels that worked on first attempt', () => {
    recordApplyAttempt('jobs.somecompany.com', {
      revealLabels: ['Apply for this job', 'Start your application'],
      outcome: 'stopped_for_review',
    });
    const recipe = getRecipe('https://jobs.somecompany.com/openings');
    expect(recipe.attempts).toBe(1);
    expect(recipe.revealLabels).toEqual(['Apply for this job', 'Start your application']);
    expect(recipe.lastOutcome).toBe('stopped_for_review');
  });

  it('OR-merges login/CAPTCHA gates and increments attempts without losing learned labels', () => {
    recordApplyAttempt('a.example.com', { outcome: 'stopped_for_review' });
    recordApplyAttempt('a.example.com', { loginRequired: true, outcome: 'login' });
    recordApplyAttempt('a.example.com', { captchaGated: true, outcome: 'captcha' });

    const recipe = getRecipe('a.example.com');
    expect(recipe.attempts).toBe(3);
    expect(recipe.loginRequired).toBe(true);
    expect(recipe.captchaGated).toBe(true);
    expect(recipe.lastOutcome).toBe('captcha');
  });

  it('a closed posting is remembered and cannot be unset by a later open attempt', () => {
    recordApplyAttempt('closed.example.com', { closedPosting: true, outcome: 'posting_closed' });
    recordApplyAttempt('closed.example.com', { closedPosting: false, outcome: 'stopped_for_review' });
    expect(getRecipe('closed.example.com').closedPosting).toBe(true);
  });

  it('keeps hosts independent and lists most-recent-first', () => {
    recordApplyAttempt('first.example.com', { outcome: 'stopped_for_review' });
    recordApplyAttempt('second.example.com', { outcome: 'login' });
    const recipes = listRecipes();
    expect(recipes).toHaveLength(2);
    expect(recipes[0].host).toBe('second.example.com'); // most recently updated first
    expect(recipes[1].host).toBe('first.example.com');
  });

  it('persists to the DB (survives a fresh module lookup)', () => {
    recordApplyAttempt('persist.example.com', { revealLabels: ['Apply'], loginRequired: true });
    const fromDb = db.prepare('SELECT reveal_labels, login_required, attempts FROM apply_recipes WHERE host = ?')
      .get('persist.example.com') as Record<string, unknown>;
    expect(fromDb).toBeTruthy();
    expect(JSON.parse(String(fromDb.reveal_labels))).toEqual(['Apply']);
    expect(Number(fromDb.login_required)).toBe(1);
    expect(Number(fromDb.attempts)).toBe(1);
  });
});