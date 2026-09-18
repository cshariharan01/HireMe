export const FHIR_TERMS = [
  'FHIR R4', 'FHIR STU3', 'FHIR R5', 'HL7', 'HL7 v2', 'HL7 CDA',
  'SMART on FHIR', 'CDS Hooks', 'Bulk FHIR', 'FHIR API', 'HL7 FHIR',
];

export const EHR_TERMS = [
  'Epic', 'Cerner', 'Oracle Health', 'Meditech', 'Allscripts',
  'Epic App Orchard', 'athenahealth', 'Cerner Millennium', 'Epic Bridges',
  'Epic Caboodle', 'eClinicalWorks', 'NextGen',
];

export const REGULATORY_TERMS = [
  'CMS', 'ONC', 'HIPAA', 'USCDI', 'TEFCA', 'Prior Auth',
  '21st Century Cures', 'interoperability', 'HITECH', 'PHI', 'CCDA', 'C-CDA',
];

export const INTEGRATION_TERMS = [
  'Mirth Connect', 'Azure Health Data Services',
  'AWS HealthLake', 'DICOM', 'IHE', 'SNOMED', 'LOINC', 'ICD-10', 'RxNorm',
];

export const ALL_TERMS = [
  ...FHIR_TERMS,
  ...EHR_TERMS,
  ...REGULATORY_TERMS,
  ...INTEGRATION_TERMS,
];

export function isDomainPriority(text: string): boolean {
  const lower = text.toLowerCase();
  let count = 0;
  for (const term of ALL_TERMS) {
    if (lower.includes(term.toLowerCase())) {
      count++;
      if (count >= 3) return true;
    }
  }
  return false;
}

export function getOntologyBoost(text: string): number {
  return isDomainPriority(text) ? 0.05 : 0;
}

// Generic, resume-driven domain boost. `terms` come from the profile's derived
// `domain_terms` (see deriveDomainTerms in llm.ts). A job whose text contains ≥3 of
// the candidate's own domain terms gets the same +0.05 nudge the hardcoded healthcare
// ontology used to give — but now the vocabulary follows the resume, so it works for
// any field. Falls back to the hardcoded ontology when the profile has no domain_terms
// yet (e.g. a resume uploaded before this feature, or if derivation failed).
export function getDomainBoost(text: string, terms: string[] | undefined | null): number {
  if (!terms || terms.length === 0) return getOntologyBoost(text);
  const lower = text.toLowerCase();
  let count = 0;
  for (const term of terms) {
    const t = term.trim().toLowerCase();
    if (t && lower.includes(t)) {
      count++;
      if (count >= 3) return 0.05;
    }
  }
  return 0;
}
