import type { Metadata } from 'next';
import { ProjectsView } from './ProjectsView';

export const metadata: Metadata = { title: 'Implementation' };

export default function ProjectsPage() {
  return <ProjectsView />;
}
