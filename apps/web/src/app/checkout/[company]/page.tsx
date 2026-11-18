import { CheckoutView } from './CheckoutView';

export default async function CheckoutPage({ params }: { params: Promise<{ company: string }> }) {
  const { company } = await params;
  return <CheckoutView company={company} />;
}
