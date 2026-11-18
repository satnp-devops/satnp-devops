import { Suspense } from 'react';
import { DoneView } from './DoneView';

export default async function CheckoutDonePage({ params }: { params: Promise<{ company: string }> }) {
  const { company } = await params;
  return (
    <Suspense fallback={null}>
      <DoneView company={company} />
    </Suspense>
  );
}
