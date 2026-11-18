'use client';

import { useState } from 'react';
import { ConfigShell } from '@/components/config/ConfigShell';
import { OrderButtons, Switch } from '@/components/config/controls';
import { Badge, Button, Card, EmptyState, ErrorAlert, Spinner, cx } from '@/components/ui';
import { api } from '@/lib/api';
import type { ConfigCompany } from '@/lib/config/companies';
import { KIND_SHORT, describeAttributes, moveItem } from '@/lib/config/format';
import { DEAL_VIEW_KEYS, useConfigMutation, useProductLines, useProducts, useVocabularies } from '@/lib/config/queries';
import type { Product, ProductLine, ProductLinePatchInput, ProductPatchInput } from '@/lib/crm/types';
import { ProductDialog } from './ProductDialog';
import { ProductLineDialog } from './ProductLineDialog';
import './products.css';

export function ProductsView() {
  return (
    <ConfigShell
      view="catalog.view"
      manage="catalog.manage"
      intro="What each company sells: product lines (batches, mentorship, test series, software) and the products in them. Deals pick a product line and product from here."
    >
      {(company) => <Catalog company={company} />}
    </ConfigShell>
  );
}

type LineDialog = ProductLine | 'new' | null;
type ProductDialogState = { line: ProductLine; product: Product | null } | null;

function Catalog({ company }: { company: ConfigCompany }) {
  const lines = useProductLines(company.unit.id);
  const products = useProducts(company.unit.id);
  const vocabularies = useVocabularies();
  const [showInactive, setShowInactive] = useState(false);
  const [lineDialog, setLineDialog] = useState<LineDialog>(null);
  const [productDialog, setProductDialog] = useState<ProductDialogState>(null);

  const updateLine = useConfigMutation(({ id, body }: { id: string; body: ProductLinePatchInput }) =>
    api.patch<ProductLine>(`/product-lines/${id}`, body), { alsoInvalidate: DEAL_VIEW_KEYS });
  const updateProduct = useConfigMutation(({ id, body }: { id: string; body: ProductPatchInput }) => api.patch<Product>(`/products/${id}`, body));
  const reorderLines = useConfigMutation((ordered: ProductLine[]) =>
    Promise.all(ordered.flatMap((line, index) => (line.position === index ? [] : [api.patch<ProductLine>(`/product-lines/${line.id}`, { position: index })]))),
  );

  const kindLabel = (key: string) => vocabularies.data?.productKinds.find((kind) => kind.key === key)?.label ?? key;
  const allLines = lines.data ?? [];
  const visibleLines = showInactive ? allLines : allLines.filter((line) => line.active);
  const inactiveCount = allLines.filter((line) => !line.active).length + (products.data ?? []).filter((product) => !product.active).length;

  const header = (
    <div className="row gap-12 config-catalog__bar">
      {inactiveCount ? <Switch label={`Show ${inactiveCount} inactive`} checked={showInactive} onChange={setShowInactive} /> : null}
      <span className="spacer" />
      {company.canManage ? (
        <Button variant="primary" size="sm" icon="plus" onClick={() => setLineDialog('new')}>
          New product line
        </Button>
      ) : null}
    </div>
  );

  if (lines.isPending || products.isPending) {
    return (
      <div className="card">
        <div className="empty">
          <Spinner />
        </div>
      </div>
    );
  }
  if (lines.isError || products.isError) return <ErrorAlert error={lines.error ?? products.error} />;

  return (
    <div className="stack gap-16">
      {header}
      <ErrorAlert error={updateLine.error ?? updateProduct.error ?? reorderLines.error} />
      {visibleLines.length === 0 ? (
        <div className="card">
          <EmptyState icon="layers" title="No product lines yet">
            {company.canManage ? 'Add a product line, like “SAT group batches”, then its products.' : 'An admin has not set up products here yet.'}
          </EmptyState>
        </div>
      ) : (
        visibleLines.map((line, index) => {
          const items = (products.data ?? []).filter((product) => product.productLineId === line.id && (showInactive || product.active));
          return (
            <Card
              key={line.id}
              flush
              className={cx(!line.active && 'config-catalog__line--inactive')}
              title={
                <span className="row gap-8">
                  {line.name}
                  <Badge>{KIND_SHORT[line.audience]}</Badge>
                  {line.active ? null : <Badge tone="warning">Inactive</Badge>}
                </span>
              }
              description={
                <>
                  {kindLabel(line.kind)} · <span className="config-key">{line.key}</span>
                  {line.description ? ` · ${line.description}` : ''}
                </>
              }
              actions={
                <>
                {company.canManage ? (
                  <OrderButtons
                    label={line.name}
                    index={index}
                    count={visibleLines.length}
                    disabled={reorderLines.isPending}
                    onMove={(delta) => reorderLines.mutate(moveItem(visibleLines, index, delta))}
                  />
                ) : null}
                  <Switch
                    label={line.active ? 'Active' : 'Inactive'}
                    accessibleLabel={`Active: ${line.name}`}
                    hideLabel
                    checked={line.active}
                    disabled={!company.canManage || updateLine.isPending}
                    onChange={(active) => updateLine.mutate({ id: line.id, body: { active } })}
                  />
                  {company.canManage ? (
                    <>
                      <Button size="sm" variant="ghost" iconOnly icon="edit" aria-label={`Edit ${line.name}`} onClick={() => setLineDialog(line)} />
                      <Button size="sm" icon="plus" aria-label={`Add a product to ${line.name}`} onClick={() => setProductDialog({ line, product: null })}>
                        Product
                      </Button>
                    </>
                  ) : null}
                </>
              }
            >
              {items.length === 0 ? (
                <p className="config-catalog__empty small muted">No products in this line yet.</p>
              ) : (
                <ul className="config-list" aria-label={`Products in ${line.name}`}>
                  {items.map((product) => (
                    <li key={product.id} className={cx('config-row', !product.active && 'config-row--inactive')}>
                      <div className="config-row__main">
                        <span className="config-row__title">
                          {product.name}
                          {product.code ? <span className="config-key">{product.code}</span> : null}
                          {product.active ? null : <Badge tone="warning">Inactive</Badge>}
                        </span>
                        <span className="config-row__meta">
                          {describeAttributes(product.attributes) || product.description || 'No details yet'}
                        </span>
                      </div>
                      <div className="config-row__actions">
                        <Switch
                          label={product.active ? 'Active' : 'Inactive'}
                          accessibleLabel={`Active: ${product.name}`}
                          checked={product.active}
                          disabled={!company.canManage || updateProduct.isPending}
                          onChange={(active) => updateProduct.mutate({ id: product.id, body: { active } })}
                        />
                        {company.canManage ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            iconOnly
                            icon="edit"
                            aria-label={`Edit ${product.name}`}
                            onClick={() => setProductDialog({ line, product })}
                          />
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })
      )}

      <ProductLineDialog company={company} line={lineDialog} onClose={() => setLineDialog(null)} />
      <ProductDialog
        line={productDialog?.line ?? null}
        product={productDialog?.product ?? null}
        lines={allLines}
        open={productDialog !== null}
        onClose={() => setProductDialog(null)}
      />
    </div>
  );
}
