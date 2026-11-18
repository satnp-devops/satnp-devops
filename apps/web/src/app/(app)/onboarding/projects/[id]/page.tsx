import type { Metadata } from 'next';
import { ProjectView } from './ProjectView';

export const metadata: Metadata = { title: 'Implementation project' };

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProjectView id={id} />;
}
