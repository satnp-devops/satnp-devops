import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './checkout.css';

export const metadata: Metadata = { title: 'Admission', robots: { index: false, follow: false } };

/** The public checkout: no sign-in, no app shell. */
export default function CheckoutLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <main className="delivery-checkout">{children}</main>;
}
