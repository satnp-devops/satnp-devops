import Link from 'next/link';
import { AuthCard } from '@/components/AuthCard';

export default function NotFound() {
  return (
    <main className="auth">
      <AuthCard title="Page not found" subtitle="The link may be old, or the page may have moved.">
        <Link href="/" className="btn btn--primary btn--block">
          Go to the home page
        </Link>
      </AuthCard>
    </main>
  );
}
