'use client';

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { isApiError, isSessionError } from '@/lib/api';
import { keys } from '@/lib/queries';

function makeQueryClient(): QueryClient {
  // When any request finds the session gone (or a second step now needed), re-check who's
  // signed in; the app layout then sends the user to the right page.
  const refreshMe = (error: unknown) => {
    if (isSessionError(error)) void client.invalidateQueries({ queryKey: keys.me });
  };
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (query.queryKey[0] !== keys.me[0]) refreshMe(error);
      },
    }),
    mutationCache: new MutationCache({ onError: refreshMe }),
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        // Retry network and server errors, never answers like 403 or 404.
        retry: (failureCount, error) => !(isApiError(error) && error.status >= 400 && error.status < 500) && failureCount < 2,
      },
    },
  });
  return client;
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(makeQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
