import type { Metadata } from 'next';
import { MyTasks } from './MyTasks';

export const metadata: Metadata = { title: 'My tasks' };

export default function TasksPage() {
  return <MyTasks />;
}
