'use client';

import { useMutation } from '@tanstack/react-query';
import { api } from './api';

/** Sign out, then load the sign-in page fresh so nothing from this session stays in memory. */
export function useSignOut() {
  return useMutation({
    mutationFn: () => api.post('/auth/logout'),
    onSettled: () => {
      window.location.assign('/login');
    },
  });
}
