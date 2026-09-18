// Shared types for platform-specific apply adapters (LinkedIn, Naukri).
//
// Every adapter receives the Playwright Page, the candidate profile, and the
// path to a tailored-resume PDF on disk. It fills supported fields, answers
// questions for which it has a known answer, attaches the PDF, navigates safe
// multi-step flows, and STOPS when it detects the final Submit/Apply button.
//
// The safety guarantee: adapters detect submit buttons but never click them.
// The caller (apply/route.ts) returns control to the user, who reviews and
// submits manually.

import type { Page } from 'playwright';

// ----- Profile shape ---------------------------------------------------------

export interface CandidateProfile {
  name?: string;
  email?: string;
  phone?: string;
  location?: string;
  linkedin?: string;
  currentCompany?: string;
  currentJobTitle?: string;
  /** Years of experience as a number (e.g. 3.6). */
  yearsExperience?: number;
  yearsOfExperience?: number;
  totalExperienceMonths?: number;
  dateOfBirth?: string;
  noticePeriodDays?: number;
  currentCtcInr?: number;
  expectedCtcInr?: number;
  street?: string;
  city?: string;
  state?: string;
  country?: string;
  zipCode?: string;
  pincode?: string;
  portfolioUrl?: string;
  /** Any additional key-value pairs for question answering. */
  [key: string]: unknown;
}

// ----- Question answering ----------------------------------------------------

export type QuestionType =
  | 'radio'
  | 'text'
  | 'textarea'
  | 'select'
  | 'checkbox'
  | 'file_upload'
  | 'unknown';

export interface PlatformQuestion {
  label: string;
  type: QuestionType;
  options?: string[];          // for radio/select
  value?: string;              // pre-filled or answered value
}

// ----- Adapter results -------------------------------------------------------

export type PlatformStatus =
  | 'submitted'              // final submit button was clicked
  | 'already_applied'        // job was already applied to on the platform
  | 'cancelled'              // stopped by user
  | 'stopped_for_review'       // submit button detected; user must review + submit
  | 'external_apply'           // no in-app form; job hands off to an offsite apply link
  | 'captcha'                  // CAPTCHA detected; user must solve manually
  | 'login_required'           // redirected to login page
  | 'error'                    // something went wrong
  | 'no_form';                // no fillable form found on page

export interface PlatformResult {
  status: PlatformStatus;
  filledFields: string[];
  resumeAttached: boolean;
  stepCount: number;
  error?: string;
  /** Present when status === 'external_apply': the offsite apply URL to hand off to. */
  externalUrl?: string;
  /** True when the application has reached the final review page and the submit button is ready. */
  readyForSubmit?: boolean;
}

// ----- Adapter interface -----------------------------------------------------

export interface PlatformAdapter {
  /** Detect whether the page has a submit/apply button ready for final submission. */
  detectSubmitButton(page: Page): Promise<boolean>;

  /** Detect whether a CAPTCHA is visible on the current page. */
  detectCaptcha(page: Page): Promise<boolean>;

  /** Detect whether the user has been redirected to a login page. */
  detectLoginRequired(page: Page): Promise<boolean>;
}

// ----- Submission plan shapes ------------------------------------------------

export interface LinkedInSubmissionPlan {
  strategy: 'linkedin';
  url: string;
  jobTitle: string;
  company: string;
  fields: Array<{
    name: string;
    type: string;
    label: string;
    required: boolean;
    value: string | null;
  }>;
  attachments: {
    resume?: { filename: string; mimeType: string; bytes: Uint8Array };
    coverLetter?: { filename: string; mimeType: string; bytes: Uint8Array };
  };
}

export interface NaukriSubmissionPlan {
  strategy: 'naukri';
  url: string;
  jobTitle: string;
  company: string;
  fields: Array<{
    name: string;
    type: string;
    label: string;
    required: boolean;
    value: string | null;
  }>;
  attachments: {
    resume?: { filename: string; mimeType: string; bytes: Uint8Array };
    coverLetter?: { filename: string; mimeType: string; bytes: Uint8Array };
  };
}
