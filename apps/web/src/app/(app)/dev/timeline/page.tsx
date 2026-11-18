import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { TimelineDemo } from './TimelineDemo';

const isProduction = process.env.NODE_ENV === 'production';

export const metadata: Metadata = isProduction ? {} : { title: 'Timeline and tasks', robots: { index: false } };

/** <Timeline /> and <TaskList /> on seeded deals, people and institutes. Not part of production builds. */
export default function TimelineDevPage() {
  if (isProduction) notFound();
  return <TimelineDemo />;
}
