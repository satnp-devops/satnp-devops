'use client';

import { Fragment, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, EmptyState, ErrorAlert, Spinner } from '@/components/ui';
import {
  SPEC_URL,
  authLabel,
  constraints,
  describeType,
  endpointMatches,
  fetchOpenApi,
  groupEndpoints,
  inlineParts,
  jsonContent,
  refName,
  resolveResponse,
  resolveSchema,
  type Endpoint,
  type JsonSchema,
  type OpenApiDocument,
  type Operation,
} from './openapi';

// The API reference, drawn from GET /api/v1/openapi.json. New modules appear here on their own:
// the document is generated from the routes the API registers.

const METHOD_TONE: Record<string, 'accent' | 'success' | 'warning' | 'danger' | 'default'> = {
  get: 'accent',
  post: 'success',
  put: 'warning',
  patch: 'warning',
  delete: 'danger',
};

const MAX_DEPTH = 4;

export function ApiDocsView() {
  const spec = useQuery({ queryKey: ['openapi'], queryFn: fetchOpenApi, staleTime: Infinity, retry: false });

  if (spec.isPending) {
    return (
      <Card>
        <div className="empty">
          <Spinner />
        </div>
      </Card>
    );
  }
  if (spec.isError) {
    return (
      <Card>
        <div className="card__body">
          <ErrorAlert error={spec.error} title="The API reference could not be loaded" />
        </div>
      </Card>
    );
  }
  return <Reference doc={spec.data} />;
}

