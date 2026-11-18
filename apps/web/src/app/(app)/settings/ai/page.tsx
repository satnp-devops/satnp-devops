import type { Metadata } from 'next';
import { ReviewQueueView } from './ReviewQueueView';

export const metadata: Metadata = { title: 'AI review queue' };

export default function AiReviewQueuePage() {
  return <ReviewQueueView />;
}
