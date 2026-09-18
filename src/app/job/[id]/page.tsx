'use client';

import { useParams } from 'next/navigation';
import { JobDetailPanel } from '@/components/job-detail-panel';

// Route entry: /job/[id] renders the shared detail panel full-page (with back + prev/next bar).
export default function JobDetailPage() {
  const params = useParams();
  return <JobDetailPanel jobId={params.id as string | undefined} variant="page" />;
}
