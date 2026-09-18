import { describe, it, expect, vi, afterEach } from 'vitest';
import { submitGreenhouse } from '@/lib/apply/greenhouse';
import { submitAshby } from '@/lib/apply/ashby';

/**
 * Dry-run must be a NETWORK guarantee, not a label.
 *
 * The whole value of the toggle is that nothing reaches the portal. These tests stub `fetch` and
 * assert it is never called — if a future refactor moved the guard below the POST, the result
 * would still say `dryRun: true` while an application had genuinely been submitted to a real
 * company. That is not a failure you can take back.
 */
const ghPlan = {
  slug: 'acme',
  jobId: '123',
  fields: [
    { name: 'first_name', type: 'input_text', label: 'First name', required: true, value: 'Test' },
    { name: 'email', type: 'input_text', label: 'Email', required: true, value: 't@example.com' },
  ],
} as unknown as Parameters<typeof submitGreenhouse>[0];

const ashbyPlan = {
  company: 'acme',
  jobPostingId: 'abc',
  fields: [
    { path: '_systemfield_name', type: 'String', label: 'Name', required: true, value: 'Test', display: 'Test' },
  ],
  // `submitAshby` reads `plan.attachments` while building the multipart body, which happens before
  // the dry-run guard — a plan without it throws. Real plans always carry it (prepareSubmission
  // sets it), so this mirrors production rather than papering over a bug.
  attachments: { resume: null, coverLetter: null },
} as unknown as Parameters<typeof submitAshby>[0];

afterEach(() => vi.unstubAllGlobals());

describe('dry-run never touches the network', () => {
  it('Greenhouse: no fetch is issued', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', spy);

    const res = await submitGreenhouse(ghPlan, { dryRun: true });

    expect(spy).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect((res.responseBody as { dryRun?: boolean })?.dryRun).toBe(true);
  });

  it('Greenhouse: a REAL submit does issue a fetch (proves the test can tell them apart)', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', spy);

    await submitGreenhouse(ghPlan, { dryRun: false });

    expect(spy).toHaveBeenCalledTimes(1);
    const url = String((spy.mock.calls as unknown as unknown[][])[0][0]);
    expect(url).toContain('boards-api.greenhouse.io');
  });

  it('Ashby: no fetch is issued in dry-run', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', spy);

    const res = await submitAshby(ashbyPlan, { dryRun: true });

    expect(spy).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
  });

  it('the required-answer gate fires BEFORE any network call, dry-run or not', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', spy);

    const incomplete = {
      ...ghPlan,
      fields: [
        { name: 'first_name', type: 'input_text', label: 'First name', required: true, value: null },
      ],
    } as unknown as Parameters<typeof submitGreenhouse>[0];

    const res = await submitGreenhouse(incomplete, { dryRun: false });

    expect(spy).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/missing required answer/i);
    // and it must name the field, so the user can fix it
    expect(res.error).toMatch(/First name/);
  });
});
