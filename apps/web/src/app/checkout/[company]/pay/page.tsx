import { Suspense } from 'react';
import { DevPayView } from './DevPayView';

export default async function DevPayPage({ params }: { params: Promise<{ company: string }> }) {
  const { company } = await params;
  return (
    <Suspense fallback={null}>
      <DevPayView company={company} />
    </Suspense>
  );
}