function Reference({ doc }: { doc: OpenApiDocument }) {
  const [query, setQuery] = useState('');
  const [module, setModule] = useState('');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const groups = useMemo(() => groupEndpoints(doc), [doc]);
  const total = groups.reduce((n, g) => n + g.endpoints.length, 0);
  const visible = groups
    .filter((g) => !module || g.tag === module)
    .map((g) => ({ ...g, endpoints: g.endpoints.filter((e) => endpointMatches(e, query)) }))
    .filter((g) => g.endpoints.length > 0);
  const server = doc.servers?.[0]?.url ?? '/api/v1';

  return (
    <div className="stack gap-20">
      <Card
        title={doc.info.title}
        description={`Version ${doc.info.version} · OpenAPI ${doc.openapi} · ${total} endpoints`}
        actions={
          <a className="btn btn--sm" href={SPEC_URL} download="phoenix-openapi.json">
            Download openapi.json
          </a>
        }
      >
        <div className="card__body stack gap-12">
          <dl className="kv">
            <dt>Base URL</dt>
            <dd className="mono">{server}</dd>
            <dt>Success</dt>
            <dd>
              <code className="mono">{'{ "data": … }'}</code>; lists <code className="mono">{'{ "data": [ … ], "nextCursor" }'}</code>{' '}
              — pass <code className="mono">cursor</code> back for the next page
            </dd>
            <dt>Errors</dt>
            <dd>
              <code className="mono">{'{ "error": { "code", "message", "details", "requestId" } }'}</code>
            </dd>
            <dt>Sign-in</dt>
            <dd>
              Session cookie from <code className="mono">POST /auth/login</code>. Every write also sends the{' '}
              <code className="mono">X-Phoenix-Client</code> header.
              {doc.components?.securitySchemes?.apiKey ? (
                <>
                  {' '}
                  Or an API key: <code className="mono">Authorization: Bearer …</code>
                </>
              ) : null}
            </dd>
          </dl>
          <p className="small muted">
            Import the document into Postman, Insomnia or a client generator. It is generated from the API&apos;s own routes and
            validation rules, so it always matches what the server accepts.
          </p>
        </div>
      </Card>

      <Card flush>
        <div className="toolbar">
          <input
            className="input toolbar__search"
            type="search"
            placeholder="Search paths, summaries, permissions"
            aria-label="Search endpoints"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select
            className="select toolbar__select"
            aria-label="Module"
            value={module}
            onChange={(event) => setModule(event.target.value)}
          >
            <option value="">All modules</option>
            {groups.map((g) => (
              <option key={g.tag} value={g.tag}>
                {g.label}
              </option>
            ))}
          </select>
        </div>
      </Card>

      {visible.length === 0 ? (
        <Card>
          <EmptyState icon="search" title="No endpoints match">
            Try another word, or show all modules.
          </EmptyState>
        </Card>
      ) : (
        visible.map((group) => (
          <Card
            key={group.tag}
            flush
            title={group.label}
            description={`${group.endpoints.length} endpoint${group.endpoints.length === 1 ? '' : 's'}`}
          >
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Endpoint</th>
                    <th scope="col">What it does</th>
                    <th scope="col">Needs</th>
                    <th scope="col">
                      <span className="visually-hidden">Details</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {group.endpoints.map((endpoint) => (
                    <Fragment key={endpoint.key}>
                      <EndpointRow
                        endpoint={endpoint}
                        open={openKey === endpoint.key}
                        onToggle={() => setOpenKey(openKey === endpoint.key ? null : endpoint.key)}
                      />
                      {openKey === endpoint.key ? (
                        <tr className="detail-row">
                          <td colSpan={4}>
                            <EndpointDetails doc={doc} operation={endpoint.operation} />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ))
      )}

      <SchemaList doc={doc} />
    </div>
  );
}

function EndpointRow({ endpoint, open, onToggle }: { endpoint: Endpoint; open: boolean; onToggle: () => void }) {
  const { operation } = endpoint;
  const permissions = operation['x-permissions'] ?? [];
  return (
    <tr>
      <td>
        <div className="row gap-8 nowrap">
          <Badge tone={METHOD_TONE[endpoint.method] ?? 'default'}>
            <span className="mono">{endpoint.method.toUpperCase()}</span>
          </Badge>
          <span className="mono">{endpoint.path}</span>
        </div>
      </td>
      <td>
        <span>{operation.summary}</span>
        {operation.deprecated ? (
          <>
            {' '}
            <Badge tone="warning">Deprecated</Badge>
          </>
        ) : null}
      </td>
      <td>
        <div className="stack gap-2">
          <span className="small">{authLabel(operation)}</span>
          {permissions.map((p) => (
            <span key={p} className="mono small muted">
              {p}
            </span>
          ))}
        </div>
      </td>
      <td className="cell-actions">
        <Button size="sm" variant="ghost" icon={open ? 'chevronDown' : 'chevronRight'} aria-expanded={open} onClick={onToggle}>
          Details
        </Button>
      </td>
    </tr>
  );
}

function Inline({ text }: { text: string }) {
  return (
    <>
      {inlineParts(text).map((part, i) =>
        part.code ? (
          <code key={i} className="mono">
            {part.text}
          </code>
        ) : (
          <Fragment key={i}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}

function Paragraphs({ text }: { text: string | undefined }) {
  if (!text) return null;
  return (
    <>
      {text.split(/\n{2,}/).map((para, i) => (
        <p key={i} className="small">
          <Inline text={para} />
        </p>
      ))}
    </>
  );
}

function EndpointDetails({ doc, operation }: { doc: OpenApiDocument; operation: Operation }) {
  const parameters = operation.parameters ?? [];
  const body = jsonContent(operation.requestBody?.content);
  const responses = Object.entries(operation.responses ?? {});

  return (
    <div className="stack gap-16">
      <Paragraphs text={operation.description} />
      {operation.operationId ? (
        <p className="small muted">
          Operation id <span className="mono">{operation.operationId}</span>
        </p>
      ) : null}

      {parameters.length > 0 ? (
        <div className="stack gap-6">
          <p className="section-title">Parameters</p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">In</th>
                  <th scope="col">Type</th>
                  <th scope="col">Notes</th>
                </tr>
              </thead>
              <tbody>
                {parameters.map((p) => (
                  <tr key={`${p.in}:${p.name}`}>
                    <td className="mono">
                      {p.name}
                      {p.required ? <span className="muted"> *</span> : null}
                    </td>
                    <td>{p.in}</td>
                    <td className="mono small">{describeType(p.schema, doc)}</td>
                    <td className="small">
                      {[p.required ? 'required' : 'optional', ...constraints(p.schema)].join(' · ')}
                      {p.description ? (
                        <>
                          {' — '}
                          <Inline text={p.description} />
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {body ? (
        <div className="stack gap-6">
          <p className="section-title">
            Request body (JSON){operation.requestBody?.required ? '' : ', optional'}
          </p>
          <SchemaTree doc={doc} schema={body} />
        </div>
      ) : null}

      {responses.length > 0 ? (
        <div className="stack gap-6">
          <p className="section-title">Responses</p>
          <div className="stack gap-10">
            {responses.map(([status, raw]) => {
              const response = resolveResponse(raw, doc);
              const schema = jsonContent(response.content);
              return (
                <div key={status} className="stack gap-4">
                  <div className="row gap-8">
                    <Badge tone={status.startsWith('2') ? 'success' : status === 'default' ? 'default' : 'danger'}>
                      <span className="mono">{status}</span>
                    </Badge>
                    <span className="small">
                      <Inline text={response.description ?? ''} />
                    </span>
                  </div>
                  {schema && status.startsWith('2') ? <SchemaTree doc={doc} schema={schema} /> : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A schema as a nested field list. Refs already shown on the way down are not expanded again. */
function SchemaTree({ doc, schema }: { doc: OpenApiDocument; schema: JsonSchema }) {
  return (
    <div className="code-pre" style={{ whiteSpace: 'normal' }}>
      <SchemaNode doc={doc} schema={schema} depth={0} seen={[]} />
    </div>
  );
}

function SchemaNode({ doc, schema, depth, seen }: { doc: OpenApiDocument; schema: JsonSchema; depth: number; seen: string[] }) {
  const name = refName(schema.$ref);
  if (name && seen.includes(name)) return <span className="muted">{name} (see above)</span>;
  const nextSeen = name ? [...seen, name] : seen;
  const resolved = resolveSchema(schema, doc);
  const element = resolved.type === 'array' && resolved.items ? resolveSchema(resolved.items, doc) : null;
  const target = element?.properties ? element : resolved;
  const properties = Object.entries(target.properties ?? {});

  if (properties.length === 0) {
    return (
      <span>
        <span className="mono">{describeType(schema, doc)}</span>
        {resolved.description ? (
          <span className="muted">
            {' — '}
            <Inline text={resolved.description} />
          </span>
        ) : null}
      </span>
    );
  }
  if (depth >= MAX_DEPTH) return <span className="mono">{describeType(schema, doc)}</span>;

  const required = new Set(target.required ?? []);
  return (
    <div className="stack gap-2">
      {name || element ? <span className="muted small">{element ? `${describeType(schema, doc)}, each:` : name}</span> : null}
      {properties.map(([key, child]) => {
        const resolvedChild = resolveSchema(child, doc);
        const nested = Boolean(resolvedChild.properties) || Boolean(resolvedChild.items && resolveSchema(resolvedChild.items, doc).properties);
        const notes = [required.has(key) ? 'required' : null, ...constraints(resolvedChild)].filter(Boolean).join(' · ');
        return (
          <div key={key} style={{ paddingLeft: depth === 0 ? 0 : 16 }}>
            <span className="mono strong">{key}</span>{' '}
            <span className="mono muted">{describeType(child, doc)}</span>
            {notes ? <span className="small muted"> · {notes}</span> : null}
            {resolvedChild.description ? (
              <span className="small">
                {' — '}
                <Inline text={resolvedChild.description} />
              </span>
            ) : null}
            {nested ? (
              <div style={{ paddingLeft: 16 }}>
                <SchemaNode doc={doc} schema={child} depth={depth + 1} seen={nextSeen} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function SchemaList({ doc }: { doc: OpenApiDocument }) {
  const [open, setOpen] = useState<string | null>(null);
  const schemas = Object.entries(doc.components?.schemas ?? {});
  if (schemas.length === 0) return null;
  return (
    <Card flush title="Shared schemas" description="Shapes referenced by several endpoints">
      <ul className="list list--rows">
        {schemas.map(([name, schema]) => (
          <li key={name} className="list__item">
            <div className="stack gap-6 grow">
              <div className="row gap-8">
                <span className="mono strong">{name}</span>
                {schema.description ? (
                  <span className="small muted">
                    <Inline text={schema.description} />
                  </span>
                ) : null}
                <span className="spacer" />
                <Button
                  size="sm"
                  variant="ghost"
                  icon={open === name ? 'chevronDown' : 'chevronRight'}
                  aria-expanded={open === name}
                  onClick={() => setOpen(open === name ? null : name)}
                >
                  Fields
                </Button>
              </div>
              {open === name ? <SchemaTree doc={doc} schema={{ $ref: `#/components/schemas/${name}` }} /> : null}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
